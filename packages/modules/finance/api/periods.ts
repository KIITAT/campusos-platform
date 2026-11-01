import { and, asc, eq, sql } from 'drizzle-orm'
import * as z from 'zod'
import { formatPaise } from '@campusos/money'
import { audit, withTenant } from '@campusos/db'
import { accounts, budgets, lines, entries, periods } from '../schema'
import { FinanceError, ensureDefaultChart, type Actor } from './operations'
import { requireRead, type Tx } from './core'
import { fiscalBounds, localToday, settingsWithin } from './years'
import { monthEnd, parseDecimal } from './numbers'
import { committedWithin } from './encumbrance'
import { checkOtherPerson } from './sod'
import { subledgerRows } from './subledgers'
import {
  closePeriodSchema,
  reopenPeriodSchema,
  setBudgetSchema,
  budgetReportQuerySchema,
  periodsQuerySchema,
  type BudgetReport,
} from './schemas'

/**
 * The close, and the budget a department argues about.
 *
 * Everything else in this module is arithmetic that can be recomputed from the
 * journal. A closed period is the one thing that cannot: it is a promise that
 * the numbers reported last quarter are the numbers still there, and it is kept
 * by a trigger rather than by whichever code path last posted.
 */

const MODULE = 'finance'

const requireAccountant = (actor: Actor): string => {
  if (actor.role !== 'institution_admin' && actor.role !== 'super_admin') {
    throw new FinanceError(403, 'forbidden', 'not permitted')
  }
  if (!actor.institutionId) {
    throw new FinanceError(400, 'no_institution', 'no institution for this session')
  }
  return actor.institutionId
}

/**
 * Reading periods and budgets is reading the books: the accounts office and the
 * administration. It used to be anybody signed in -- a student could ask the
 * API for every department's budget (decision 149).
 */
const requireReader = requireRead

/** The first and last day of the fiscal year that starts in `year`. */
async function budgetYear(tx: Parameters<Parameters<typeof withTenant>[1]>[0], institutionId: string, year: number) {
  const s = await settingsWithin(tx, institutionId)
  const month = String(s.fiscalYearStartMonth).padStart(2, '0')
  return fiscalBounds(s.fiscalYearStartMonth, `${year}-${month}-01`)
}

// --- the close -------------------------------------------------------------

export async function listPeriods(actor: Actor, input: unknown = {}) {
  const tenant = requireReader(actor)
  const { year } = periodsQuerySchema.parse(input)
  return withTenant(tenant, (tx) =>
    tx
      .select()
      .from(periods)
      .where(year === undefined ? undefined : eq(periods.year, year))
      .orderBy(asc(periods.year), asc(periods.month)),
  )
}

export interface CloseCheck {
  key: 'month_over' | 'drafts' | 'bank' | 'depreciation' | 'subledgers' | 'gst_filed'
  label: string
  ok: boolean
  blocking: boolean
  detail: string
}

const pad = (n: number) => String(n).padStart(2, '0')

/**
 * What stands between a month and its close (ACC-07): the month is over in the
 * institution's own zone, nothing is left in draft, every bank line is dealt
 * with, depreciation is posted, the sub-ledgers agree with the books, and the
 * GSTR-1 is marked filed (which informs but does not block, because it falls
 * due after the month ends).
 */
export async function closeChecklist(tx: Tx, tenant: string, year: number, month: number): Promise<CloseCheck[]> {
  const start = `${year}-${pad(month)}-01`
  const end = monthEnd(start)
  const count = async (query: ReturnType<typeof sql>) => Number(((await tx.execute<{ n: string }>(query)).rows[0] as { n: string }).n)

  const over = end < (await localToday(tx, tenant))
  const drafts = await count(sql`select (
      (select count(*) from finance_invoices where docstatus = 'draft' and posting_date between ${start} and ${end})
    + (select count(*) from finance_payments where docstatus = 'draft' and posting_date between ${start} and ${end})
    + (select count(*) from finance_journals where docstatus = 'draft' and posting_date between ${start} and ${end})
    + (select count(*) from finance_stock_entries where docstatus = 'draft' and posting_date between ${start} and ${end})
    + (select count(*) from finance_receipts where docstatus = 'draft' and posting_date between ${start} and ${end})
    + (select count(*) from finance_orders where docstatus = 'draft' and posting_date between ${start} and ${end})
    )::int as n`)
  const bank = await count(sql`select count(*)::int as n from finance_bank_statement_lines where status = 'unmatched' and txn_date between ${start} and ${end}`)
  const depreciation = await count(sql`select count(*)::int as n
      from finance_depreciation_schedule d join finance_assets a on a.id = d.asset_id
     where d.entry_id is null and d.period_end <= ${end} and a.docstatus = 'submitted'
       and not exists (select 1 from finance_asset_events e where e.asset_id = a.id and e.kind in ('sold', 'scrapped') and e.on <= ${end})`)
  const differing = (await subledgerRows(tx, tenant, end)).filter((r) => r.differencePaise !== 0)
  const settings = await settingsWithin(tx, tenant)
  const filed = settings.gstin
    ? (await count(sql`select count(*)::int as n from finance_gst_filings where return_type = 'gstr1' and ${end} between period_from and period_to`)) > 0
    : true

  return [
    { key: 'month_over', label: 'Month is over', ok: over, blocking: true, detail: over ? '' : 'the month has not finished yet' },
    { key: 'drafts', label: 'No drafts dated in the month', ok: drafts === 0, blocking: true, detail: drafts ? `${drafts} draft${drafts === 1 ? '' : 's'}` : '' },
    { key: 'bank', label: 'Every bank line matched or ignored', ok: bank === 0, blocking: true, detail: bank ? `${bank} unmatched` : '' },
    { key: 'depreciation', label: 'Depreciation posted', ok: depreciation === 0, blocking: true, detail: depreciation ? `${depreciation} period${depreciation === 1 ? '' : 's'} not posted` : '' },
    {
      key: 'subledgers',
      label: 'Sub-ledgers agree with the books',
      ok: differing.length === 0,
      blocking: true,
      detail: differing.map((r) => `${r.ledger} ${r.code || r.name} differs by ${formatPaise(r.differencePaise)}`).join('; '),
    },
    { key: 'gst_filed', label: 'GSTR-1 marked filed', ok: filed, blocking: false, detail: filed ? '' : 'not marked filed' },
  ]
}

const checklistQuerySchema = z.object({ year: z.coerce.number().int().min(1900).max(2200), month: z.coerce.number().int().min(1).max(12) })

/** The checklist for one month, for the administrators who close it. */
export async function periodChecklist(actor: Actor, input: unknown) {
  const tenant = requireAccountant(actor)
  const data = checklistQuerySchema.parse(input)
  return withTenant(tenant, async (tx) => ({ year: data.year, month: data.month, checks: await closeChecklist(tx, tenant, data.year, data.month) }))
}

/**
 * Close a month.
 *
 * Refused before the month is over (in the institution's zone), because a period
 * closed while entries for it are still legitimately arriving is a period that
 * will be reopened on Monday. Refused too while a blocking check fails, unless an
 * administrator overrides it with a reason, which goes on the trail.
 */
export async function closePeriod(actor: Actor, input: unknown) {
  const tenant = requireAccountant(actor)
  const data = closePeriodSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const checks = await closeChecklist(tx, tenant, data.year, data.month)
    if (!checks.find((c) => c.key === 'month_over')!.ok) {
      throw new FinanceError(409, 'period_not_over', 'that month has not finished yet')
    }
    const failed = checks.filter((c) => c.blocking && !c.ok)
    const overrideReason = (data.overrideReason ?? '').trim()
    if (failed.length && !data.override) {
      throw new FinanceError(409, 'close_checks_failed', 'the month is not ready to close', { checks: failed })
    }
    if (failed.length && (overrideReason.length < 10 || overrideReason.length > 300)) {
      throw new FinanceError(400, 'override_reason', 'say why the month closes with open items (10 to 300 characters)')
    }

    const [existing] = await tx
      .select()
      .from(periods)
      .where(and(eq(periods.year, data.year), eq(periods.month, data.month)))

    if (existing?.status === 'closed') {
      throw new FinanceError(409, 'already_closed', 'that period is already closed')
    }

    const closedAt = new Date()
    const cleared = { reopenRequestedBy: null, reopenRequestedAt: null, reopenRequestReason: null }
    const [row] = existing
      ? await tx
          .update(periods)
          .set({ status: 'closed', closedBy: actor.id, closedAt, reopenedReason: null, ...cleared })
          .where(eq(periods.id, existing.id))
          .returning()
      : await tx
          .insert(periods)
          .values({
            institutionId: tenant,
            year: data.year,
            month: data.month,
            status: 'closed',
            closedBy: actor.id,
            closedAt,
          })
          .returning()

    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: 'period.closed',
      entity: 'finance_periods',
      entityId: row!.id,
      reason: data.reason ?? `${data.year}-${String(data.month).padStart(2, '0')} closed`,
      detail: { year: data.year, month: data.month },
    })
    if (failed.length) {
      await audit(tx, {
        institutionId: tenant,
        actorId: actor.id,
        actorEmail: actor.email ?? null,
        moduleId: MODULE,
        action: 'period.close_overridden',
        entity: 'finance_periods',
        entityId: row!.id,
        reason: overrideReason,
        detail: { year: data.year, month: data.month, failed: failed.map((c) => c.key) },
      })
    }

    return row!
  })
}

/**
 * Open it again, which is a decision rather than an undo, and takes two people.
 *
 * The first call records the request; another administrator confirms it with
 * the same call. The requester confirming their own request is a separation-of-
 * duties question (single-officer mode lets an office of one work, on the
 * trail). The reason is mandatory and stays on the row: a period reopened
 * silently is worse than one never closed.
 */
export async function reopenPeriod(actor: Actor, input: unknown) {
  const tenant = requireAccountant(actor)
  const data = reopenPeriodSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const [existing] = await tx
      .select()
      .from(periods)
      .where(and(eq(periods.year, data.year), eq(periods.month, data.month)))
      .for('update')
    if (!existing || existing.status !== 'closed') {
      throw new FinanceError(409, 'not_closed', 'that period is not closed')
    }

    if (!existing.reopenRequestedAt) {
      const [row] = await tx
        .update(periods)
        .set({ reopenRequestedBy: actor.id, reopenRequestedAt: new Date(), reopenRequestReason: data.reason })
        .where(eq(periods.id, existing.id))
        .returning()
      await audit(tx, {
        institutionId: tenant,
        actorId: actor.id,
        actorEmail: actor.email ?? null,
        moduleId: MODULE,
        action: 'period.reopen_requested',
        entity: 'finance_periods',
        entityId: existing.id,
        reason: data.reason,
        detail: { year: data.year, month: data.month },
      })
      return { ...row!, notice: 'Reopen requested. Another administrator must confirm it.' }
    }

    const verdict = await checkOtherPerson(tx, actor, tenant, {
      creatorId: existing.reopenRequestedBy,
      act: 'reopen',
      moduleId: MODULE,
      entity: 'finance_periods',
      entityId: existing.id,
    })
    if (verdict === 'refused') {
      throw new FinanceError(403, 'separation_of_duties', 'you asked for this reopening, so someone else must confirm it')
    }

    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: 'period.reopened',
      entity: 'finance_periods',
      entityId: existing.id,
      reason: existing.reopenRequestReason ?? data.reason,
      detail: { year: data.year, month: data.month, closedAt: existing.closedAt, requestedBy: existing.reopenRequestedBy },
    })

    const [row] = await tx
      .update(periods)
      .set({
        status: 'open',
        closedAt: null,
        reopenedReason: existing.reopenRequestReason,
        reopenRequestedBy: null,
        reopenRequestedAt: null,
        reopenRequestReason: null,
      })
      .where(eq(periods.id, existing.id))
      .returning()
    return row!
  })
}

// --- budgets ---------------------------------------------------------------

export async function setBudget(actor: Actor, input: unknown) {
  const tenant = requireAccountant(actor)
  const data = setBudgetSchema.parse(input)

  // The form sends the amount as typed -- rupees -- and the API may send paise.
  // The form's field used to be read as paise, so ₹5,00,000 budgeted ₹5,000.
  const amountPaise =
    data.amount !== undefined ? parseDecimal(data.amount, 2) : (data.amountPaise ?? null)
  if (amountPaise === null || amountPaise < 0) {
    throw new FinanceError(400, 'bad_amount', 'say how much, in rupees')
  }

  return withTenant(tenant, async (tx) => {
    // Budgeting can be the first thing an institution does, before a single
    // payment has seeded the chart.
    await ensureDefaultChart(tx, tenant)

    const [account] = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.code, data.accountCode))
    if (!account) {
      throw new FinanceError(404, 'no_such_account', `no account with code ${data.accountCode}`)
    }

    const [row] = await tx
      .insert(budgets)
      .values({
        institutionId: tenant,
        year: data.year,
        costCenter: data.costCenter,
        accountId: account.id,
        amountPaise,
        hardLimit: data.hardLimit,
        note: data.note ?? null,
      })
      .onConflictDoUpdate({
        target: [budgets.institutionId, budgets.year, budgets.costCenter, budgets.accountId],
        set: {
          amountPaise,
          hardLimit: data.hardLimit,
          note: data.note ?? null,
        },
      })
      .returning()
    return row!
  })
}

/**
 * What each cost centre was given, and what it has actually spent.
 *
 * Actual is summed from the journal on the same pair the budget names, so there
 * is no second set of figures to keep in step. Debits less credits, because a
 * budget is about spending and a credit to an expense account is spending
 * reversed.
 */
export async function budgetReport(actor: Actor, input: unknown): Promise<BudgetReport> {
  const tenant = requireReader(actor)
  const data = budgetReportQuerySchema.parse(input)

  return withTenant(tenant, async (tx): Promise<BudgetReport> => {
    const planned = await tx
      .select({
        id: budgets.id,
        costCenter: budgets.costCenter,
        accountId: budgets.accountId,
        accountCode: accounts.code,
        accountName: accounts.name,
        amountPaise: budgets.amountPaise,
        hardLimit: budgets.hardLimit,
      })
      .from(budgets)
      .innerJoin(accounts, eq(accounts.id, budgets.accountId))
      .where(
        data.costCenter
          ? and(eq(budgets.year, data.year), eq(budgets.costCenter, data.costCenter))
          : eq(budgets.year, data.year),
      )
      .orderBy(asc(budgets.costCenter), asc(accounts.code))

    const fy = await budgetYear(tx, tenant, data.year)
    const spent = await tx
      .select({
        accountId: lines.accountId,
        costCenter: lines.costCenter,
        spentPaise: sql<number>`sum(${lines.debitPaise} - ${lines.creditPaise})::bigint`,
      })
      .from(lines)
      .innerJoin(entries, eq(entries.id, lines.entryId))
      .where(sql`${entries.postingDate} between ${fy.startsOn} and ${fy.endsOn}`)
      .groupBy(lines.accountId, lines.costCenter)

    const committed = await committedWithin(tx, { fy })
    const rows = planned.map((b) => {
      const actualPaise = Number(
        spent.find((s) => s.accountId === b.accountId && s.costCenter === b.costCenter)
          ?.spentPaise ?? 0,
      )
      const committedHere = committed.get(`${b.costCenter}|${b.accountId}`) ?? 0
      return {
        costCenter: b.costCenter,
        accountCode: b.accountCode,
        accountName: b.accountName,
        budgetPaise: b.amountPaise,
        actualPaise,
        remainingPaise: b.amountPaise - actualPaise,
        committedPaise: committedHere,
        availablePaise: b.amountPaise - actualPaise - committedHere,
        hardLimit: b.hardLimit,
        overspent: actualPaise > b.amountPaise,
      }
    })

    return {
      year: data.year,
      rows,
      budgetedPaise: rows.reduce((n, r) => n + r.budgetPaise, 0),
      spentPaise: rows.reduce((n, r) => n + r.actualPaise, 0),
      committedPaise: rows.reduce((n, r) => n + r.committedPaise, 0),
      overspentCount: rows.filter((r) => r.overspent).length,
    }
  })
}

/**
 * What a cost centre has already spent on an account this year, for the hard
 * limit check. Read inside the posting transaction, so two entries racing for
 * the last of a budget cannot both see room.
 */
export async function spentSoFar(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  year: number,
  accountId: string,
  costCenter: string,
): Promise<number> {
  const [inst] = (await tx.execute(sql`select current_setting('app.institution_id', true) as id`)).rows as {
    id: string
  }[]
  const fy = await budgetYear(tx, inst!.id, year)
  const [row] = await tx
    .select({
      spentPaise: sql<number>`coalesce(sum(${lines.debitPaise} - ${lines.creditPaise}), 0)::bigint`,
    })
    .from(lines)
    .innerJoin(entries, eq(entries.id, lines.entryId))
    .where(
      and(
        eq(lines.accountId, accountId),
        eq(lines.costCenter, costCenter),
        sql`${entries.postingDate} between ${fy.startsOn} and ${fy.endsOn}`,
      ),
    )
  return Number(row?.spentPaise ?? 0)
}
