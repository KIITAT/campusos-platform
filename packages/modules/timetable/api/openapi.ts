import * as z from 'zod'
import { manifest } from '../manifest'
import { specs } from '../routes'

/**
 * The timetable's fragment of the API document, read from the route list
 * itself, so every route is documented and nothing is documented that does
 * not exist. Refusals share one shape: a code a client can act on, and a
 * sentence a person can read.
 */

const base = manifest.apiBasePath
const err = z.object({ error: z.string(), message: z.string() })
const json = (schema: z.ZodType) => ({ 'application/json': { schema } })
const refusals = {
  '400': { description: 'The request cannot be right: a missing term, a time that is not one', content: json(err) },
  '403': { description: 'Not permitted, or the module is not enabled', content: json(err) },
  '404': { description: 'Something it names does not exist', content: json(err) },
  '409': { description: 'The timetable stands in the way: a clash, a draft already applied, a term not ready', content: json(err) },
}

export const paths: Record<string, Record<string, unknown>> = {}
for (const s of specs) {
  const at = `${base}${s.path}`
  const op: Record<string, unknown> = {
    summary: s.summary,
    tags: [`timetable: ${s.tag}`],
    responses: s.raw ? { '200': { description: 'A PDF document' }, ...refusals } : { '200': { description: 'OK' }, ...refusals },
  }
  if (s.method === 'POST') op.requestBody = { content: json(s.body ?? z.looseObject({})) }
  paths[at] = { ...(paths[at] ?? {}), [s.method.toLowerCase()]: op }
}
