import type { Allo } from 'allo'
import type { Context } from 'cordis'

const defaultFields = ['summary', 'status', 'assignee', 'issuetype', 'priority', 'updated']
const text = { type: 'string', pattern: '\\S' }
const issueKey = { type: 'string', pattern: '^(?:[A-Za-z][A-Za-z0-9_]*-\\d+|\\d+)$' }
const id = { type: 'string', pattern: '^\\d+$' }
const projectKey = { type: 'string', pattern: '^(?:[A-Za-z][A-Za-z0-9_]*|\\d+)$' }
const nullableText = { anyOf: [text, { type: 'null' }] }
const document = {
  type: 'object',
  properties: { type: { const: 'doc' }, version: { const: 1 }, content: { type: 'array' } },
  required: ['type', 'version', 'content'],
}
const richText = { anyOf: [text, document] }
const fieldMap = { type: 'object' }
const fieldNames = {
  type: 'array', minItems: 1, uniqueItems: true,
  items: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_]*$' },
}
const object = (properties: Record<string, object>, required: string[] = [], extra = false) =>
  ({ type: 'object', properties, required, additionalProperties: extra })
const page = {
  startAt: { type: 'integer', minimum: 0 },
  maxResults: { type: 'integer', minimum: 1, maximum: 100 },
}
const pageResult = (key: string, items: object) => object({
  startAt: { type: 'integer' },
  maxResults: { type: 'integer' },
  total: { type: 'integer' },
  [key]: { type: 'array', items },
}, [key], true)
const namedId = object({ id, name: text }, ['id', 'name'], true)
const fieldInfo = object({
  fieldId: text, key: text, name: text, required: { type: 'boolean' },
  hasDefaultValue: { type: 'boolean' }, allowedValues: { type: 'array' }, schema: fieldMap,
}, ['name', 'required'], true)
const fieldsInfo = { type: 'object', additionalProperties: fieldInfo }
const searchFields = { jql: text, fields: fieldNames, nextPageToken: text }
const issueResult = object({ id, key: issueKey, fields: fieldMap }, ['id', 'key', 'fields'], true)
const searchResult = object({
  issues: { type: 'array', items: issueResult },
  nextPageToken: text,
  isLast: { type: 'boolean' },
}, ['issues'], true)
const changeFields = {
  summary: text,
  description: { anyOf: [text, document, { type: 'null' }] },
  assigneeAccountId: nullableText,
  priorityId: { anyOf: [id, { type: 'null' }] },
  labels: { type: 'array', items: text, uniqueItems: true },
  parent: { anyOf: [issueKey, { type: 'null' }] },
  fields: fieldMap,
}

type Credentials = { email: string; token: string }
type Search = { jql: string; fields?: string[]; maxResults?: number; nextPageToken?: string }
type SearchPage = { issues: unknown[]; isLast?: boolean; nextPageToken?: string }
type IssueFields = {
  summary?: string; description?: string | object | null; assigneeAccountId?: string | null;
  priorityId?: string | null; labels?: string[]; parent?: string | null; fields?: Record<string, unknown>
}
type Request = {
  method?: 'GET' | 'POST' | 'PUT'; query?: Record<string, string | number | undefined>;
  body?: object; credentials?: Credentials; noContent?: boolean
}
type Page = { startAt?: number; maxResults?: number }

function adf(value: string | object | null) {
  if (typeof value !== 'string') return value
  return {
    version: 1, type: 'doc',
    content: value.split(/\r\n|\r|\n/).map(line => ({
      type: 'paragraph',
      ...(line ? { content: [{ type: 'text', text: line }] } : {}),
    })),
  }
}

const projectRef = (value: string) => /^\d+$/.test(value) ? { id: value } : { key: value }
const issuePath = (key: string) => `issue/${encodeURIComponent(key)}`
function writeFields(input: IssueFields) {
  const fields = { ...input.fields }
  if (input.summary !== undefined) fields.summary = input.summary
  if (input.description !== undefined) fields.description = adf(input.description)
  if (input.assigneeAccountId !== undefined) fields.assignee = input.assigneeAccountId === null ? null : { accountId: input.assigneeAccountId }
  if (input.priorityId !== undefined) fields.priority = input.priorityId === null ? null : { id: input.priorityId }
  if (input.labels !== undefined) fields.labels = input.labels
  if (input.parent !== undefined) fields.parent = input.parent === null ? null : projectRef(input.parent)
  return fields
}

export default {
  name: 'jira',
  inject: ['allo'],
  apply(ctx: Context, config: { connection?: string }) {
    const allo: Allo = ctx.get('allo')
    const connection = config.connection ?? 'jira'

    function binding() {
      const selected = allo.connection(connection, { requireCredential: false })
      const base = new URL(selected.destination)
      const site = base.hostname.endsWith('.atlassian.net') && base.pathname === '/'
      const gateway = base.hostname === 'api.atlassian.com' && /^\/ex\/jira\/[a-z0-9-]+\/?$/i.test(base.pathname)
      if (base.protocol !== 'https:' || base.port || (!site && !gateway)) {
        throw allo.error('jira_invalid_destination', 'Use an HTTPS Atlassian Cloud site or Jira Cloud API gateway URL', { connection })
      }
      if (!base.pathname.endsWith('/')) base.pathname += '/'
      return { base, name: selected.name ?? connection, tokenEnv: selected.credentialEnv ?? 'ALLO_JIRA_TOKEN' }
    }

    async function credentials(selected: ReturnType<typeof binding>) {
      const email = process.env.ALLO_JIRA_EMAIL?.trim()
      const token = process.env[selected.tokenEnv]?.trim()
      if (email && token) return { email, token, source: 'environment' }
      if (email || token) {
        throw allo.error('jira_incomplete_credentials', 'Set both the Atlassian email and API token for an environment override', {
          emailEnv: 'ALLO_JIRA_EMAIL', tokenEnv: selected.tokenEnv,
        })
      }
      const saved = await allo.logins.read(selected.name, selected.base.href)
      if (!saved) throw allo.error('credentials_missing', `Run allo login ${connection} or supply the Jira environment credentials`, { connection })
      return { ...saved, source: 'windows' }
    }

    async function request<Result>(path: string, options: Request = {}): Promise<Result> {
      const selected = binding()
      const auth = options.credentials ?? await credentials(selected)
      const url = new URL(`rest/api/3/${path}`, selected.base)
      for (const [key, value] of Object.entries(options.query ?? {})) {
        if (value !== undefined) url.searchParams.set(key, String(value))
      }
      const method = options.method ?? 'GET'
      const write = method !== 'GET' && path !== 'search/jql'
      const unknown = () => allo.error('outcome_unknown', 'Jira may have applied the write. Check Jira before retrying.', { connection, method, resource: path })
      let response
      try {
        response = await fetch(url, {
          method,
          headers: {
            Accept: 'application/json',
            Authorization: `Basic ${Buffer.from(`${auth.email}:${auth.token}`, 'utf8').toString('base64')}`,
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: options.body ? JSON.stringify(options.body) : undefined,
          redirect: 'error',
          signal: AbortSignal.timeout(15000),
        })
      } catch {
        if (write) throw unknown()
        throw allo.error('jira_unreachable', 'Jira did not return an HTTP response', { connection })
      }
      if (!response.ok) {
        if (write && (response.status >= 500 || response.status === 408)) {
          await response.body?.cancel().catch(() => {})
          throw unknown()
        }
        const errors: Record<number, [string, string]> = {
          400: ['jira_bad_request', 'Jira rejected the request'],
          401: ['jira_unauthenticated', 'Jira rejected the Atlassian email or API token'],
          403: ['jira_forbidden', 'The Jira account or token lacks permission for this request'],
          404: ['jira_not_found', 'Jira could not find or disclose the requested resource'],
          429: ['jira_rate_limited', 'Jira rate-limited the request'],
        }
        const [code, message] = errors[response.status] ?? ['jira_request_failed', 'The Jira request failed']
        const retryAfter = response.headers.get('Retry-After')
        const details = response.status === 400
          ? await response.json().catch(() => undefined)
          : undefined
        if (response.status !== 400) await response.body?.cancel().catch(() => {})
        throw allo.error(code, message, {
          status: response.status, ...(retryAfter ? { retryAfter } : {}),
          ...(details ? { errors: details.errors, errorMessages: details.errorMessages } : {}),
        })
      }
      if (options.noContent) {
        await response.body?.cancel().catch(() => {})
        return { ok: true } as Result
      }
      try {
        return await response.json() as Result
      } catch {
        if (write) throw unknown()
        throw allo.error('jira_invalid_response', 'Jira returned invalid or incomplete JSON', { connection })
      }
    }

    async function identity(auth: Credentials) {
      const user = await request<{ accountId?: string; displayName?: string; emailAddress?: string }>('myself', { credentials: auth })
      if (!user?.accountId || (user.emailAddress && user.emailAddress.toLowerCase() !== auth.email.toLowerCase())) {
        throw allo.error('jira_identity_mismatch', 'Jira did not verify the requested account', { connection })
      }
      return { accountId: user.accountId, displayName: user.displayName, email: auth.email }
    }

    const jira = {
      connection,
      account: {
        async login(email: string, token: string) {
          if (!/^[^\s:@]+@[^\s:@]+$/.test(email) || Buffer.byteLength(token, 'utf8') > 2560) {
            throw allo.error('jira_invalid_credentials', 'Provide a valid Atlassian email and API token')
          }
          const selected = binding()
          const user = await identity({ email, token })
          await allo.logins.write(selected.name, selected.base.href, email, token)
          return { connection, destination: selected.base.href, source: 'windows', ...user }
        },
        async status() {
          const selected = binding()
          const auth = await credentials(selected)
          return { connection, destination: selected.base.href, source: auth.source, ...await identity(auth) }
        },
        async logout() {
          const selected = binding()
          return { connection, removed: await allo.logins.delete(selected.name, selected.base.href) }
        },
      },
      getIssue(key: string, fields = [...defaultFields, 'description']) {
        return request(issuePath(key), { query: { fields: fields.join(',') } })
      },
      async search({ jql, fields = defaultFields, maxResults = 20, nextPageToken }: Search, auth?: Credentials) {
        const result = await request<SearchPage>('search/jql', {
          method: 'POST', body: { jql, fields, maxResults, nextPageToken }, credentials: auth,
        })
        if (!Array.isArray(result?.issues) || (result.nextPageToken !== undefined && typeof result.nextPageToken !== 'string')) {
          throw allo.error('jira_invalid_response', 'Jira returned an invalid search page')
        }
        return result
      },
    }
    allo.account(ctx, connection, jira.account)
    allo.service(ctx, {
      name: 'jira.issues',
      description: 'Read Jira Cloud issues and search using JQL.',
      usage: "Declare inject: ['jira.issues']. In apply(ctx), use const jira = ctx.get('jira.issues') and await jira.getIssue('PROJ-123').",
    }, jira)

    function operation<Input, Result>(name: string, description: string, inputSchema: object, resultSchema: object,
      handler: (input: Input) => Result | Promise<Result>) {
      allo.operation(ctx, { name: `jira.${name}`, description, connections: [connection], requireCredential: false, inputSchema, resultSchema }, handler)
    }

    operation('get-issue', 'Read one Jira issue by key or ID.', object({ key: issueKey, fields: fieldNames }, ['key']),
      issueResult, ({ key, fields }: { key: string; fields?: string[] }) => jira.getIssue(key, fields))
    operation('search-issues', 'Read one page of Jira issues matching JQL.',
      object({ ...searchFields, maxResults: page.maxResults }, ['jql']), searchResult, jira.search)
    operation('search-all', 'Read up to 1,000 issues matching JQL and report whether Jira reached the final page.',
      object({ ...searchFields, limit: { type: 'integer', minimum: 1, maximum: 1000 } }, ['jql']),
      object({
        issues: searchResult.properties.issues, count: { type: 'integer' }, complete: { type: 'boolean' },
        nextPageToken: text, reason: text, error: fieldMap,
      }, ['issues', 'count', 'complete']),
      async ({ limit = 1000, nextPageToken, ...input }: Search & { limit?: number }) => {
        const auth = await credentials(binding())
        const issues: unknown[] = []
        const tokens = new Set<string>()
        let pages = 0
        const partial = (reason: string, error?: object) =>
          ({ issues, count: issues.length, complete: false, nextPageToken, reason, error })
        while (pages < 100) {
          if (nextPageToken) tokens.add(nextPageToken)
          let response
          try {
            const maxResults = Math.min(100, limit - issues.length)
            response = await jira.search({ ...input, maxResults, nextPageToken }, auth)
            if (response.issues.length > maxResults) throw allo.error('jira_invalid_response', 'Jira exceeded the requested page size')
          } catch (error) {
            if (!pages) throw error
            const cause = error instanceof Error ? error : new Error(String(error))
            const code = 'code' in cause ? cause.code : 'jira_request_failed'
            return partial('request_failed', { code, message: cause.message })
          }
          pages++
          issues.push(...response.issues)
          nextPageToken = response.nextPageToken || undefined
          if (response.isLast === true || (!nextPageToken && response.isLast !== false)) {
            return { issues, count: issues.length, complete: true }
          }
          if (!nextPageToken) return partial('missing_page_token')
          if (tokens.has(nextPageToken)) return partial('repeated_page_token')
          if (issues.length === limit) return partial('issue_limit')
        }
        return partial('page_limit')
      })

    const project = { project: projectKey }
    const key = { key: issueKey }
    const confirmed = object({ ok: { const: true } }, ['ok'])
    operation('list-issue-types', 'List Jira issue types available to create in a project.',
      object({ ...project, ...page }, ['project']), pageResult('issueTypes', namedId),
      ({ project, ...query }: Page & { project: string }) => request(`issue/createmeta/${encodeURIComponent(project)}/issuetypes`, { query }))
    operation('create-fields', 'Inspect required fields and allowed values for a project and issue type.',
      object({ ...project, issueTypeId: id, ...page }, ['project', 'issueTypeId']), pageResult('fields', fieldInfo),
      ({ project, issueTypeId, ...query }: Page & { project: string; issueTypeId: string }) =>
        request(`issue/createmeta/${encodeURIComponent(project)}/issuetypes/${encodeURIComponent(issueTypeId)}`, { query }))
    operation('edit-fields', 'Inspect editable fields and allowed values on an issue.', object(key, ['key']),
      object({ fields: fieldsInfo }, ['fields'], true),
      ({ key }: { key: string }) => request(`${issuePath(key)}/editmeta`))
    operation('create-issue', 'Create one Jira issue, optionally passing custom values by field ID.',
      object({ ...project, issueTypeId: id, ...changeFields }, ['project', 'issueTypeId', 'summary']),
      object({ id, key: issueKey }, ['id', 'key'], true),
      async ({ project, issueTypeId, ...input }: IssueFields & { project: string; issueTypeId: string }) => {
        const fields = { ...writeFields(input), project: projectRef(project), issuetype: { id: issueTypeId } }
        const result = await request<{ id?: string; key?: string }>('issue', { method: 'POST', body: { fields } })
        if (!result?.id || !result.key) throw allo.error('outcome_unknown', 'Jira returned no issue identifier. Check Jira before creating another issue.', { connection })
        return result
      })
    operation('update-issue', 'Update only the supplied fields on an issue.',
      object({ ...key, ...changeFields }, ['key']), confirmed,
      ({ key, ...input }: IssueFields & { key: string }) => {
        const fields = writeFields(input)
        const clearParent = fields.parent === null
        if (clearParent) delete fields.parent
        if (!Object.keys(fields).length && !clearParent) throw allo.error('invalid_input', 'Supply a field to update')
        const update = clearParent ? { parent: [{ set: { none: true } }] } : undefined
        return request(issuePath(key), { method: 'PUT', body: { fields, update }, noContent: true })
      })
    operation('assign-issue', 'Assign an issue by Atlassian account ID or pass null to unassign it.',
      object({ ...key, accountId: nullableText }, ['key', 'accountId']), confirmed,
      ({ key, accountId }: { key: string; accountId: string | null }) =>
        request(`${issuePath(key)}/assignee`, { method: 'PUT', body: { accountId }, noContent: true }))
    operation('find-assignees', 'Find users who can be assigned to an issue.',
      object({ ...key, query: text, ...page }, ['key', 'query']), { type: 'array', items: fieldMap },
      ({ key, ...query }: Page & { key: string; query: string }) =>
        request('user/assignable/search', { query: { issueKey: key, ...query } }))
    operation('list-comments', 'Read one page of issue comments.',
      object({ ...key, ...page }, ['key']), pageResult('comments', object({ id, body: document }, ['id'], true)),
      ({ key, ...query }: Page & { key: string }) => request(`${issuePath(key)}/comment`, { query }))
    operation('add-comment', 'Add a plain-text or Atlassian Document Format comment to an issue.',
      object({ ...key, body: richText }, ['key', 'body']), object({ id }, ['id'], true),
      async ({ key, body }: { key: string; body: string | object }) => {
        const result = await request<{ id?: string }>(`${issuePath(key)}/comment`, { method: 'POST', body: { body: adf(body) } })
        if (!result?.id) throw allo.error('outcome_unknown', 'Jira returned no comment identifier. Check Jira before adding another comment.', { connection, key })
        return result
      })
    operation('list-transitions', 'List available transition IDs, target statuses, and transition screen fields.',
      object(key, ['key']), object({
        transitions: {
          type: 'array',
          items: object({ id, name: text, to: namedId, fields: fieldsInfo }, ['id', 'name', 'to'], true),
        },
      }, ['transitions'], true),
      ({ key }: { key: string }) => request(`${issuePath(key)}/transitions`, { query: { expand: 'transitions.fields' } }))
    operation('transition-issue', 'Apply an available transition ID and supply any required transition fields or update verbs, such as a worklog entry required by the transition screen.',
      object({ ...key, transitionId: id, fields: fieldMap, update: fieldMap }, ['key', 'transitionId']), confirmed,
      ({ key, transitionId, fields, update }: { key: string; transitionId: string; fields?: object; update?: object }) =>
        request(`${issuePath(key)}/transitions`, { method: 'POST', body: { transition: { id: transitionId }, fields, update }, noContent: true }))
  },
}
