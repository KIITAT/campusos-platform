import * as z from 'zod'
import { specs } from '../routes'

const idQuery = [{ name: 'id', in: 'query', required: true, schema: { type: 'string', format: 'uuid' } }]

export const paths: Record<string, Record<string, unknown>> = {}
for (const route of specs) {
  const path = '/api/v1/modules/reports' + route.path
  const query = route.method === 'GET' && ['/reports/detail', '/runs/csv', '/reports/parquet'].includes(route.path) ? idQuery : []
  paths[path] = {
    ...paths[path],
    [route.method.toLowerCase()]: {
      summary: route.summary,
      tags: ['Reports'],
      ...(query.length ? { parameters: query } : {}),
      ...(route.method === 'POST' ? { requestBody: { required: true, content: { 'application/json': { schema: route.body ?? z.looseObject({}) } } } } : {}),
      responses: {
        '200': { description: 'OK' },
        '400': { description: 'Invalid fields or a report that does not compile' },
        '403': { description: 'Not permitted' },
        '404': { description: 'Not found in this institution' },
        '409': { description: 'Archived, unavailable, stale, too slow or too large' },
      },
    },
  }
}
