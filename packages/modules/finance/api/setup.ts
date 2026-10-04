import { and, asc, desc, eq, lte, sql } from 'drizzle-orm'
import { audit, users, withTenant } from '@campusos/db'
import * as z from 'zod'
import { ticked } from '@campusos/module-framework'
import {
  approvalRules,
  approvals,
  costCenters,
  currencies,
  exchangeRates,
  funds,
  series,
  seriesCounters,
  staff,
} from '../schema'
import {
  FinanceError,
  hasCapability,
  named,
  requireConfigure,
  requireOperate,
  requireRead,
  type Actor,
  type Tx,
} from './core'
import { parseDecimal } from './numbers'
import { fiscalShort, settingsWithin } from './years'
import { treeOrder } from './operations'

/**
 * The lists the books are kept against: cost centres, funds, currencies and
 * their rates, how documents are numbered, who approves what, and who has been
 * given which job.
 */

const text = (min: number, max: number) => z.string().trim().min(min).max(max)
const optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined))
const id = z.uuid()

async function idByCode(tx: Tx, table: typeof costCenters, code: string | undefined) {
  if (!code) return null
  const [row] = await tx.select({ id: table.id }).from(table).where(eq(table.code, code))
  if (!row) throw new FinanceError(404, 'no_such_cost_center', `no cost centre ${code}`)
  return row.id
}

// --- cost centres ---------------------------------------------------------------

export const costCenterSchema = z
  .object({ code: text(1, 40), name: text(2, 120), parentCode: optional(40) })
  .meta({ id: 'FinanceCostCenter' })

export async function listCostCenters(actor: Actor) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) => treeOrder(await tx.select().from(costCenters)))
}

export async function createCostCenter(actor: Actor, input: unknown) {
  const tenant = requireConfigure(actor)
  const data = costCenterSchema.parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      const [row] = await tx
        .insert(costCenters)
        .values({
          institutionId: tenant,
          code: data.code,
          name: data.name,
          parentId: await idByCode(tx, costCenters, data.parentCode),
        })
        .returning({ id: costCenters.id })
      return { ...row!, notice: `Cost centre ${data.code} added.` }
    }),
  )
}

export async function archiveCostCenter(actor: Actor, input: unknown) {
  const tenant = requireConfigure(actor)
  const data = z.object({ id, archived: z.preprocess(ticked, z.boolean()).default(true) }).parse(input)
  return withTenant(tenant, async (tx) => {
    await tx
      .update(costCenters)
      .set({ archivedAt: data.archived ? new Date() : null })
      .where(eq(costCenters.id, data.id))
    return { notice: data.archived ? 'Cost centre closed.' : 'Cost centre reopened.' }
  })
}

// --- funds ---------------------------------------------------------------------

export const fundSchema = z
  .object({
    code: text(1, 40),
    name: text(2, 160),
    kind: z.enum(['unrestricted', 'restricted', 'endowment', 'grant']),
    grantor: optional(160),
    sanctionRef: optional(120),
    sanctioned: optional(30),
    startsOn: z.iso.date().optional().or(z.literal('').transform(() => undefined)),
    endsOn: z.iso.date().optional().or(z.literal('').transform(() => undefined)),
    note: optional(500),
  })
  .meta({ id: 'FinanceFund' })

export async function listFunds(actor: Actor) {
  const tenant = requireRead(actor)
  return withTenant(tenant, (tx) => tx.select().from(funds).orderBy(asc(funds.code)))
}

export async function createFund(actor: Actor, input: unknown) {
  const tenant = requireConfigure(actor)
  const data = fundSchema.parse(input)
  const sanctionedPaise = data.sanctioned ? parseDecimal(data.sanctioned, 2) : null
  if (data.sanctioned && sanctionedPaise === null) {
    throw new FinanceError(400, 'bad_amount', 'the sanctioned amount is not a number')
  }
  return withTenant(tenant, (tx) =>
    named(async () => {
      const [row] = await tx
        .insert(funds)
        .values({
          institutionId: tenant,
          code: data.code,
          name: data.name,
          kind: data.kind,
          grantor: data.grantor ?? null,
          sanctionRef: data.sanctionRef ?? null,
          sanctionedPaise,
          startsOn: data.startsOn ?? null,
          endsOn: data.endsOn ?? null,
          note: data.note ?? null,
        })
        .returning({ id: funds.id })
      return { ...row!, notice: `Fund ${data.code} added.` }
    }),
  )
}

// --- currencies and rates ---------------------------------------------------------

export const currencySchema = z
  .object({
    code: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
    name: text(2, 60),
    symbol: optional(5),
    minorUnits: z.coerce.number().int().min(0).max(4).default(2),
  })
  .meta({ id: 'FinanceCurrency' })

export const rateSchema = z
  .object({
    currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
    on: z.iso.date(),
    rate: z.string().trim().regex(/^\d{1,10}(\.\d{1,10})?$/, 'a rate like 83.25'),
    source: optional(120),
  })
  .meta({ id: 'FinanceExchangeRate' })

export interface CurrencyInfo {
  code: string
  name: string
  symbol: string | null
  minorUnits: number
}

/** The currencies an institution keeps, its own first. */
export async function currenciesWithin(tx: Tx, institutionId: string): Promise<CurrencyInfo[]> {
  const s = await settingsWithin(tx, institutionId)
  const rows = await tx.select().from(currencies).orderBy(asc(currencies.code))
  const base = rows.find((r) => r.code === s.baseCurrency) ?? {
    code: s.baseCurrency,
    name: s.baseCurrency === 'INR' ? 'Indian Rupee' : s.baseCurrency,
    symbol: s.baseCurrency === 'INR' ? '₹' : null,
    minorUnits: 2,
  }
  return [base, ...rows.filter((r) => r.code !== s.baseCurrency)]
}

export async function minorUnitsOf(tx: Tx, institutionId: string, code: string): Promise<number> {
  const all = await currenciesWithin(tx, institutionId)
  const found = all.find((c) => c.code === code)
  if (!found) throw new FinanceError(400, 'no_such_currency', `${code} is not one of this institution's currencies`)
  return found.minorUnits
}

export async function listCurrencies(actor: Actor) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) => ({
    currencies: await currenciesWithin(tx, tenant),
    rates: await tx.select().from(exchangeRates).orderBy(desc(exchangeRates.on), asc(exchangeRates.currency)).limit(200),
  }))
}

export async function addCurrency(actor: Actor, input: unknown) {
  const tenant = requireConfigure(actor)
  const data = currencySchema.parse(input)
  return withTenant(tenant, async (tx) => {
    await tx
      .insert(currencies)
      .values({ institutionId: tenant, ...data, symbol: data.symbol ?? null })
      .onConflictDoUpdate({
        target: [currencies.institutionId, currencies.code],
        set: { name: data.name, symbol: data.symbol ?? null, minorUnits: data.minorUnits },
      })
    return { notice: `${data.code} added.` }
  })
}

/**
 * A rate somebody typed, for a day. CampusOS fetches none: the accounts office
 * says what rate it used, and the books say who said so.
 */
export async function setRate(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const data = rateSchema.parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      await minorUnitsOf(tx, tenant, data.currency)
      const s = await settingsWithin(tx, tenant)
      if (data.currency === s.baseCurrency) {
        throw new FinanceError(400, 'base_currency', 'the base currency is always worth one')
      }
      await tx
        .insert(exchangeRates)
        .values({
          institutionId: tenant,
          currency: data.currency,
          on: data.on,
          rate: data.rate,
          source: data.source ?? null,
          enteredBy: actor.id,
        })
        .onConflictDoUpdate({
          target: [exchangeRates.institutionId, exchangeRates.currency, exchangeRates.on],
          set: { rate: data.rate, source: data.source ?? null, enteredBy: actor.id },
        })
      return { notice: `${data.currency} on ${data.on}: ${data.rate}` }
    }),
  )
}

/** The rate for a currency on a day: the latest entered on or before it. */
export async function rateOn(tx: Tx, institutionId: string, currency: string, on: string): Promise<string> {
  const s = await settingsWithin(tx, institutionId)
  if (currency === s.baseCurrency) return '1'
  const [row] = await tx
    .select({ rate: exchangeRates.rate })
    .from(exchangeRates)
    .where(and(eq(exchangeRates.currency, currency), lte(exchangeRates.on, on)))
    .orderBy(desc(exchangeRates.on))
    .limit(1)
  if (!row) {
    throw new FinanceError(409, 'no_rate', `no ${currency} rate entered on or before ${on}; enter one first`)
  }
  return row.rate
}

// --- numbering -----------------------------------------------------------------------

/**
 * Default prefixes. `{FYS}` is the fiscal year in four digits (2627) and
 * `{FY}` its name (2026-27). Short, because a GST invoice number may be
 * sixteen characters at most: SI/2627/0001 is twelve.
 */
export const DEFAULT_SERIES: Record<string, string> = {
  journal: 'JV/{FYS}/',
  sales_invoice: 'SI/{FYS}/',
  sales_return: 'SCN/{FYS}/',
  purchase_invoice: 'PI/{FYS}/',
  purchase_return: 'PDN/{FYS}/',
  payment_receive: 'RV/{FYS}/',
  payment_pay: 'PV/{FYS}/',
  payment_transfer: 'CV/{FYS}/',
  stock_entry: 'SE/{FYS}/',
  material_request: 'MR/{FYS}/',
  rfq: 'RFQ/{FYS}/',
  supplier_quotation: 'SQ/{FYS}/',
  purchase_order: 'PO/{FYS}/',
  sales_order: 'SO/{FYS}/',
  quotation: 'QT/{FYS}/',
  purchase_receipt: 'GRN/{FYS}/',
  purchase_receipt_return: 'GRR/{FYS}/',
  delivery_note: 'DN/{FYS}/',
  delivery_note_return: 'DNR/{FYS}/',
  asset: 'FA/{FYS}/',
}

/**
 * The next number for a kind of document, in the fiscal year of `on`.
 *
 * One atomic upsert on the counter row: two submissions racing for the next
 * invoice number get consecutive ones, never the same one, and a submission
 * that fails rolls its number back with it -- so a series has no gaps.
 */
export async function nextNumber(tx: Tx, institutionId: string, docType: string, on: string): Promise<string> {
  const { label, short } = await fiscalShort(tx, institutionId, on)
  const [own] = await tx.select().from(series).where(eq(series.docType, docType))
  const prefix = own?.prefix ?? DEFAULT_SERIES[docType] ?? `${docType.toUpperCase()}/{FYS}/`
  const padding = own?.padding ?? 4
  const res = await tx.execute(sql`
    insert into finance_series_counters (institution_id, doc_type, scope, last_value)
    values (${institutionId}, ${docType}, ${label}, 1)
    on conflict (institution_id, doc_type, scope)
      do update set last_value = finance_series_counters.last_value + 1
    returning last_value`)
  const n = Number((res.rows[0] as { last_value: number }).last_value)
  return `${prefix.replaceAll('{FYS}', short).replaceAll('{FY}', label)}${String(n).padStart(padding, '0')}`
}

export const seriesSchema = z
  .object({
    docType: z.enum(Object.keys(DEFAULT_SERIES) as [string, ...string[]]),
    prefix: text(1, 40),
    padding: z.coerce.number().int().min(1).max(10).default(4),
  })
  .meta({ id: 'FinanceSeries' })

export async function listSeries(actor: Actor) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) => {
    const own = await tx.select().from(series)
    const used = await tx.select().from(seriesCounters)
    return Object.entries(DEFAULT_SERIES).map(([docType, prefix]) => {
      const mine = own.find((s) => s.docType === docType)
      return {
        docType,
        prefix: mine?.prefix ?? prefix,
        padding: mine?.padding ?? 4,
        custom: !!mine,
        issued: used.filter((u) => u.docType === docType).reduce((n, u) => n + u.lastValue, 0),
      }
    })
  })
}

export async function setSeries(actor: Actor, input: unknown) {
  const tenant = requireConfigure(actor)
  const data = seriesSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    await tx
      .insert(series)
      .values({ institutionId: tenant, docType: data.docType, prefix: data.prefix, padding: data.padding })
      .onConflictDoUpdate({
        target: [series.institutionId, series.docType],
        set: { prefix: data.prefix, padding: data.padding },
      })
    return { notice: `Numbering for ${data.docType.replaceAll('_', ' ')} saved.` }
  })
}

// --- approvals ------------------------------------------------------------------------

export const APPROVABLE = ['purchase_order', 'payment_pay', 'journal', 'material_request', 'purchase_invoice'] as const

export const approvalRuleSchema = z
  .object({
    docType: z.enum(APPROVABLE),
    minAmount: text(1, 30),
    approver: z.enum(['institution_admin', 'hod', 'accounts_staff', 'approver']),
  })
  .meta({ id: 'FinanceApprovalRule' })

export async function listApprovalRules(actor: Actor) {
  const tenant = requireRead(actor)
  return withTenant(tenant, (tx) =>
    tx.select().from(approvalRules).orderBy(asc(approvalRules.docType), asc(approvalRules.minAmountPaise)),
  )
}

export async function setApprovalRule(actor: Actor, input: unknown) {
  const tenant = requireConfigure(actor)
  const data = approvalRuleSchema.parse(input)
  const min = parseDecimal(data.minAmount, 2)
  if (min === null || min < 0) throw new FinanceError(400, 'bad_amount', 'say from what amount, in rupees')
  return withTenant(tenant, async (tx) => {
    await tx
      .insert(approvalRules)
      .values({ institutionId: tenant, docType: data.docType, minAmountPaise: min, approver: data.approver })
      .onConflictDoUpdate({
        target: [approvalRules.institutionId, approvalRules.docType, approvalRules.minAmountPaise],
        set: { approver: data.approver },
      })
    return { notice: 'Approval rule saved.' }
  })
}

export async function removeApprovalRule(actor: Actor, input: unknown) {
  const tenant = requireConfigure(actor)
  const data = z.object({ id }).parse(input)
  return withTenant(tenant, async (tx) => {
    await tx.delete(approvalRules).where(eq(approvalRules.id, data.id))
    return { notice: 'Approval rule removed.' }
  })
}

/** A stable fingerprint of what is being approved: change the draft and it changes. */
export function fingerprint(doc: unknown): string {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === 'object' && !(v instanceof Date)
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>)
              .filter(([k]) => !['updatedAt', 'createdAt', 'id'].includes(k))
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, canonical(x)]),
          )
        : v instanceof Date
          ? v.toISOString()
          : v
  // Not cryptographic: it only has to change when the document does.
  const s = JSON.stringify(canonical(doc))
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < s.length; i++) {
    h1 = Math.imul(h1 ^ s.charCodeAt(i), 16777619) >>> 0
    h2 = Math.imul(h2 + s.charCodeAt(i), 2246822519) >>> 0
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}${s.length.toString(16)}`
}

/** The rule a document of this size falls under, if any. */
export async function ruleFor(tx: Tx, docType: string, amountPaise: number) {
  const [rule] = await tx
    .select()
    .from(approvalRules)
    .where(and(eq(approvalRules.docType, docType), lte(approvalRules.minAmountPaise, amountPaise)))
    .orderBy(desc(approvalRules.minAmountPaise))
    .limit(1)
  return rule ?? null
}

export async function mayApprove(tx: Tx, actor: Actor, approver: string) {
  if (actor.role === 'institution_admin' || actor.role === 'super_admin') return true
  if (approver === 'approver') return hasCapability(tx, actor, 'approver')
  return actor.role === approver
}

/**
 * Refuse to submit a document that needs an approval it does not have.
 *
 * An approval counts only if it was given to the document as it stands now:
 * the fingerprint must match. A refusal after the last approval stands until
 * somebody approves again.
 */
export async function assertApproved(tx: Tx, docType: string, docId: string, doc: unknown, amountPaise: number) {
  const rule = await ruleFor(tx, docType, amountPaise)
  if (!rule) return
  const print = fingerprint(doc)
  const [last] = await tx
    .select()
    .from(approvals)
    .where(and(eq(approvals.docType, docType), eq(approvals.docId, docId), eq(approvals.fingerprint, print)))
    .orderBy(desc(approvals.createdAt))
    .limit(1)
  if (!last || last.decision !== 'approved') {
    throw new FinanceError(409, 'needs_approval', `this needs approval by ${rule.approver.replaceAll('_', ' ')} first`, {
      approver: rule.approver,
    })
  }
}

/** Approve or refuse a draft as it stands. */
export async function decide(
  tx: Tx,
  institutionId: string,
  actor: Actor,
  docType: string,
  docId: string,
  doc: unknown,
  amountPaise: number,
  decision: 'approved' | 'rejected',
  note?: string,
) {
  const rule = await ruleFor(tx, docType, amountPaise)
  if (!rule) throw new FinanceError(409, 'no_approval_needed', 'this does not need an approval')
  if (!(await mayApprove(tx, actor, rule.approver))) {
    throw new FinanceError(403, 'forbidden', `approval is for ${rule.approver.replaceAll('_', ' ')}`)
  }
  await named(() =>
    tx.insert(approvals).values({
      institutionId,
      docType,
      docId,
      fingerprint: fingerprint(doc),
      decision,
      decidedBy: actor.id,
      note: note ?? null,
    }),
  )
  await audit(tx, {
    institutionId,
    actorId: actor.id,
    actorEmail: actor.email ?? null,
    moduleId: 'finance',
    action: `${docType}.${decision}`,
    entity: docType,
    entityId: docId,
    reason: note ?? decision,
  })
}

export async function approvalsFor(tx: Tx, docType: string, docId: string) {
  return tx
    .select({
      decision: approvals.decision,
      note: approvals.note,
      createdAt: approvals.createdAt,
      by: users.name,
    })
    .from(approvals)
    .leftJoin(users, eq(users.id, approvals.decidedBy))
    .where(and(eq(approvals.docType, docType), eq(approvals.docId, docId)))
    .orderBy(desc(approvals.createdAt))
}

// --- staff given jobs -------------------------------------------------------------------

export const staffSchema = z
  .object({
    userId: text(1, 100),
    capability: z.enum(['storekeeper', 'purchaser', 'approver']),
    warehouseId: id.optional().or(z.literal('').transform(() => undefined)),
  })
  .meta({ id: 'FinanceStaffJob' })

export async function listStaff(actor: Actor) {
  const tenant = requireRead(actor)
  return withTenant(tenant, (tx) =>
    tx
      .select({
        id: staff.id,
        userId: staff.userId,
        name: users.name,
        email: users.email,
        capability: staff.capability,
        warehouseId: staff.warehouseId,
      })
      .from(staff)
      .innerJoin(users, eq(users.id, staff.userId))
      .orderBy(asc(staff.capability), asc(users.name)),
  )
}

export async function grantJob(actor: Actor, input: unknown) {
  const tenant = requireConfigure(actor)
  const data = staffSchema.parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      const [person] = await tx.select({ role: users.role }).from(users).where(eq(users.id, data.userId))
      if (!person || ['student', 'parent', 'pending'].includes(person.role)) {
        throw new FinanceError(400, 'not_staff', 'only a member of staff is given a job in the books')
      }
      await tx
        .insert(staff)
        .values({
          institutionId: tenant,
          userId: data.userId,
          capability: data.capability,
          warehouseId: data.warehouseId ?? null,
        })
        .onConflictDoUpdate({
          target: [staff.institutionId, staff.userId, staff.capability],
          set: { warehouseId: data.warehouseId ?? null },
        })
      return { notice: `Made ${data.capability}.` }
    }),
  )
}

export async function revokeJob(actor: Actor, input: unknown) {
  const tenant = requireConfigure(actor)
  const data = z.object({ id }).parse(input)
  return withTenant(tenant, async (tx) => {
    await tx.delete(staff).where(eq(staff.id, data.id))
    return { notice: 'Job taken back.' }
  })
}

/** Staff who could be given a job: for the picker. */
export async function staffChoices(tx: Tx) {
  const rows = await tx
    .select({ id: users.id, name: users.name, email: users.email, role: users.role })
    .from(users)
    .where(sql`${users.role} not in ('student', 'parent', 'pending')`)
    .orderBy(asc(users.name))
  return rows.map((r) => ({ value: r.id, label: `${r.name ?? r.email} (${r.role.replaceAll('_', ' ')})` }))
}
