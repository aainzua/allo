import type { Allo } from 'allo'
import type { Context } from 'cordis'

export default {
  name: 'jira-summary',
  inject: ['allo', 'jira.issues'],
  apply(ctx: Context) {
    const allo: Allo = ctx.get('allo')
    const jira = ctx.get('jira.issues')
    allo.operation(ctx, {
      name: 'jira-summary.get',
      description: 'Read the summary of one Jira issue.',
      inputSchema: {
        type: 'object', properties: { key: { type: 'string' } },
        required: ['key'], additionalProperties: false,
      },
      resultSchema: {
        type: 'object', properties: { summary: { type: 'string' } },
        required: ['summary'], additionalProperties: false,
      },
    }, async ({ key }: { key: string }) => {
      const issue = await jira.getIssue(key, ['summary'])
      return { summary: issue.fields.summary }
    })
  },
}
