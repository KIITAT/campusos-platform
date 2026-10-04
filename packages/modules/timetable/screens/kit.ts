import { listStructure } from '@campusos/module-academic/api'
import type { PluginActor, PluginField, PluginForm, PluginPage, PluginSection, PluginTable, Role } from '@campusos/module-framework'
import { DAY_NAMES, OFFICE, TimetableError } from '../api/core'
import type { Grid } from '../api/views'

export const ROOT = '/m/timetable'
export const API = '/api/v1/modules/timetable'
export const dayOptions = DAY_NAMES.slice(1).map((label, index) => ({ value: String(index + 1), label }))
export const queryOf = (request: Request) => Object.fromEntries(new URL(request.url).searchParams)
export const officeOf = (actor: PluginActor) => OFFICE.includes(actor.role)
export const hidden = (name: string, value: string): PluginField => ({ name, label: '', kind: 'hidden', value })
export const number = (name: string, label: string, optional = false, value?: number): PluginField => ({ name, label, kind: 'number', optional, ...(value === undefined ? {} : { value: String(value) }) })
export const select = (name: string, label: string, options: PluginField['options'], optional = false, value?: string): PluginField => ({ name, label, kind: 'select', options, optional, value })
export const choices = <Row>(rows: Row[], value: (row: Row) => string, label: (row: Row) => string) => rows.map(row => ({ value: value(row), label: label(row) }))
export const form = (title: string, path: string, fields: PluginField[], extra: Partial<PluginForm> = {}): PluginForm => ({ kind: 'form', title, submit: title, path, fields, roles: OFFICE, ...extra })
export const table = (title: string, rows: string, columns: PluginTable['columns'], extra: Partial<PluginTable> = {}): PluginTable => ({ kind: 'table', title, rows, columns, empty: 'Nothing recorded yet.', ...extra })

export function definePage<Data extends Record<string, unknown>>(page: Omit<PluginPage, 'load' | 'sections' | 'record'> & {
  load: (actor: PluginActor, request: Request) => Promise<Data>
  sections: (data: Data) => PluginSection[]
  record?: (data: Data) => ReturnType<NonNullable<PluginPage['record']>>
}): PluginPage {
  const { sections, record, ...definition } = page
  return { ...definition, sections: data => sections(data as Data), ...(record ? { record: data => record(data as Data) } : {}) }
}

export async function context(actor: PluginActor, request: Request) {
  const query = queryOf(request)
  const structure = await listStructure(actor)
  const termId = query.termId || structure.terms.find(term => term.isCurrent)?.id || ''
  if (termId && !structure.terms.some(term => term.id === termId)) throw new TimetableError(404, 'no_such_term', 'no such term')
  return {
    office: officeOf(actor), faculty: actor.role === 'faculty', actorId: actor.id, query, termId, structure,
    termOptions: choices(structure.terms, term => term.id, term => `${term.code} · ${term.name}${term.isCurrent ? ' (current)' : ''}`),
  }
}

export const termFilter = (path: string, data: { termId: string }): PluginForm => form('Choose term', path, [select('termId', 'Term', 'termOptions', false, data.termId)], { method: 'GET', roles: undefined, submit: 'Show term' })
export const noTerm: PluginSection = { kind: 'note', tone: 'warn', text: 'Choose a term. If none is listed, create and mark a current term in Academic → Structure.' }
export const termHref = (path: string, termId: string) => `${ROOT}${path}${termId ? `?termId=${encodeURIComponent(termId)}` : ''}`

export function removeRows<Row>(rows: Row[], title: (row: Row) => string, path: string, field: string, id: (row: Row) => string, roles: Role[] = OFFICE): PluginForm[] {
  return rows.map(row => form(`Remove ${title(row)}`, path, [hidden(field, id(row))], { roles, placement: 'inline', submit: 'Remove' }))
}

export function gridSections(grid: Grid | null): PluginSection[] {
  if (!grid) return [{ kind: 'note', text: 'Choose a cohort, teacher or room to see its week.' }]
  return [table(grid.title, 'gridRows', [
    { key: 'period', label: 'Period' }, { key: 'time', label: 'Time' },
    ...grid.days.map(day => ({ key: `d${day.day}`, label: day.label })),
  ], { note: grid.subtitle, fixedOrder: true, pageSize: 100, empty: 'No teaching periods or meetings for this week.' })]
}

export const workloadSections = (unstaffed: number): PluginSection[] => [
  { kind: 'figures', figures: [{ label: 'Classes without a teacher', value: String(unstaffed), tone: unstaffed ? 'due' : 'clear' }] },
  table('Teacher workload', 'workload', [
    { key: 'teacher', label: 'Teacher' }, { key: 'periods', label: 'Periods' }, { key: 'classes', label: 'Classes' },
    ...dayOptions.map(day => ({ key: `d${day.value}`, label: day.label.slice(0, 3) })),
    { key: 'dailyLoad', label: 'Busiest / limit', alertWhen: 'atLimit' }, { key: 'utilisationLabel', label: 'Week used' },
  ]),
]

export const workloadRows = (rows: Record<string, unknown>[]) => rows.map(row => ({
  ...row, dailyLoad: `${row.busiestDay} / ${row.maxPerDay ?? '—'}`,
  atLimit: row.maxPerDay !== null && Number(row.busiestDay) >= Number(row.maxPerDay),
  utilisationLabel: row.utilisation === null ? '—' : `${row.utilisation}%`,
}))
