import type { Allo } from 'allo'
import type { Context } from 'cordis'

export interface Inventory {
  readonly connection: string
  lookup(sku: string): Promise<Array<{ warehouse: string; quantity: number }>>
}

export default {
  name: 'erp',
  inject: ['allo'],
  apply(ctx: Context, config: { connection: string }) {
    const allo: Allo = ctx.get('allo')
    const connection = config.connection
    const inventory: Inventory = {
      connection,
      async lookup(sku) {
        const { destination, credential } = allo.connection(connection)
        const url = new URL('stock', destination)
        url.searchParams.set('sku', sku)
        let response
        try {
          response = await fetch(url, {
            headers: { Authorization: `Bearer ${credential}` },
            signal: AbortSignal.timeout(5000),
            redirect: 'error',
          })
        } catch {
          throw allo.error('erp_unreachable', 'Could not read inventory from the ERP', { connection })
        }
        if (response.status === 404) throw allo.error('sku_not_found', `Unknown ERP SKU ${sku}`, { sku })
        if (!response.ok) throw allo.error('erp_rejected', 'The ERP rejected the inventory lookup', { status: response.status })
        return await response.json()
      },
    }
    allo.service(ctx, {
      name: 'erp.inventory',
      description: 'Read current stock by SKU. Returns one warehouse and quantity pair per location.',
      usage: "Declare inject: ['allo', 'erp.inventory']. In apply(ctx), read const inventory: Inventory = ctx.get('erp.inventory') and await inventory.lookup(sku). The Inventory type is exported from plugins/erp.ts. See plugins/stock-summary.ts for an operation that uses this service.",
    }, inventory)
  },
}
