const list = (v: unknown) => (v === undefined || v === null || v === '' ? [] : Array.isArray(v) ? v : [v])
const text = (v: unknown) => (typeof v === 'string' ? v : '')

/**
 * The builder form posts flat fields (a sort key and direction, a grid of filters, blank rows left empty);
 * a JSON caller sends the nested shape. This turns the first into the second and leaves the second alone.
 */
export function fromForm(input: unknown): unknown {
  const b = (input ?? {}) as Record<string, unknown>
  if (b.spec !== undefined) return b
  const rows = (v: unknown) => list(v).filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
  return {
    ...(b.id !== undefined ? { id: b.id } : {}),
    name: b.name,
    dataset: b.dataset,
    viewerRoles: b.viewerRoles,
    onDashboard: b.onDashboard,
    schedule: text(b.schedule) || 'none',
    spec: {
      columns: list(b.columns),
      filters: rows(b.filters).filter((f) => text(f.column) && text(f.op)).map((f) => ({ column: f.column, op: f.op, value: text(f.value) })),
      groupBy: text(b.groupBy) || null,
      bucket: text(b.bucket) || null,
      measures: rows(b.measures).filter((m) => text(m.fn)).map((m) => ({ fn: m.fn, column: text(m.column) || null })),
      sort: text(b.sortKey) ? { key: b.sortKey, dir: text(b.sortDir) || 'asc' } : null,
      ...(text(b.limit) ? { limit: b.limit } : {}),
      chart: text(b.chart) || 'none',
    },
  }
}
