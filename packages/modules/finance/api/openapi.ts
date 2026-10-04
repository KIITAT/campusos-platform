import * as z from 'zod'
import { manifest } from '../manifest'
import { specs } from '../routes'

/**
 * The books' fragment of the API document, read from the route list itself
 * (routes.ts): every route is documented, with its request body's schema
 * where it has one, and none is documented that does not exist.
 *
 * Every refusal has the same shape: an error code a client can act on and a
 * sentence a person can read. 400 is a request that cannot be right, 403 a
 * reader without the right, 404 something named that is not there, 409 a
 * rule of the books -- a closed period, a settled invoice, a submitted
 * document -- standing in the way.
 */

const base = manifest.apiBasePath
const err = z.object({ error: z.string(), message: z.string() })
const json = (schema: z.ZodType) => ({ 'application/json': { schema } })

const refusals = {
  '400': { description: 'The request cannot be right: a missing field, an amount that is not one', content: json(err) },
  '403': { description: 'Not permitted, or the module is not enabled', content: json(err) },
  '404': { description: 'Something it names does not exist', content: json(err) },
  '409': {
    description: 'A rule of the books stands in the way: a closed period, a submitted document, a settled invoice',
    content: json(err),
  },
}

const TAGS: Record<string, string> = {
  ledger: 'finance: ledger',
  setup: 'finance: setup',
  tax: 'finance: tax',
  parties: 'finance: parties',
  stock: 'finance: stock',
  invoices: 'finance: invoices',
  payments: 'finance: payments',
  orders: 'finance: orders',
  buying: 'finance: buying',
  assets: 'finance: assets',
  bank: 'finance: bank',
  reports: 'finance: reports',
}

export const paths: Record<string, Record<string, unknown>> = {}
for (const s of specs) {
  const at = `${base}${s.path}`
  const op: Record<string, unknown> = {
    summary: s.summary,
    tags: [TAGS[s.tag] ?? 'finance'],
    responses: s.raw
      ? { '200': { description: s.path.endsWith('.csv') ? 'A CSV file' : 'A PDF document' }, ...refusals }
      : { '200': { description: 'OK' }, ...refusals },
  }
  if (s.method === 'POST') op.requestBody = { content: json(s.body ?? z.looseObject({})) }
  paths[at] = { ...(paths[at] ?? {}), [s.method.toLowerCase()]: op }
}
