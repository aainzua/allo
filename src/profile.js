import { readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const profileName = 'allo.json'

export class AlloError extends Error {
  constructor(code, message, details) {
    super(message)
    this.code = code
    this.details = details
  }
}

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function parseJson(source, label) {
  try {
    return JSON.parse(source.replace(/^\uFEFF/, ''))
  } catch {
    throw new AlloError('invalid_json', `${label} does not contain valid JSON`)
  }
}

export async function readJson(path) {
  return parseJson(await readFile(path, 'utf8'), path)
}

export function projectPath(root, path) {
  const parts = typeof path === 'string' ? path.split(/[\\/]/) : []
  if (parts[0] === '.') parts.shift()
  if (!parts.length || parts.some(part =>
    !part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]|[ .]$/u.test(part) ||
    /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part) ||
    ['.git', 'node_modules'].includes(part.toLowerCase())
  )) {
    throw new AlloError('invalid_path', 'Expected a portable path inside the project', { path })
  }
  return join(root, ...parts)
}

export async function sourcePath(root, path) {
  const physicalPath = await realpath(projectPath(root, path))
  const fromRoot = relative(root, physicalPath)
  if (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new AlloError('invalid_path', 'Source resolves outside the project', { path })
  }
  return physicalPath
}

function validateConnections(connections, label) {
  if (!isRecord(connections)) throw new AlloError('invalid_connections', `Invalid connections in ${label}`)
  for (const [name, connection] of Object.entries(connections)) {
    if (!/^[a-z][a-z0-9-]*$/.test(name) || !isRecord(connection) ||
        Object.keys(connection).some(key => !['destination', 'credentialEnv'].includes(key)) ||
        typeof connection.destination !== 'string' ||
        (connection.credentialEnv !== undefined &&
         (typeof connection.credentialEnv !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(connection.credentialEnv)))) {
      throw new AlloError('invalid_connections', `Invalid connection ${name} in ${label}`)
    }
    const url = URL.parse(connection.destination)
    if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new AlloError('invalid_connections', `Connection ${name} requires a destination URL without credentials, query, or fragment`)
    }
  }
  return connections
}

export function validateProfile(data, path) {
  if (!isRecord(data) || !Array.isArray(data.plugins) ||
      (data.snapshotFiles !== undefined && !Array.isArray(data.snapshotFiles))) {
    throw new AlloError('invalid_profile', 'A profile requires a plugins array and may specify a snapshotFiles array', { path })
  }
  const root = dirname(path)
  const plugins = data.plugins.map(entry => {
    const plugin = typeof entry === 'string' ? { path: entry } : entry
    if (!isRecord(plugin)) throw new AlloError('invalid_profile', 'Invalid plugin entry', { path })
    const entryPath = projectPath(root, plugin.path)
    if (!/\.(?:[cm]?[jt]s)$/.test(entryPath)) {
      throw new AlloError('invalid_profile', 'Plugin entry points must be TypeScript or JavaScript files', { plugin: plugin.path })
    }
    return plugin
  })
  for (const file of data.snapshotFiles ?? []) projectPath(root, file)
  const connections = validateConnections(data.connections ?? {}, path)
  return { path, root, data, plugins, connections }
}

export async function loadProfile(explicit) {
  if (explicit) {
    const path = await realpath(resolve(explicit)).catch(error => {
      if (error.code === 'ENOENT') throw new AlloError('profile_not_found', 'The selected profile does not exist', { path: resolve(explicit) })
      throw error
    })
    return validateProfile(await readJson(path), path)
  }
  let directory = await realpath(process.cwd())
  while (true) {
    const path = join(directory, profileName)
    try {
      return validateProfile(await readJson(path), path)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    const parent = dirname(directory)
    if (parent === directory) throw new AlloError('profile_not_found', 'No allo.json found above the working directory')
    directory = parent
  }
}

export async function loadConnections(path) {
  const file = path ?? join(homedir(), '.allo', 'connections.json')
  try {
    return validateConnections(await readJson(file), file)
  } catch (error) {
    if (!path && error.code === 'ENOENT') return {}
    throw error
  }
}

export function connectionConflicts(profile, local) {
  return Object.entries(profile.connections).flatMap(([name, connection]) => {
    const existing = Object.hasOwn(local, name) ? local[name] : undefined
    if (!existing || new URL(existing.destination).href === new URL(connection.destination).href) return []
    return [{ connection: name, profileDestination: connection.destination, localDestination: existing.destination }]
  })
}

export function connectionResolver(profile, local, mappings) {
  const conflicts = new Map(connectionConflicts(profile, local).map(conflict => [conflict.connection, conflict]))
  for (const [name, target] of mappings) {
    if (!Object.hasOwn(profile.connections, name) || !Object.hasOwn(local, target)) {
      throw new AlloError('invalid_connection_mapping', 'A mapping must link a profile connection to a local connection', { connection: name, target })
    }
  }
  return name => {
    if (!Object.hasOwn(profile.connections, name)) {
      throw new AlloError('connection_not_found', `Connection ${name} is missing from the profile`, { connection: name })
    }
    if (conflicts.has(name) && !mappings.has(name)) {
      throw new AlloError('connection_conflict', `Connection ${name} requires an explicit mapping`, conflicts.get(name))
    }
    const target = mappings.get(name) ?? name
    const connection = Object.hasOwn(local, target) ? local[target] : profile.connections[name]
    const variable = connection.credentialEnv ?? profile.connections[name].credentialEnv
    const credential = variable ? process.env[variable] : undefined
    if (variable && !credential) {
      throw new AlloError('credentials_missing', `Configure credentials for ${name}`, { connection: name, credentialEnv: variable })
    }
    return { destination: connection.destination, credential }
  }
}
