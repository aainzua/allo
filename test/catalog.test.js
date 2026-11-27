import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { catalogCommand, pluginCommand } from '../src/catalog.js'
import { loadProfile, pluginDigest } from '../src/profile.js'
import { boot } from '../src/runtime.js'
import { exportSnapshot, restoreSnapshot } from '../src/snapshot.js'

const sample = fileURLToPath(new URL('../examples/catalog/', import.meta.url))

test('catalog installs are unambiguous, pinned, updatable, and portable', async t => {
  const root = await mkdtemp(join(tmpdir(), 'allo-catalog-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const profilePath = join(root, 'allo.json')
  await writeFile(profilePath, JSON.stringify({ plugins: [] }))
  await cp(sample, join(root, 'one'), { recursive: true })
  await cp(sample, join(root, 'two'), { recursive: true })
  const profile = () => loadProfile(profilePath)
  const catalog = async (...args) => catalogCommand(await profile(), ...args)
  const plugin = async (...args) => pluginCommand(await profile(), ...args)
  await catalog('add', 'one', 'one/catalog.json')
  await catalog('add', 'two', 'two/catalog.json')
  assert.deepEqual((await plugin('search', 'jira')).plugins.map(entry => entry.plugin), ['one/jira-summary', 'two/jira-summary'])
  await assert.rejects(plugin('add', 'jira-summary'), { code: 'ambiguous_plugin' })
  await assert.rejects(plugin('add', 'two/jira-summary'), { code: 'plugin_dependency_missing' })
  await plugin('add', 'bundled/jira')
  const original = await plugin('add', 'two/jira-summary')
  assert.equal(original.version, '1.0.0')
  await assert.rejects(plugin('remove', 'bundled/jira'), { code: 'plugin_in_use' })
  await assert.rejects(catalog('remove', 'two'), { code: 'catalog_in_use' })

  const path = join(root, 'two', 'catalog.json')
  const source = join(root, 'two', 'jira-summary.ts')
  const manifest = JSON.parse(await readFile(path, 'utf8'))
  const releases = manifest.plugins['jira-summary'].releases
  const updated = (await readFile(source, 'utf8')).replace('Read the summary of one Jira issue.', 'Read a Jira summary.')
  await writeFile(join(root, 'two', 'updated.ts'), updated)
  releases.push({ ...releases[0], version: '1.1.0', source: './updated.ts', sha256: '0'.repeat(64) })
  await writeFile(path, JSON.stringify(manifest))
  await assert.rejects(plugin('update', 'jira-summary'), { code: 'plugin_integrity_failed' })
  assert.equal((await plugin('list')).plugins[1].version, '1.0.0')
  releases[1].sha256 = pluginDigest(updated)
  await writeFile(path, JSON.stringify(manifest))
  assert.equal((await plugin('update', 'jira-summary')).version, '1.1.0')

  const snapshot = join(root, 'profile.allo-snapshot.json')
  await exportSnapshot(await profile(), snapshot)
  const restored = await restoreSnapshot(snapshot, join(root, 'restored'), {})
  const restoredProfile = await loadProfile(restored.profile)
  await assert.rejects(pluginCommand(restoredProfile, 'remove', 'bundled/jira'), { code: 'plugin_in_use' })
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ id: '101', key: 'DEMO-1', fields: { summary: 'Sample Jira issue' } }))
  const runtime = await boot(restoredProfile, () => ({ destination: 'https://fixture.atlassian.net/' }), {
    read: async () => ({ email: 'fixture@example.test', token: 'fixture-token' }),
  })
  t.after(() => runtime.close())
  assert.deepEqual(runtime.discover().issues, [])
  assert.equal(runtime.describe('operation', 'jira-summary.get').description, 'Read a Jira summary.')
  assert.deepEqual(await runtime.call('jira-summary.get', { key: 'DEMO-1' }), { summary: 'Sample Jira issue' })

  await plugin('remove', 'two/jira-summary')
  await catalog('remove', 'two')
  assert.equal((await plugin('list')).plugins.length, 1)
})

test('private catalogs keep credentials on their origin and updates keep the installed origin', async t => {
  const root = await mkdtemp(join(tmpdir(), 'allo-remote-catalog-'))
  const profilePath = join(root, 'allo.json')
  const variable = 'ALLO_TEST_CATALOG_TOKEN'
  const previous = process.env[variable]
  process.env[variable] = 'test-token'
  t.after(async () => {
    if (previous === undefined) delete process.env[variable]
    else process.env[variable] = previous
    await rm(root, { recursive: true, force: true })
  })
  await writeFile(profilePath, JSON.stringify({ plugins: [{ plugin: 'jira' }] }))
  const catalog = JSON.parse(await readFile(join(sample, 'catalog.json'), 'utf8'))
  catalog.plugins['jira-summary'].releases[0].source = 'https://files.example.test/jira-summary.ts'
  const bytes = await readFile(join(sample, 'jira-summary.ts'))
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push([url.origin, options.headers.Authorization])
    return url.hostname === 'catalog.example.test' ? Response.json(catalog) : new Response(bytes)
  })

  await catalogCommand(await loadProfile(profilePath), 'add', 'private', 'https://catalog.example.test/catalog.json', variable)
  await pluginCommand(await loadProfile(profilePath), 'add', 'private/jira-summary')
  assert.deepEqual(calls, [
    ['https://catalog.example.test', 'Bearer test-token'],
    ['https://catalog.example.test', 'Bearer test-token'],
    ['https://files.example.test', undefined],
  ])
  const { data } = await loadProfile(profilePath)
  data.catalogs.private.source = 'https://other.example.test/catalog.json'
  await writeFile(profilePath, JSON.stringify(data))
  await assert.rejects(pluginCommand(await loadProfile(profilePath), 'update', 'private/jira-summary'), { code: 'plugin_origin_changed' })
  assert.equal(calls.length, 3)
})
