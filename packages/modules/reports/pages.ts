import { ADMIN, STAFF, type CellKind, type PluginColumn, type PluginField, type PluginPage, type PluginSection, type Role } from '@campusos/module-framework'
import { dashboard, listDatasets, listReports, reportDetail, specSchema, type Dataset, type OutColumn, type Row } from './api'

const STAFF_ROLES: Role[] = [...STAFF]
const ADMIN_ROLES: Role[] = [...ADMIN]
const param = (request: Request, name: string) => new URL(request.url).searchParams.get(name) ?? ''
const KIND_CELL: Record<string, CellKind> = { money: 'money', date: 'date', bool: 'bool' }
const cols = (columns: OutColumn[]): PluginColumn[] => columns.map((c) => ({ key: c.key, label: c.label, kind: KIND_CELL[c.kind] ?? 'text' }))
const opt = (items: { name: string; label: string }[]) => items.map((c) => ({ value: c.name, label: c.label }))

// ponytail: dates and numbers share operator codes, so each code is listed once, worded for both; per-kind wording if people ask.
const OP_OPTIONS = [
  { value: 'eq', label: 'is' }, { value: 'ne', label: 'is not' }, { value: 'contains', label: 'contains' },
  { value: 'lt', label: 'is before / less than' }, { value: 'le', label: 'is on or before / at most' },
  { value: 'gt', label: 'is after / more than' }, { value: 'ge', label: 'is on or after / at least' },
  { value: 'empty', label: 'is empty' }, { value: 'not_empty', label: 'is not empty' },
  { value: 'is_true', label: 'is yes' }, { value: 'is_false', label: 'is no' },
]

const SCHEDULES = [
  { value: 'none', label: 'Not scheduled' }, { value: 'daily', label: 'Every day at 7:00' },
  { value: 'weekly', label: 'Mondays at 7:00' }, { value: 'monthly', label: 'The 1st at 7:00' },
]

/** The builder's fields for one dataset; `v` prefills them when editing. */
function builder(ds: Dataset, v: Record<string, string> = {}): PluginField[] {
  return [
    { name: 'name', label: 'Name', value: v.name ?? '' },
    { name: 'dataset', label: 'Dataset', kind: 'hidden', value: ds.id },
    { name: 'columns', label: 'Columns to list', kind: 'checkboxes', optional: true, options: opt(ds.columns), value: v.columns ?? '', hint: 'For a plain list. Leave empty when grouping or totalling.' },
    {
      name: 'filters', label: 'Filters', kind: 'lines', optional: true, lineCount: 5, value: 'filterRows',
      hint: 'A date may be today, today-30, month_start or fy_start. Amounts in rupees.',
      columns: [
        { name: 'column', label: 'Column', kind: 'select', options: 'columnOptions', optional: true },
        { name: 'op', label: 'Condition', kind: 'select', options: OP_OPTIONS, optional: true },
        { name: 'value', label: 'Value', optional: true },
      ],
    },
    { name: 'groupBy', label: 'Group by', kind: 'select', optional: true, options: opt(ds.columns), value: v.groupBy ?? '' },
    { name: 'bucket', label: 'Group dates by', kind: 'select', optional: true, options: [{ value: 'day', label: 'Day' }, { value: 'month', label: 'Month' }, { value: 'year', label: 'Year' }], value: v.bucket ?? '' },
    {
      name: 'measures', label: 'Totals', kind: 'lines', optional: true, lineCount: 3, value: 'measureRows',
      columns: [
        { name: 'fn', label: 'Total', kind: 'select', options: [{ value: 'count', label: 'Count' }, { value: 'sum', label: 'Sum' }, { value: 'avg', label: 'Average' }, { value: 'min', label: 'Lowest' }, { value: 'max', label: 'Highest' }], optional: true },
        { name: 'column', label: 'Of', kind: 'select', options: 'columnOptions', optional: true },
      ],
    },
    { name: 'sortKey', label: 'Sort by', kind: 'select', optional: true, options: [...opt(ds.columns), { value: 'm0', label: 'First total' }], value: v.sortKey ?? '' },
    { name: 'sortDir', label: 'Order', kind: 'select', options: [{ value: 'asc', label: 'Ascending' }, { value: 'desc', label: 'Descending' }], value: v.sortDir ?? 'asc' },
    { name: 'limit', label: 'Rows at most', kind: 'number', value: v.limit ?? '500' },
    { name: 'chart', label: 'Chart', kind: 'select', options: [{ value: 'none', label: 'No chart' }, { value: 'bar', label: 'Bars' }, { value: 'line', label: 'Line' }], value: v.chart ?? 'none' },
    { name: 'viewerRoles', label: 'Share with', kind: 'checkboxes', optional: true, options: ds.roles.filter((r) => !ADMIN.includes(r)).map((r) => ({ value: r, label: r.replaceAll('_', ' ') })), value: v.viewerRoles ?? '' },
    { name: 'onDashboard', label: 'Show on the dashboard', kind: 'checkbox', optional: true, value: v.onDashboard ?? 'false' },
    { name: 'schedule', label: 'Run', kind: 'select', options: SCHEDULES, value: v.schedule ?? 'none' },
  ]
}

const rows = (items: object[]) => items.map((r) => Object.fromEntries(Object.entries(r).map(([k, x]) => [k, x == null ? '' : String(x)])))

export const pages: PluginPage[] = [
  {
    path: '/', title: 'Dashboard', menu: 'Dashboard', roles: STAFF_ROLES,
    load: async (actor) => {
      const items = await dashboard(actor)
      const data: Record<string, unknown> = { items }
      items.forEach((it, i) => { data['d' + i] = it.chart !== 'none' ? it.rows : it.rows.slice(0, 10) })
      return data
    },
    sections: (data) => {
      const items = data.items as Awaited<ReturnType<typeof dashboard>>
      if (items.length === 0) return [{ kind: 'note', text: 'No dashboard reports for your role yet.' }]
      return items.flatMap((it, i): PluginSection[] => {
        const open: PluginSection = { kind: 'links', links: [{ label: 'Open ' + it.name, href: '/m/reports/report?id=' + it.id }] }
        if (!it.runAt) return [{ kind: 'note', text: `${it.name}: Not run yet.` }, open]
        const money = it.columns[1]?.kind === 'money'
        return it.chart !== 'none'
          ? [{ kind: 'chart', title: it.name, type: it.chart as 'bar' | 'line', rows: 'd' + i, x: it.columns[0]!.key, series: it.columns.slice(1).map((c) => ({ key: c.key, label: c.label })), unit: money ? 'money' : 'number' }, open]
          : [{ kind: 'table', title: it.name, rows: 'd' + i, columns: cols(it.columns as OutColumn[]), pageSize: 10, fixedOrder: true }, open]
      })
    },
  },
  {
    path: '/reports', title: 'Reports', menu: 'Reports', roles: STAFF_ROLES,
    load: async (actor) => ({ reports: await listReports(actor), admin: ADMIN.includes(actor.role) }),
    sections: (data) => [
      {
        kind: 'table', title: 'Reports', rows: 'reports', empty: 'No reports yet.',
        columns: [
          { key: 'name', label: 'Name', href: '/m/reports/report?id={id}' },
          { key: 'dataset', label: 'Dataset' },
          { key: 'schedule', label: 'Schedule' },
          { key: 'lastRunAt', label: 'Last run', kind: 'when' },
          { key: 'lastStatus', label: 'Status', kind: 'status' },
        ],
      },
      ...(data.admin ? [{ kind: 'links', links: [{ label: 'New report', href: '/m/reports/new' }] } as PluginSection] : []),
    ],
  },
  {
    path: '/new', title: 'New report', menu: 'New report', roles: ADMIN_ROLES,
    load: async (actor, request) => {
      const list = await listDatasets(actor)
      const chosen = list.find((d) => d.id === param(request, 'dataset')) ?? null
      return { chosen, datasetOptions: list.map((d) => ({ value: d.id, label: d.label })), columnOptions: chosen ? opt(chosen.columns) : [], filterRows: [], measureRows: [] }
    },
    sections: (data) => {
      const ds = data.chosen as Dataset | null
      if (!ds) {
        return [
          { kind: 'note', text: 'Choose what the report is about. Only datasets of modules switched on here are offered.' },
          { kind: 'form', title: 'Dataset', path: '/new', method: 'GET', submit: 'Choose', fields: [{ name: 'dataset', label: 'Dataset', kind: 'select', options: 'datasetOptions' }] },
        ]
      }
      return [{ kind: 'form', title: ds.label, path: '/reports', submit: 'Save report', placement: 'inline', fields: builder(ds) }]
    },
  },
  {
    path: '/report', title: 'Report', roles: STAFF_ROLES,
    load: async (actor, request) => {
      const d = await reportDetail(actor, { id: param(request, 'id') })
      const run = d.run
      return {
        report: d.report, datasetLabel: d.datasetLabel, admin: ADMIN.includes(actor.role),
        run: run ? { id: run.id as string, status: run.status as string, errorCode: run.error_code as string | null, startedAt: run.started_at as string, onReplica: run.on_replica as boolean, dataAsOf: run.data_as_of as string | null, truncated: run.truncated as boolean, columns: run.columns as OutColumn[] } : null,
        runRows: (run?.rows as Row[] | undefined) ?? [],
      }
    },
    record: (data) => {
      const r = data.report as { name: string; schedule: string; nextRunAt: Date | null } | undefined
      if (!r) return null
      const run = data.run as { startedAt: string; onReplica: boolean; dataAsOf: string | null } | null
      return {
        title: r.name,
        subtitle: (data.datasetLabel as string | null) ?? 'Dataset not available',
        fields: [
          { label: 'Schedule', value: r.schedule },
          { label: 'Next run', value: r.nextRunAt ? String(r.nextRunAt instanceof Date ? r.nextRunAt.toISOString() : r.nextRunAt) : null, kind: 'when' },
          { label: 'Last run', value: run?.startedAt ?? null, kind: 'when' },
          { label: 'Ran on the replica', value: run?.onReplica ?? false, kind: 'bool' },
          { label: 'Data as of', value: run?.dataAsOf ?? null, kind: 'when' },
        ],
      }
    },
    sections: (data) => {
      const report = data.report as { id: string; spec: unknown }
      const run = data.run as { id: string; status: string; errorCode: string | null; truncated: boolean; columns: OutColumn[] } | null
      const spec = specSchema.safeParse(report.spec)
      const out: PluginSection[] = []
      if (run?.status === 'ok') {
        if (spec.success && spec.data.chart !== 'none') {
          const money = run.columns[1]?.kind === 'money'
          out.push({ kind: 'chart', title: 'Chart', type: spec.data.chart, rows: 'runRows', x: run.columns[0]!.key, series: run.columns.slice(1).map((c) => ({ key: c.key, label: c.label })), unit: money ? 'money' : 'number' })
        }
        out.push({ kind: 'table', title: 'Latest run', rows: 'runRows', columns: cols(run.columns), empty: 'The report found no rows.' })
        if (run.truncated && spec.success) out.push({ kind: 'note', text: `Showing the first ${spec.data.limit} rows.` })
      } else if (run) {
        out.push({ kind: 'note', tone: 'danger', text: `The latest run failed (${run.errorCode ?? 'failed'}). Change the report or run it again.` })
      } else {
        out.push({ kind: 'note', text: 'Not run yet.' })
      }
      out.push({ kind: 'form', title: 'Run now', path: '/reports/run', submit: 'Run now', placement: 'inline', fields: [{ name: 'id', label: '', kind: 'hidden', value: report.id }] })
      const links = [
        ...(run ? [{ label: 'Download CSV', href: `/api/v1/modules/reports/runs/csv?id=${run.id}` }] : []),
        ...(data.admin ? [{ label: 'Export Parquet', href: `/api/v1/modules/reports/reports/parquet?id=${report.id}` }, { label: 'Edit', href: `/m/reports/edit?id=${report.id}` }] : []),
      ]
      if (links.length) out.push({ kind: 'links', links })
      if (data.admin) out.push({ kind: 'form', title: 'Archive', path: '/reports/archive', submit: 'Archive', placement: 'inline', roles: ADMIN_ROLES, fields: [{ name: 'id', label: '', kind: 'hidden', value: report.id }] })
      return out
    },
  },
  {
    path: '/edit', title: 'Edit report', roles: ADMIN_ROLES,
    load: async (actor, request) => {
      const d = await reportDetail(actor, { id: param(request, 'id') })
      const list = await listDatasets(actor)
      const ds = list.find((x) => x.id === d.report.dataset) ?? null
      const spec = specSchema.safeParse(d.report.spec)
      return {
        ds, report: d.report, columnOptions: ds ? opt(ds.columns) : [],
        filterRows: spec.success ? rows(spec.data.filters) : [], measureRows: spec.success ? rows(spec.data.measures) : [],
        values: {
          name: d.report.name, columns: spec.success ? spec.data.columns.join(',') : '', groupBy: spec.success ? spec.data.groupBy ?? '' : '', bucket: spec.success ? spec.data.bucket ?? '' : '',
          sortKey: spec.success ? spec.data.sort?.key ?? '' : '', sortDir: spec.success ? spec.data.sort?.dir ?? 'asc' : 'asc', limit: String(spec.success ? spec.data.limit : 500),
          chart: spec.success ? spec.data.chart : 'none', viewerRoles: d.report.viewerRoles.join(','), onDashboard: String(d.report.onDashboard), schedule: d.report.schedule,
        },
      }
    },
    sections: (data) => {
      const ds = data.ds as Dataset | null
      const report = data.report as { id: string }
      if (!ds) return [{ kind: 'note', tone: 'warn', text: 'That dataset is not available here: its module is not enabled or no longer provides it.' }]
      return [{ kind: 'form', title: 'Edit report', path: '/reports/update', submit: 'Save changes', placement: 'inline', fields: [{ name: 'id', label: '', kind: 'hidden', value: report.id }, ...builder(ds, data.values as Record<string, string>)] }]
    },
  },
]
