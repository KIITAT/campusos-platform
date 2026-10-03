import { and, asc, desc, eq, isNull } from 'drizzle-orm'
import * as z from 'zod'
import { audit, users, withTenant } from '@campusos/db'
import type { Role } from '@campusos/module-framework'
import { terms } from '@campusos/module-academic/schema'
import { parseRupeesToPaise } from '@campusos/money'
import { studentCharges } from '../schema'
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

export async function chargeStudent(actor: Actor, input: unknown) {
  const tenant = requireFinance(actor)
  const d = chargeStudentSchema.parse(input)
  const amountPaise = parseRupeesToPaise(d.amount)
  if (amountPaise === null || amountPaise <= 0) throw new FeeError(400, 'bad_amount', 'enter an amount in rupees, more than nothing')
  return withTenant(tenant, async (tx) => {
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
    return { ...row, notice: 'Charged. It is billed on the next invoice.' }
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

export async function listStudentCharges(actor: Actor, termId?: string) {
  const tenant = requireFinance(actor)
  return withTenant(tenant, async (tx) => {
    const rows = await tx
      .select({
        c: studentCharges,
        student: users.name,
        email: users.email,
        term: terms.code,
      })
      .from(studentCharges)
      .innerJoin(users, eq(users.id, studentCharges.studentId))
      .innerJoin(terms, eq(terms.id, studentCharges.termId))
      .where(termId ? eq(studentCharges.termId, termId) : undefined)
      .orderBy(desc(studentCharges.createdAt), asc(users.name))
    return rows.map((r) => ({
      ...r.c,
      student: r.student ?? r.email ?? r.c.studentId,
      term: r.term,
      state: r.c.cancelledAt ? 'cancelled' : r.c.invoicedAt ? 'invoiced' : 'pending',
    }))
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
