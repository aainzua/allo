import { fileURLToPath } from 'node:url'

export const bundledPlugins = Object.freeze({
  jira: fileURLToPath(new URL('./plugins/jira.ts', import.meta.url)),
})
