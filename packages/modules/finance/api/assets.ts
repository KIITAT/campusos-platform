import { and, asc, desc, eq, inArray, isNull, lte, sql } from 'drizzle-orm'
import { cancelDocument, submitDocument, users, withTenant } from '@campusos/db'
import * as z from 'zod'
import { ticked } from '@campusos/module-framework'
import { assetCategories, assetEvents, assets, depreciationSchedule, warehouses } from '../schema'
import { FinanceError, named, requireConfigure, requireOperate, requireRead, type Actor, type Tx } from './core'
import { addDays, bpOf, daysBetween, divRound, monthEnd, parseDecimal } from './numbers'
import { accountFor, postWithin, reverseWithin } from './operations'
import { nextNumber } from './setup'
import { fiscalBounds, localToday, settingsWithin } from './years'

/**
 * Fixed assets: capitalised, depreciated, moved, looked after, counted, and
 * in the end sold or scrapped.
 *
 * Submitting an asset puts it in the books and writes its depreciation
 * schedule, period by period to the end of its life; a run posts whatever has
 * fallen due. Straight line spreads what is to be depreciated evenly over the
 * days of its remaining life; written down value takes the year's rate of
 * what was left at the start of each year. Either way the first period is
 * charged only for the days the asset was in use, and the schedule adds up to
 * the paisa: the last period takes what rounding left.
 */

const MODULE = 'finance'
const optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined))
const optionalId = z
  .uuid()
  .optional()
  .or(z.literal('').transform(() => undefined))
const optionalDate = z.iso
  .date()
  .optional()
  .or(z.literal('').transform(() => undefined))

const money = (v: string | undefined, what: string) => {
  if (!v) return 0
  const n = parseDecimal(v, 2)
  if (n === null || n < 0) throw new FinanceError(400, 'bad_amount', `${what} is not an amount`)
  return n
}

// --- categories ---------------------------------------------------------------------

export const assetCategorySchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    method: z.enum(['slm', 'wdv', 'none']),
    lifeYears: optional(6),
    ratePercent: optional(8),
    residualPercent: optional(8),
    frequency: z.enum(['month', 'year']).default('month'),
    assetAccountId: optionalId,
    accumulatedAccountId: optionalId,
    depreciationAccountId: optionalId,
  })
  .meta({ id: 'FinanceAssetCategory' })

export async function createAssetCategory(actor: Actor, input: unknown) {
  const tenant = requireConfigure(actor)
  const data = assetCategorySchema.parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      const life = data.lifeYears ? parseDecimal(data.lifeYears, 2) : null
      const rate = data.ratePercent ? parseDecimal(data.ratePercent, 2) : null
      const residual = data.residualPercent ? parseDecimal(data.residualPercent, 2) : 0
      if (data.method === 'slm' && (!life || life <= 0)) throw new FinanceError(400, 'finance_asset_categories_basis', 'straight line needs a life in years')
      if (data.method === 'wdv' && (!rate || rate <= 0)) throw new FinanceError(400, 'finance_asset_categories_basis', 'written down value needs a rate')
      const [row] = await tx
        .insert(assetCategories)
        .values({
          institutionId: tenant,
          name: data.name,
          method: data.method,
          // Years as typed, in whole months: 2.5 years is 30 months.
          lifeMonths: life ? Math.round((life * 12) / 100) : null,
          rateBp: rate,
          residualBp: residual ?? 0,
          frequency: data.frequency,
          assetAccountId: data.assetAccountId ?? (await accountFor(tx, tenant, 'fixed_assets')),
          accumulatedAccountId: data.accumulatedAccountId ?? (await accountFor(tx, tenant, 'accumulated_depreciation')),
          depreciationAccountId: data.depreciationAccountId ?? (await accountFor(tx, tenant, 'depreciation_expense')),
        })
        .returning({ id: assetCategories.id })
      return { ...row!, notice: `${data.name} added.` }
    }),
  )
}

export async function listAssetCategories(actor: Actor) {
  const tenant = requireRead(actor)
  return withTenant(tenant, (tx) => tx.select().from(assetCategories).orderBy(asc(assetCategories.name)))
}

// --- the schedule --------------------------------------------------------------------

export interface ScheduleInput {
  method: 'slm' | 'wdv' | 'none'
  lifeMonths: number | null
  rateBp: number | null
  residualBp: number
  frequency: 'month' | 'year'
  fyStartMonth: number
  gross: number
  /** Depreciation already charged before `from`. */
  accumulated: number
  /** The first day charged. */
  from: string
  /** Straight line: months of life already used before `from`. */
  usedMonths: number
}

export interface ScheduleRow {
  periodEnd: string
  amount: number
  accumulatedAfter: number
}

/** Whole months from one date to another, counting a part month as none. */
export function monthsBetween(from: string, to: string): number {
  const [y1, m1, d1] = from.split('-').map(Number) as [number, number, number]
  const [y2, m2, d2] = to.split('-').map(Number) as [number, number, number]
  return Math.max((y2 - y1) * 12 + (m2 - m1) - (d2 < d1 ? 1 : 0), 0)
}

/** Each period's end from `from` on: month ends, or fiscal year ends. */
function periodEnd(day: string, s: ScheduleInput) {
  return s.frequency === 'month' ? monthEnd(day) : fiscalBounds(s.fyStartMonth, day).endsOn
}

export function depreciationScheduleFor(s: ScheduleInput): ScheduleRow[] {
  if (s.method === 'none') return []
  const residual = bpOf(s.gross, s.residualBp)
  const rows: ScheduleRow[] = []
  let accumulated = s.accumulated

  if (s.method === 'slm') {
    const remainingMonths = Math.max((s.lifeMonths ?? 0) - s.usedMonths, 1)
    const toCharge = Math.max(s.gross - residual - s.accumulated, 0)
    if (toCharge === 0) return []
    // An equal charge for every whole month of the life left; a part month at
    // either end is charged for its share of that month's days. Months are
    // gathered into the period they end in, and each period is the rounded
    // running total less what the periods before it took -- so the schedule
    // comes to exactly what is to be depreciated.
    const lastDay = addDays(addMonthsIso(s.from, remainingMonths), -1)
    const perMonth = toCharge / remainingMonths
    let exact = 0
    let charged = 0
    let start = s.from
    while (start <= lastDay) {
      const end = periodEnd(start, s) > lastDay ? lastDay : periodEnd(start, s)
      for (let day = start; day <= end; ) {
        const sliceEnd = monthEnd(day) > end ? end : monthEnd(day)
        const inMonth = Number(monthEnd(day).slice(8, 10))
        exact += (perMonth * (daysBetween(day, sliceEnd) + 1)) / inMonth
        day = addDays(sliceEnd, 1)
      }
      const cum = end === lastDay ? toCharge : Math.min(Math.round(exact), toCharge)
      const amount = cum - charged
      charged = cum
      accumulated += amount
      rows.push({ periodEnd: end, amount, accumulatedAfter: accumulated })
      start = addDays(end, 1)
    }
    return rows
  }

  // Written down value: each fiscal year charges its rate on what was left
  // when it began -- or, in the first year, when the asset came into use --
  // for the days of the year it was in use, spread over the year's periods.
  const rate = s.rateBp ?? 0
  if (rate <= 0) return []
  let start = s.from
  for (let year = 0; year < 100; year++) {
    const atStart = s.gross - accumulated
    if (atStart <= residual) break
    const fy = fiscalBounds(s.fyStartMonth, start)
    const yearDays = BigInt(daysBetween(fy.startsOn, fy.endsOn) + 1)
    if (divRound(BigInt(atStart) * BigInt(rate), 10_000n) === 0n) break
    const firstDay = start
    let charged = 0
    let finished = false
    while (start <= fy.endsOn) {
      const pe = periodEnd(start, s)
      const end = pe > fy.endsOn ? fy.endsOn : pe
      const cumDays = BigInt(daysBetween(firstDay, end) + 1)
      const cum = Number(divRound(BigInt(atStart) * BigInt(rate) * cumDays, 10_000n * yearDays))
      let amount = cum - charged
      charged = cum
      if (s.gross - accumulated - amount <= residual) {
        amount = s.gross - accumulated - residual
        finished = true
      }
      if (amount > 0) {
        accumulated += amount
        rows.push({ periodEnd: end, amount, accumulatedAfter: accumulated })
      }
      start = addDays(end, 1)
      if (finished) break
    }
    if (finished) break
  }
  return rows
}

function addMonthsIso(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  const target = new Date(Date.UTC(y, m - 1 + months, d))
  return target.toISOString().slice(0, 10)
}

// --- assets -------------------------------------------------------------------------

export const assetSchema = z
  .object({
    assetId: optionalId,
    name: z.string().trim().min(2).max(200),
    categoryId: z.uuid(),
    itemId: optionalId,
    purchasedOn: z.iso.date(),
    inUseOn: optionalDate,
    gross: z.string().trim().min(1).max(24),
    /** Brought in from earlier books, with what had been depreciated by then. */
    existing: z.preprocess(ticked, z.boolean()).default(false),
    openingAccumulated: optional(24),
    /** For an asset brought in: the day these books start charging it. */
    depreciateFrom: optionalDate,
    /** What a new asset not bought on an invoice is paid for from: work in progress, a grant, a donation. */
    creditAccountId: optionalId,
    locationId: optionalId,
    custodianId: optional(80),
    costCenter: optional(80),
    fundId: optionalId,
    warrantyTill: optionalDate,
    insuredTill: optionalDate,
    tagCode: optional(60),
    note: optional(1000),
    submit: z.preprocess(ticked, z.boolean()).default(false),
  })
  .meta({ id: 'FinanceAsset' })

export async function saveAsset(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const data = assetSchema.parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      const gross = money(data.gross, 'the cost')
      if (gross <= 0) throw new FinanceError(400, 'bad_amount', 'an asset costs something')
      const opening = data.existing ? money(data.openingAccumulated, 'the depreciation already charged') : 0
      const values = {
        name: data.name,
        categoryId: data.categoryId,
        itemId: data.itemId ?? null,
        purchasedOn: data.purchasedOn,
        inUseOn: data.inUseOn ?? data.purchasedOn,
        grossPaise: gross,
        openingAccumulatedPaise: opening,
        existing: (data.existing ? 'yes' : 'no') as 'yes' | 'no',
        locationId: data.locationId ?? null,
        custodianId: data.custodianId ?? null,
        costCenter: data.costCenter ?? null,
        fundId: data.fundId ?? null,
        warrantyTill: data.warrantyTill ?? null,
        insuredTill: data.insuredTill ?? null,
        tagCode: data.tagCode ?? null,
        note: data.note ?? null,
      }
      let id = data.assetId
      if (id) {
        const [row] = await tx.select().from(assets).where(eq(assets.id, id)).for('update')
        if (!row || row.docstatus !== 'draft') throw new FinanceError(409, 'not_a_draft', 'only a draft is edited')
        // An asset bought on an invoice keeps the cost the invoice posted.
        await tx
          .update(assets)
          .set(row.invoiceLineId ? { ...values, grossPaise: row.grossPaise, existing: 'no', openingAccumulatedPaise: 0 } : values)
          .where(eq(assets.id, id))
      } else {
        const [row] = await tx.insert(assets).values({ ...values, institutionId: tenant, createdBy: actor.id }).returning({ id: assets.id })
        id = row!.id
      }
      if (data.submit) return submitAssetWithin(tx, actor, id!, { depreciateFrom: data.depreciateFrom, creditAccountId: data.creditAccountId })
      return { id, notice: 'Saved as a draft.', next: `/m/finance/asset?id=${id}` }
    }),
  )
}

export async function submitAsset(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const data = z.object({ assetId: z.uuid(), depreciateFrom: optionalDate, creditAccountId: optionalId }).parse(input)
  return withTenant(tenant, (tx) => named(() => submitAssetWithin(tx, actor, data.assetId, data)))
}

async function writeSchedule(tx: Tx, institutionId: string, asset: typeof assets.$inferSelect, from: string, accumulated: number) {
  const [cat] = await tx.select().from(assetCategories).where(eq(assetCategories.id, asset.categoryId))
  const settings = await settingsWithin(tx, institutionId)
  const rows = depreciationScheduleFor({
    method: cat!.method,
    lifeMonths: cat!.lifeMonths,
    rateBp: cat!.rateBp,
    residualBp: cat!.residualBp,
    frequency: cat!.frequency,
    fyStartMonth: settings.fiscalYearStartMonth,
    gross: asset.grossPaise,
    accumulated,
    from,
    usedMonths: monthsBetween(asset.inUseOn, from),
  })
  if (rows.length) {
    await tx.insert(depreciationSchedule).values(
      rows.map((r) => ({ institutionId, assetId: asset.id, periodEnd: r.periodEnd, amountPaise: r.amount, accumulatedAfterPaise: r.accumulatedAfter })),
    )
  }
  return rows.length
}

async function submitAssetWithin(tx: Tx, actor: Actor, assetId: string, opts: { depreciateFrom?: string; creditAccountId?: string }) {
  const tenant = actor.institutionId!
  const [a] = await tx.select().from(assets).where(eq(assets.id, assetId)).for('update')
  if (!a) throw new FinanceError(404, 'no_such_asset', 'no such asset')
  if (a.docstatus !== 'draft') throw new FinanceError(409, 'not_a_draft', 'that asset is not a draft')
  const [cat] = await tx.select().from(assetCategories).where(eq(assetCategories.id, a.categoryId))
  const today = await localToday(tx, tenant)
  const number = await nextNumber(tx, tenant, 'asset', a.inUseOn > today ? today : a.inUseOn)

  // Bought on an invoice: the invoice already posted its cost. Brought in from
  // earlier books: its cost and what it had depreciated come in against the
  // opening balance. Anything else is paid for from the account named.
  let entryId: string | null = null
  let from = a.inUseOn
  if (a.existing === 'yes') {
    const settings = await settingsWithin(tx, tenant)
    from = opts.depreciateFrom ?? fiscalBounds(settings.fiscalYearStartMonth, today).startsOn
    if (from < a.inUseOn) from = a.inUseOn
    const lines = [
      { accountId: cat!.assetAccountId, debitPaise: a.grossPaise, creditPaise: 0, costCenter: a.costCenter, fundId: a.fundId },
      { accountId: await accountFor(tx, tenant, 'opening_balance'), debitPaise: 0, creditPaise: a.grossPaise - a.openingAccumulatedPaise },
    ]
    if (a.openingAccumulatedPaise) lines.push({ accountId: cat!.accumulatedAccountId, debitPaise: 0, creditPaise: a.openingAccumulatedPaise })
    const posted = await postWithin(tx, tenant, actor.id, {
      postingDate: addDays(from, -1) < a.purchasedOn ? a.purchasedOn : addDays(from, -1),
      memo: `${number} ${a.name}, brought into the books`.slice(0, 200),
      sourceModule: MODULE,
      sourceRef: `asset:${assetId}`,
      lines: lines.filter((l) => l.debitPaise || l.creditPaise),
    })
    entryId = posted.id
  } else if (!a.invoiceLineId) {
    const credit = opts.creditAccountId ?? (await accountFor(tx, tenant, 'capital_wip'))
    const posted = await postWithin(tx, tenant, actor.id, {
      postingDate: a.inUseOn > today ? today : a.inUseOn,
      memo: `${number} ${a.name}, capitalised`.slice(0, 200),
      sourceModule: MODULE,
      sourceRef: `asset:${assetId}`,
      lines: [
        { accountId: cat!.assetAccountId, debitPaise: a.grossPaise, creditPaise: 0, costCenter: a.costCenter, fundId: a.fundId },
        { accountId: credit, debitPaise: 0, creditPaise: a.grossPaise, fundId: a.fundId },
      ],
    })
    entryId = posted.id
  }

  await tx.update(assets).set({ number, entryId }).where(eq(assets.id, assetId))
  await submitDocument(tx, assets, assetId, { institutionId: tenant, actorId: actor.id, actorEmail: actor.email, moduleId: MODULE })
  const [fresh] = await tx.select().from(assets).where(eq(assets.id, assetId))
  const periods = await writeSchedule(tx, tenant, fresh!, from, a.openingAccumulatedPaise)
  return { id: assetId, number, periods, notice: `${number} capitalised; ${periods} period(s) of depreciation scheduled.`, next: `/m/finance/asset?id=${assetId}` }
}

export async function cancelAsset(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const data = z.object({ assetId: z.uuid(), reason: z.string().trim().min(5).max(300) }).parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      const [a] = await tx.select().from(assets).where(eq(assets.id, data.assetId)).for('update')
      if (!a) throw new FinanceError(404, 'no_such_asset', 'no such asset')
      await cancelDocument(tx, assets, a.id, { institutionId: tenant, actorId: actor.id, actorEmail: actor.email, moduleId: MODULE, reason: data.reason })
      await tx.delete(depreciationSchedule).where(and(eq(depreciationSchedule.assetId, a.id), isNull(depreciationSchedule.entryId)))
      if (a.entryId) await reverseWithin(tx, tenant, actor.id, a.entryId, data.reason)
      return { notice: `${a.number} cancelled.` }
    }),
  )
}

export async function deleteAsset(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const { assetId } = z.object({ assetId: z.uuid() }).parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      await tx.delete(assets).where(eq(assets.id, assetId))
      return { notice: 'Draft deleted.', next: '/m/finance/assets' }
    }),
  )
}

// --- depreciation runs ---------------------------------------------------------------

/** What an asset has depreciated by a day: before these books, posted since, and written down. */
async function accumulatedOf(tx: Tx, assetId: string, on?: string) {
  const [a] = await tx.select().from(assets).where(eq(assets.id, assetId))
  const [posted] = await tx
    .select({ v: sql<number>`coalesce(sum(${depreciationSchedule.amountPaise}), 0)::bigint` })
    .from(depreciationSchedule)
    .where(and(eq(depreciationSchedule.assetId, assetId), sql`${depreciationSchedule.entryId} is not null`, on ? lte(depreciationSchedule.periodEnd, on) : undefined))
  const [impaired] = await tx
    .select({ v: sql<number>`coalesce(sum(${assetEvents.amountPaise}), 0)::bigint` })
    .from(assetEvents)
    .where(and(eq(assetEvents.assetId, assetId), eq(assetEvents.kind, 'impairment'), on ? lte(assetEvents.on, on) : undefined))
  return (a?.openingAccumulatedPaise ?? 0) + Number(posted?.v ?? 0) + Number(impaired?.v ?? 0)
}

/** Where an asset is charged now: its last transfer's cost centre, or its own. */
async function currentCostCenter(tx: Tx, a: typeof assets.$inferSelect) {
  const [last] = await tx
    .select({ c: assetEvents.toCostCenter })
    .from(assetEvents)
    .where(and(eq(assetEvents.assetId, a.id), eq(assetEvents.kind, 'transfer'), sql`${assetEvents.toCostCenter} is not null`))
    .orderBy(desc(assetEvents.on), desc(assetEvents.createdAt))
    .limit(1)
  return last?.c ?? a.costCenter
}

async function postDue(tx: Tx, actor: Actor, upTo: string, assetIds?: string[]) {
  const tenant = actor.institutionId!
  const due = await tx
    .select({ row: depreciationSchedule, asset: assets, cat: assetCategories })
    .from(depreciationSchedule)
    .innerJoin(assets, eq(assets.id, depreciationSchedule.assetId))
    .innerJoin(assetCategories, eq(assetCategories.id, assets.categoryId))
    .where(
      and(
        isNull(depreciationSchedule.entryId),
        lte(depreciationSchedule.periodEnd, upTo),
        eq(assets.docstatus, 'submitted'),
        assetIds ? inArray(assets.id, assetIds) : undefined,
        sql`not exists (select 1 from finance_asset_events e where e.asset_id = "finance_assets"."id" and e.kind in ('sold', 'scrapped'))`,
      ),
    )
    .orderBy(asc(depreciationSchedule.periodEnd))
  const byPeriod = new Map<string, typeof due>()
  for (const d of due) {
    if (d.row.amountPaise === 0) continue
    byPeriod.set(d.row.periodEnd, [...(byPeriod.get(d.row.periodEnd) ?? []), d])
  }
  let rows = 0
  for (const [periodEnd, ds] of byPeriod) {
    const lines = []
    for (const d of ds) {
      const costCenter = await currentCostCenter(tx, d.asset)
      lines.push({ accountId: d.cat.depreciationAccountId, debitPaise: d.row.amountPaise, creditPaise: 0, costCenter, fundId: d.asset.fundId, memo: d.asset.number })
      lines.push({ accountId: d.cat.accumulatedAccountId, debitPaise: 0, creditPaise: d.row.amountPaise, fundId: d.asset.fundId, memo: d.asset.number })
    }
    const posted = await postWithin(tx, tenant, actor.id, {
      postingDate: periodEnd,
      memo: `Depreciation to ${periodEnd} (${ds.length} asset${ds.length === 1 ? '' : 's'})`,
      sourceModule: MODULE,
      sourceRef: `depreciation:${periodEnd}:${ds.map((d) => d.row.id).sort()[0]}`,
      lines,
    })
    await tx
      .update(depreciationSchedule)
      .set({ entryId: posted.id })
      .where(inArray(depreciationSchedule.id, ds.map((d) => d.row.id)))
    rows += ds.length
  }
  return rows
}

/** Post every period of depreciation that has ended by a day. A monthly job calls this; so does the button. */
export async function postDepreciation(actor: Actor, input: unknown = {}) {
  const tenant = requireOperate(actor)
  const data = z.object({ upTo: optionalDate }).parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      const upTo = data.upTo ?? (await localToday(tx, tenant))
      const rows = await postDue(tx, actor, upTo)
      return { rows, notice: rows ? `${rows} period(s) of depreciation posted.` : 'Nothing was due.' }
    }),
  )
}

// --- what happens to an asset -----------------------------------------------------------

export const assetEventSchema = z
  .object({
    assetId: z.uuid(),
    kind: z.enum(['transfer', 'maintenance', 'verification', 'impairment', 'sold', 'scrapped']),
    on: optionalDate,
    toLocationId: optionalId,
    toCustodianId: optional(80),
    toCostCenter: optional(80),
    cost: optional(24),
    amount: optional(24),
    vendorId: optionalId,
    finding: z.enum(['found', 'elsewhere', 'missing', '']).optional().transform((v) => (v ? v : undefined)),
    nextDueOn: optionalDate,
    note: optional(1000),
    /** On a sale: the cash or bank account the money went into. */
    proceedsAccountId: optionalId,
  })
  .meta({ id: 'FinanceAssetEvent' })

export async function recordAssetEvent(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const data = assetEventSchema.parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      const [a] = await tx.select().from(assets).where(eq(assets.id, data.assetId)).for('update')
      if (!a) throw new FinanceError(404, 'no_such_asset', 'no such asset')
      const [cat] = await tx.select().from(assetCategories).where(eq(assetCategories.id, a.categoryId))
      const on = data.on ?? (await localToday(tx, tenant))
      if (on < a.inUseOn) throw new FinanceError(400, 'before_use', 'that is before the asset was in use')
      if (data.kind === 'verification' && !data.finding) throw new FinanceError(400, 'finding_required', 'say what the count found')
      if (data.kind === 'transfer' && !data.toLocationId && !data.toCustodianId && !data.toCostCenter) {
        throw new FinanceError(400, 'transfer_to', 'say where it went, or to whom')
      }
      const costPaise = data.cost ? money(data.cost, 'the cost') : null
      let amountPaise = data.amount ? money(data.amount, 'the amount') : null
      let entryId: string | null = null
      const costCenter = await currentCostCenter(tx, a)

      if (data.kind === 'impairment' || data.kind === 'sold' || data.kind === 'scrapped') {
        // Whatever fell due before the day is charged first.
        await postDue(tx, actor, on, [a.id])
        const accumulated = await accumulatedOf(tx, a.id)
        const nbv = a.grossPaise - accumulated

        if (data.kind === 'impairment') {
          if (!amountPaise || amountPaise > nbv) throw new FinanceError(400, 'bad_amount', `an impairment writes down no more than the ${nbv / 100} left`)
          const posted = await postWithin(tx, tenant, actor.id, {
            postingDate: on,
            memo: `${a.number} ${a.name}: written down`.slice(0, 200),
            sourceModule: MODULE,
            sourceRef: `asset-impairment:${a.id}:${on}:${Date.now()}`,
            lines: [
              { accountId: cat!.depreciationAccountId, debitPaise: amountPaise, creditPaise: 0, costCenter, fundId: a.fundId, memo: 'Impairment' },
              { accountId: cat!.accumulatedAccountId, debitPaise: 0, creditPaise: amountPaise, fundId: a.fundId },
            ],
          })
          entryId = posted.id
        } else {
          amountPaise = data.kind === 'sold' ? (amountPaise ?? 0) : 0
          if (data.kind === 'sold' && amountPaise > 0 && !data.proceedsAccountId) {
            throw new FinanceError(400, 'proceeds_account', 'say which cash or bank account the money went into')
          }
          const gainLoss = nbv - amountPaise
          const lines = [
            { accountId: cat!.accumulatedAccountId, debitPaise: accumulated, creditPaise: 0, fundId: a.fundId },
            { accountId: cat!.assetAccountId, debitPaise: 0, creditPaise: a.grossPaise, fundId: a.fundId },
          ]
          if (amountPaise > 0) lines.push({ accountId: data.proceedsAccountId!, debitPaise: amountPaise, creditPaise: 0, fundId: a.fundId })
          if (gainLoss !== 0) {
            lines.push({
              accountId: await accountFor(tx, tenant, 'asset_disposal'),
              debitPaise: Math.max(gainLoss, 0),
              creditPaise: Math.max(-gainLoss, 0),
              fundId: a.fundId,
            })
          }
          const posted = await postWithin(tx, tenant, actor.id, {
            postingDate: on,
            memo: `${a.number} ${a.name}: ${data.kind}`.slice(0, 200),
            sourceModule: MODULE,
            sourceRef: `asset-disposal:${a.id}`,
            lines: lines.filter((l) => l.debitPaise || l.creditPaise),
          })
          entryId = posted.id
        }
        // The rest of the schedule will not happen as written.
        await tx.delete(depreciationSchedule).where(and(eq(depreciationSchedule.assetId, a.id), isNull(depreciationSchedule.entryId)))
      }

      await tx.insert(assetEvents).values({
        institutionId: tenant,
        assetId: a.id,
        kind: data.kind,
        on,
        toLocationId: data.toLocationId ?? null,
        toCustodianId: data.toCustodianId ?? null,
        toCostCenter: data.toCostCenter ?? null,
        costPaise,
        amountPaise,
        vendorId: data.vendorId ?? null,
        finding: data.finding ?? null,
        nextDueOn: data.nextDueOn ?? null,
        note: data.note ?? null,
        entryId,
        recordedBy: actor.id,
      })

      // Written down: what is left is spread over what is left of its life.
      if (data.kind === 'impairment') {
        await writeSchedule(tx, tenant, a, addDays(on, 1), await accumulatedOf(tx, a.id))
      }
      return { notice: { transfer: 'Moved.', maintenance: 'Maintenance recorded.', verification: 'Count recorded.', impairment: 'Written down and rescheduled.', sold: 'Sold, and taken out of the books.', scrapped: 'Scrapped, and taken out of the books.' }[data.kind] }
    }),
  )
}

// --- reading ------------------------------------------------------------------------

/** The fixed asset register on a day: cost, depreciation to date, and what is left. */
export async function assetRegister(actor: Actor, input: { on?: string; categoryId?: string; status?: string } = {}) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) => {
    const on = input.on ?? (await localToday(tx, tenant))
    const rows = await tx
      .select({
        a: assets,
        category: assetCategories.name,
        custodian: users.name,
        location: warehouses.name,
        depreciated: sql<number>`(select coalesce(sum(d.amount_paise), 0) from finance_depreciation_schedule d where d.asset_id = "finance_assets"."id" and d.entry_id is not null and d.period_end <= ${on})::bigint`,
        impaired: sql<number>`(select coalesce(sum(e.amount_paise), 0) from finance_asset_events e where e.asset_id = "finance_assets"."id" and e.kind = 'impairment' and e.on <= ${on})::bigint`,
        disposedOn: sql<string | null>`(select min(e.on)::text from finance_asset_events e where e.asset_id = "finance_assets"."id" and e.kind in ('sold', 'scrapped'))`,
      })
      .from(assets)
      .innerJoin(assetCategories, eq(assetCategories.id, assets.categoryId))
      .leftJoin(users, eq(users.id, assets.custodianId))
      .leftJoin(warehouses, eq(warehouses.id, assets.locationId))
      .where(and(input.categoryId ? eq(assets.categoryId, input.categoryId) : undefined, sql`${assets.docstatus} <> 'cancelled'`))
      .orderBy(asc(assets.number), asc(assets.name))
    return rows
      .map((r) => {
        const accumulated = r.a.openingAccumulatedPaise + Number(r.depreciated) + Number(r.impaired)
        const disposed = !!r.disposedOn && r.disposedOn <= on
        return {
          ...r.a,
          category: r.category,
          custodian: r.custodian,
          location: r.location,
          accumulatedPaise: disposed ? 0 : accumulated,
          netPaise: disposed || r.a.docstatus === 'draft' ? 0 : r.a.grossPaise - accumulated,
          status: r.a.docstatus === 'draft' ? 'draft' : disposed ? 'disposed' : 'in_use',
          disposedOn: r.disposedOn,
        }
      })
      .filter((r) => !input.status || r.status === input.status)
  })
}

export async function assetDetail(actor: Actor, assetId: string) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) => {
    const [a] = await tx.select().from(assets).where(eq(assets.id, assetId))
    if (!a) throw new FinanceError(404, 'no_such_asset', 'no such asset')
    const [cat] = await tx.select().from(assetCategories).where(eq(assetCategories.id, a.categoryId))
    const schedule = await tx.select().from(depreciationSchedule).where(eq(depreciationSchedule.assetId, assetId)).orderBy(asc(depreciationSchedule.periodEnd))
    const events = await tx
      .select({ e: assetEvents, by: users.name })
      .from(assetEvents)
      .leftJoin(users, eq(users.id, assetEvents.recordedBy))
      .where(eq(assetEvents.assetId, assetId))
      .orderBy(desc(assetEvents.on), desc(assetEvents.createdAt))
    const accumulated = await accumulatedOf(tx, assetId)
    return { asset: a, category: cat, schedule, events: events.map((x) => ({ ...x.e, recordedByName: x.by })), accumulatedPaise: accumulated, netPaise: a.grossPaise - accumulated }
  })
}

/** Maintenance that has fallen due, or falls due within `days`, by the last record of each asset. */
export async function maintenanceDue(actor: Actor, input: { days?: number } = {}) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) => {
    const today = await localToday(tx, tenant)
    const res = await tx.execute(sql`
      select distinct on (e.asset_id) e.asset_id, a.number, a.name, e.next_due_on::text as next_due_on, e.on::text as last_on
        from finance_asset_events e join finance_assets a on a.id = e.asset_id
       where e.kind = 'maintenance' and a.docstatus = 'submitted'
       order by e.asset_id, e.on desc, e.created_at desc`)
    const limit = addDays(today, input.days ?? 30)
    return (res.rows as { asset_id: string; number: string; name: string; next_due_on: string | null; last_on: string }[])
      .filter((r) => r.next_due_on && r.next_due_on <= limit)
      .map((r) => ({ assetId: r.asset_id, number: r.number, name: r.name, nextDueOn: r.next_due_on!, lastOn: r.last_on, overdue: r.next_due_on! < today }))
      .sort((a, b) => a.nextDueOn.localeCompare(b.nextDueOn))
  })
}

/** Depreciation for a period, by category: the schedule's rows that end in it, posted or not. */
export async function depreciationReport(actor: Actor, input: { from: string; to: string }) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) => {
    const res = await tx.execute(sql`
      select c.name as category, count(distinct d.asset_id)::int as assets,
             coalesce(sum(d.amount_paise), 0)::bigint as amount,
             coalesce(sum(d.amount_paise) filter (where d.entry_id is not null), 0)::bigint as posted
        from finance_depreciation_schedule d
        join finance_assets a on a.id = d.asset_id
        join finance_asset_categories c on c.id = a.category_id
       where d.period_end between ${input.from}::date and ${input.to}::date
       group by c.name order by c.name`)
    return (res.rows as { category: string; assets: number; amount: number; posted: number }[]).map((r) => ({
      category: r.category,
      assets: r.assets,
      amountPaise: Number(r.amount),
      postedPaise: Number(r.posted),
    }))
  })
}

