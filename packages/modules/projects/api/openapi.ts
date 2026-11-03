import * as z from 'zod'
import { specs } from '../routes'

interface Param { name: string; required?: boolean; format?: string; description?: string }

const paging: Param[] = [
  { name: 'q' },
  { name: 'sort' },
  { name: 'dir' },
  { name: 'n', description: 'Rows per page, at most 500.' },
  { name: 'after', description: 'The next value of the previous page.' },
]

/** The query parameters of each GET route; the paged lists take the five paging parameters as well. */
const parameters: Record<string, Param[]> = {
  '/projects': [...paging, { name: 'status' }],
  '/projects/detail': [{ name: 'id', required: true, format: 'uuid' }],
  '/tasks': [...paging, { name: 'projectId', required: true, format: 'uuid' }],
  '/timesheets': [
    ...paging, { name: 'projectId', format: 'uuid' }, { name: 'taskId', format: 'uuid' }, { name: 'userId' }, { name: 'status' }, { name: 'queue' },
  ],
  '/cost-rates': [...paging, { name: 'userId' }],
  '/billings': [...paging, { name: 'projectId', format: 'uuid' }],
  '/costings': [...paging, { name: 'projectId', format: 'uuid' }, { name: 'open' }],
  '/profitability': [...paging, { name: 'from', format: 'date' }, { name: 'to', format: 'date' }],
}

const idempotency = {
  name: 'Idempotency-Key', in: 'header', required: false, description: 'Once per key: a replay returns the first result.',
  schema: { type: 'string' },
}

export const paths: Record<string, Record<string, unknown>> = {}
for (const route of specs) {
  const path = '/api/v1/modules/projects' + route.path
  const query = route.method === 'GET'
    ? (parameters[route.path] ?? []).map((p) => ({
        name: p.name, in: 'query', required: p.required ?? false, ...(p.description ? { description: p.description } : {}),
        schema: { type: 'string', ...(p.format ? { format: p.format } : {}) },
      }))
    : []
  const keyed = route.method === 'POST' && (route.path === '/billings' || route.path === '/costings') ? [idempotency] : []
  const all = [...query, ...keyed]
  paths[path] = {
    ...paths[path],
    [route.method.toLowerCase()]: {
      summary: route.summary,
      tags: ['Projects and timesheets'],
      ...(all.length ? { parameters: all } : {}),
      ...(route.method === 'POST' ? { requestBody: { required: true, content: { 'application/json': { schema: route.body ?? z.looseObject({}) } } } } : {}),
      responses: {
        '200': { description: 'OK' },
        '400': { description: 'Invalid fields' },
        '403': { description: 'Not permitted' },
        '404': { description: 'Not found in this institution' },
        '409': { description: 'Lifecycle, settlement or idempotency conflict' },
      },
    },
  }
}
