import type * as z from 'zod'
import { jsonBody, type PluginRoute } from '@campusos/module-framework'
import * as api from './api'

/**
 * Every operation of the module, as an HTTP route. Declared once: the routes are this list, and so is the
 * OpenAPI document (api/openapi.ts reads it), so the two cannot drift apart.
 */
export interface RouteSpec extends PluginRoute {
  summary: string
  /** The request body's schema, for the API document. */
  body?: z.ZodType
}

const idParam = (req: Request) => ({ id: new URL(req.url).searchParams.get('id') ?? '' })

const post = (path: string, summary: string, run: (actor: api.Actor, input: unknown) => Promise<unknown>, body?: z.ZodType): RouteSpec => ({
  method: 'POST', path, summary, body, handler: async (actor, request) => run(actor, await jsonBody(request)),
})

const saved = (r: { id: string }) => ({ ...r, notice: 'Report saved.', next: '/m/reports/report?id=' + r.id })

export const specs: RouteSpec[] = [
  { method: 'GET', path: '/datasets', summary: 'List the datasets this institution can report on', handler: (a) => api.listDatasets(a) },
  { method: 'GET', path: '/reports', summary: 'List the reports you can see', handler: (a) => api.listReports(a) },
  { method: 'GET', path: '/reports/detail', summary: 'Read a report with its latest run', handler: (a, req) => api.reportDetail(a, idParam(req)) },
  post('/reports', 'Build a report over a dataset', async (a, i) => saved(await api.createReport(a, api.fromForm(i))), api.reportSchema),
  post('/reports/update', 'Change a report', async (a, i) => saved(await api.updateReport(a, api.fromForm(i))), api.updateSchema),
  post('/reports/archive', 'Archive a report', async (a, i) => ({ ...(await api.archiveReport(a, i)), notice: 'Report archived.', next: '/m/reports/reports' }), api.idSchema),
  post('/reports/run', 'Run a report now and keep the result', async (a, i) => { const r = await api.runReport(a, i as { id: string }); return { ...r, notice: `Report run: ${r.rowCount} rows.` } }, api.idSchema),
  { method: 'GET', path: '/runs/csv', summary: 'Download a stored run as CSV', raw: true, handler: (a, req) => api.runCsv(a, idParam(req)) },
  { method: 'GET', path: '/reports/parquet', summary: 'Export a report as a Parquet file (administrators)', raw: true, handler: (a, req) => api.exportParquet(a, idParam(req)) },
  { method: 'GET', path: '/dashboard', summary: 'The reports marked for your dashboard, from their latest runs', handler: (a) => api.dashboard(a) },
]
export const routes: PluginRoute[] = specs
