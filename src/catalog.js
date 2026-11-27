import { build } from 'esbuild'
import { isBuiltin } from 'node:module'
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import semver from 'semver'
import manifest from '../package.json' with { type: 'json' }
import { bundledPlugins } from './bundled.js'
import {
  AlloError, catalogName, digestPattern, isRecord, managedPath, parseJson, pluginDigest,
  projectPath, readJson, sourcePath, validateProfile,
} from './profile.js'

const qualified = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/
const maxBytes = 1024 * 1024

function fail(code, message, details) {
  throw new AlloError(code, message, details)
}

function httpsUrl(value) {
  const url = URL.parse(value)
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    fail('invalid_catalog_url', 'Use an HTTPS URL without credentials, query, or fragment')
  }
  return url
}

function source(value) {
  return /^\w+:\/\//.test(value) ? httpsUrl(value) : value
}

async function readBytes(location, token) {
  if (typeof location === 'string') {
    const bytes = await readFile(location)
    if (bytes.length > maxBytes) fail('catalog_size_limit', 'Catalogs and plugin sources are limited to 1 MiB')
    return bytes
  }
  const response = await fetch(location, {
    redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(location.hostname === 'api.github.com' ? { Accept: 'application/vnd.github.raw+json' } : {}),
    },
  })
  if (!response.ok) {
    await response.body?.cancel()
    fail('catalog_request_failed', 'Catalog or artifact request failed', { status: response.status, url: location.href })
  }
  const chunks = []
  let total = 0
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return Buffer.concat(chunks, total)
      total += value.length
      if (total > maxBytes) {
        await reader.cancel()
        fail('catalog_size_limit', 'Catalogs and plugin sources are limited to 1 MiB')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
}

async function readCatalog(profile, name, entry) {
  const location = source(entry.source)
  const file = typeof location === 'string' ? resolve(profile.root, location) : location
  const token = entry.credentialEnv ? process.env[entry.credentialEnv] : undefined
  if (entry.credentialEnv && !token) {
    fail('catalog_credentials_missing', 'Set the configured catalog credential environment variable',
      { catalog: name, credentialEnv: entry.credentialEnv })
  }
  const data = parseJson((await readBytes(file, token)).toString('utf8'), name)
  if (!isRecord(data) || data.format !== 1 || !isRecord(data.plugins)) {
    fail('invalid_catalog', 'Expected a format 1 catalog with a plugins map', { catalog: name })
  }
  for (const [plugin, info] of Object.entries(data.plugins)) {
    const invalid = () => fail('invalid_catalog', 'Invalid plugin or release in catalog', { plugin: `${name}/${plugin}` })
    if (!catalogName.test(plugin) || !isRecord(info) || typeof info.description !== 'string' ||
        !Array.isArray(info.releases) || !info.releases.length) invalid()
    const versions = new Set()
    for (const release of info.releases) {
      if (!isRecord(release) || typeof release.version !== 'string' || semver.valid(release.version) !== release.version ||
          versions.has(release.version) || typeof release.allo !== 'string' || !semver.validRange(release.allo) ||
          typeof release.source !== 'string' || !release.source || typeof release.sha256 !== 'string' ||
          !digestPattern.test(release.sha256) || (release.requires !== undefined &&
           (!Array.isArray(release.requires) || release.requires.some(id => typeof id !== 'string' || !qualified.test(id))))) invalid()
      versions.add(release.version)
    }
  }
  return { name, file, origin: entry.source, token, plugins: data.plugins }
}

function installedId(plugin) {
  if (plugin.plugin) return `bundled/${plugin.plugin}`
  if (plugin.bundledRevision) return `bundled/${plugin.bundledRevision.name}`
  if (plugin.install) return `${plugin.install.catalog}/${plugin.install.name}`
  return plugin.path
}

function pinnedPlugin(plugins, ref) {
  const matches = plugins.filter(plugin => installedId(plugin) === ref ||
    plugin.install?.name === ref || plugin.plugin === ref || plugin.bundledRevision?.name === ref)
  if (matches.length !== 1) {
    fail(matches.length ? 'ambiguous_plugin' : 'plugin_not_installed',
      matches.length ? 'Use a qualified installed plugin name' : 'Plugin is not enabled in the profile',
      { plugin: ref, matches: matches.map(installedId) })
  }
  return matches[0]
}

async function atomicWrite(path, content) {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, content, { flag: 'wx' })
    await rename(temporary, path)
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
}

async function change(profile, data, artifact) {
  validateProfile(data, profile.path)
  const lockPath = `${profile.path}.lock`
  const lock = await open(lockPath, 'wx').catch(error => {
    if (error.code === 'EEXIST') fail('profile_locked', 'Another profile change is in progress', { path: profile.path })
    throw error
  })
  try {
    const current = await readJson(profile.path)
    if (JSON.stringify(current) !== JSON.stringify(profile.data)) {
      fail('profile_changed', 'The profile changed during this command. Inspect it and retry.', { path: profile.path })
    }
    if (artifact) {
      const path = projectPath(profile.root, artifact.path)
      await mkdir(dirname(path), { recursive: true })
      await atomicWrite(path, artifact.bytes)
    }
    await atomicWrite(profile.path, JSON.stringify(data, null, 2) + '\n')
  } finally {
    await lock.close()
    await unlink(lockPath)
  }
}

async function install(profile, catalog, name, release, previous) {
  const id = `${catalog.name}/${name}`
  const requires = release.requires ?? []
  const enabled = new Set(profile.plugins.filter(plugin => plugin !== previous).map(installedId))
  if (enabled.has(id)) fail('plugin_already_installed', 'Plugin is already enabled. Use plugin update.', { plugin: id })
  const missing = requires.filter(dependency => !enabled.has(dependency))
  if (missing.length) fail('plugin_dependency_missing', 'Enable the missing dependencies first', { plugin: id, missing })

  const origin = catalog.file
  const location = typeof origin === 'string'
    ? (/^\w+:\/\//.test(release.source) ? httpsUrl(release.source) : resolve(dirname(origin), release.source))
    : httpsUrl(new URL(release.source, origin))
  const token = typeof origin !== 'string' && typeof location !== 'string' && origin.origin === location.origin
    ? catalog.token : undefined
  const bytes = await readBytes(location, token)
  if (pluginDigest(bytes) !== release.sha256) fail('plugin_integrity_failed', 'Plugin source did not match the catalog SHA-256', { plugin: id })
  try {
    const result = await build({
      stdin: { contents: bytes.toString('utf8'), loader: 'ts' },
      bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent', write: false, metafile: true,
    })
    const [output] = Object.values(result.metafile.outputs)
    if (!output.exports.includes('default') || output.imports.some(item => !isBuiltin(item.path))) {
      fail('invalid_plugin_artifact', 'Catalog plugins must be standalone TypeScript files with a default export')
    }
  } catch {
    fail('invalid_plugin_artifact', 'Catalog plugins must be standalone TypeScript files with a default export', { plugin: id })
  }

  const pin = { catalog: catalog.name, name, origin: catalog.origin, version: release.version, sha256: release.sha256, requires }
  const path = managedPath(pin.sha256)
  const entry = { ...(previous ?? {}), path, install: pin }
  const plugins = [...profile.data.plugins]
  if (previous) plugins[profile.plugins.indexOf(previous)] = entry
  else plugins.push(entry)
  await change(profile, { ...profile.data, plugins }, { path, bytes })
  return {
    profile: profile.path, plugin: id, version: pin.version, sha256: pin.sha256,
    ...(previous ? { previousVersion: previous.install.version, updated: true } : {}),
  }
}

function compatibleReleases(info) {
  return info.releases.filter(release => semver.satisfies(manifest.version, release.allo))
    .sort((first, second) => semver.rcompare(first.version, second.version))
}

export async function catalogCommand(profile, action, name, url, credentialEnv) {
  const catalogs = profile.data.catalogs ?? {}
  if (action === 'list') return { profile: profile.path, catalogs }
  if (typeof name !== 'string' || !catalogName.test(name) || name === 'bundled') {
    fail('invalid_catalog_name', 'Use a catalog name such as official or local')
  }
  if (action === 'add') {
    if (Object.hasOwn(catalogs, name)) fail('catalog_already_configured', 'This catalog name already has a source', { catalog: name })
    const entry = { source: url, credentialEnv }
    const data = { ...profile.data, catalogs: { ...catalogs, [name]: entry } }
    validateProfile(data, profile.path)
    await readCatalog(profile, name, entry)
    await change(profile, data)
    return { profile: profile.path, catalog: name, source: url }
  }
  if (!Object.hasOwn(catalogs, name)) fail('catalog_not_found', 'Catalog is not configured', { catalog: name })
  const plugins = profile.plugins.filter(plugin => plugin.install?.catalog === name).map(installedId)
  if (plugins.length) fail('catalog_in_use', 'Remove its installed plugins before removing the catalog', { catalog: name, plugins })
  const rest = { ...catalogs }
  delete rest[name]
  await change(profile, { ...profile.data, catalogs: rest })
  return { profile: profile.path, removed: name }
}

export async function pluginCommand(profile, action, ref, version) {
  const catalogs = profile.data.catalogs ?? {}
  if (version !== undefined && (!version || semver.valid(version) !== version)) {
    fail('invalid_plugin_version', 'Use an exact SemVer release such as 1.0.0')
  }
  if (action === 'list') return {
    profile: profile.path,
    plugins: profile.plugins.map(plugin => ({
      id: installedId(plugin), source: (plugin.plugin || plugin.bundledRevision) ? 'bundled' : plugin.install ? 'catalog' : 'local',
      ...(plugin.install ?? plugin.bundledRevision ?? {}),
    })),
  }
  if (action === 'remove') {
    const selected = pinnedPlugin(profile.plugins, ref)
    const id = installedId(selected)
    const dependents = profile.plugins.filter(plugin => plugin.install?.requires.includes(id)).map(installedId)
    if (dependents.length) fail('plugin_in_use', 'Other enabled plugins require this plugin', { plugin: id, dependents })
    const plugins = profile.data.plugins.filter((_, index) => profile.plugins[index] !== selected)
    await change(profile, { ...profile.data, plugins })
    return { profile: profile.path, removed: id }
  }
  if (action === 'add' && (ref.startsWith('./') || ref.startsWith('.\\') || ref.startsWith('bundled/'))) {
    if (version) fail('invalid_arguments', 'A version can only be selected for catalog plugins')
    const bundled = ref.startsWith('bundled/') ? ref.slice(8) : undefined
    if (bundled && !Object.hasOwn(bundledPlugins, bundled)) fail('plugin_not_found', 'Unknown bundled plugin', { plugin: ref })
    if (!bundled) await sourcePath(profile.root, ref)
    const id = bundled ? ref : projectPath(profile.root, ref)
    const duplicate = profile.plugins.some(plugin => installedId(plugin) === ref ||
      (!bundled && plugin.path && projectPath(profile.root, plugin.path) === id))
    if (duplicate) fail('plugin_already_installed', 'Plugin is already enabled')
    const entry = bundled ? { plugin: bundled } : ref
    await change(profile, { ...profile.data, plugins: [...profile.data.plugins, entry] })
    return { profile: profile.path, plugin: ref }
  }

  const previous = action === 'update' ? pinnedPlugin(profile.plugins, ref) : undefined
  if (previous && !previous.install) fail('plugin_update_unsupported', 'Update bundled plugins through Allo and local plugins by editing their source')
  const target = previous ? installedId(previous) : ref
  if (action !== 'search' && !qualified.test(target) && !catalogName.test(target)) {
    fail('invalid_plugin_name', 'Use a plugin name, catalog/name, bundled/name, or a project-relative ./path.ts')
  }
  const [prefix, suffix] = (target ?? '').split('/')
  if (previous && Object.hasOwn(catalogs, prefix) && catalogs[prefix].source !== previous.install.origin) {
    fail('plugin_origin_changed', 'The configured catalog source differs from the installed origin', { plugin: target })
  }
  const sources = action === 'search' || !suffix ? Object.keys(catalogs) : [prefix]
  const loaded = await Promise.all(sources.map(name => {
    if (!Object.hasOwn(catalogs, name)) fail('catalog_not_found', 'Catalog is not configured', { catalog: name })
    return readCatalog(profile, name, catalogs[name])
  }))
  const entries = loaded.flatMap(catalog => Object.entries(catalog.plugins).map(([name, info]) => ({ catalog, name, info })))
  if (action === 'search') {
    const query = (ref ?? '').toLowerCase()
    return { profile: profile.path, plugins: entries.flatMap(({ catalog, name, info }) => {
      const plugin = `${catalog.name}/${name}`
      return `${plugin} ${info.description}`.toLowerCase().includes(query)
        ? [{ plugin, description: info.description, version: compatibleReleases(info)[0]?.version }]
        : []
    }) }
  }
  const matches = entries.filter(({ catalog, name }) => suffix ? catalog.name === prefix && name === suffix : name === prefix)
  if (matches.length !== 1) {
    fail(matches.length ? 'ambiguous_plugin' : 'plugin_not_found',
      matches.length ? 'Use a qualified catalog/plugin name' : 'No catalog publishes this plugin',
      { plugin: target, matches: matches.map(({ catalog, name }) => `${catalog.name}/${name}`) })
  }
  const { catalog, name, info } = matches[0]
  const releases = compatibleReleases(info)
  if (previous && !releases.some(release => semver.gt(release.version, previous.install.version))) {
    return { profile: profile.path, plugin: target, version: previous.install.version, updated: false }
  }
  const release = version ? releases.find(release => release.version === version) : releases[0]
  if (!release) fail('compatible_release_not_found', 'No matching release supports this Allo version', { plugin: target, version })
  return install(profile, catalog, name, release, previous)
}
