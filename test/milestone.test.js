import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createFixture } from '../examples/erp/fixture.mjs'

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url))
const starter = fileURLToPath(new URL('../examples/erp/starter/', import.meta.url))
const run = async (cwd, args, env, input) => {
  const child = spawn(process.execPath, [cli, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  child.stdin.end(input)
  const [code] = await once(child, 'close')
  const response = JSON.parse(stdout)
  assert.equal(code, response.ok ? 0 : 1, stderr)
  return { ...response, stderr }
}

const newPlugin = `
import type { Allo } from 'allo'
import type { Context } from 'cordis'
import type { Inventory } from './erp.ts'
import { findStock } from './find-stock.ts'

export default {
  name: 'warehouse',
  inject: ['allo', 'erp.inventroy'],
  apply(ctx: Context) {
    const allo: Allo = ctx.get('allo')
    const inventory: Inventory = ctx.get('erp.inventory')
    allo.operation(ctx, {
      name: 'warehouse.stock',
      description: 'Get stock for one SKU and warehouse.',
      connections: [inventory.connection],
      inputSchema: {
        type: 'object',
        properties: { sku: { type: 'string' }, warehouse: { type: 'string' } },
        required: ['sku', 'warehouse'],
        additionalProperties: false,
      },
      resultSchema: { type: 'integer' },
    }, async ({ sku, warehouse }: { sku: string; warehouse: string }) => {
      console.log('Looking up warehouse stock')
      return findStock(await inventory.lookup(sku), warehouse)
    })
  },
}
`

test('author a local plugin, recover its exact source, and call it against current ERP stock', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'allo-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const cwd = join(workspace, 'working')
  await cp(starter, cwd, { recursive: true })
  const stockFile = join(workspace, 'stock.json')
  const stock = quantity => writeFile(stockFile, JSON.stringify({ A42: [{ warehouse: 'Bilbao', quantity }] }))
  await stock(11)
  const server = createFixture(stockFile, 'milestone-fixture-secret').listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.close() })
  const destination = `http://127.0.0.1:${server.address().port}/`
  const localPath = join(workspace, 'local.json')
  await writeFile(localPath, '{}')
  const local = ['--connections', localPath]
  const env = { ...process.env }
  delete env.ALLO_FIXTURE_TOKEN
  const credentials = { ...env, ALLO_FIXTURE_TOKEN: 'milestone-fixture-secret' }
  const profilePath = join(cwd, 'allo.json')
  const profile = JSON.parse(await readFile(profilePath, 'utf8'))
  profile.connections['erp-demo'].destination = destination
  await writeFile(profilePath, JSON.stringify(profile))

  const initial = await run(join(cwd, 'plugins'), ['discover', ...local], env)
  assert.equal(initial.result.profile, await realpath(profilePath))
  assert.deepEqual(initial.result.issues, [])
  assert.deepEqual(initial.result.services.map(service => service.name), ['erp.inventory'])
  assert.deepEqual(initial.result.operations.map(operation => operation.name), ['summary.total-stock'])
  const service = await run(cwd, ['describe', 'service', 'erp.inventory', ...local], env)
  assert.deepEqual(service.result.inject, ['erp.inventory'])
  assert.match(service.result.usage, /inventory\.lookup/)

  const authored = join(cwd, 'plugins', 'warehouse.ts')
  await writeFile(authored, newPlugin)
  await writeFile(join(cwd, 'plugins', 'find-stock.ts'),
    "export const findStock = (rows, warehouse) => rows.find(row => row.warehouse === warehouse)?.quantity ?? 0\n")
  profile.plugins.unshift('./plugins/warehouse.ts')
  await writeFile(profilePath, JSON.stringify(profile))
  const pending = await run(cwd, ['discover', ...local], env)
  assert.deepEqual(pending.result.issues, [{
    plugin: './plugins/warehouse.ts', code: 'missing_services', services: ['erp.inventroy'],
  }])
  assert.equal(pending.result.operations[0].name, 'summary.total-stock')

  await writeFile(authored, newPlugin.replace('erp.inventroy', 'erp.inventory'))
  const description = await run(cwd, ['describe', 'operation', 'warehouse.stock', ...local], env)
  assert.equal(description.result.issue.code, 'credentials_missing')
  assert.deepEqual(description.result.connections, ['erp-demo'])
  assert.deepEqual(description.result.inputSchema.required, ['sku', 'warehouse'])
  const input = JSON.stringify({ sku: 'A42', warehouse: 'Bilbao' })
  const command = ['call', 'warehouse.stock', ...local]
  assert.equal((await run(cwd, command, env, input)).error.code, 'credentials_missing')
  assert.equal((await run(cwd, command, credentials, '{}')).error.code, 'invalid_input')
  const original = await run(cwd, command, credentials, input)
  assert.equal(original.result, 11)
  assert.match(original.stderr, /Looking up warehouse stock/)

  const snapshot = join(workspace, 'monday.allo-snapshot.json')
  assert.equal((await run(cwd, ['snapshot', 'export', snapshot], credentials)).ok, true)
  const archive = JSON.parse(await readFile(snapshot, 'utf8'))
  assert.ok(archive.files.some(file => file.path === 'plugins/find-stock.ts'))
  assert.ok(!archive.files.some(file =>
    Buffer.from(file.content, 'base64').includes('milestone-fixture-secret')))
  archive.files.find(file => file.path === 'plugins/find-stock.ts').content = Buffer.from('changed').toString('base64')
  const corrupted = join(workspace, 'corrupted.allo-snapshot.json')
  await writeFile(corrupted, JSON.stringify(archive))
  assert.equal((await run(workspace, ['snapshot', 'restore', corrupted, ...local], env)).error.code, 'invalid_snapshot_file')
  await writeFile(authored, 'export default {')
  const broken = await run(cwd, ['discover', ...local], env)
  assert.equal(broken.result.issues[0].code, 'plugin_load_failed')
  assert.equal(broken.result.operations[0].name, 'summary.total-stock')

  await stock(19)
  await writeFile(localPath, JSON.stringify({
    'erp-demo': { destination: 'http://127.0.0.1:1/' },
    'erp-test': { destination },
  }))
  const restored = join(workspace, 'restored')
  const restore = await run(workspace, ['snapshot', 'restore', snapshot, '--to', restored, ...local], env)
  assert.deepEqual(restore.result.conflicts, [{
    connection: 'erp-demo', profileDestination: destination, localDestination: 'http://127.0.0.1:1/',
  }])
  assert.equal((await run(restored, command, credentials, input)).error.code, 'connection_conflict')
  const mapped = [...command, '--map-connection', 'erp-demo=erp-test']
  assert.equal((await run(restored, mapped, env, input)).error.code, 'credentials_missing')
  const inputFile = join(workspace, 'input.json')
  await writeFile(inputFile, input)
  const recovered = await run(workspace, [
    ...mapped, '--profile', join(restored, 'allo.json'), '--input-file', inputFile,
  ], credentials)
  assert.equal(recovered.result, 19)
  assert.equal(await readFile(authored, 'utf8'), 'export default {')
})

test('two plugins claiming one operation leave its name unavailable', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'allo-conflict-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const localPath = join(cwd, 'local.json')
  await writeFile(localPath, '{}')
  const local = ['--connections', localPath]
  await writeFile(join(cwd, 'allo.json'), JSON.stringify({ plugins: ['./first.ts', './second.ts'] }))
  const plugin = `
export default {
  inject: ['allo'],
  apply(ctx) {
    ctx.get('allo').operation(ctx, {
      name: 'example.ping', description: 'Ping',
      inputSchema: true, resultSchema: { type: 'string' },
    }, () => 'pong')
  },
}
`
  await writeFile(join(cwd, 'first.ts'), plugin)
  await writeFile(join(cwd, 'second.ts'), plugin)
  const catalog = await run(cwd, ['discover', ...local], process.env)
  assert.deepEqual(catalog.result.operations, [{
    name: 'example.ping',
    available: false,
    issue: { code: 'registration_conflict', plugins: ['./first.ts', './second.ts'] },
  }])
  assert.equal((await run(cwd, ['call', 'example.ping', ...local], process.env)).error.code, 'registration_conflict')
})
