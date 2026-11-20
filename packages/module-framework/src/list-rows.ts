import type { CellKind, PluginColumn } from './pages'
import type { ListQuery } from './views'

/**
 * Not exported from the package index: the packed modules' shim names every
 * index export, so a new one would stop a new archive loading on a host built
 * before it. The web host imports it from `@campusos/module-framework/list-rows`.
 */
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

/** The rows filtered and sorted as the list view's toolbar asks, with no cut: what an export writes. */
export function listRows<T extends Record<string, unknown>>(rows: T[], columns: PluginColumn[], query: ListQuery): T[] {
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
  return sorted
}

