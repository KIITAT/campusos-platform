import * as z from 'zod'
import { specs } from '../routes'

const query = (...names: string[]) => names.map(name => ({ name, in: 'query', required: false, schema: { type: 'string' } }))
export const paths: Record<string, Record<string, unknown>> = {}
for (const route of specs) {
  const path = '/api/v1/modules/crm' + route.path
  paths[path] = { ...paths[path], [route.method.toLowerCase()]: {
    summary: route.summary, tags: ['Sales CRM'],
    ...(route.path === '/leads/detail' ? { parameters: [{ name: 'id', in: 'query', required: true, schema: { type: 'string', format: 'uuid' } }] } : {}),
    ...(route.path === '/pipeline' ? { parameters: query('q', 'sort', 'dir', 'n', 'after', 'kind', 'status') } : {}),
    ...(route.method === 'POST' ? { requestBody: { required: true, content: { 'application/json': { schema: route.body ?? z.looseObject({}) } } } } : {}),
    responses: { '200': { description: 'OK' }, '400': { description: 'Invalid fields' }, '403': { description: 'Not permitted' }, '404': { description: 'Not found in this pipeline' }, '409': { description: 'Lifecycle or uniqueness conflict' } },
  } }
}
