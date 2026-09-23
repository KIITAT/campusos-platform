import type { CellKind, PluginColumn, Tone } from './pages'

/**
 * The parts of rendering that are decisions rather than markup, kept here so
 * they are the same in every host and can be tested without one.
 */

/**
 * Which colour a lifecycle word gets.
 *
 * Colour is used narrowly and for meaning: green is done and good, red is
 * refused or stopped, orange wants somebody's attention, blue is live and
 * moving, gray is not started. A word nobody listed is gray rather than a
 * guess.
 */
const TONES: Record<string, Tone> = {}
const tone = (t: Tone, words: string) => words.split(' ').forEach((w) => (TONES[w] = t))
tone('green', 'paid accepted approved verified completed complete done filled hired active present passed cleared settled closed_ok posted issued eligible awarded')
tone('red', 'cancelled canceled refused rejected revoked expired overdue withdrawn failed absent lapsed separated terminated blocked ineligible void')
tone('orange', 'not_eligible short awaiting pending waiting partial due submitted_for_review requested applied screening self_review manager_review held withheld outstanding')
tone('blue', 'open submitted scheduled interviewing offered offer in_progress ongoing running published sanctioned current live')
tone('violet', 'amended superseded transferred promoted')
tone('gray', 'draft new closed inactive none unused not_started')

export function statusTone(word: unknown): Tone {
  if (typeof word !== 'string') return 'gray'
  const key = word.trim().toLowerCase().replace(/[\s-]+/g, '_')
  return TONES[key] ?? 'gray'
}

export interface ListQuery {
  /** Free text, matched against every column's shown value. */
  q?: string | null
  sort?: string | null
  dir?: 'asc' | 'desc' | null
  /** How many rows to show. */
  limit?: number | null
}

export interface ListView<T> {
  rows: T[]
  /** After filtering, before the limit. */
  matched: number
  total: number
  limit: number
}

const text = (v: unknown, kind?: CellKind): string => {
  if (v === null || v === undefined) return ''
  if (kind === 'bool') return v ? 'yes' : 'no'
  return String(v)
}

const comparable = (v: unknown): number | string | null => {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  return String(v).toLowerCase()
}

/**
 * Filter, sort and cut a table's rows the way the list view's toolbar asks.
 *
 * On the rows the page already loaded: a module's load decides what a reader
 * may see, and this only decides the order they see it in. Blanks sort last
 * either way, because a missing date is not the earliest one.
 */
export function listView<T extends Record<string, unknown>>(
  rows: T[],
  columns: PluginColumn[],
  query: ListQuery,
  pageSize = 20,
): ListView<T> {
  const q = query.q?.trim().toLowerCase()
  const filtered = q
    ? rows.filter((r) => columns.some((c) => text(r[c.key], c.kind).toLowerCase().includes(q)))
    : rows

  const col = columns.find((c) => c.key === query.sort)
  const sorted = col
    ? [...filtered].sort((a, b) => {
        const x = comparable(a[col.key])
        const y = comparable(b[col.key])
        if (x === null && y === null) return 0
        if (x === null) return 1
        if (y === null) return -1
        const order = x < y ? -1 : x > y ? 1 : 0
        return query.dir === 'desc' ? -order : order
      })
    : filtered

  const limit = Math.min(Math.max(query.limit ?? pageSize, 1), 500)
  return { rows: sorted.slice(0, limit), matched: filtered.length, total: rows.length, limit }
}

/** Nice round steps for a chart's axis, from zero to at least the largest value. */
export function axisTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0]
  const raw = max / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw
  const ticks: number[] = []
  for (let v = 0; v < max + step; v += step) ticks.push(Math.round(v * 1e6) / 1e6)
  return ticks
}
