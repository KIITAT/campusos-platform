import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { users, withTenant } from '@campusos/db'
import type { PluginActor, PluginField, PluginRecord, Role, Tone } from '@campusos/module-framework'
import {
  accounts,
  assetCategories,
  costCenters,
  funds,
  items,
  parties,
  taxTemplates,
  tdsSections,
  warehouses,
} from '../schema'
import { currenciesWithin, formatMoney, formatQty, settingsWithin, tenantOf, type Actor } from '../api'

/**
 * What every screen of the books shares: who may see it, how money and
 * quantities read, the choices a form offers, and how a document's lifecycle
 * is shown.
 */

export const OFFICE: Role[] = ['institution_admin', 'super_admin', 'accounts_staff']
export const ADMIN: Role[] = ['institution_admin', 'super_admin']
/** Everybody who works here: may ask the stores for something, and keepers and purchasers among them. */
export const STAFF: Role[] = ['institution_admin', 'super_admin', 'accounts_staff', 'hod', 'faculty', 'library_staff', 'hostel_staff']

export const as = (actor: PluginActor) => actor as Actor
export const q = (req: Request) => Object.fromEntries(new URL(req.url).searchParams) as Record<string, string | undefined>
export const today = () => new Date().toISOString().slice(0, 10)
export const monthStart = () => `${today().slice(0, 8)}01`

/** Money in a currency's own units, with its sign: ₹1,23,456.50. */
export const fc = (minor: number | null | undefined, currency = 'INR', minorUnits = 2) =>
  minor === null || minor === undefined ? '' : formatMoney(minor, currency, minorUnits)
export const qty = (milli: number | null | undefined, uom?: string | null) =>
  milli === null || milli === undefined ? '' : `${formatQty(milli)}${uom ? ` ${uom}` : ''}`

const docTone: Record<string, Tone> = { draft: 'gray', submitted: 'blue', cancelled: 'red' }

/** A document's record sidebar and its lifecycle buttons. */
export function docRecord(input: {
  title: string
  subtitle?: string
  status?: { label: string; tone?: Tone }
  docstatus: 'draft' | 'submitted' | 'cancelled'
  id: string
  idField: string
  base: string
  entity: string
  fields: PluginRecord['fields']
  createdAt?: Date | string | null
  submittedAt?: Date | string | null
  cancelReason?: string | null
  roles?: Role[]
  cancel?: boolean
  amend?: boolean
  submit?: boolean
}): PluginRecord {
  const iso = (d: Date | string | null | undefined) => (d instanceof Date ? d.toISOString() : (d ?? null))
  return {
    title: input.title,
    subtitle: input.subtitle,
    status: input.status ?? { label: input.docstatus, tone: docTone[input.docstatus] },
    fields: [...(input.fields ?? []), ...(input.cancelReason ? [{ label: 'Cancelled because', value: input.cancelReason }] : [])],
    createdAt: iso(input.createdAt),
    modifiedAt: iso(input.submittedAt),
    audit: { entity: input.entity, entityId: input.id },
    docStatus: {
      value: input.docstatus,
      id: input.id,
      idField: input.idField,
      submit: input.submit === false ? undefined : `${input.base}/submit`,
      cancel: input.cancel === false ? undefined : `${input.base}/cancel`,
      amend: input.amend === false ? undefined : `${input.base}/amend`,
      roles: input.roles ?? OFFICE,
    },
  }
}

export interface Choices {
  customers: { value: string; label: string }[]
  suppliers: { value: string; label: string }[]
  parties: { value: string; label: string }[]
  items: { value: string; label: string }[]
  stockItems: { value: string; label: string }[]
  assetItems: { value: string; label: string }[]
  warehouses: { value: string; label: string }[]
  accounts: { value: string; label: string }[]
  expenseAccounts: { value: string; label: string }[]
  incomeAccounts: { value: string; label: string }[]
  cashBank: { value: string; label: string }[]
  groups: { value: string; label: string }[]
  taxes: { value: string; label: string }[]
  tds: { value: string; label: string }[]
  costCenters: { value: string; label: string }[]
  funds: { value: string; label: string }[]
  currencies: { value: string; label: string }[]
  categories: { value: string; label: string }[]
  staff: { value: string; label: string }[]
  baseCurrency: string
  stateCode: string | null
}

/** Everything a form might offer, read in one transaction. */
export async function choices(actor: PluginActor): Promise<Choices> {
  const a = as(actor)
  const tenant = tenantOf(a)
  return withTenant(tenant, async (tx) => {
    const ps = await tx
      .select({ id: parties.id, code: parties.code, name: parties.name, c: parties.isCustomer, s: parties.isSupplier })
      .from(parties)
      .where(isNull(parties.archivedAt))
      .orderBy(asc(parties.name))
    const its = await tx
      .select({ id: items.id, code: items.code, name: items.name, uom: items.uom, isStock: items.isStock, isAsset: items.isAsset })
      .from(items)
      .where(isNull(items.archivedAt))
      .orderBy(asc(items.name))
    const ws = await tx
      .select({ id: warehouses.id, code: warehouses.code, name: warehouses.name })
      .from(warehouses)
      .where(and(isNull(warehouses.archivedAt), eq(warehouses.isGroup, false)))
      .orderBy(asc(warehouses.code))
    const acs = await tx
      .select({ id: accounts.id, code: accounts.code, name: accounts.name, type: accounts.type, subtype: accounts.subtype, purpose: accounts.purpose, isGroup: accounts.isGroup })
      .from(accounts)
      .where(isNull(accounts.archivedAt))
      .orderBy(asc(accounts.code))
    const tx_ = await tx.select({ id: taxTemplates.id, name: taxTemplates.name }).from(taxTemplates).where(isNull(taxTemplates.archivedAt)).orderBy(asc(taxTemplates.name))
    const tds = await tx.select({ id: tdsSections.id, code: tdsSections.code, name: tdsSections.name }).from(tdsSections).where(isNull(tdsSections.archivedAt)).orderBy(asc(tdsSections.code))
    const ccs = await tx.select({ code: costCenters.code, name: costCenters.name }).from(costCenters).where(isNull(costCenters.archivedAt)).orderBy(asc(costCenters.code))
    const fs = await tx.select({ id: funds.id, code: funds.code, name: funds.name }).from(funds).where(isNull(funds.archivedAt)).orderBy(asc(funds.code))
    const cats = await tx.select({ id: assetCategories.id, name: assetCategories.name }).from(assetCategories).where(isNull(assetCategories.archivedAt)).orderBy(asc(assetCategories.name))
    const people = await tx
      .select({ id: users.id, name: users.name, email: users.email, role: users.role })
      .from(users)
      .where(sql`${users.role} not in ('student', 'parent', 'pending')`)
      .orderBy(asc(users.name))
    const settings = await settingsWithin(tx, tenant)
    const curr = await currenciesWithin(tx, tenant)
    const party = (p: (typeof ps)[number]) => ({ value: p.id, label: `${p.name} (${p.code})` })
    const leaf = acs.filter((x) => !x.isGroup)
    const acct = (x: (typeof acs)[number]) => ({ value: x.id, label: `${x.code} ${x.name}` })
    return {
      customers: ps.filter((p) => p.c).map(party),
      suppliers: ps.filter((p) => p.s).map(party),
      parties: ps.map(party),
      items: its.map((i) => ({ value: i.id, label: `${i.name} (${i.code}, ${i.uom})` })),
      stockItems: its.filter((i) => i.isStock).map((i) => ({ value: i.id, label: `${i.name} (${i.code}, ${i.uom})` })),
      assetItems: its.filter((i) => i.isAsset).map((i) => ({ value: i.id, label: `${i.name} (${i.code})` })),
      warehouses: ws.map((w) => ({ value: w.id, label: `${w.name} (${w.code})` })),
      accounts: leaf.map(acct),
      expenseAccounts: leaf.filter((x) => x.type === 'expense' || x.subtype === 'fixed_asset' || x.subtype === 'capital_wip').map(acct),
      incomeAccounts: leaf.filter((x) => x.type === 'income').map(acct),
      cashBank: leaf.filter((x) => ['cash', 'bank'].includes(x.subtype ?? x.purpose ?? '')).map(acct),
      groups: acs.filter((x) => x.isGroup).map((x) => ({ value: x.code, label: `${x.code} ${x.name}` })),
      taxes: tx_.map((t) => ({ value: t.id, label: t.name })),
      tds: tds.map((t) => ({ value: t.id, label: `${t.code}: ${t.name}` })),
      costCenters: ccs.map((c) => ({ value: c.code, label: `${c.code} ${c.name}` })),
      funds: fs.map((f) => ({ value: f.id, label: `${f.code} ${f.name}` })),
      currencies: curr.map((c) => ({ value: c.code, label: `${c.code} ${c.name}` })),
      categories: cats.map((c) => ({ value: c.id, label: c.name })),
      staff: people.map((p) => ({ value: p.id, label: `${p.name ?? p.email} (${p.role.replaceAll('_', ' ')})` })),
      baseCurrency: settings.baseCurrency,
      stateCode: settings.stateCode,
    }
  })
}

/** A choice field that is optional, so a blank leaves the default in place. */
export const pick = (name: string, label: string, options: string, extra: Partial<PluginField> = {}): PluginField => ({
  name,
  label,
  kind: 'select',
  options,
  optional: true,
  ...extra,
})

/** The from/to (or on) form a report page filters by: a GET back to itself. */
export const periodLinks = (path: string, from: string, to: string) => [
  { label: 'This month', href: `${path}?from=${monthStart()}&to=${today()}`, active: from === monthStart() && to === today() },
]
