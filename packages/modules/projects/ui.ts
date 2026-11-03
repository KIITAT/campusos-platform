import { and, asc, inArray, isNull } from 'drizzle-orm'
import { users, withTenant } from '@campusos/db'
import type { PluginActor, PluginColumn, PluginField, PluginForm, PluginPage, PluginSection, Role } from '@campusos/module-framework'
import { partyChoices } from '@campusos/module-finance/api'
import { costCenters, funds, taxTemplates } from '@campusos/module-finance/schema'
import { OFFICE, STAFF, tenant } from './api/core'

export const STAFF_ROLES: Role[] = [...STAFF]
export const OFFICE_ROLES: Role[] = [...OFFICE]

export const pick = (name: string, label: string, options: string, optional = false): PluginField => ({ name, label, kind: 'select', options, optional })
export const field = (name: string, label: string, kind: PluginField['kind'] = 'text', optional = false): PluginField => ({ name, label, kind, optional })
export const choice = (items: readonly string[]) => items.map((value) => ({ value, label: value.replaceAll('_', ' ') }))
export const form = (title: string, path: string, fields: PluginField[], roles: Role[] = STAFF_ROLES): PluginForm => ({ kind: 'form', title, path, fields, submit: title, roles })
export const table = (title: string, rows: string, columns: PluginColumn[]): PluginSection => ({ kind: 'table', title, rows, columns, empty: 'Nothing recorded yet.' })
export const hidden = (name: string, value: string): PluginField => ({ name, label: '', kind: 'hidden', value })
export const withValue = (f: PluginField, value: string | null | undefined): PluginField => ({ ...f, value: value ?? '' })
export const rupees = (paise: number) => (paise / 100).toFixed(2)

export function screen<Data extends Record<string, unknown>>(
  definition: Omit<PluginPage, 'load' | 'sections'> & {
    load: (actor: PluginActor, request: Request) => Promise<Data>
    sections: (data: Data) => PluginSection[]
  },
): PluginPage {
  return { ...definition, sections: (data) => definition.sections(data as Data) }
}

/** Members of staff as a pick list. */
export async function staffOptions(actor: PluginActor) {
  return withTenant(tenant(actor, STAFF), async (tx) => {
    const rows = await tx
      .select({ id: users.id, name: users.name, email: users.email, role: users.role })
      .from(users)
      .where(and(isNull(users.erasedAt), inArray(users.role, STAFF_ROLES)))
      .orderBy(asc(users.name))
    return rows.map((r) => ({ value: r.id, label: `${r.name ?? r.email} · ${r.role}` }))
  })
}

/** What the office picks a project's money from. */
export async function officePickers(actor: PluginActor) {
  return withTenant(tenant(actor, OFFICE), async (tx) => {
    const centres = await tx.select({ code: costCenters.code, name: costCenters.name }).from(costCenters).where(isNull(costCenters.archivedAt)).orderBy(asc(costCenters.code))
    const funded = await tx.select({ id: funds.id, code: funds.code, name: funds.name }).from(funds).where(isNull(funds.archivedAt)).orderBy(asc(funds.code))
    const taxes = await tx.select({ id: taxTemplates.id, name: taxTemplates.name }).from(taxTemplates).where(isNull(taxTemplates.archivedAt)).orderBy(asc(taxTemplates.name))
    return {
      costCenterOptions: centres.map((c) => ({ value: c.code, label: `${c.code} ${c.name}` })),
      customerOptions: await partyChoices(tx, 'customer'),
      fundOptions: funded.map((f) => ({ value: f.id, label: `${f.code} ${f.name}` })),
      taxOptions: taxes.map((t) => ({ value: t.id, label: t.name })),
    }
  })
}

export const NO_PICKERS = { costCenterOptions: [], customerOptions: [], fundOptions: [], taxOptions: [] }

/** The manager and the members of a project as a pick list. */
export const memberOptions = (detail: { project: { managerId: string }; managerName: string | null; members: { userId: string; name: string | null }[] }) => [
  { value: detail.project.managerId, label: detail.managerName ?? detail.project.managerId },
  ...detail.members.map((m) => ({ value: m.userId, label: m.name ?? m.userId })),
]
