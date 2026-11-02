import { randomUUID } from 'node:crypto'
import * as z from 'zod'
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm'
import { withIdempotencyKey, withTenant } from '@campusos/db'
import {
  cursorColumn, finishPage, keyset, orderKeys, readPage, searchAny,
  type Page, type PageRequest, type SortSpec,
} from '@campusos/module-framework'
import { costCenterReport, localToday, mulDiv, postWithin, reverseWithin } from '@campusos/module-finance/api'
import { costRates, costings, projectIdempotencyKeys, projects, timesheets } from '../schema'
import {
  OFFICE, ProjectsError, hours, log, named, optionalDate, optionalEnum, optionalId, projectFor, tenant, text,
  type Actor, type Tx,
} from './core'
import { PROJECT_SORTS } from './projects'

export const costingSchema = z.object({ projectId: z.uuid(), period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) })
export const reverseSchema = z.object({ costingId: z.uuid(), reason: text(5, 200) })
const profitabilitySchema = z.object({ from: optionalDate, to: optionalDate })

/** The last day of the month a period (YYYY-MM) names. */
function monthEnd(period: string): string {
  return new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0)).toISOString().slice(0, 10)
}

export async function costProject(actor: Actor, input: unknown) {
  const institutionId = tenant(actor, OFFICE)
  const data = costingSchema.parse(input)
  return withTenant(institutionId, (tx) => named(async () => {
    const { value, replayed } = await withIdempotencyKey(tx, projectIdempotencyKeys,
      { institutionId, actorId: actor.id, operation: 'costing', key: actor.idempotencyKey, request: data },
      () => costWithin(tx, actor, institutionId, data),
      async (id) => {
        const [row] = await tx.select({ id: costings.id, entryId: costings.entryId, amountPaise: costings.amountPaise, minutes: costings.minutes })
          .from(costings).where(eq(costings.id, id))
        return row
      })
    return replayed ? { ...value, replayed: true, notice: 'Already costed. Nothing was costed twice.' } : value
  }))
}

async function costWithin(tx: Tx, actor: Actor, institutionId: string, data: z.infer<typeof costingSchema>) {
  const { project } = await projectFor(tx, actor, data.projectId, 'manage', true)
  const first = `${data.period}-01`
  const end = monthEnd(data.period)
  if (end >= (await localToday(tx, institutionId))) throw new ProjectsError(409, 'month_not_over', 'That month has not finished yet.')
  const lines = await tx
    .select({ id: timesheets.id, userId: timesheets.userId, workDate: timesheets.workDate, minutes: timesheets.minutes })
    .from(timesheets)
    .where(and(eq(timesheets.projectId, project.id), eq(timesheets.status, 'approved'), isNull(timesheets.costingId),
      gte(timesheets.workDate, first), lte(timesheets.workDate, end)))
    .orderBy(asc(timesheets.id))
    .for('update')
  if (lines.length === 0) throw new ProjectsError(409, 'nothing_to_cost', 'No approved time in that month is waiting to be costed.')
  const people = [...new Set(lines.map((l) => l.userId))]
  const rates = await tx.select().from(costRates)
    .where(and(inArray(costRates.userId, people), lte(costRates.effectiveFrom, end)))
    .orderBy(desc(costRates.effectiveFrom))
  const rateFor = (l: { userId: string; workDate: string }) => rates.find((r) => r.userId === l.userId && r.effectiveFrom <= l.workDate)
  const missing = [...new Set(lines.filter((l) => !rateFor(l)).map((l) => l.userId))]
  if (missing.length) {
    throw new ProjectsError(409, 'no_cost_rate', 'Some time has no hourly cost for its day; set the cost rates first.', { userIds: missing })
  }
  const costed = lines.map((l) => {
    const r = rateFor(l)!
    return { id: l.id, cost: mulDiv(l.minutes, r.hourlyCostPaise, 60), home: r.homeCostCenter }
  })
  const total = costed.reduce((n, c) => n + c.cost, 0)
  const minutes = lines.reduce((n, l) => n + l.minutes, 0)
  const credits = new Map<string | null, number>()
  for (const c of costed) credits.set(c.home, (credits.get(c.home) ?? 0) + c.cost)
  if (credits.size > 199) throw new ProjectsError(409, 'too_many_cost_centres', 'More than 199 home cost centres in one costing.')
  const costingId = randomUUID()
  const entry = await postWithin(tx, institutionId, actor.id, {
    postingDate: end,
    memo: `${project.code} time costed for ${data.period}`.slice(0, 200),
    sourceModule: 'projects',
    sourceRef: `costing:${costingId}`,
    lines: [
      { purpose: 'salaries_expense', debitPaise: total, costCenter: project.costCenter, fundId: project.fundId },
      ...[...credits.entries()].map(([home, amount]) => ({ purpose: 'salaries_expense', creditPaise: amount, costCenter: home })),
    ],
  })
  await tx.insert(costings).values({
    id: costingId, institutionId, projectId: project.id, period: data.period, postedOn: end,
    entryId: entry.id, amountPaise: total, minutes, costedBy: actor.id,
  })
  // ponytail: one statement per line, fine for a month of one project (an unnest over array parameters is refused by the driver)
  for (const c of costed) {
    await tx.update(timesheets).set({ costingId, costPaise: c.cost, updatedAt: new Date() }).where(eq(timesheets.id, c.id))
  }
  await log(tx, actor, 'costing.created', 'projects_costings', costingId, 'Approved time costed to the project',
    { projectId: project.id, period: data.period, entryId: entry.id, minutes, amountPaise: total })
  return { id: costingId, entryId: entry.id, amountPaise: total, minutes,
    notice: `${hours(minutes)} h costed to ${project.costCenter} for ${data.period}.` }
}

export async function reverseCosting(actor: Actor, input: unknown) {
  const institutionId = tenant(actor, OFFICE)
  const data = reverseSchema.parse(input)
  return withTenant(institutionId, (tx) => named(async () => {
    const [seen] = await tx.select({ projectId: costings.projectId }).from(costings).where(eq(costings.id, data.costingId))
    if (!seen) throw new ProjectsError(404, 'no_such_costing', 'No such costing.')
    await projectFor(tx, actor, seen.projectId, 'manage', true)   // project first, as D11's order
    const [costing] = await tx.select().from(costings).where(eq(costings.id, data.costingId)).for('update')
    if (!costing) throw new ProjectsError(404, 'no_such_costing', 'No such costing.')
    if (costing.reversedAt) throw new ProjectsError(409, 'already_reversed', 'That costing is already reversed.')
    const reversalId = await reverseWithin(tx, institutionId, actor.id, costing.entryId, data.reason)
    await tx.update(costings).set({
      reversedAt: new Date(), reversedBy: actor.id, reversalEntryId: reversalId, reverseReason: data.reason,
    }).where(eq(costings.id, costing.id))
    await tx.update(timesheets).set({ costingId: null, costPaise: null, updatedAt: new Date() }).where(eq(timesheets.costingId, costing.id))
    await log(tx, actor, 'costing.reversed', 'projects_costings', costing.id, data.reason, { entryId: costing.entryId, reversalId })
    return { id: costing.id, reversalEntryId: reversalId, notice: 'Costing reversed; its time can be corrected and costed again.' }
  }))
}

export const COSTING_SORTS: SortSpec = {
  postedOn: {
    dir: 'desc',
    keys: [
      { sql: sql`${costings.postedOn}`, type: 'date' },
      { sql: sql`${costings.createdAt}`, type: 'timestamptz' },
      { sql: sql`${costings.id}`, type: 'uuid' },
    ],
  },
}
export const costingPage = (req: Request, prefix: string) => readPage(req, prefix, COSTING_SORTS, 'postedOn', 50)
export const profitPage = (req: Request, prefix: string) => readPage(req, prefix, PROJECT_SORTS, 'code', 50)

export interface CostingRow {
  id: string
  projectId: string
  projectCode: string
  period: string
  postedOn: string
  minutes: number
  hours: string
  amountPaise: number
  reversed: boolean
}

export async function listCostings(
  actor: Actor,
  input: unknown = {},
  page: PageRequest = costingPage(new Request('https://x/'), ''),
): Promise<Page<CostingRow>> {
  const institutionId = tenant(actor, OFFICE)
  const data = z.object({ projectId: optionalId, open: optionalEnum(['true']) }).parse(input)
  return withTenant(institutionId, async (tx) => {
    const keys = COSTING_SORTS[page.sort]!.keys
    const filter = and(
      data.projectId ? eq(costings.projectId, data.projectId) : undefined,
      data.open ? isNull(costings.reversedAt) : undefined,
      searchAny(page.q, [sql`${projects.code}`, sql`${costings.period}`]),
    )
    const rows = await tx
      .select({
        id: costings.id, projectId: costings.projectId, projectCode: projects.code, period: costings.period, postedOn: costings.postedOn,
        minutes: costings.minutes, amountPaise: costings.amountPaise, reversed: sql<boolean>`${costings.reversedAt} is not null`,
        _cursor: cursorColumn(keys),
      })
      .from(costings)
      .innerJoin(projects, eq(projects.id, costings.projectId))
      .where(and(filter, keyset(keys, page)))
      .orderBy(...orderKeys(keys, page.dir))
      .limit(page.limit + 1)
    const [counted] = await tx.select({ total: sql<number>`count(*)::int` }).from(costings)
      .innerJoin(projects, eq(projects.id, costings.projectId)).where(filter)
    return finishPage(rows.map((r) => ({ ...r, hours: hours(r.minutes) })), page, counted!.total)
  })
}

export interface ProfitRow {
  id: string
  code: string
  name: string
  costCenter: string
  minutes: number
  hours: string
  billedPaise: number
  costedPaise: number
  incomePaise: number
  expensePaise: number
  marginPaise: number
  unexplainedIncomePaise: number
  unexplainedExpensePaise: number
}

export async function profitability(
  actor: Actor,
  input: unknown = {},
  page: PageRequest = profitPage(new Request('https://x/'), ''),
): Promise<{ from: string; to: string; rows: ProfitRow[]; total: number; next: string | null }> {
  const institutionId = tenant(actor, OFFICE)
  const data = profitabilitySchema.parse(input)
  const books = await costCenterReport(actor, { from: data.from, to: data.to })
  const byCentre = new Map(books.rows.map((r) => [r.costCenter, r]))
  return withTenant(institutionId, async (tx) => {
    const keys = PROJECT_SORTS[page.sort]!.keys
    const filter = searchAny(page.q, [sql`${projects.code}`, sql`${projects.name}`])
    const rows = await tx
      .select({
        id: projects.id, code: projects.code, name: projects.name, costCenter: projects.costCenter,
        minutes: sql<string>`coalesce((select sum(t.minutes) from projects_timesheets t where t.project_id = "projects_projects"."id" and t.status = 'approved' and t.work_date between ${books.from}::date and ${books.to}::date), 0)::bigint`,
        billed: sql<string>`coalesce((select sum(b.amount_paise) from projects_billings b where b.project_id = "projects_projects"."id" and b.billed_on between ${books.from}::date and ${books.to}::date), 0)::bigint`,
        costed: sql<string>`coalesce((select sum(c.amount_paise) from projects_costings c where c.project_id = "projects_projects"."id" and c.reversed_at is null and c.posted_on between ${books.from}::date and ${books.to}::date), 0)::bigint`,
        _cursor: cursorColumn(keys),
      })
      .from(projects)
      .where(and(filter, keyset(keys, page)))
      .orderBy(...orderKeys(keys, page.dir))
      .limit(page.limit + 1)
    const [counted] = await tx.select({ total: sql<number>`count(*)::int` }).from(projects).where(filter)
    const done = finishPage(rows, page, counted!.total)
    return {
      from: books.from,
      to: books.to,
      total: done.total,
      next: done.next,
      rows: done.rows.map((r) => {
        const minutes = Number(r.minutes)
        const billedPaise = Number(r.billed)
        const costedPaise = Number(r.costed)
        const incomePaise = byCentre.get(r.costCenter)?.incomePaise ?? 0
        const expensePaise = byCentre.get(r.costCenter)?.expensePaise ?? 0
        return {
          id: r.id, code: r.code, name: r.name, costCenter: r.costCenter, minutes, hours: hours(minutes), billedPaise, costedPaise,
          incomePaise, expensePaise, marginPaise: incomePaise - expensePaise,
          unexplainedIncomePaise: incomePaise - billedPaise, unexplainedExpensePaise: expensePaise - costedPaise,
        }
      }),
    }
  })
}
