import { randomUUID } from 'node:crypto'
import * as z from 'zod'
import { and, asc, eq, inArray, isNull, lte, sql } from 'drizzle-orm'
import { users, withIdempotencyKey, withTenant } from '@campusos/db'
import {
  cursorColumn, finishPage, keyset, orderKeys, readPage, searchAny,
  type Page, type PageRequest, type SortSpec,
} from '@campusos/module-framework'
import { localToday, saveDraftWithin, settingsWithin, submitWithin } from '@campusos/module-finance/api'
import { invoiceLines, invoices } from '@campusos/module-finance/schema'
import { billings, costRates, projectIdempotencyKeys, projects, tasks, timesheets } from '../schema'
import {
  OFFICE, ProjectsError, hours, log, named, optional, optionalDate, optionalId, paiseOf, projectFor, staffMember, tenant, text,
  type Actor, type Tx,
} from './core'

const costRateSchema = z.object({ userId: text(1, 64), effectiveFrom: z.iso.date(), hourlyCost: text(1, 24), homeCostCenter: optional(80) })
const billingSchema = z.object({ projectId: z.uuid(), through: optionalDate })
const listBillingsQuery = z.object({ projectId: optionalId })

export async function setCostRate(actor: Actor, input: unknown) {
  const institutionId = tenant(actor, OFFICE)
  const data = costRateSchema.parse(input)
  return withTenant(institutionId, (tx) => named(async () => {
    await staffMember(tx, data.userId)
    const paise = paiseOf(data.hourlyCost)
    if (paise < 100) throw new ProjectsError(400, 'bad_amount', 'An hourly cost is at least one rupee.')
    const [row] = await tx.insert(costRates).values({
      institutionId, userId: data.userId, effectiveFrom: data.effectiveFrom, hourlyCostPaise: paise, homeCostCenter: data.homeCostCenter ?? null,
    }).returning({ id: costRates.id })
    await log(tx, actor, 'cost_rate.set', 'projects_cost_rates', row!.id, 'Cost rate set',
      { userId: data.userId, effectiveFrom: data.effectiveFrom, hourlyCostPaise: paise, homeCostCenter: data.homeCostCenter ?? null })
    return { id: row!.id, notice: 'Cost rate set.' }
  }))
}

export const RATE_SORTS: SortSpec = {
  effectiveFrom: {
    dir: 'desc',
    keys: [
      { sql: sql`${costRates.effectiveFrom}`, type: 'date' },
      { sql: sql`${costRates.createdAt}`, type: 'timestamptz' },
      { sql: sql`${costRates.id}`, type: 'uuid' },
    ],
  },
}
export const ratePage = (req: Request, prefix: string) => readPage(req, prefix, RATE_SORTS, 'effectiveFrom', 50)

export const BILLING_SORTS: SortSpec = {
  billedOn: {
    dir: 'desc',
    keys: [
      { sql: sql`${billings.billedOn}`, type: 'date' },
      { sql: sql`${billings.createdAt}`, type: 'timestamptz' },
      { sql: sql`${billings.id}`, type: 'uuid' },
    ],
  },
}
export const billingPage = (req: Request, prefix: string) => readPage(req, prefix, BILLING_SORTS, 'billedOn', 50)

export interface RateRow { id: string; userId: string; person: string | null; effectiveFrom: string; hourlyCostPaise: number; homeCostCenter: string | null }

export async function listCostRates(
  actor: Actor,
  input: unknown = {},
  page: PageRequest = ratePage(new Request('https://x/'), ''),
): Promise<Page<RateRow>> {
  const institutionId = tenant(actor, OFFICE)
  const data = z.object({ userId: optional(64) }).parse(input)
  return withTenant(institutionId, async (tx) => {
    const keys = RATE_SORTS[page.sort]!.keys
    const filter = and(data.userId ? eq(costRates.userId, data.userId) : undefined, searchAny(page.q, [sql`${users.name}`]))
    const rows = await tx
      .select({
        id: costRates.id, userId: costRates.userId, person: users.name, effectiveFrom: costRates.effectiveFrom,
        hourlyCostPaise: costRates.hourlyCostPaise, homeCostCenter: costRates.homeCostCenter, _cursor: cursorColumn(keys),
      })
      .from(costRates)
      .innerJoin(users, eq(users.id, costRates.userId))
      .where(and(filter, keyset(keys, page)))
      .orderBy(...orderKeys(keys, page.dir))
      .limit(page.limit + 1)
    const [counted] = await tx.select({ total: sql<number>`count(*)::int` }).from(costRates).innerJoin(users, eq(users.id, costRates.userId)).where(filter)
    return finishPage(rows, page, counted!.total)
  })
}

export async function billProject(actor: Actor, input: unknown) {
  const institutionId = tenant(actor, OFFICE)
  const data = billingSchema.parse(input)
  return withTenant(institutionId, (tx) => named(async () => {
    const { value, replayed } = await withIdempotencyKey(tx, projectIdempotencyKeys,
      { institutionId, actorId: actor.id, operation: 'billing', key: actor.idempotencyKey, request: data },
      () => billWithin(tx, actor, institutionId, data),
      (id) => billingResult(tx, id))
    return replayed ? { ...value, replayed: true, notice: `Already billed as ${value.number}. Nothing was billed twice.` } : value
  }))
}

async function billingResult(tx: Tx, id: string) {
  const [row] = await tx
    .select({ id: billings.id, invoiceId: billings.invoiceId, number: invoices.number, amountPaise: billings.amountPaise, minutes: billings.minutes })
    .from(billings).innerJoin(invoices, eq(invoices.id, billings.invoiceId)).where(eq(billings.id, id))
  if (!row) return undefined
  const number = row.number ?? ''
  return { ...row, number, notice: `${number} raised for ${hours(row.minutes)} h.`, next: `/m/finance/invoice?id=${row.invoiceId}` }
}

async function billWithin(tx: Tx, actor: Actor, institutionId: string, data: z.infer<typeof billingSchema>) {
  const { project } = await projectFor(tx, actor, data.projectId, 'manage', true)   // the lock of D11
  if (!project.billable || !project.partyId || !project.billingRatePaise) {
    throw new ProjectsError(409, 'not_billable', 'That project bills no one: it needs a customer and an hourly rate.')
  }
  const today = await localToday(tx, institutionId)
  const through = data.through ?? today
  if (through > today) throw new ProjectsError(400, 'future_date', 'Time is billed up to today or earlier.')
  const lines = await tx
    .select({ id: timesheets.id, taskId: timesheets.taskId, minutes: timesheets.minutes })
    .from(timesheets)
    .where(and(eq(timesheets.projectId, project.id), eq(timesheets.status, 'approved'), isNull(timesheets.billingId), lte(timesheets.workDate, through)))
    .orderBy(asc(timesheets.id))
    .for('update')
  if (lines.length === 0) throw new ProjectsError(409, 'nothing_to_bill', 'No approved time is waiting to be billed.')
  const byTask = new Map<string, number>()
  for (const l of lines) byTask.set(l.taskId, (byTask.get(l.taskId) ?? 0) + l.minutes)
  if (byTask.size > 300) throw new ProjectsError(409, 'too_many_tasks', 'More than 300 tasks to bill at once; bill to an earlier date first.')
  const titles = new Map(
    (await tx.select({ id: tasks.id, title: tasks.title }).from(tasks).where(inArray(tasks.id, [...byTask.keys()]))).map((t) => [t.id, t.title]),
  )
  const settings = await settingsWithin(tx, institutionId)
  const billingId = randomUUID()
  const invoiceId = await saveDraftWithin(tx, institutionId, actor.id, {
    kind: 'sales',
    partyId: project.partyId,
    postingDate: today,
    currency: settings.baseCurrency,
    costCenter: project.costCenter,
    fundId: project.fundId,
    memo: `${project.code} ${project.name}: time to ${through}`.slice(0, 500),
    sourceModule: 'projects',
    sourceRef: `billing:${billingId}`,
    lines: [...byTask.entries()]
      .sort((a, b) => titles.get(a[0])!.localeCompare(titles.get(b[0])!))
      .map(([taskId, minutes]) => ({
        description: `${titles.get(taskId)} (${hours(minutes)} h)`,
        qtyMilli: (minutes / 15) * 250,
        rateFc: project.billingRatePaise!,
        taxTemplateId: project.taxTemplateId,
        costCenter: project.costCenter,
        fundId: project.fundId,
      })),
  })
  const submitted = await submitWithin(tx, actor, invoiceId)
  const [sum] = await tx
    .select({ v: sql<string>`coalesce(sum(${invoiceLines.amountPaise}), 0)::bigint` })
    .from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId))
  const amountPaise = Number(sum!.v)
  const minutes = lines.reduce((n, l) => n + l.minutes, 0)
  await tx.insert(billings).values({ id: billingId, institutionId, projectId: project.id, through, billedOn: today, invoiceId, amountPaise, minutes, billedBy: actor.id })
  await tx.update(timesheets).set({ billingId, updatedAt: new Date() }).where(inArray(timesheets.id, lines.map((l) => l.id)))
  await log(tx, actor, 'billing.created', 'projects_billings', billingId, 'Approved time billed through the books',
    { projectId: project.id, invoiceId, number: submitted.number, minutes, amountPaise, lines: lines.length })
  return { id: billingId, invoiceId, number: submitted.number, amountPaise, minutes,
    notice: `${submitted.number} raised for ${hours(minutes)} h.`, next: `/m/finance/invoice?id=${invoiceId}` }
}

export interface BillingRow {
  id: string
  projectId: string
  projectCode: string
  through: string
  billedOn: string
  invoiceId: string
  invoiceNumber: string | null
  invoiceStatus: string
  minutes: number
  hours: string
  amountPaise: number
}

export async function listBillings(
  actor: Actor,
  input: unknown = {},
  page: PageRequest = billingPage(new Request('https://x/'), ''),
): Promise<Page<BillingRow>> {
  const institutionId = tenant(actor, OFFICE)
  const data = listBillingsQuery.parse(input)
  return withTenant(institutionId, async (tx) => {
    const keys = BILLING_SORTS[page.sort]!.keys
    const filter = and(
      data.projectId ? eq(billings.projectId, data.projectId) : undefined,
      searchAny(page.q, [sql`${invoices.number}`, sql`${projects.code}`]),
    )
    const rows = await tx
      .select({
        id: billings.id, projectId: billings.projectId, projectCode: projects.code, through: billings.through, billedOn: billings.billedOn,
        invoiceId: billings.invoiceId, invoiceNumber: invoices.number, invoiceStatus: invoices.docstatus, minutes: billings.minutes,
        amountPaise: billings.amountPaise, _cursor: cursorColumn(keys),
      })
      .from(billings)
      .innerJoin(projects, eq(projects.id, billings.projectId))
      .innerJoin(invoices, eq(invoices.id, billings.invoiceId))
      .where(and(filter, keyset(keys, page)))
      .orderBy(...orderKeys(keys, page.dir))
      .limit(page.limit + 1)
    const [counted] = await tx.select({ total: sql<number>`count(*)::int` }).from(billings)
      .innerJoin(projects, eq(projects.id, billings.projectId)).innerJoin(invoices, eq(invoices.id, billings.invoiceId)).where(filter)
    return finishPage(rows.map((r) => ({ ...r, hours: hours(r.minutes) })), page, counted!.total)
  })
}
