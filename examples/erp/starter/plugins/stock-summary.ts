import type { Allo } from 'allo'
import type { Context } from 'cordis'
import type { Inventory } from './erp.ts'

export default {
  name: 'summary',
  inject: ['allo', 'erp.inventory'],
  apply(ctx: Context) {
    const allo: Allo = ctx.get('allo')
    const inventory: Inventory = ctx.get('erp.inventory')
    allo.operation(ctx, {
      name: 'summary.total-stock',
      description: 'Sum the current stock for one SKU across all warehouses.',
      connections: [inventory.connection],
      inputSchema: {
        type: 'object',
        properties: { sku: { type: 'string', minLength: 1 } },
        required: ['sku'],
        additionalProperties: false,
      },
      resultSchema: {
        type: 'object',
        properties: { quantity: { type: 'integer', minimum: 0 } },
        required: ['quantity'],
        additionalProperties: false,
      },
    }, async ({ sku }: { sku: string }) => {
      const locations = await inventory.lookup(sku)
      return { quantity: locations.reduce((sum, location) => sum + location.quantity, 0) }
    })
  },
}
