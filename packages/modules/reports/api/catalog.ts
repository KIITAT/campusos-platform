import * as z from 'zod'
import { sql } from 'drizzle-orm'
import type { ReadTx } from '@campusos/db/replica'
import { ROLES, STAFF, type Role } from '@campusos/module-framework'

/** Datasets are security_invoker views in schema `reporting`, described by JSON comments (decision 436). */
export const KINDS = ['text', 'number', 'money', 'date', 'bool'] as const
export type Kind = (typeof KINDS)[number]

export const viewMetaSchema = z.object({
  label: z.string().min(1).max(80),
  module: z.string().regex(/^[a-z][a-z0-9-]*$/),
  roles: z.array(z.enum(ROLES as [Role, ...Role[]])).min(1),
})
export const columnMetaSchema = z.object({ label: z.string().min(1).max(80), kind: z.enum(KINDS) })

export interface Dataset {
  id: string
  label: string
  module: string
  roles: Role[]
  columns: { name: string; label: string; kind: Kind }[]
}

const parse = (text: string | null): unknown => {
  try { return text ? JSON.parse(text) : undefined } catch { return undefined }
}

/** The datasets this institution may build on: published, well described, and their module enabled. Run inside `withTenantRead`. */
export async function datasets(tx: ReadTx, institutionId: string): Promise<Dataset[]> {
  const rows = (await tx.execute(sql`
    select c.relname as view, obj_description(c.oid, 'pg_class') as meta,
           a.attname as col, col_description(c.oid, a.attnum) as col_meta
      from pg_class c
      join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
     where c.relnamespace = to_regnamespace('reporting') and c.relkind = 'v'
     order by c.relname, a.attnum`)).rows as { view: string; meta: string | null; col: string; col_meta: string | null }[]
  const enabled = new Set(((await tx.execute(sql`select module_id from institution_modules where institution_id = ${institutionId} and enabled`)).rows as { module_id: string }[]).map((r) => r.module_id))
  const out = new Map<string, Dataset>()
  for (const r of rows) {
    let d = out.get(r.view)
    if (!d) {
      const meta = viewMetaSchema.safeParse(parse(r.meta))
      if (!meta.success) continue
      d = { id: r.view, label: meta.data.label, module: meta.data.module, roles: meta.data.roles.filter((x) => STAFF.includes(x)), columns: [] }
      out.set(r.view, d)
    }
    const col = columnMetaSchema.safeParse(parse(r.col_meta))
    if (col.success) d.columns.push({ name: r.col, ...col.data })
  }
  return [...out.values()]
    .filter((d) => d.columns.length > 0 && d.roles.length > 0 && enabled.has(d.module))
    .sort((a, b) => a.label.localeCompare(b.label))
}

export const datasetById = (list: Dataset[], id: string) => list.find((d) => d.id === id)
