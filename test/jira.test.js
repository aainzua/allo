import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadProfile } from '../src/profile.js'
import { boot } from '../src/runtime.js'
import { exportSnapshot, restoreSnapshot } from '../src/snapshot.js'

test('Jira Cloud reads issues and forwards pagination tokens without retrying rate limits', async t => {
  const profile = await loadProfile(fileURLToPath(new URL('../examples/jira/allo.example.json', import.meta.url)))
  const previousEmail = process.env.ALLO_JIRA_EMAIL
  const previousToken = process.env.ALLO_JIRA_TOKEN
  process.env.ALLO_JIRA_EMAIL = 'fixture@example.test'
  process.env.ALLO_JIRA_TOKEN = 'fixture-token'
  t.after(() => {
    if (previousEmail === undefined) delete process.env.ALLO_JIRA_EMAIL
    else process.env.ALLO_JIRA_EMAIL = previousEmail
    if (previousToken === undefined) delete process.env.ALLO_JIRA_TOKEN
    else process.env.ALLO_JIRA_TOKEN = previousToken
  })
  const issue = { id: '101', key: 'DEMO-1', fields: { summary: 'Example issue' } }
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options })
    if (calls.length === 1) return Response.json(issue)
    if (calls.length === 2) return Response.json({ issues: [issue], nextPageToken: 'cursor' })
    return new Response(null, { status: 429, headers: { 'Retry-After': '12' } })
  })
  const runtime = await boot(profile, () => ({
    destination: 'https://api.atlassian.com/ex/jira/fixture-id', credential: 'fixture-token',
  }))
  t.after(() => runtime.close())
  const prefix = '/ex/jira/fixture-id/rest/api/3'
  assert.deepEqual(await runtime.call('jira.get-issue', { key: 'DEMO-1', fields: ['summary'] }), issue)
  assert.equal(calls[0].url.pathname, prefix + '/issue/DEMO-1')
  assert.equal(calls[0].url.searchParams.get('fields'), 'summary')
  assert.equal(calls[0].options.method, 'GET')
  assert.equal(calls[0].options.redirect, 'error')
  assert.equal(calls[0].options.headers.Authorization,
    'Basic ' + Buffer.from('fixture@example.test:fixture-token').toString('base64'))

  const search = { jql: 'project = DEMO', fields: ['summary'], maxResults: 5 }
  const page = await runtime.call('jira.search-issues', search)
  assert.deepEqual(page.issues, [issue])
  assert.equal(calls[1].url.pathname, prefix + '/search/jql')
  assert.equal(calls[1].options.method, 'POST')
  assert.deepEqual(JSON.parse(calls[1].options.body), search)
  await assert.rejects(runtime.call('jira.search-issues', { ...search, nextPageToken: page.nextPageToken }),
    error => error.code === 'jira_rate_limited' && error.details.retryAfter === '12')
  assert.equal(calls.length, 3)
  assert.equal(JSON.parse(calls[2].options.body).nextPageToken, 'cursor')
})

test('Jira writes ADF and applies the requested transition once', async t => {
  const profile = await loadProfile(fileURLToPath(new URL('../examples/jira/allo.example.json', import.meta.url)))
  const issue = { id: '101', key: 'DEMO-1' }
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ path: url.pathname, method: options.method, body: JSON.parse(options.body) })
    if (calls.length === 1) return Response.json(issue, { status: 201 })
    if (calls.length === 2) return new Response(null, { status: 204 })
    return new Response('error', { status: 502 })
  })
  const runtime = await boot(profile, () => ({ destination: 'https://fixture.atlassian.net/' }), {
    read: async () => ({ email: 'fixture@example.test', token: 'fixture-token' }),
  })
  t.after(() => runtime.close())
  assert.deepEqual(await runtime.call('jira.create-issue', {
    project: 'DEMO', issueTypeId: '10002', summary: 'Test', description: 'First\nSecond',
    fields: { customfield_12345: { id: '6' } },
  }), issue)
  assert.deepEqual(calls[0].body.fields, {
    project: { key: 'DEMO' }, issuetype: { id: '10002' }, summary: 'Test',
    description: {
      version: 1, type: 'doc', content: ['First', 'Second'].map(text =>
        ({ type: 'paragraph', content: [{ type: 'text', text }] })),
    },
    customfield_12345: { id: '6' },
  })
  assert.deepEqual(await runtime.call('jira.transition-issue', { key: 'DEMO-1', transitionId: '17', fields: { resolution: { id: '1' } } }), { ok: true })
  assert.deepEqual(calls[1], {
    path: '/rest/api/3/issue/DEMO-1/transitions', method: 'POST',
    body: { transition: { id: '17' }, fields: { resolution: { id: '1' } } },
  })
  await assert.rejects(runtime.call('jira.add-comment', { key: 'DEMO-1', body: 'Verify me' }),
    error => error.code === 'outcome_unknown')
  assert.equal(calls.length, 3)
})

test('Jira fetch-all retains retrieved issues when a later page fails', async t => {
  const profile = await loadProfile(fileURLToPath(new URL('../examples/jira/allo.example.json', import.meta.url)))
  const issue = { id: '101', key: 'DEMO-1', fields: {} }
  const nextPageToken = 'resume-here'
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => ++calls === 1
    ? Response.json({ issues: [issue], nextPageToken, isLast: false })
    : new Response(null, { status: 429 }))
  const runtime = await boot(profile, () => ({ destination: 'https://fixture.atlassian.net/' }), {
    read: async () => ({ email: 'fixture@example.test', token: 'fixture-token' }),
  })
  t.after(() => runtime.close())
  assert.deepEqual(await runtime.call('jira.search-all', { jql: 'project = DEMO', limit: 2 }), {
    issues: [issue], count: 1, complete: false, nextPageToken, reason: 'request_failed',
    error: { code: 'jira_rate_limited', message: 'Jira rate-limited the request' },
  })
  assert.equal(calls, 2)
})

test('a snapshot restores the exact bundled Jira revision as editable source', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'allo-jira-snapshot-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const profile = await loadProfile(fileURLToPath(new URL('../examples/jira/allo.example.json', import.meta.url)))
  const snapshot = join(workspace, 'jira.allo-snapshot.json')
  const restored = join(workspace, 'restored')
  await exportSnapshot(profile, snapshot)
  const restoredResult = await restoreSnapshot(snapshot, restored, {})
  const portableProfile = await loadProfile(restoredResult.profile)
  const [entry] = portableProfile.plugins
  const expected = await readFile(new URL('../src/plugins/jira.ts', import.meta.url))
  const digest = createHash('sha256').update(expected).digest('hex')
  assert.equal(entry.path, `.allo/bundled/jira-${digest}.ts`)
  assert.deepEqual(await readFile(join(restored, entry.path)), expected)
  assert.deepEqual(portableProfile.connections, profile.connections)
  const runtime = await boot(portableProfile, () => ({ destination: 'https://fixture.atlassian.net/' }))
  t.after(() => runtime.close())
  assert.equal(runtime.discover().operations.some(operation => operation.name === 'jira.create-issue'), true)
  assert.deepEqual(runtime.discover().issues, [])
})
