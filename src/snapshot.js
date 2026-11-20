import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { build } from 'esbuild'
import manifest from '../package.json' with { type: 'json' }
import {
  AlloError, connectionConflicts, isRecord, parseJson, profileName,
  projectPath, readJson, sourcePath, validateProfile,
} from './profile.js'

const format = 1
const dependencyFields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const fileName = path => path.split(sep).join('/')

function validateDependencies(files) {
  const packageBytes = files.get('package.json')
  const lockBytes = files.get('package-lock.json')
  if (!packageBytes && !lockBytes) return false
  const pkg = packageBytes && parseJson(packageBytes.toString(), 'package.json')
  if (!isRecord(pkg)) throw new AlloError('invalid_dependencies', 'A dependency lock requires a project package.json')
  if (pkg.workspaces) {
    throw new AlloError('invalid_dependencies', 'Snapshot dependencies must be locked in a standalone npm package')
  }
  if (!lockBytes && dependencyFields.every(field => !Object.keys(pkg[field] ?? {}).length)) return false
  if (!lockBytes) throw new AlloError('dependency_lock_required', 'Generate a package-lock.json before exporting the profile')
  const lock = parseJson(lockBytes.toString(), 'package-lock.json')
  const root = lock?.packages?.['']
  if (lock?.lockfileVersion !== 3 || !isRecord(lock.packages) || !isRecord(root)) {
    throw new AlloError('invalid_dependencies', 'Snapshots require npm lockfile version 3')
  }
  for (const field of dependencyFields) {
    const declared = pkg[field] ?? {}
    const locked = root[field] ?? {}
    if (!isRecord(declared) || !isRecord(locked) || Object.keys(declared).length !== Object.keys(locked).length ||
        Object.entries(declared).some(([name, version]) => !Object.hasOwn(locked, name) || locked[name] !== version)) {
      throw new AlloError('dependency_lock_mismatch', 'Refresh package-lock.json to match package.json', { field })
    }
  }
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (!name) continue
    const url = typeof entry?.resolved === 'string' ? URL.parse(entry.resolved) : null
    if (!name.startsWith('node_modules/') || name.split('/').some(part => !part || part === '..' || part === '.') ||
        entry?.link || !url ||
        url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
        typeof entry.version !== 'string' || typeof entry.integrity !== 'string' ||
        !/^sha(?:1|256|384|512)-[A-Za-z0-9+/]+=*$/.test(entry.integrity)) {
      throw new AlloError('unpinned_dependency', 'Dependencies must have a registry URL, version, and integrity hash', { dependency: name })
    }
  }
  return Object.keys(lock.packages).length > 1
}

function checkSnapshotPath(root, path) {
  const absolute = projectPath(root, path)
  const normalized = fileName(relative(root, absolute))
  if (normalized.split('/').some(part => /^\.env(?:\..*)?$|^\.npmrc$/i.test(part))) {
    throw new AlloError('invalid_snapshot_path', 'Credential configuration files cannot be included in snapshots', { path })
  }
  return normalized
}

function putFile(files, seen, name, bytes) {
  const folded = name.toLowerCase()
  if (seen.has(folded) && seen.get(folded) !== name) {
    throw new AlloError('snapshot_path_conflict', 'Snapshot paths must be unique on case-insensitive filesystems', { path: name })
  }
  seen.set(folded, name)
  files.set(name, bytes)
}

export async function exportSnapshot(profile, destination) {
  const files = new Map()
  const seen = new Map()
  const entries = profile.plugins.map(plugin => plugin.path)
  const paths = new Set([...entries, ...(profile.data.snapshotFiles ?? [])])
  const externalPackages = new Set()
  for (const name of entries) await sourcePath(profile.root, name)
  if (entries.length) {
    try {
      const result = await build({
        absWorkingDir: profile.root,
        entryPoints: entries.map(name => projectPath(profile.root, name)),
        outdir: 'allo-snapshot-trace',
        platform: 'node',
        bundle: true,
        packages: 'external',
        metafile: true,
        write: false,
        logLevel: 'silent',
      })
      for (const file of Object.keys(result.metafile.inputs)) paths.add(file)
      for (const output of Object.values(result.metafile.outputs)) {
        for (const { path, external } of output.imports) {
          if (!external || isBuiltin(path) || path.startsWith('#')) continue
          const parts = path.split('/')
          externalPackages.add(parts.slice(0, path.startsWith('@') ? 2 : 1).join('/'))
        }
      }
    } catch (error) {
      throw new AlloError('snapshot_source_error', 'Could not resolve plugin source for export', {
        errors: error.errors?.map(({ text, location }) => ({ message: text, file: location?.file })) ?? [error.message],
      })
    }
  }
  for (const name of ['package.json', 'package-lock.json', 'tsconfig.json']) {
    try {
      await stat(join(profile.root, name))
      paths.add(name)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }

  for (const path of paths) {
    const name = checkSnapshotPath(profile.root, path)
    const source = await sourcePath(profile.root, path)
    // Copy both names so a traced import and an explicitly configured symlink agree.
    const canonical = checkSnapshotPath(profile.root, relative(profile.root, source))
    const bytes = await readFile(source)
    putFile(files, seen, name, bytes)
    putFile(files, seen, canonical, bytes)
  }
  const profileBytes = Buffer.from(JSON.stringify(profile.data, null, 2) + '\n')
  putFile(files, seen, profileName, profileBytes)
  validateDependencies(files)
  const packageFile = files.get('package.json')
  const pkg = packageFile ? parseJson(packageFile.toString(), 'package.json') : {}
  const undeclared = [...externalPackages].filter(name =>
    !dependencyFields.some(field => Object.hasOwn(pkg[field] ?? {}, name)) &&
    !(pkg.name === name && pkg.exports))
  if (undeclared.length) {
    throw new AlloError('undeclared_dependencies', 'Declare plugin dependencies in the project package.json before exporting', { packages: undeclared })
  }
  const snapshot = {
    format,
    alloVersion: manifest.version,
    files: [...files].sort(([left], [right]) => left.localeCompare(right)).map(([path, bytes]) => ({
      path,
      sha256: hash(bytes),
      content: bytes.toString('base64'),
    })),
  }
  const path = resolve(destination)
  await writeFile(path, JSON.stringify(snapshot, null, 2) + '\n', { flag: 'wx' })
  return { snapshot: path, files: files.size, alloVersion: manifest.version }
}

function installDependencies(cwd) {
  return new Promise((resolve, reject) => {
    const windows = process.platform === 'win32'
    const args = ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--no-bin-links',
      '--include=dev', '--include=optional', '--include=peer', '--fetch-retries=0']
    const child = windows
      ? spawn('npm.cmd ' + args.join(' '), { cwd, shell: true, windowsHide: true })
      : spawn('npm', args, { cwd })
    let diagnostics = ''
    child.stdout.resume()
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-12000) })
    child.on('error', error => reject(new AlloError('dependency_restore_failed', 'Could not start npm ci', { message: error.message })))
    child.on('close', code => {
      if (code === 0) resolve()
      else reject(new AlloError('dependency_restore_failed', 'npm could not recover the locked dependencies', { exitCode: code, diagnostics: diagnostics.trim() }))
    })
  })
}

export async function restoreSnapshot(input, destination, localConnections) {
  const snapshot = await readJson(resolve(input))
  if (!isRecord(snapshot) || snapshot.format !== format || !Array.isArray(snapshot.files)) {
    throw new AlloError('invalid_snapshot', 'Unsupported snapshot format')
  }
  if (snapshot.alloVersion !== manifest.version) {
    throw new AlloError('incompatible_snapshot', 'Restore this snapshot with its recorded Allo version', {
      required: snapshot.alloVersion, running: manifest.version,
    })
  }

  const label = basename(input).replace(/(?:\.allo-snapshot)?\.json$/i, '')
  const root = resolve(destination ?? `${label}-restored`)
  const files = new Map()
  const seen = new Map()
  for (const file of snapshot.files) {
    if (!isRecord(file) || typeof file.content !== 'string') throw new AlloError('invalid_snapshot', 'Invalid file record')
    const name = checkSnapshotPath(root, file.path)
    const bytes = Buffer.from(file.content, 'base64')
    if (name !== file.path || files.has(name) || file.content !== bytes.toString('base64') || hash(bytes) !== file.sha256) {
      throw new AlloError('invalid_snapshot_file', 'Invalid or corrupted snapshot file', { path: file.path })
    }
    putFile(files, seen, name, bytes)
  }
  const profilePath = join(root, profileName)
  const profileBytes = files.get(profileName)
  if (!profileBytes) throw new AlloError('invalid_snapshot', 'Snapshot does not contain allo.json')
  const profile = validateProfile(parseJson(profileBytes.toString(), profileName), profilePath)
  for (const path of [...profile.plugins.map(plugin => plugin.path), ...(profile.data.snapshotFiles ?? [])]) {
    if (!files.has(checkSnapshotPath(root, path))) {
      throw new AlloError('invalid_snapshot', 'Snapshot is missing a configured source file', { path })
    }
  }
  const hasDependencies = validateDependencies(files)
  const conflicts = connectionConflicts(profile, localConnections)

  await mkdir(root)
  try {
    for (const [name, bytes] of files) {
      if (name === profileName) continue
      const path = projectPath(root, name)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, bytes, { flag: 'wx' })
    }
    if (hasDependencies) await installDependencies(root)
    await writeFile(profilePath, profileBytes, { flag: 'wx' })
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(cleanupError => {
      console.error(`Could not remove the incomplete restore at ${root}: ${cleanupError.message}`)
    })
    throw error
  }
  return { profile: profilePath, conflicts }
}
