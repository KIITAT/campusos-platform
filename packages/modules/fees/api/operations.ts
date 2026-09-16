import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { audit, auditLog, users, withTenant } from '@campusos/db'
import { viewsOnBehalf, type Role, type ViewerScope } from '@campusos/module-framework'
import {
  programs,
  sectionMembers,
  sections,
  terms,
} from '@campusos/module-academic/schema'
import { feeItems, feePayments, feeWaivers, receiptCounters } from '../schema'
import {
  createFeeItemSchema,
  grantWaiverSchema,
  recordPaymentSchema,
  reconcilePaymentSchema,
  revokeWaiverSchema,
  type DuesReport,
  type StudentLedger,
} from './schemas'
import { ledger, overpaidPaise, type LedgerLine } from './ledger'

const MODULE = 'fees'

export interface Actor extends ViewerScope {
  id: string
  email?: string | null
  role: Role
  institutionId: string | null
}

export class FeeError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const tenantOf = (actor: Actor): string => {
  if (!actor.institutionId) {
    throw new FeeError(400, 'no_institution', 'no institution for this session')
  }
  return actor.institutionId
}

/** The finance desk, plus the administrators above it. */
const isFinance = (r: Role) =>
  r === 'accounts_staff' || r === 'institution_admin' || r === 'super_admin'

/** Waiving money and defining charges is a decision, not a clerk's task. */
const canWaive = (r: Role) => r === 'institution_admin' || r === 'super_admin'

const requireFinance = (actor: Actor) => {
  const tenant = tenantOf(actor)
  if (!isFinance(actor.role)) throw new FeeError(403, 'forbidden', 'not permitted')
  return tenant
}

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]

// --- charges ---------------------------------------------------------------

export async function createFeeItem(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  if (!canWaive(actor.role)) throw new FeeError(403, 'forbidden', 'not permitted')
  const data = createFeeItemSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const [row] = await tx
      .insert(feeItems)
      .values({
        institutionId: tenant,
        programId: data.programId,
        termId: data.termId,
        label: data.label,
        amountPaise: data.amount,
        dueOn: data.dueOn ? new Date(data.dueOn) : null,
      })
      .onConflictDoNothing()
      .returning()
    if (!row) {
      throw new FeeError(409, 'exists', `a "${data.label}" charge already exists for that term`)
    }
    return row
  })
}

export async function listFeeItems(actor: Actor, termId?: string) {
  const tenant = requireFinance(actor)
  return withTenant(tenant, (tx) =>
    tx
      .select({
        id: feeItems.id,
        label: feeItems.label,
        amountPaise: feeItems.amountPaise,
        dueOn: feeItems.dueOn,
        programCode: programs.code,
        programId: feeItems.programId,
        termCode: terms.code,
        termId: feeItems.termId,
      })
      .from(feeItems)
      .innerJoin(programs, eq(programs.id, feeItems.programId))
      .innerJoin(terms, eq(terms.id, feeItems.termId))
      .where(termId ? eq(feeItems.termId, termId) : undefined)
      .orderBy(asc(programs.code), asc(terms.code), asc(feeItems.label)),
  )
}

// --- waivers ---------------------------------------------------------------

/**
 * A scholarship or waiver. Audited with a mandatory reason, exactly as the
 * spec requires and by the same shared utility grade revisions use.
 */
export async function grantWaiver(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  if (!canWaive(actor.role)) throw new FeeError(403, 'forbidden', 'not permitted')
  const data = grantWaiverSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const [item] = await tx
      .select({ amountPaise: feeItems.amountPaise, label: feeItems.label })
      .from(feeItems)
      .where(eq(feeItems.id, data.feeItemId))
    if (!item) throw new FeeError(404, 'no_such_item', 'no such charge')

    // A waiver larger than the charge would make the balance negative, which
    // is a refund owed rather than a fee forgiven -- a different thing that
    // nobody asked for here.
    if (data.amount > item.amountPaise) {
      throw new FeeError(
        400,
        'waiver_exceeds_charge',
        `a waiver cannot exceed the ${item.label} charge itself`,
      )
    }

    const [existing] = await tx
      .select({ id: feeWaivers.id, amountPaise: feeWaivers.amountPaise })
      .from(feeWaivers)
      .where(
        and(eq(feeWaivers.studentId, data.studentId), eq(feeWaivers.feeItemId, data.feeItemId)),
      )

    const [row] = await tx
      .insert(feeWaivers)
      .values({
        institutionId: tenant,
        studentId: data.studentId,
        feeItemId: data.feeItemId,
        amountPaise: data.amount,
        reason: data.reason,
        grantedBy: actor.id,
      })
      .onConflictDoUpdate({
        target: [feeWaivers.studentId, feeWaivers.feeItemId],
        set: { amountPaise: data.amount, reason: data.reason, grantedBy: actor.id },
      })
      .returning({ id: feeWaivers.id })

    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: existing ? 'fee.waiver_revised' : 'fee.waiver_granted',
      entity: 'fee_waivers',
      entityId: row!.id,
      reason: data.reason,
      detail: {
        studentId: data.studentId,
        label: item.label,
        fromPaise: existing?.amountPaise ?? 0,
        toPaise: data.amount,
      },
    })

    return row!
  })
}

export async function revokeWaiver(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  if (!canWaive(actor.role)) throw new FeeError(403, 'forbidden', 'not permitted')
  const data = revokeWaiverSchema.parse(input)

  await withTenant(tenant, async (tx) => {
    const [row] = await tx
      .select()
      .from(feeWaivers)
      .where(eq(feeWaivers.id, data.waiverId))
    if (!row) throw new FeeError(404, 'no_such_waiver', 'no such waiver')

    // Audited before the delete: afterwards there is no row to describe.
    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: 'fee.waiver_revoked',
      entity: 'fee_waivers',
      entityId: row.id,
      reason: data.reason,
      detail: {
        studentId: row.studentId,
        feeItemId: row.feeItemId,
        wasPaise: row.amountPaise,
        originalReason: row.reason,
      },
    })

    await tx.delete(feeWaivers).where(eq(feeWaivers.id, data.waiverId))
  })
}

// --- payments -------------------------------------------------------------

/**
 * Next receipt number for the institution. A counter row updated in the same
 * transaction, not a count of payments: two clerks taking money at once must
 * not be handed the same number, and the row lock makes that impossible.
 */
async function nextReceiptNo(tx: Tx, tenant: string): Promise<string> {
  await tx
    .insert(receiptCounters)
    .values({ institutionId: tenant })
    .onConflictDoNothing()

  const [row] = await tx
    .update(receiptCounters)
    .set({ next: sql`${receiptCounters.next} + 1` })
    .where(eq(receiptCounters.institutionId, tenant))
    .returning({ prefix: receiptCounters.prefix, next: receiptCounters.next })

  // `next` comes back already incremented, so the number issued is one less.
  return `${row!.prefix}-${String(row!.next - 1).padStart(6, '0')}`
}

export async function recordPayment(actor: Actor, input: unknown) {
  const tenant = requireFinance(actor)
  const data = recordPaymentSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    // The student must be visible in this tenant, which RLS decides, and must
    // actually be a student.
    const [student] = await tx
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, data.studentId))
    if (!student) throw new FeeError(404, 'no_such_student', 'no such student')
    if (student.role !== 'student') {
      throw new FeeError(400, 'not_a_student', 'fees are recorded against students')
    }

    const receiptNo = await nextReceiptNo(tx, tenant)

    const [row] = await tx
      .insert(feePayments)
      .values({
        institutionId: tenant,
        studentId: data.studentId,
        termId: data.termId,
        amountPaise: data.amount,
        method: data.method,
        reference: data.reference ?? null,
        receivedAt: data.receivedAt ? new Date(data.receivedAt) : new Date(),
        recordedBy: actor.id,
        receiptNo,
        notes: data.notes ?? null,
      })
      .returning()

    // Recording is not itself a discretionary act, but it moves money, so it
    // is on the trail without needing a typed reason.
    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: 'fee.payment_recorded',
      entity: 'fee_payments',
      entityId: row!.id,
      reason: `receipt ${receiptNo} for ${data.method}`,
      detail: {
        studentId: data.studentId,
        amountPaise: data.amount,
        method: data.method,
        reference: data.reference ?? null,
      },
    })

    return row!
  })
}

/**
 * Manual reconciliation: the accounts office confirming this payment against
 * the bank. Audited with a mandatory reason, per the spec, because it is the
 * assertion that turns a claim into cleared funds.
 */
export async function reconcilePayment(actor: Actor, input: unknown) {
  const tenant = requireFinance(actor)
  const data = reconcilePaymentSchema.parse(input)

  await withTenant(tenant, async (tx) => {
    const [row] = await tx
      .select()
      .from(feePayments)
      .where(eq(feePayments.id, data.paymentId))
    if (!row) throw new FeeError(404, 'no_such_payment', 'no such payment')
    if (row.reconciledAt) {
      throw new FeeError(409, 'already_reconciled', 'that payment is already reconciled')
    }

    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: 'fee.payment_reconciled',
      entity: 'fee_payments',
      entityId: row.id,
      reason: data.reason,
      detail: {
        receiptNo: row.receiptNo,
        amountPaise: row.amountPaise,
        method: row.method,
        reference: row.reference,
      },
    })

    await tx
      .update(feePayments)
      .set({ reconciledAt: new Date(), reconciledBy: actor.id })
      .where(eq(feePayments.id, data.paymentId))
  })
}

export async function paymentTrail(actor: Actor, paymentId: string) {
  const tenant = requireFinance(actor)
  return withTenant(tenant, (tx) =>
    tx
      .select({
        at: auditLog.at,
        action: auditLog.action,
        reason: auditLog.reason,
        actorEmail: auditLog.actorEmail,
      })
      .from(auditLog)
      .where(and(eq(auditLog.entity, 'fee_payments'), eq(auditLog.entityId, paymentId)))
      .orderBy(asc(auditLog.at)),
  )
}

// --- reads ----------------------------------------------------------------

/**
 * Charges applying to one student in one term: the fee items for whichever
 * programmes their cohorts belong to.
 */
async function chargesFor(tx: Tx, studentId: string, termId: string) {
  const progs = await tx
    .selectDistinct({ programId: sections.programId })
    .from(sectionMembers)
    .innerJoin(sections, eq(sections.id, sectionMembers.sectionId))
    .where(eq(sectionMembers.userId, studentId))

  if (progs.length === 0) return []

  return tx
    .select({
      feeItemId: feeItems.id,
      label: feeItems.label,
      chargedPaise: feeItems.amountPaise,
      waiverId: feeWaivers.id,
      waivedPaise: feeWaivers.amountPaise,
      waiverReason: feeWaivers.reason,
    })
    .from(feeItems)
    .leftJoin(
      feeWaivers,
      and(eq(feeWaivers.feeItemId, feeItems.id), eq(feeWaivers.studentId, studentId)),
    )
    .where(
      and(
        eq(feeItems.termId, termId),
        inArray(feeItems.programId, progs.map((p) => p.programId)),
      ),
    )
    .orderBy(asc(feeItems.label))
}

export async function studentLedger(
  actor: Actor,
  studentId: string,
  termId: string,
): Promise<StudentLedger> {
  const tenant = tenantOf(actor)
  // A student may read their own; the finance desk may read any.
  if (!viewsOnBehalf(actor, studentId)) {
    if (actor.role === 'student') {
      if (studentId !== actor.id) throw new FeeError(403, 'forbidden', 'not permitted')
    } else if (!isFinance(actor.role) && actor.role !== 'hod') {
      throw new FeeError(403, 'forbidden', 'not permitted')
    }
  }

  return withTenant(tenant, async (tx): Promise<StudentLedger> => {
    const [student] = await tx
      .select({ name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, studentId))
    if (!student) throw new FeeError(404, 'no_such_student', 'no such student')

    const [term] = await tx
      .select({ code: terms.code, name: terms.name })
      .from(terms)
      .where(eq(terms.id, termId))
    if (!term) throw new FeeError(404, 'no_such_term', 'no such term')

    const charges = await chargesFor(tx, studentId, termId)
    const payments = await tx
      .select()
      .from(feePayments)
      .where(and(eq(feePayments.studentId, studentId), eq(feePayments.termId, termId)))
      .orderBy(asc(feePayments.receivedAt))

    const lines: LedgerLine[] = charges.map((c) => ({
      label: c.label,
      chargedPaise: c.chargedPaise,
      waivedPaise: c.waivedPaise ?? 0,
    }))
    const l = ledger(lines, payments)

    return {
      studentId,
      studentName: student.name,
      studentEmail: student.email,
      termCode: term.code,
      termName: term.name,
      lines: charges.map((c) => ({
        feeItemId: c.feeItemId,
        label: c.label,
        chargedPaise: c.chargedPaise,
        waivedPaise: c.waivedPaise ?? 0,
        waiverId: c.waiverId,
        waiverReason: c.waiverReason,
      })),
      payments: payments.map((p) => ({
        id: p.id,
        receiptNo: p.receiptNo,
        amountPaise: p.amountPaise,
        method: p.method,
        reference: p.reference,
        receivedAt: p.receivedAt.toISOString(),
        reconciledAt: p.reconciledAt?.toISOString() ?? null,
      })),
      chargedPaise: l.chargedPaise,
      waivedPaise: l.waivedPaise,
      payablePaise: l.payablePaise,
      paidPaise: l.paidPaise,
      unreconciledPaise: l.unreconciledPaise,
      outstandingPaise: l.outstandingPaise,
      overpaidPaise: overpaidPaise(l),
    }
  })
}

/**
 * Defaulters for a term. Every enrolled student, not only those who have paid
 * something, because the ones who have paid nothing are the point of the report.
 */
export async function duesReport(actor: Actor, termId: string): Promise<DuesReport> {
  const tenant = requireFinance(actor)

  return withTenant(tenant, async (tx): Promise<DuesReport> => {
    const [term] = await tx
      .select({ code: terms.code })
      .from(terms)
      .where(eq(terms.id, termId))
    if (!term) throw new FeeError(404, 'no_such_term', 'no such term')

    const roster = await tx
      .selectDistinct({
        studentId: users.id,
        studentName: users.name,
        studentEmail: users.email,
        programCode: programs.code,
      })
      .from(sectionMembers)
      .innerJoin(users, eq(users.id, sectionMembers.userId))
      .innerJoin(sections, eq(sections.id, sectionMembers.sectionId))
      .innerJoin(programs, eq(programs.id, sections.programId))
      .orderBy(asc(programs.code), asc(users.email))

    const rows = []
    for (const s of roster) {
      // ponytail: one pair of queries per student. Fine at a few hundred; if a
      // term's roster reaches thousands, fold this into two grouped queries.
      const charges = await chargesFor(tx, s.studentId, termId)
      const payments = await tx
        .select({ amountPaise: feePayments.amountPaise, reconciledAt: feePayments.reconciledAt })
        .from(feePayments)
        .where(and(eq(feePayments.studentId, s.studentId), eq(feePayments.termId, termId)))

      const l = ledger(
        charges.map((c) => ({
          label: c.label,
          chargedPaise: c.chargedPaise,
          waivedPaise: c.waivedPaise ?? 0,
        })),
        payments,
      )
      if (l.payablePaise === 0 && l.paidPaise === 0) continue

      rows.push({
        studentId: s.studentId,
        studentName: s.studentName,
        studentEmail: s.studentEmail,
        programCode: s.programCode,
        payablePaise: l.payablePaise,
        paidPaise: l.paidPaise,
        unreconciledPaise: l.unreconciledPaise,
        outstandingPaise: l.outstandingPaise,
      })
    }

    return {
      termCode: term.code,
      rows: rows.sort((a, b) => b.outstandingPaise - a.outstandingPaise),
      totalOutstandingPaise: rows.reduce((n, r) => n + r.outstandingPaise, 0),
      defaulterCount: rows.filter((r) => r.outstandingPaise > 0).length,
    }
  })
}

export async function paymentForReceipt(actor: Actor, paymentId: string) {
  const tenant = tenantOf(actor)

  return withTenant(tenant, async (tx) => {
    const [row] = await tx
      .select({
        id: feePayments.id,
        receiptNo: feePayments.receiptNo,
        amountPaise: feePayments.amountPaise,
        method: feePayments.method,
        reference: feePayments.reference,
        receivedAt: feePayments.receivedAt,
        reconciledAt: feePayments.reconciledAt,
        studentId: feePayments.studentId,
        studentName: users.name,
        studentEmail: users.email,
        termCode: terms.code,
        termName: terms.name,
      })
      .from(feePayments)
      .innerJoin(users, eq(users.id, feePayments.studentId))
      .innerJoin(terms, eq(terms.id, feePayments.termId))
      .where(eq(feePayments.id, paymentId))
    if (!row) throw new FeeError(404, 'no_such_payment', 'no such payment')

    // A student may fetch only their own receipt.
    if (!viewsOnBehalf(actor, row.studentId)) {
      if (actor.role === 'student' && row.studentId !== actor.id) {
        throw new FeeError(403, 'forbidden', 'not permitted')
      }
      if (actor.role !== 'student' && !isFinance(actor.role)) {
        throw new FeeError(403, 'forbidden', 'not permitted')
      }
    }
    return row
  })
}
