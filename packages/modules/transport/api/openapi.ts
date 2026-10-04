import * as z from 'zod'
import { specs } from '../routes'
export const paths: Record<string, Record<string, unknown>> = {}
for (const route of specs) {
  const path = '/api/v1/modules/transport' + route.path
  paths[path] = { ...paths[path], [route.method.toLowerCase()]: {
    summary: route.summary, tags: ['Transport'],
    ...(route.method === 'POST' ? { requestBody: { required: true, content: { 'application/json': { schema: route.body ?? z.looseObject({}) } } } } : {}),
    responses: { '200': { description: 'OK' }, '400': { description: 'Invalid fields' }, '403': { description: 'Not permitted' }, '404': { description: 'Not found in this institution' }, '409': { description: 'Lifecycle or capacity conflict' } },
  } }
}
