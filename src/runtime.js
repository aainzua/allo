import { pathToFileURL } from 'node:url'
import Ajv from 'ajv'
import { Context, FiberState, Logger } from 'cordis'
import { tsImport } from 'tsx/esm/api'
import { AlloError, pluginSource } from './profile.js'
import { bundledPlugins } from './bundled.js'
import { credentialStore } from './credentials.js'

const qualifiedName = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/

function checkDescription(name, description) {
  if (!qualifiedName.test(name) || typeof description !== 'string' || !description.trim()) {
    throw new TypeError('Registrations require a qualified name and a description')
  }
}

function register(ctx, registry, name, entry) {
  ctx.effect(() => {
    const entries = registry.get(name) ?? new Set()
    registry.set(name, entries)
    entries.add(entry)
    return () => {
      entries.delete(entry)
      if (!entries.size) registry.delete(name)
    }
  })
}

export async function boot(profile, resolveConnection, logins = credentialStore) {
  const root = new Context()
  const operations = new Map()
  const services = new Map()
  const accounts = new Map()
  const sources = new Map()
  const issues = []
  const ajv = new Ajv({ allErrors: true, addUsedSchema: false })

  function pluginPath(ctx) {
    for (let fiber = ctx.fiber; fiber !== root.fiber; fiber = fiber.parent.fiber) {
      if (sources.has(fiber)) return sources.get(fiber)
    }
    throw new Error('Registrations require a profile plugin context')
  }

  root.logger.exporter({
    colors: false,
    export: message => console.error(Logger.format({ colors: false }, message)),
  })
  root.provide('allo', {
    operation(ctx, spec, handler) {
      checkDescription(spec.name, spec.description)
      const plugin = pluginPath(ctx)
      const { name, description, inputSchema, resultSchema, connections = [], requireCredential = true } = structuredClone(spec)
      if (!Array.isArray(connections) || connections.some(name => typeof name !== 'string') ||
          typeof handler !== 'function') {
        throw new TypeError('An operation requires a handler and a list of connection names')
      }
      register(ctx, operations, name, {
        ctx, plugin, name, description, inputSchema, resultSchema, connections, requireCredential, handler,
        validateInput: ajv.compile(inputSchema),
        validateResult: ajv.compile(resultSchema),
      })
    },
    service(ctx, spec, value) {
      checkDescription(spec.name, spec.description)
      const plugin = pluginPath(ctx)
      if (typeof spec.usage !== 'string' || !spec.usage.trim() || value === undefined) {
        throw new TypeError('A discoverable service requires a TypeScript usage example and a value')
      }
      ctx.provide(spec.name, value)
      register(ctx, services, spec.name, {
        ctx, plugin, name: spec.name, description: spec.description, usage: spec.usage,
      })
    },
    connection: resolveConnection,
    logins,
    account(ctx, name, provider) {
      register(ctx, accounts, name, { ctx, plugin: pluginPath(ctx), provider })
    },
    error: (code, message, details) => new AlloError(code, message, details),
  })

  try {
    // Import before mounting so the catalog reflects a single composed Cordis context.
    const loaded = []
    for (const entry of profile.plugins) {
      const label = entry.plugin ?? (entry.install ? `${entry.install.catalog}/${entry.install.name}` : entry.path)
      try {
        const url = pathToFileURL(entry.plugin ? bundledPlugins[entry.plugin] : await pluginSource(profile.root, entry)).href
        const module = await tsImport(url, import.meta.url)
        // tsx transforms TypeScript in CommonJS packages into a default-export wrapper.
        const exported = module.default
        const component = exported?.__esModule === true && Object.hasOwn(exported, 'default')
          ? exported.default
          : exported
        loaded.push({ entry, component, label })
      } catch (error) {
        issues.push({ plugin: label, code: 'plugin_load_failed', message: String(error.message ?? error) })
      }
    }
    for (const { entry, component, label } of loaded) {
      try {
        const fiber = root.use(component, entry.config ?? {})
        sources.set(fiber.ctx.fiber, label)
      } catch (error) {
        issues.push({ plugin: label, code: 'plugin_load_failed', message: String(error.message ?? error) })
      }
    }

    // A provider becoming active can start consumers that were previously pending.
    const fibers = () => [...root.registry.values()].flatMap(runtime => [...runtime.fibers])
    while (true) {
      const loading = fibers().filter(fiber => fiber.inertia)
      if (!loading.length) break
      await Promise.allSettled(loading.map(fiber => fiber.await()))
    }
    for (const fiber of fibers()) {
      if (fiber.state === FiberState.PENDING) {
        const missing = Object.keys(fiber.inject).filter(name => fiber.ctx.get(name) === undefined)
        issues.push({ plugin: pluginPath(fiber.ctx), code: 'missing_services', services: missing })
      } else if (fiber.state === FiberState.FAILED) {
        await fiber.await().catch(error => {
          issues.push({ plugin: pluginPath(fiber.ctx), code: 'plugin_activation_failed', message: String(error.message ?? error) })
        })
      }
    }
  } catch (error) {
    await root.fiber.dispose()
    throw error
  }

  function entriesFor(registry, name) {
    return [...registry.get(name) ?? []]
  }

  function availability(entries) {
    const plugins = entries.map(entry => entry.plugin)
    if (entries.length > 1) return { available: false, issue: { code: 'registration_conflict', plugins } }
    if (entries[0].ctx.fiber.state !== FiberState.ACTIVE) {
      return { available: false, issue: { code: 'plugin_unavailable', plugins } }
    }
    return { available: true }
  }

  function metadata(kind, name, detailed = false) {
    const entries = entriesFor(kind === 'operation' ? operations : services, name)
    if (!entries.length) throw new AlloError(`${kind}_not_found`, `Unknown ${kind} ${name}`, { name })
    const state = availability(entries)
    if (entries.length > 1) return { name, ...state }
    const { description, plugin, connections, inputSchema, resultSchema, usage, requireCredential } = entries[0]
    const info = { name, description, plugin, ...state }
    if (kind === 'operation') {
      if (state.available) {
        try {
          for (const connection of connections) resolveConnection(connection, { requireCredential })
        } catch (error) {
          info.available = false
          info.issue = { code: error.code, ...error.details }
        }
      }
      if (detailed) Object.assign(info, { inputSchema, resultSchema, connections })
    } else if (detailed) {
      Object.assign(info, { inject: [name], usage })
    }
    return info
  }

  return {
    discover() {
      return {
        profile: profile.path,
        operations: [...operations.keys()].sort().map(name => metadata('operation', name)),
        services: [...services.keys()].sort().map(name => metadata('service', name)),
        issues,
      }
    },
    describe: (kind, name) => metadata(kind, name, true),
    account(name) {
      const entries = entriesFor(accounts, name).filter(entry => entry.ctx.fiber.state === FiberState.ACTIVE)
      if (!entries.length) throw new AlloError('login_connection_not_found', 'No active login provider uses this connection', { connection: name })
      if (entries.length > 1) throw new AlloError('registration_conflict', 'Multiple login providers use this connection', { connection: name })
      return entries[0].provider
    },
    async call(name, input) {
      const entries = entriesFor(operations, name)
      if (!entries.length) throw new AlloError('operation_not_found', `Unknown operation ${name}`, { name })
      const state = availability(entries)
      if (!state.available) throw new AlloError(state.issue.code, `Operation ${name} is unavailable`, state.issue)
      const entry = entries[0]
      if (!entry.validateInput(input)) {
        throw new AlloError('invalid_input', `Input does not match the schema for ${name}`, entry.validateInput.errors)
      }
      for (const connection of entry.connections) resolveConnection(connection, { requireCredential: entry.requireCredential })
      const value = await entry.handler(input)
      let result
      try {
        result = JSON.parse(JSON.stringify(value))
      } catch {
        throw new AlloError('invalid_result', `Operation ${name} did not return a JSON value`)
      }
      if (!entry.validateResult(result)) {
        throw new AlloError('invalid_result', `Result does not match the schema for ${name}`, entry.validateResult.errors)
      }
      return result
    },
    close: () => root.fiber.dispose(),
  }
}
