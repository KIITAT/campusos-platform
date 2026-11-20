import { and, asc, desc, eq, gte, isNull, like, lte, sql } from 'drizzle-orm'
import * as z from 'zod'
import { audit, users, withIdempotencyKey, withTenant } from '@campusos/db'
import {
  cursorColumn,
  finishPage,
  keyset,
  orderKeys,
  readPage,
  searchAny,
  type Role,
  type SortSpec,
} from '@campusos/module-framework'
import { terms } from '@campusos/module-academic/schema'
import { parseRupeesToPaise } from '@campusos/money'
import { feeIdempotencyKeys, studentCharges } from '../schema'
import { FeeError, type Actor } from './operations'

/**
 * Charges on one student. The office raises them by hand; another module
 * raises them inside its own transaction through `chargeStudentWithin`, so a
 * booking and its fee land together or not at all.
 */

const MODULE = 'fees'

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]

const REFUSALS: Record<string, [400 | 409, string]> = {
  fee_student_charge_student: [400, 'a charge is on a student'],
  fee_student_charge_invoiced: [409, 'that charge is on an invoice already; waive or refund it instead'],
  fee_student_charge_fixed: [409, 'a charge is fixed once raised'],
  fee_student_charges_source: [409, 'that has already been charged'],
  fee_student_charges_cancel: [400, 'say why, in at least five characters'],
}

function named(e: unknown): never {
  const c = (e as { cause?: { constraint?: string } }).cause?.constraint
  const known = c ? REFUSALS[c] : undefined
  if (known) throw new FeeError(known[0], c!, known[1])
  throw e
}

export interface ChargeInput {
  studentId: string
  termId: string
  label: string
  amountPaise: number
  sourceModule?: string
  sourceId?: string | null
}

/** Raise a charge in the caller's transaction. */
export async function chargeStudentWithin(tx: Tx, tenant: string, actorId: string, c: ChargeInput) {
  try {
    const [row] = await tx
      .insert(studentCharges)
      .values({
        institutionId: tenant,
        studentId: c.studentId,
        termId: c.termId,
        label: c.label,
        amountPaise: c.amountPaise,
        sourceModule: c.sourceModule ?? MODULE,
        sourceId: c.sourceId ?? null,
        createdBy: actorId,
      })
      .returning()
    return row!
  } catch (e) {
    named(e)
  }
}

/**
 * Cancel the live charge another module raised for one of its own records.
 * Refused by the database once the charge is on an invoice.
 */
export async function cancelChargeForSourceWithin(tx: Tx, sourceModule: string, sourceId: string, reason: string) {
  try {
    const rows = await tx
      .update(studentCharges)
      .set({ cancelledAt: new Date(), cancelReason: reason })
      .where(
        and(
          eq(studentCharges.sourceModule, sourceModule),
          eq(studentCharges.sourceId, sourceId),
          isNull(studentCharges.cancelledAt),
        ),
      )
      .returning({ id: studentCharges.id })
    return rows.length
  } catch (e) {
    named(e)
  }
}

// --- stays: a bed, a bus seat, charged per term (ACC-28, decisions 571-575) ---

/**
 * Something a student occupies for a stretch of days, priced per term: a
 * hostel bed, a seat on a bus route. `from` and `until` are local dates;
 * `until` is exclusive (vacating on the 6th means not sleeping there on the
 * 6th) and null while the stay is open.
 */
export interface Stay {
  sourceModule: string
  stayId: string
  studentId: string
  label: string
  termFeePaise: number
  from: string
  until: string | null
}

export interface TermSpan {
  id: string
  code: string
  startsOn: string
  endsOn: string
}

const DAY_MS = 86_400_000
const dayNo = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))) / DAY_MS
const termColumns = { id: terms.id, code: terms.code, startsOn: terms.startsOn, endsOn: terms.endsOn }

/**
 * The term a day falls in: the latest-starting one that covers it.
 * ponytail: one term per day for the whole institution; choose by the
 * student's programme if an institution ever runs overlapping terms.
 */
export async function termOnWithin(tx: Tx, day: string): Promise<TermSpan | null> {
  const [t] = await tx
    .select(termColumns)
    .from(terms)
    .where(and(lte(terms.startsOn, day), gte(terms.endsOn, day)))
    .orderBy(desc(terms.startsOn), asc(terms.id))
    .limit(1)
  return t ?? null
}

/** Nights of the stay inside the term, and the term's length. */
export function stayDays(term: TermSpan, from: string, until: string | null): { days: number; termDays: number } {
  const start = dayNo(term.startsOn)
  const end = dayNo(term.endsOn) + 1
  const first = Math.max(dayNo(from), start)
  const last = Math.min(until ? dayNo(until) : end, end)
  return { days: Math.max(0, last - first), termDays: end - start }
}

export const proratedPaise = (feePaise: number, days: number, termDays: number) =>
  Math.round((feePaise * days) / termDays)

const sourceOf = (stay: Stay, termId: string) => `${stay.stayId}:${termId}`

/**
 * Charge a stay for one term, for the nights it covers. Nothing when it
 * covers none, and nothing twice: a live charge for the stay and term stands
 * and comes back marked `existing`, so a run can tell "already charged" from
 * "nothing to charge" (null).
 */
export async function chargeStayWithin(tx: Tx, tenant: string, actorId: string, stay: Stay, termId: string) {
  const [t] = await tx.select(termColumns).from(terms).where(eq(terms.id, termId))
  if (!t) return null
  const { days, termDays } = stayDays(t, stay.from, stay.until)
  const amountPaise = proratedPaise(stay.termFeePaise, days, termDays)
  if (days === 0 || amountPaise <= 0) return null
  const sourceId = sourceOf(stay, termId)
  const [live] = await tx
    .select({ id: studentCharges.id })
    .from(studentCharges)
    .where(and(eq(studentCharges.sourceModule, stay.sourceModule), eq(studentCharges.sourceId, sourceId), isNull(studentCharges.cancelledAt)))
  if (live) return { id: live.id, amountPaise: 0, existing: true as const }
  const row = await chargeStudentWithin(tx, tenant, actorId, {
    studentId: stay.studentId,
    termId,
    label: `${stay.label}, ${t.code}${days < termDays ? ` (${days} of ${termDays} days)` : ''}`,
    amountPaise,
    sourceModule: stay.sourceModule,
    sourceId,
  })
  return { id: row.id, amountPaise, existing: false as const }
}

/**
 * A stay has ended. Each of its charges not yet invoiced is cancelled and
 * raised again for the nights actually used; an invoiced one is left, and its
 * term named, because the way back from an invoice is a waiver.
 */
export async function endStayWithin(tx: Tx, tenant: string, actorId: string, stay: Stay & { until: string }) {
  // Take the term locks a term run and an invoice run take, before reading the
  // charges: a run that read this stay as open lands its charge first and is
  // shrunk below, and an invoice that priced a charge commits it as billed
  // before it can be replaced. Terms in id order; each run holds only one.
  const spanning = await tx
    .select({ id: terms.id })
    .from(terms)
    .where(gte(terms.endsOn, stay.from))
    .orderBy(asc(terms.id))
  for (const t of spanning) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'fees.issue:' + t.id}, 0))`)
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${stay.sourceModule + '.charge:' + t.id}, 0))`)
  }
  const rows = await tx
    .select({
      termId: studentCharges.termId,
      invoicedAt: studentCharges.invoicedAt,
      amountPaise: studentCharges.amountPaise,
      code: terms.code,
      startsOn: terms.startsOn,
      endsOn: terms.endsOn,
    })
    .from(studentCharges)
    .innerJoin(terms, eq(terms.id, studentCharges.termId))
    .where(
      and(
        eq(studentCharges.sourceModule, stay.sourceModule),
        like(studentCharges.sourceId, `${stay.stayId}:%`),
        isNull(studentCharges.cancelledAt),
      ),
    )
    .orderBy(asc(terms.startsOn))
  const invoiced: string[] = []
  for (const r of rows) {
    if (r.invoicedAt) {
      invoiced.push(r.code)
      continue
    }
    // The charge is cut to the nights used at the fee it was raised at, not
    // the tariff as it stands now (which may have changed, or been cleared).
    const span = { id: r.termId, code: r.code, startsOn: r.startsOn, endsOn: r.endsOn }
    const was = stayDays(span, stay.from, null)
    const termFeePaise = (r.amountPaise * was.termDays) / Math.max(was.days, 1)
    await cancelChargeForSourceWithin(tx, stay.sourceModule, sourceOf(stay, r.termId), `stay ended on ${stay.until}`)
    await chargeStayWithin(tx, tenant, actorId, { ...stay, termFeePaise }, r.termId)
  }
  return { invoiced }
}

export { localToday } from '@campusos/module-finance/api'

/** Terms, newest first, for a picker. */
export async function termChoicesWithin(tx: Tx) {
  const rows = await tx.select({ id: terms.id, code: terms.code, name: terms.name }).from(terms).orderBy(desc(terms.startsOn))
  return rows.map((t) => ({ value: t.id, label: `${t.code} - ${t.name}` }))
}

const isFinance = (r: Role) => r === 'accounts_staff' || r === 'institution_admin' || r === 'super_admin'
const requireFinance = (actor: Actor) => {
  if (!actor.institutionId) throw new FeeError(400, 'no_institution', 'no institution for this session')
  if (!isFinance(actor.role)) throw new FeeError(403, 'forbidden', 'not permitted')
  return actor.institutionId
}

export const chargeStudentSchema = z
  .object({
    studentId: z.string().min(1),
    termId: z.uuid(),
    label: z.string().trim().min(3).max(120),
    /** Rupees, as typed: "1,500" or "1500.00". */
    amount: z.string().trim().min(1),
  })
  .meta({ id: 'FeeStudentCharge' })

export const cancelStudentChargeSchema = z
  .object({ chargeId: z.uuid(), reason: z.string().trim().min(5).max(500) })
  .meta({ id: 'FeeStudentChargeCancel' })

/** Once per idempotency key, as a payment is (NEW-15): submitted twice, charged once. */
export async function chargeStudent(actor: Actor, input: unknown) {
  const tenant = requireFinance(actor)
  const d = chargeStudentSchema.parse(input)
  const amountPaise = parseRupeesToPaise(d.amount)
  if (amountPaise === null || amountPaise <= 0) throw new FeeError(400, 'bad_amount', 'enter an amount in rupees, more than nothing')
  return withTenant(tenant, async (tx) => {
    const { value, replayed } = await withIdempotencyKey(
      tx,
      feeIdempotencyKeys,
      { institutionId: tenant, actorId: actor.id, operation: 'charge', key: actor.idempotencyKey, request: d },
      async () => {
        const row = await chargeStudentWithin(tx, tenant, actor.id, {
          studentId: d.studentId,
          termId: d.termId,
          label: d.label,
          amountPaise,
        })
        await audit(tx, {
          institutionId: tenant,
          actorId: actor.id,
          actorEmail: actor.email ?? null,
          moduleId: MODULE,
          action: 'charge',
          entity: 'fee_student_charges',
          entityId: row.id,
          reason: d.label,
        })
        return row
      },
      // A charge cancelled since is not answered as if it stood.
      async (id) =>
        (await tx.select().from(studentCharges).where(and(eq(studentCharges.id, id), isNull(studentCharges.cancelledAt))))[0],
    )
    return replayed
      ? { ...value, replayed: true, notice: 'Already charged. Nothing was charged twice.' }
      : { ...value, notice: 'Charged. It is billed on the next invoice.' }
  })
}

export async function cancelStudentCharge(actor: Actor, input: unknown) {
  const tenant = requireFinance(actor)
  const d = cancelStudentChargeSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [row] = await tx.select().from(studentCharges).where(eq(studentCharges.id, d.chargeId))
    if (!row) throw new FeeError(404, 'no_such_charge', 'no such charge')
    if (row.sourceModule !== MODULE) {
      throw new FeeError(409, 'not_ours', `that charge belongs to ${row.sourceModule}; cancel it there`)
    }
    try {
      await tx
        .update(studentCharges)
        .set({ cancelledAt: new Date(), cancelReason: d.reason })
        .where(eq(studentCharges.id, d.chargeId))
    } catch (e) {
      named(e)
    }
    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: 'cancel',
      entity: 'fee_student_charges',
      entityId: d.chargeId,
      reason: d.reason,
    })
    return { id: d.chargeId, notice: 'Cancelled.' }
  })
}

const CHARGE_SORTS: SortSpec = {
  created: {
    dir: 'desc',
    keys: [{ sql: sql`${studentCharges.createdAt}`, type: 'timestamptz' }, { sql: sql`${studentCharges.id}`, type: 'uuid' }],
  },
}
export const chargePage = (req: Request, prefix: string) => readPage(req, prefix, CHARGE_SORTS, 'created', 50)

/** Charges on single students, newest first, a page at a time (LOW-04). */
export async function listStudentCharges(actor: Actor, termId?: string, page = chargePage(new Request('https://x/'), '')) {
  const tenant = requireFinance(actor)
  const keys = CHARGE_SORTS[page.sort]!.keys
  const where = and(
    termId ? eq(studentCharges.termId, termId) : undefined,
    searchAny(page.q, [sql`${users.name}`, sql`${users.email}`, sql`${studentCharges.label}`]),
  )
  return withTenant(tenant, async (tx) => {
    const rows = await tx
      .select({
        c: studentCharges,
        student: users.name,
        email: users.email,
        term: terms.code,
        _cursor: cursorColumn(keys),
      })
      .from(studentCharges)
      .innerJoin(users, eq(users.id, studentCharges.studentId))
      .innerJoin(terms, eq(terms.id, studentCharges.termId))
      .where(and(where, keyset(keys, page)))
      .orderBy(...orderKeys(keys, page.dir))
      .limit(page.limit + 1)
    const [{ n }] = (await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(studentCharges)
      .innerJoin(users, eq(users.id, studentCharges.studentId))
      .where(where)) as [{ n: number }]
    return finishPage(
      rows.map((r) => ({
        ...r.c,
        student: r.student ?? r.email ?? r.c.studentId,
        term: r.term,
        state: r.c.cancelledAt ? 'cancelled' : r.c.invoicedAt ? 'invoiced' : 'pending',
        _cursor: r._cursor,
      })),
      page,
      Number(n),
    )
  })
}

/** What the office may still cancel: its own charges not yet invoiced. */
export async function cancellableCharges(actor: Actor) {
  const tenant = requireFinance(actor)
  return withTenant(tenant, async (tx) => {
    const rows = await tx
      .select({ id: studentCharges.id, label: studentCharges.label, student: users.name, email: users.email })
      .from(studentCharges)
      .innerJoin(users, eq(users.id, studentCharges.studentId))
      .where(
        and(
          eq(studentCharges.sourceModule, MODULE),
          isNull(studentCharges.cancelledAt),
          isNull(studentCharges.invoicedAt),
        ),
      )
      .orderBy(desc(studentCharges.createdAt))
    return rows.map((r) => ({ value: r.id, label: `${r.student ?? r.email}: ${r.label}` }))
  })
}

/** Every student, for a picker. */
export async function studentChoices(actor: Actor) {
  const tenant = requireFinance(actor)
  return withTenant(tenant, async (tx) => {
    const rows = await tx
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(eq(users.role, 'student'))
      .orderBy(asc(users.name))
    return rows.map((u) => ({ value: u.id, label: u.name ? `${u.name} (${u.email ?? ''})` : (u.email ?? u.id) }))
  })
}
