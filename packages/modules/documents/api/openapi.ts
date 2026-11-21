import * as z from 'zod'
import { specs } from '../routes'

export const paths: Record<string, Record<string, unknown>> = {}
for (const route of specs) {
  const path = '/api/v1/modules/documents' + route.path
  paths[path] = { ...paths[path], [route.method.toLowerCase()]: {
    summary: route.summary, tags: ['Documents'],
    ...(route.query ? { parameters: route.query.map(q => ({ name: q.name, in: 'query', required: q.name === 'id', schema: { type: 'string', ...(q.format ? { format: q.format } : {}) } })) } : {}),
    ...(route.method === 'POST' ? { requestBody: { required: true, content: { 'application/json': { schema: route.body ?? z.looseObject({}) } } } } : {}),
    responses: {
      '200': route.binary ? { description: 'The file', content: { [route.path === '/receipt.pdf' ? 'application/pdf' : 'application/octet-stream']: { schema: { type: 'string', format: 'binary' } } } } : { description: 'OK' },
      '400': { description: 'Invalid fields' }, '403': { description: 'Not permitted' }, '404': { description: 'Document unavailable' }, '409': { description: 'Request closed, expired, or integrity check failed' },
    },
  } }
}
