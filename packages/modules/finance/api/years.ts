import { and, asc, eq, gte, lte, sql } from 'drizzle-orm'
import { audit, withTenant } from '@campusos/db'
import * as z from 'zod'
import { ticked } from '@campusos/module-framework'
import { accounts, entries, fiscalYears, lines, settings } from '../schema'
import { FinanceError, named, requireConfigure, requireRead, type Actor, type Tx } from './core'
import { accountFor, postWithin, reverseWithin } from './operations'

/**
 * The institution's settings, and its fiscal years.
 *
 * A fiscal year is created the first time anything is dated in it, from the
 * month the institution's year starts -- April for an Indian college, so the
 * year that starts in April 2026 is "2026-27" -- and closed once, after it has
 * ended, by carrying its income and expenditure to retained surplus.
 */

export type Settings = typeof settings.$inferSelect

const DEFAULTS = {
  baseCurrency: 'INR',
  fiscalYearStartMonth: 4,
  timeZone: 'Asia/Kolkata',
  legalName: null,
  address: null,
  gstin: null,
  stateCode: null,
  pan: null,
  tan: null,
  roundInvoices: true,
  stockValuation: 'moving_average' as const,
  allowNegativeStock: false,
  overReceiptBp: 0,
  blockExpiredBatches: true,
}

export async function settingsWithin(tx: Tx, institutionId: string): Promise<Settings> {
  const [row] = await tx.select().from(settings).where(eq(settings.institutionId, institutionId))
  return row ?? { institutionId, ...DEFAULTS, updatedAt: new Date(0) }
}

/** Today, in the institution's own zone. */
export async function localToday(tx: Tx, institutionId: string): Promise<string> {
  const s = await settingsWithin(tx, institutionId)
  const res = await tx.execute(sql`select (now() at time zone ${s.timeZone})::date::text as day`)
  return String((res.rows[0] as { day: string }).day)
}

const optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v === '' ? undefined : v))

export const updateSettingsSchema = z
  .object({
    baseCurrency: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    fiscalYearStartMonth: z.coerce.number().int().min(1).max(12).optional(),
    timeZone: optional(64),
    legalName: optional(200),
    address: optional(500),
    gstin: optional(15).transform((v) => v?.toUpperCase()),
    stateCode: optional(2),
    pan: optional(10).transform((v) => v?.toUpperCase()),
    tan: optional(10).transform((v) => v?.toUpperCase()),
    roundInvoices: z.preprocess(ticked, z.boolean()).optional(),
    stockValuation: z.enum(['moving_average', 'fifo']).optional(),
    allowNegativeStock: z.preprocess(ticked, z.boolean()).optional(),
    overReceiptPercent: z.coerce.number().min(0).max(100).optional(),
    blockExpiredBatches: z.preprocess(ticked, z.boolean()).optional(),
  })
  .meta({ id: 'FinanceSettings' })

export async function getSettings(actor: Actor) {
  const tenant = requireRead(actor)
  return withTenant(tenant, (tx) => settingsWithin(tx, tenant))
}

/**
 * Change how the books are kept. The base currency and the start of the year
 * are fixed once anything has been posted: every figure already in the books
 * is in that currency and belongs to those years.
 */
export async function updateSettings(actor: Actor, input: unknown) {
  const tenant = requireConfigure(actor)
  const data = updateSettingsSchema.parse(input)

  return withTenant(tenant, (tx) =>
    named(async () => {
      const current = await settingsWithin(tx, tenant)
      const posted = (await tx.select({ id: entries.id }).from(entries).limit(1)).length > 0
      if (posted && data.baseCurrency && data.baseCurrency !== current.baseCurrency) {
        throw new FinanceError(409, 'base_currency_fixed', 'the base currency is fixed once anything is posted')
      }
      if (posted && data.fiscalYearStartMonth && data.fiscalYearStartMonth !== current.fiscalYearStartMonth) {
        throw new FinanceError(409, 'fiscal_year_fixed', 'the start of the fiscal year is fixed once anything is posted')
      }
      if (data.timeZone) {
        try {
          new Intl.DateTimeFormat('en', { timeZone: data.timeZone })
        } catch {
          throw new FinanceError(400, 'time_zone', 'that is not a time zone')
        }
      }
      if (data.gstin && data.stateCode && data.gstin.slice(0, 2) !== data.stateCode) {
        throw new FinanceError(400, 'state_mismatch', 'a GSTIN begins with its state code')
      }

      const values = {
        baseCurrency: data.baseCurrency ?? current.baseCurrency,
        fiscalYearStartMonth: data.fiscalYearStartMonth ?? current.fiscalYearStartMonth,
        timeZone: data.timeZone ?? current.timeZone,
        legalName: data.legalName ?? current.legalName,
        address: data.address ?? current.address,
        gstin: data.gstin ?? current.gstin,
        stateCode: data.stateCode ?? current.stateCode ?? data.gstin?.slice(0, 2) ?? null,
        pan: data.pan ?? current.pan,
        tan: data.tan ?? current.tan,
        roundInvoices: data.roundInvoices ?? current.roundInvoices,
        stockValuation: data.stockValuation ?? current.stockValuation,
        allowNegativeStock: data.allowNegativeStock ?? current.allowNegativeStock,
        overReceiptBp:
          data.overReceiptPercent !== undefined ? Math.round(data.overReceiptPercent * 100) : current.overReceiptBp,
        blockExpiredBatches: data.blockExpiredBatches ?? current.blockExpiredBatches,
        updatedAt: new Date(),
      }
      await tx
        .insert(settings)
        .values({ institutionId: tenant, ...values })
        .onConflictDoUpdate({ target: settings.institutionId, set: values })
      await audit(tx, {
        institutionId: tenant,
        actorId: actor.id,
        actorEmail: actor.email ?? null,
        moduleId: 'finance',
        action: 'settings.updated',
        entity: 'finance_settings',
        entityId: tenant,
        reason: 'settings changed',
        detail: data as Record<string, unknown>,
      })
      return { notice: 'Settings saved.' }
    }),
  )
}

// --- fiscal years ---------------------------------------------------------------

/** The year a date falls in, by the start month: its first and last day and its name. */
export function fiscalBounds(startMonth: number, isoDate: string) {
  const [y, m] = isoDate.split('-').map(Number) as [number, number]
  const startYear = m >= startMonth ? y : y - 1
  const startsOn = `${startYear}-${String(startMonth).padStart(2, '0')}-01`
  const end = new Date(Date.UTC(startYear + 1, startMonth - 1, 0))
  const endsOn = end.toISOString().slice(0, 10)
  const label =
    startMonth === 1 ? String(startYear) : `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`
  const short =
    startMonth === 1
      ? String(startYear % 100).padStart(2, '0')
      : `${String(startYear % 100).padStart(2, '0')}${String((startYear + 1) % 100).padStart(2, '0')}`
  return { startYear, startsOn, endsOn, label, short }
}

export type FiscalYear = typeof fiscalYears.$inferSelect

/**
 * The fiscal year a date falls in, made if it does not exist yet.
 *
 * A year the institution set up by hand -- a long first year, say -- is
 * found by its dates rather than recomputed.
 */
export async function fiscalYearOf(tx: Tx, institutionId: string, isoDate: string): Promise<FiscalYear> {
  const find = async () => {
    const [row] = await tx
      .select()
      .from(fiscalYears)
      .where(and(lte(fiscalYears.startsOn, isoDate), gte(fiscalYears.endsOn, isoDate)))
    return row
  }
  const found = await find()
  if (found) return found
  const s = await settingsWithin(tx, institutionId)
  const b = fiscalBounds(s.fiscalYearStartMonth, isoDate)
  await tx
    .insert(fiscalYears)
    .values({ institutionId, label: b.label, startsOn: b.startsOn, endsOn: b.endsOn })
    .onConflictDoNothing()
  const made = await find()
  if (!made) {
    // A hand-made year overlaps where this one would go without covering the
    // date: the institution's years have a gap, which is theirs to fix.
    throw new FinanceError(409, 'no_fiscal_year', `no fiscal year covers ${isoDate}`)
  }
  return made
}

/** The calendar year a date's fiscal year starts in: what budgets are kept by. */
export async function fiscalYearStart(tx: Tx, institutionId: string, isoDate: string): Promise<number> {
  const fy = await fiscalYearOf(tx, institutionId, isoDate)
  return Number(fy.startsOn.slice(0, 4))
}

/** The short form of a year's name, for document numbers: 2627. */
export async function fiscalShort(tx: Tx, institutionId: string, isoDate: string) {
  const fy = await fiscalYearOf(tx, institutionId, isoDate)
  const startYear = Number(fy.startsOn.slice(0, 4))
  const endYear = Number(fy.endsOn.slice(0, 4))
  const short =
    startYear === endYear
      ? String(startYear % 100).padStart(2, '0')
      : `${String(startYear % 100).padStart(2, '0')}${String(endYear % 100).padStart(2, '0')}`
  return { label: fy.label, short }
}

export async function listFiscalYears(actor: Actor) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) => {
    await fiscalYearOf(tx, tenant, await localToday(tx, tenant))
    return tx.select().from(fiscalYears).orderBy(asc(fiscalYears.startsOn))
  })
}

const yearSchema = z.object({ label: z.string().trim().min(4).max(20) })
const reopenYearSchema = z.object({ label: z.string().trim().min(4).max(20), reason: z.string().trim().min(5).max(500) })

/** Income and expenditure for a year, per account and fund, leaving out any closing of it. */
async function resultForYear(tx: Tx, fy: FiscalYear) {
  const rows = await tx
    .select({
      accountId: lines.accountId,
      type: accounts.type,
      fundId: lines.fundId,
      debit: sql<number>`sum(${lines.debitPaise})::bigint`,
      credit: sql<number>`sum(${lines.creditPaise})::bigint`,
    })
    .from(lines)
    .innerJoin(entries, eq(entries.id, lines.entryId))
    .innerJoin(accounts, eq(accounts.id, lines.accountId))
    .where(
      and(
        gte(entries.postingDate, fy.startsOn),
        lte(entries.postingDate, fy.endsOn),
        sql`${accounts.type} in ('income', 'expense')`,
        sql`${entries.sourceRef} not like 'year-close:%'`,
        // The outer row by name: inside the subquery, a Drizzle column would mean c's own.
        sql`not exists (select 1 from finance_journal_entries c where c.id = finance_journal_entries.reversal_of and c.source_ref like 'year-close:%')`,
      ),
    )
    .groupBy(lines.accountId, accounts.type, lines.fundId)
  return rows.map((r) => ({ ...r, net: Number(r.debit) - Number(r.credit) }))
}

/**
 * Close a fiscal year.
 *
 * Its income and expenditure are carried to retained surplus by one entry on
 * the year's last day -- per fund, so a grant's unspent balance stays the
 * grant's -- and then the year is marked closed, which the database reads on
 * every posting from then on. Refused before the year has ended.
 */
export async function closeFiscalYear(actor: Actor, input: unknown) {
  const tenant = requireConfigure(actor)
  const { label } = yearSchema.parse(input)

  return withTenant(tenant, (tx) =>
    named(async () => {
      const [fy] = await tx.select().from(fiscalYears).where(eq(fiscalYears.label, label)).for('update')
      if (!fy) throw new FinanceError(404, 'no_such_year', 'no such fiscal year')
      if (fy.status === 'closed') throw new FinanceError(409, 'already_closed', 'that year is already closed')
      if (fy.endsOn >= (await localToday(tx, tenant))) {
        throw new FinanceError(409, 'year_not_over', 'that year has not ended yet')
      }

      const result = (await resultForYear(tx, fy)).filter((r) => r.net !== 0)
      let closingEntryId: string | null = null
      if (result.length > 0) {
        const surplus = await accountFor(tx, tenant, 'retained_surplus')
        const byFund = new Map<string | null, number>()
        const entryLines: Record<string, unknown>[] = []
        for (const r of result) {
          // Each income and expense account is brought to nil for the year.
          entryLines.push({
            accountId: r.accountId,
            debitPaise: r.net < 0 ? -r.net : 0,
            creditPaise: r.net > 0 ? r.net : 0,
            fundId: r.fundId,
            memo: 'closed to retained surplus',
          })
          byFund.set(r.fundId, (byFund.get(r.fundId) ?? 0) + r.net)
        }
        for (const [fundId, net] of byFund) {
          if (net === 0) continue
          // Debits exceeding credits is a deficit, which reduces the surplus.
          entryLines.push({
            accountId: surplus,
            debitPaise: net > 0 ? net : 0,
            creditPaise: net < 0 ? -net : 0,
            fundId,
            memo: net < 0 ? 'surplus for the year' : 'deficit for the year',
          })
        }
        const posted = await postWithin(tx, tenant, actor.id, {
          postingDate: fy.endsOn,
          memo: `Fiscal year ${fy.label} closed`,
          sourceModule: 'finance',
          sourceRef: `year-close:${fy.label}:${Date.now()}`,
          lines: entryLines,
        })
        closingEntryId = posted.id
      }

      await tx
        .update(fiscalYears)
        .set({ status: 'closed', closedAt: new Date(), closedBy: actor.id, closingEntryId, reopenedReason: null })
        .where(eq(fiscalYears.id, fy.id))
      await audit(tx, {
        institutionId: tenant,
        actorId: actor.id,
        actorEmail: actor.email ?? null,
        moduleId: 'finance',
        action: 'year.closed',
        entity: 'finance_fiscal_years',
        entityId: fy.id,
        reason: `${fy.label} closed`,
      })
      return { id: fy.id, notice: `${fy.label} is closed. Its result was carried to retained surplus.` }
    }),
  )
}

/** Open a closed year again: the closing entry is reversed, and the reason stays. */
export async function reopenFiscalYear(actor: Actor, input: unknown) {
  const tenant = requireConfigure(actor)
  const { label, reason } = reopenYearSchema.parse(input)

  return withTenant(tenant, (tx) =>
    named(async () => {
      const [fy] = await tx.select().from(fiscalYears).where(eq(fiscalYears.label, label)).for('update')
      if (!fy) throw new FinanceError(404, 'no_such_year', 'no such fiscal year')
      if (fy.status !== 'closed') throw new FinanceError(409, 'not_closed', 'that year is not closed')
      if (
        (await tx
          .select({ id: fiscalYears.id })
          .from(fiscalYears)
          .where(and(eq(fiscalYears.status, 'closed'), gte(fiscalYears.startsOn, fy.endsOn)))).length > 0
      ) {
        throw new FinanceError(409, 'later_year_closed', 'a later year is closed; reopen that one first')
      }
      await tx
        .update(fiscalYears)
        .set({ status: 'open', closedAt: null, closedBy: null, reopenedReason: reason })
        .where(eq(fiscalYears.id, fy.id))
      if (fy.closingEntryId) {
        await reverseWithin(tx, tenant, actor.id, fy.closingEntryId, `year reopened: ${reason}`, fy.endsOn)
        await tx.update(fiscalYears).set({ closingEntryId: null }).where(eq(fiscalYears.id, fy.id))
      }
      await audit(tx, {
        institutionId: tenant,
        actorId: actor.id,
        actorEmail: actor.email ?? null,
        moduleId: 'finance',
        action: 'year.reopened',
        entity: 'finance_fiscal_years',
        entityId: fy.id,
        reason,
      })
      return { id: fy.id, notice: `${fy.label} is open again.` }
    }),
  )
}
