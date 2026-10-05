import type { Role } from './types'
import type { PluginSection } from './pages'
import { jsonBody, type Plugin, type PluginActor, type PluginRoute } from './plugin'
import { readUpload, UploadError } from './uploads'
import { ticked } from './views'
import { csvCell, normaliseHeader, parseCsvRecords } from './csv'

/**
 * Bulk upload from a CSV file, the same way for every module.
 *
 * A module declares what a file holds -- its columns, and what one row does
 * through the module's own operations -- and `withImports` gives it the rest:
 * a route that takes the file, a template to download, an Import page in its
 * menu and the OpenAPI entries. Each row goes through the operation a person
 * would use one at a time, so an import cannot write what the form would
 * refuse.
 *
 * A file is all or nothing. Every row runs inside one transaction, each in a
 * savepoint of its own, so every bad row is found in one pass and reported by
 * line; then, unless the file was clean and Apply was ticked, all of it is
 * rolled back. Checking a file is therefore a real run that leaves nothing
 * behind, and later rows see what earlier ones made: a course can name a
 * department created three lines up.
 */

export interface ImportColumn {
  /** As the header names it. Compared ignoring case, spaces, dashes and underscores. */
  name: string
  required?: boolean
  note: string
  example: string
}

export type ImportOutcome = 'created' | 'updated' | 'skipped'

export interface ImportRow {
  line: number
  /** Every declared column, trimmed; '' where the cell or the column is absent. */
  values: Record<string, string>
}

export interface ImportSpec {
  /** Lower case and dashes, unique in the module: it names the file in the route. */
  id: string
  title: string
  note: string
  roles: Role[]
  columns: ImportColumn[]
  /**
   * One row, through the module's own operations. Throw to refuse it: the
   * message is shown beside its line. `memo` lives for the whole file, for
   * lookups worth doing once and for what `finish` gathers.
   */
  row: (actor: PluginActor, row: ImportRow, memo: Map<string, unknown>) => Promise<ImportOutcome>
  /** After every row, when the whole file is one document: an opening balance. */
  finish?: (actor: PluginActor, memo: Map<string, unknown>) => Promise<void>
  /** At most this many rows in one file. Default 5000. */
  maxRows?: number
}

/** The module's own `withTenantBatch`, passed in so this package needs no database. */
export type ImportBatch = <T>(
  institutionId: string,
  fn: (step: <R>(run: () => Promise<R>) => Promise<R>) => Promise<T>,
) => Promise<T>

export class ImportError extends Error {
  constructor(
    readonly status: 400 | 403 | 404,
    readonly code: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message)
  }
}

export interface ImportReport {
  importId: string
  rows: number
  created: number
  updated: number
  skipped: number
  applied: boolean
  errors: { line: number; message: string }[]
  notice: string
}

const MAX_BYTES = 4 * 1024 * 1024
const ROLLBACK = Symbol('roll the import back')

/** What went wrong with one row, in words a person can act on. */
export function describeError(e: unknown): string {
  const issues = (e as { issues?: { path?: (string | number)[]; message: string }[] })?.issues
  if (Array.isArray(issues) && issues.length) {
    return issues.map((i) => (i.path?.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ')
  }
  if (e instanceof Error) {
    // A database refusal arrives wrapped in the query that caused it; the
    // cause is the sentence, the query is noise.
    const cause = (e as { cause?: unknown }).cause
    if (e.message.startsWith('Failed query') && cause instanceof Error) return cause.message
    return e.message
  }
  return String(e)
}

function fileText(body: Record<string, unknown>): string {
  let text: string
  if (body.file !== undefined && body.file !== null && body.file !== '') {
    try {
      text = readUpload(body.file, { maxBytes: MAX_BYTES, what: 'the CSV file' }).bytes.toString('utf8')
    } catch (e) {
      if (e instanceof UploadError) throw new ImportError(400, e.code, e.message)
      throw e
    }
  } else if (typeof body.csv === 'string' && body.csv.trim()) {
    if (Buffer.byteLength(body.csv) > MAX_BYTES) throw new ImportError(400, 'too_large', 'the CSV is over 4 MB; split it')
    text = body.csv
  } else {
    throw new ImportError(400, 'no_file', 'attach a CSV file')
  }
  // A workbook saved as .xlsx, or any other binary, is not a CSV however it is named.
  if (text.includes('\u0000') || text.startsWith('PK\u0003\u0004')) {
    throw new ImportError(400, 'not_csv', 'that is not a CSV file: in Excel, use Save As and choose CSV UTF-8')
  }
  return text
}

/** The header against the declared columns: refuse an unknown or missing column before any row runs. */
function columnsOf(spec: ImportSpec, header: string[]): (string | null)[] {
  const declared = new Map(spec.columns.map((c) => [normaliseHeader(c.name), c.name]))
  const mapped = header.map((h) => (h.trim() === '' ? null : (declared.get(normaliseHeader(h)) ?? undefined)))
  const unknown = header.filter((_, i) => mapped[i] === undefined)
  const seen = new Set(mapped.filter(Boolean))
  const missing = spec.columns.filter((c) => c.required && !seen.has(c.name)).map((c) => c.name)
  const repeated = mapped.filter((m, i) => m && mapped.indexOf(m) !== i)
  const problems = [
    unknown.length ? `unknown column${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')}` : '',
    missing.length ? `missing column${missing.length > 1 ? 's' : ''} ${missing.join(', ')}` : '',
    repeated.length ? `column${repeated.length > 1 ? 's' : ''} ${[...new Set(repeated)].join(', ')} given twice` : '',
  ].filter(Boolean)
  if (problems.length) {
    throw new ImportError(400, 'bad_columns', `The header does not match: ${problems.join('; ')}. Expected: ${spec.columns.map((c) => c.name).join(', ')}.`)
  }
  return mapped.map((m) => m ?? null)
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

function summary(report: Omit<ImportReport, 'notice'>): string {
  const parts = [
    report.created && `${report.created} created`,
    report.updated && `${report.updated} updated`,
    report.skipped && `${report.skipped} already here, left as they are`,
  ].filter(Boolean)
  const what = parts.length ? parts.join(', ') : 'nothing to change'
  return report.applied
    ? `Imported ${plural(report.rows, 'row')}: ${what}.`
    : `Checked ${plural(report.rows, 'row')}: ${what}. Nothing was written: tick Apply to import.`
}

export async function runImport(spec: ImportSpec, actor: PluginActor, input: unknown, batch: ImportBatch): Promise<ImportReport> {
  if (!actor.institutionId) throw new ImportError(400, 'no_institution', 'no institution for this session')
  if (!spec.roles.includes(actor.role)) throw new ImportError(403, 'forbidden', `your role cannot import ${spec.title.toLowerCase()}`)
  const body = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const apply = ticked(body.apply) === true

  const [head, ...records] = parseCsvRecords(fileText(body))
  if (!head) throw new ImportError(400, 'empty', 'the file is empty')
  const columns = columnsOf(spec, head.cells)
  if (records.length === 0) throw new ImportError(400, 'empty', 'the file has a header and no rows')
  const max = spec.maxRows ?? 5000
  if (records.length > max) throw new ImportError(400, 'too_many_rows', `at most ${max} rows in one file; this has ${records.length}. Split it.`)

  const rows: ImportRow[] = records.map((r) => {
    const values: Record<string, string> = Object.fromEntries(spec.columns.map((c) => [c.name, '']))
    columns.forEach((name, i) => {
      if (name) values[name] = (r.cells[i] ?? '').trim()
    })
    return { line: r.line, values }
  })

  const tally = { created: 0, updated: 0, skipped: 0 }
  const errors: ImportReport['errors'] = []
  const memo = new Map<string, unknown>()
  try {
    await batch(actor.institutionId, async (step) => {
      for (const row of rows) {
        const blank = spec.columns.filter((c) => c.required && !row.values[c.name]).map((c) => c.name)
        if (blank.length) {
          errors.push({ line: row.line, message: `${blank.join(', ')} ${blank.length > 1 ? 'are' : 'is'} required` })
          continue
        }
        try {
          tally[await step(() => spec.row(actor, row, memo))]++
        } catch (e) {
          errors.push({ line: row.line, message: describeError(e) })
        }
      }
      if (spec.finish && errors.length === 0) {
        try {
          await step(() => spec.finish!(actor, memo))
        } catch (e) {
          errors.push({ line: 0, message: describeError(e) })
        }
      }
      if (!apply || errors.length) throw ROLLBACK
    })
  } catch (e) {
    if (e !== ROLLBACK) throw e
  }

  const report = { importId: spec.id, rows: rows.length, ...tally, applied: apply && errors.length === 0, errors }
  if (errors.length) {
    const shown = errors.slice(0, 10).map((e) => (e.line ? `line ${e.line}: ${e.message}` : e.message))
    const more = errors.length > shown.length ? `; and ${errors.length - shown.length} more` : ''
    throw new ImportError(400, 'bad_rows', `${plural(errors.length, 'row')} ${errors.length === 1 ? 'needs' : 'need'} fixing, so nothing was imported. ${shown.join('; ')}${more}.`, report)
  }
  return { ...report, notice: summary(report) }
}

/** A header and one example row: what the template download holds. */
export const importTemplate = (spec: ImportSpec) =>
  `${spec.columns.map((c) => csvCell(c.name)).join(',')}\r\n${spec.columns.map((c) => csvCell(c.example)).join(',')}\r\n`

const OPENAPI_RUN = {
  type: 'object',
  required: ['importId'],
  properties: {
    importId: { type: 'string', description: 'Which of the module’s imports, from GET /imports' },
    file: { type: 'object', description: 'The CSV, as the host posts a file: { name, type, size, base64 }' },
    csv: { type: 'string', description: 'Or the CSV text itself' },
    apply: { type: 'boolean', description: 'Write the rows. Absent or false checks the file and writes nothing' },
  },
}

/**
 * The module with its imports added: the three routes, an Import page in its
 * menu, and their OpenAPI entries.
 */
export function withImports(plugin: Plugin, specs: ImportSpec[], batch: ImportBatch): Plugin {
  const { manifest } = plugin
  const base = manifest.apiBasePath
  const ids = new Set<string>()
  for (const s of specs) {
    if (!/^[a-z][a-z0-9-]*$/.test(s.id) || ids.has(s.id)) throw new Error(`${manifest.id}: invalid or duplicate import ${s.id}`)
    if (!s.columns.length || !s.roles.length) throw new Error(`${manifest.id}: import ${s.id} declares no columns or roles`)
    ids.add(s.id)
  }
  const find = (actor: PluginActor, id: unknown) => {
    const spec = specs.find((s) => s.id === id)
    if (!spec) throw new ImportError(404, 'no_such_import', `${manifest.name} has no import ${String(id)}`)
    if (!actor.institutionId) throw new ImportError(400, 'no_institution', 'no institution for this session')
    if (!spec.roles.includes(actor.role)) throw new ImportError(403, 'forbidden', `your role cannot import ${spec.title.toLowerCase()}`)
    return spec
  }
  const visible = (actor: PluginActor) => specs.filter((s) => s.roles.includes(actor.role))
  const templateHref = (id: string) => `${base}/imports/template?id=${id}`

  const routes: PluginRoute[] = [
    {
      method: 'GET',
      path: '/imports',
      handler: async (actor) => {
        if (!actor.institutionId) throw new ImportError(400, 'no_institution', 'no institution for this session')
        return visible(actor).map((s) => ({ id: s.id, title: s.title, note: s.note, columns: s.columns, template: templateHref(s.id) }))
      },
    },
    {
      method: 'GET',
      path: '/imports/template',
      raw: true,
      handler: async (actor, req) => {
        const spec = find(actor, new URL(req.url).searchParams.get('id'))
        return new Response(importTemplate(spec), {
          headers: {
            'content-type': 'text/csv; charset=utf-8',
            'content-disposition': `attachment; filename="${manifest.id}-${spec.id}.csv"`,
            'cache-control': 'private, no-store',
          },
        })
      },
    },
    {
      method: 'POST',
      path: '/imports/run',
      handler: async (actor, req) => {
        const body = (await jsonBody(req)) as Record<string, unknown>
        return runImport(find(actor, body?.importId), actor, body, batch)
      },
    },
  ]

  const roles = [...new Set(specs.flatMap((s) => s.roles))]
  const page = {
    path: '/import',
    title: 'Import from CSV',
    menu: 'Import',
    roles,
    load: async (actor: PluginActor) => ({
      imports: visible(actor).map((s) => s.id),
      ...Object.fromEntries(
        visible(actor).map((s) => [
          `columns:${s.id}`,
          s.columns.map((c) => ({ name: c.name, required: c.required ? 'Required' : '', note: c.note, example: c.example })),
        ]),
      ),
    }),
    sections: (data: Record<string, unknown>): PluginSection[] => {
      const shown = new Set((data.imports as string[] | undefined) ?? [])
      const intro: PluginSection = {
        kind: 'note',
        tone: 'info',
        text:
          'Download a template, fill it in a spreadsheet and save it as CSV. Upload with Apply unticked to check it: every row is tried and every problem is listed by line, and nothing is written. Then upload it again with Apply ticked. A file with any bad row writes nothing, and rows that are already here are left as they are, so the same file can be uploaded twice. People are named by email address: import them first, under Administration, Import people.',
      }
      return [
        intro,
        ...specs.filter((s) => shown.has(s.id)).flatMap((s): PluginSection[] => {
          const key = `columns:${s.id}`
          return [
            {
              kind: 'form',
              title: s.title,
              note: s.note,
              submit: 'Upload',
              path: '/imports/run',
              method: 'POST',
              placement: 'inline',
              roles: s.roles,
              fields: [
                { name: 'importId', label: 'Import', kind: 'hidden', value: s.id },
                { name: 'file', label: 'CSV file', kind: 'file', accept: '.csv,text/csv' },
                { name: 'apply', label: 'Apply: write the rows (leave unticked to check the file first)', kind: 'checkbox', optional: true },
              ],
            },
            { kind: 'links', links: [{ label: `Download the ${s.title.toLowerCase()} template`, href: templateHref(s.id) }] },
            {
              kind: 'table',
              title: `${s.title}: columns`,
              rows: key,
              fixedOrder: true,
              pageSize: 50,
              columns: [
                { key: 'name', label: 'Column', kind: 'code' },
                { key: 'required', label: 'Required' },
                { key: 'note', label: 'What goes in it' },
                { key: 'example', label: 'Example' },
              ],
            },
          ]
        }),
      ]
    },
  }

  const err = { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } }
  const refusals = {
    '400': { description: 'The file cannot be imported: a bad header, or rows that need fixing, each listed by line', content: { 'application/json': { schema: err } } },
    '403': { description: 'Not permitted, or the module is not enabled', content: { 'application/json': { schema: err } } },
    '404': { description: 'No such import', content: { 'application/json': { schema: err } } },
  }
  const openapiPaths = {
    ...plugin.openapiPaths,
    [`${base}/imports`]: { get: { summary: 'What this module can import from CSV, with each file’s columns', tags: [`${manifest.id}: import`], responses: { '200': { description: 'OK' }, ...refusals } } },
    [`${base}/imports/template`]: {
      get: {
        summary: 'A CSV template: the header and one example row',
        tags: [`${manifest.id}: import`],
        parameters: [{ name: 'id', in: 'query', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'A CSV file' }, ...refusals },
      },
    },
    [`${base}/imports/run`]: {
      post: {
        summary: 'Check a CSV file, or with apply import it: all rows or none',
        tags: [`${manifest.id}: import`],
        requestBody: { content: { 'application/json': { schema: OPENAPI_RUN } } },
        responses: { '200': { description: 'What was, or would be, created, updated and left as it was' }, ...refusals },
      },
    },
  }

  return { ...plugin, routes: [...plugin.routes, ...routes], pages: [...(plugin.pages ?? []), page], openapiPaths }
}
