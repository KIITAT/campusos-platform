import { and, asc, eq, sql } from 'drizzle-orm'
import { audit, withTenant } from '@campusos/db'
import { accounts, budgets, lines, entries, periods } from '../schema'
import { FinanceError, ensureDefaultChart, type Actor } from './operations'
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

const requireReader = (actor: Actor): string => {
  if (!actor.institutionId) {
    throw new FinanceError(400, 'no_institution', 'no institution for this session')
  }
  return actor.institutionId
}

/** The last day of a month, which is when it becomes closeable. */
const endOfMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0, 23, 59, 59))

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

/**
 * Close a month.
 *
 * Refused before the month is over, because a period closed while entries for
 * it are still legitimately arriving is a period that will be reopened on
 * Monday, and a reopening is exactly the event a close exists to make rare.
 */
export async function closePeriod(actor: Actor, input: unknown) {
  const tenant = requireAccountant(actor)
  const data = closePeriodSchema.parse(input)

  if (endOfMonth(data.year, data.month) > new Date()) {
    throw new FinanceError(
      409,
      'period_not_over',
      'that month has not finished yet',
    )
  }

  return withTenant(tenant, async (tx) => {
    const [existing] = await tx
      .select()
      .from(periods)
      .where(and(eq(periods.year, data.year), eq(periods.month, data.month)))

    if (existing?.status === 'closed') {
      throw new FinanceError(409, 'already_closed', 'that period is already closed')
    }

    const closedAt = new Date()
    const [row] = existing
      ? await tx
          .update(periods)
          .set({ status: 'closed', closedBy: actor.id, closedAt, reopenedReason: null })
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

    return row!
  })
}

/**
 * Open it again, which is a decision rather than an undo.
 *
 * The reason is mandatory and stays on the row: a period reopened silently is
 * worse than one never closed, because the close is what everybody downstream
 * relied on.
 */
export async function reopenPeriod(actor: Actor, input: unknown) {
  const tenant = requireAccountant(actor)
  const data = reopenPeriodSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const [existing] = await tx
      .select()
      .from(periods)
      .where(and(eq(periods.year, data.year), eq(periods.month, data.month)))
    if (!existing || existing.status !== 'closed') {
      throw new FinanceError(409, 'not_closed', 'that period is not closed')
    }

    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: 'period.reopened',
      entity: 'finance_periods',
      entityId: existing.id,
      reason: data.reason,
      detail: { year: data.year, month: data.month, closedAt: existing.closedAt },
    })

    const [row] = await tx
      .update(periods)
      .set({ status: 'open', closedAt: null, reopenedReason: data.reason })
      .where(eq(periods.id, existing.id))
      .returning()
    return row!
  })
}

// --- budgets ---------------------------------------------------------------

export async function setBudget(actor: Actor, input: unknown) {
  const tenant = requireAccountant(actor)
  const data = setBudgetSchema.parse(input)

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
        amountPaise: data.amountPaise,
        hardLimit: data.hardLimit,
        note: data.note ?? null,
      })
      .onConflictDoUpdate({
        target: [budgets.institutionId, budgets.year, budgets.costCenter, budgets.accountId],
        set: {
          amountPaise: data.amountPaise,
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

    const spent = await tx
      .select({
        accountId: lines.accountId,
        costCenter: lines.costCenter,
        spentPaise: sql<number>`sum(${lines.debitPaise} - ${lines.creditPaise})::bigint`,
      })
      .from(lines)
      .innerJoin(entries, eq(entries.id, lines.entryId))
      .where(sql`extract(year from ${entries.occurredAt}) = ${data.year}`)
      .groupBy(lines.accountId, lines.costCenter)

    const rows = planned.map((b) => {
      const actualPaise = Number(
        spent.find((s) => s.accountId === b.accountId && s.costCenter === b.costCenter)
          ?.spentPaise ?? 0,
      )
      return {
        costCenter: b.costCenter,
        accountCode: b.accountCode,
        accountName: b.accountName,
        budgetPaise: b.amountPaise,
        actualPaise,
        remainingPaise: b.amountPaise - actualPaise,
        hardLimit: b.hardLimit,
        overspent: actualPaise > b.amountPaise,
      }
    })

    return {
      year: data.year,
      rows,
      budgetedPaise: rows.reduce((n, r) => n + r.budgetPaise, 0),
      spentPaise: rows.reduce((n, r) => n + r.actualPaise, 0),
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
        sql`extract(year from ${entries.occurredAt}) = ${year}`,
      ),
    )
  return Number(row?.spentPaise ?? 0)
}
