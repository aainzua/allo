#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import manifest from '../package.json' with { type: 'json' }
import { AlloError, connectionResolver, loadConnections, loadProfile, parseJson } from './profile.js'

const usage = [
  'allo discover',
  'allo describe <operation|service> <name>',
  'allo call <operation> [--input-file <path>]',
  'allo snapshot export <file>',
  'allo snapshot restore <file> [--to <directory>]',
]

function argumentsFor(argv) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        profile: { type: 'string' },
        connections: { type: 'string' },
        'map-connection': { type: 'string', multiple: true },
        'input-file': { type: 'string' },
        to: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    })
  } catch (error) {
    throw new AlloError('invalid_arguments', error.message, { usage })
  }
}

async function readInput(file) {
  if (file !== undefined) return parseJson(await readFile(file, 'utf8'), file)
  if (process.stdin.isTTY) return {}
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const source = Buffer.concat(chunks).toString('utf8')
  return source.trim() ? parseJson(source, 'stdin') : {}
}

async function run(argv) {
  const { values, positionals } = argumentsFor(argv)
  const [command, kind, name] = positionals
  if (values.version) return { version: manifest.version }
  if (values.help || !command) {
    return { usage, options: ['--profile <path>', '--connections <path>', '--map-connection <profile-name>=<local-name>'] }
  }

  const discover = command === 'discover' && positionals.length === 1
  const describe = command === 'describe' && ['operation', 'service'].includes(kind) && positionals.length === 3
  const call = command === 'call' && positionals.length === 2
  const snapshot = command === 'snapshot' && ['export', 'restore'].includes(kind) && positionals.length === 3
  if ((!discover && !describe && !call && !snapshot) ||
      (values['input-file'] !== undefined && !call) ||
      (values.to !== undefined && !(snapshot && kind === 'restore')) ||
      (snapshot && (values['map-connection'] || (kind === 'restore' && values.profile)))) {
    throw new AlloError('invalid_arguments', 'Invalid command or options', { usage })
  }

  if (snapshot) {
    const { exportSnapshot, restoreSnapshot } = await import('./snapshot.js')
    if (kind === 'export') return exportSnapshot(await loadProfile(values.profile), name)
    return restoreSnapshot(name, values.to, await loadConnections(values.connections))
  }

  const mappings = new Map()
  for (const mapping of values['map-connection'] ?? []) {
    const [source, target, extra] = mapping.split('=')
    if (!source || !target || extra !== undefined || mappings.has(source)) {
      throw new AlloError('invalid_connection_mapping', 'Use --map-connection <profile-name>=<local-name> once per connection')
    }
    mappings.set(source, target)
  }
  const profile = await loadProfile(values.profile)
  const local = await loadConnections(values.connections)
  const input = call ? await readInput(values['input-file']) : undefined
  const { boot } = await import('./runtime.js')
  const runtime = await boot(profile, connectionResolver(profile, local, mappings))
  try {
    if (discover) return runtime.discover()
    if (describe) return runtime.describe(kind, name)
    return await runtime.call(kind, input)
  } finally {
    await runtime.close()
  }
}

// Reserve stdout for the CLI response, including when plugin code logs to stdout.
const writeResponse = process.stdout.write.bind(process.stdout)
process.stdout.write = process.stderr.write.bind(process.stderr)
let response
try {
  const result = await run(process.argv.slice(2))
  response = JSON.stringify({ ok: true, result })
} catch (cause) {
  process.exitCode = 1
  const error = cause instanceof AlloError
    ? { code: cause.code, message: cause.message, details: cause.details }
    : { code: 'command_failed', message: String(cause?.message ?? cause) }
  try {
    response = JSON.stringify({ ok: false, error })
  } catch {
    response = JSON.stringify({ ok: false, error: { code: 'command_failed', message: error.message } })
  }
}
writeResponse(response + '\n')
