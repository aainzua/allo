import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

export function createFixture(stockFile, token) {
  return createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json')
    const url = new URL(request.url, 'http://localhost')
    if (request.method !== 'GET' || url.pathname !== '/stock') {
      response.writeHead(404).end(JSON.stringify({ error: 'route_not_found' }))
      return
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end(JSON.stringify({ error: 'unauthorized' }))
      return
    }
    try {
      const stock = JSON.parse(await readFile(stockFile, 'utf8'))
      const sku = url.searchParams.get('sku')
      if (!Object.hasOwn(stock, sku)) {
        response.writeHead(404).end(JSON.stringify({ error: 'sku_not_found' }))
        return
      }
      response.end(JSON.stringify(stock[sku]))
    } catch {
      response.writeHead(500).end(JSON.stringify({ error: 'fixture_unavailable' }))
    }
  })
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const stockFile = process.argv[2] ?? new URL('./stock.json', import.meta.url)
  const token = process.env.ALLO_FIXTURE_TOKEN ?? 'demo-token'
  createFixture(stockFile, token).listen(7341, '127.0.0.1', () => {
    console.log('Fixture ERP listening on http://127.0.0.1:7341/')
  })
}
