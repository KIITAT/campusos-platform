import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { audit, auditLog, users, withTenant } from '@campusos/db'
import { viewsOnBehalf, type Role, type ViewerScope } from '@campusos/module-framework'
import {
  programs,
  sectionMembers,
  sections,
  terms,
} from '@campusos/module-academic/schema'
import {
  feeInvoices,
  feeItems,
  feePayments,
  feeRefunds,
  feeWaivers,
  receiptCounters,
} from '../schema'
import {
  createFeeItemSchema,
  grantWaiverSchema,
  issueInvoicesSchema,
  recordPaymentSchema,
  reconcilePaymentSchema,
  refundPaymentSchema,
  revokeWaiverSchema,
  type DuesReport,
  type StudentLedger,
} from './schemas'
import { ledger, overpaidPaise, type LedgerLine } from './ledger'
import { postInvoice, postPayment, postRefund, postWaiverChange } from './posting'

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

/**
 * Issuing charges and giving money back are decisions, not counter work -- the
 * same line waivers already sit on the far side of.
 */
const requireAdmin = (actor: Actor) => {
  const tenant = tenantOf(actor)
  if (!canWaive(actor.role)) throw new FeeError(403, 'forbidden', 'not permitted')
  return tenant
}

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]

/** Whether this student's charges for this term have been issued yet. */
async function invoiceFor(tx: Tx, studentId: string, termId: string) {
  const [row] = await tx
    .select()
    .from(feeInvoices)
    .where(and(eq(feeInvoices.studentId, studentId), eq(feeInvoices.termId, termId)))
  return row ?? null
}

/** For a journal memo, which a human reads and an account number does not help. */
async function nameOf(tx: Tx, userId: string): Promise<string | null> {
  const [row] = await tx.select({ name: users.name }).from(users).where(eq(users.id, userId))
  return row?.name ?? null
}

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
      .select({
        amountPaise: feeItems.amountPaise,
        label: feeItems.label,
        termId: feeItems.termId,
      })
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
      .select({
        id: feeWaivers.id,
        amountPaise: feeWaivers.amountPaise,
        postedPaise: feeWaivers.postedPaise,
        postings: feeWaivers.postings,
      })
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

    // If the charges have already gone out, forgiving part of them is an event
    // in the books and posts the difference. If they have not, this waiver is
    // simply part of what will be issued, and posting it now would forgive it
    // twice.
    if (await invoiceFor(tx, data.studentId, item.termId)) {
      const posting = (existing?.postings ?? 0) + 1
      await tx
        .update(feeWaivers)
        .set({ postedPaise: data.amount, postings: posting })
        .where(eq(feeWaivers.id, row!.id))

      await postWaiverChange(tx, tenant, actor.id, {
        waiverId: row!.id,
        posting,
        deltaPaise: data.amount - (existing?.postedPaise ?? 0),
        label: item.label,
        studentName: await nameOf(tx, data.studentId),
      })
    }

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

    // Whatever the books were told is forgiven, they are now told otherwise.
    if (row.postedPaise > 0) {
      const [item] = await tx
        .select({ label: feeItems.label })
        .from(feeItems)
        .where(eq(feeItems.id, row.feeItemId))

      await postWaiverChange(tx, tenant, actor.id, {
        waiverId: row.id,
        posting: row.postings + 1,
        deltaPaise: -row.postedPaise,
        label: item?.label ?? 'a charge',
        studentName: await nameOf(tx, row.studentId),
      })
    }

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

    // Same transaction, deliberately: money recorded and books that never
    // heard about it is the one failure this module cannot have.
    //
    // Posted at recording rather than at reconciliation. Reconciling is the
    // accounts office matching a claim against the bank statement -- useful,
    // and not an accounting event: the entry the student's receipt describes
    // happened when the money changed hands. A cheque that bounces is a
    // reversing entry, which is what the journal is for.
    await postPayment(tx, tenant, actor.id, row!)

    return row!
  })
}

/**
 * Issue a term's charges, turning a price list into money owed.
 *
 * Per term rather than per student: issuing one at a time is how half a cohort
 * ends up uninvoiced and unchased. Re-running it is safe, and is how a charge
 * added late reaches the books -- the invoice keeps what was issued, and only
 * the difference is posted.
 *
 * No audit row. Issuing is not a discretionary act with a reason behind it,
 * and the journal entry it writes is already append-only evidence of what was
 * issued and when.
 */
export async function issueInvoices(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const data = issueInvoicesSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const [term] = await tx
      .select({ code: terms.code })
      .from(terms)
      .where(eq(terms.id, data.termId))
    if (!term) throw new FeeError(404, 'no_such_term', 'no such term')

    const roster = await tx
      .selectDistinct({
        studentId: users.id,
        studentName: users.name,
        studentEmail: users.email,
      })
      .from(sectionMembers)
      .innerJoin(users, eq(users.id, sectionMembers.userId))
      .where(data.studentId ? eq(sectionMembers.userId, data.studentId) : undefined)
      .orderBy(asc(users.email))

    const issued = []
    let unchanged = 0

    for (const s of roster) {
      // ponytail: a pair of queries per student, like duesReport. Fine for a
      // few hundred; fold into grouped queries if a roster reaches thousands.
      const charges = await chargesFor(tx, s.studentId, data.termId)
      const chargedPaise = charges.reduce((n, c) => n + c.chargedPaise, 0)
      if (chargedPaise === 0) continue

      const invoice = await invoiceFor(tx, s.studentId, data.termId)
      const delta = chargedPaise - (invoice?.chargedPaise ?? 0)
      if (delta <= 0) {
        unchanged++
        continue
      }

      // Waivers the books have not been told about: everything granted before
      // this student was ever invoiced, plus anything against a charge added
      // since. Both ride along in this entry.
      const fresh = charges.filter(
        (c) => c.waiverId && (c.waivedPaise ?? 0) > (c.postedPaise ?? 0),
      )
      const waivedPaise = fresh.reduce(
        (n, c) => n + ((c.waivedPaise ?? 0) - (c.postedPaise ?? 0)),
        0,
      )

      const version = (invoice?.version ?? 0) + 1
      const id =
        invoice?.id ??
        (
          await tx
            .insert(feeInvoices)
            .values({
              institutionId: tenant,
              studentId: s.studentId,
              termId: data.termId,
              chargedPaise,
              issuedBy: actor.id,
            })
            .returning({ id: feeInvoices.id })
        )[0]!.id

      if (invoice) {
        await tx
          .update(feeInvoices)
          .set({ chargedPaise, version })
          .where(eq(feeInvoices.id, invoice.id))
      }

      await postInvoice(tx, tenant, actor.id, {
        id,
        version,
        studentName: s.studentName,
        termCode: term.code,
        chargedPaise: delta,
        waivedPaise,
      })

      if (fresh.length > 0) {
        await tx
          .update(feeWaivers)
          .set({ postedPaise: sql`${feeWaivers.amountPaise}` })
          .where(
            inArray(
              feeWaivers.id,
              fresh.map((c) => c.waiverId!),
            ),
          )
      }

      issued.push({
        studentId: s.studentId,
        studentName: s.studentName,
        invoiceId: id,
        version,
        chargedPaise: delta,
        waivedPaise,
      })
    }

    return { termCode: term.code, issued, unchanged }
  })
}

export async function listInvoices(actor: Actor, termId: string) {
  const tenant = requireFinance(actor)
  return withTenant(tenant, (tx) =>
    tx
      .select({
        id: feeInvoices.id,
        studentId: feeInvoices.studentId,
        studentName: users.name,
        studentEmail: users.email,
        chargedPaise: feeInvoices.chargedPaise,
        version: feeInvoices.version,
        issuedAt: feeInvoices.issuedAt,
      })
      .from(feeInvoices)
      .innerJoin(users, eq(users.id, feeInvoices.studentId))
      .where(eq(feeInvoices.termId, termId))
      .orderBy(asc(users.email)),
  )
}

/**
 * Money back out, against the payment it came in on.
 *
 * Never a deletion of the payment: the money did arrive, and a ledger that
 * erased it would answer a different question from the one the student's
 * receipt asks. The database refuses a refund larger than its payment too, so
 * that the check surviving is not a matter of remembering to call it.
 */
export async function refundPayment(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const data = refundPaymentSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const [payment] = await tx
      .select()
      .from(feePayments)
      .where(eq(feePayments.id, data.paymentId))
    if (!payment) throw new FeeError(404, 'no_such_payment', 'no such payment')

    const [sums] = await tx
      .select({ back: sql<number>`coalesce(sum(${feeRefunds.amountPaise}), 0)::bigint` })
      .from(feeRefunds)
      .where(eq(feeRefunds.paymentId, payment.id))
    const already = Number(sums?.back ?? 0)

    if (already + data.amount > payment.amountPaise) {
      throw new FeeError(
        400,
        'refund_exceeds_payment',
        `receipt ${payment.receiptNo} has ${payment.amountPaise - already} paise left to refund`,
      )
    }

    const [row] = await tx
      .insert(feeRefunds)
      .values({
        institutionId: tenant,
        paymentId: payment.id,
        amountPaise: data.amount,
        method: data.method ?? payment.method,
        reference: data.reference ?? null,
        reason: data.reason,
        refundedBy: actor.id,
      })
      .returning()

    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: 'fee.refunded',
      entity: 'fee_refunds',
      entityId: row!.id,
      reason: data.reason,
      detail: {
        studentId: payment.studentId,
        receiptNo: payment.receiptNo,
        amountPaise: data.amount,
        ofPaise: payment.amountPaise,
        method: row!.method,
      },
    })

    await postRefund(tx, tenant, actor.id, {
      id: row!.id,
      receiptNo: payment.receiptNo,
      amountPaise: row!.amountPaise,
      method: row!.method,
      refundedAt: row!.refundedAt,
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
      postedPaise: feeWaivers.postedPaise,
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

/** What has gone back out to this student for this term. */
function refundsFor(tx: Tx, studentId: string, termId: string) {
  return tx
    .select({ amountPaise: feeRefunds.amountPaise })
    .from(feeRefunds)
    .innerJoin(feePayments, eq(feePayments.id, feeRefunds.paymentId))
    .where(and(eq(feePayments.studentId, studentId), eq(feePayments.termId, termId)))
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
    const refunds = await refundsFor(tx, studentId, termId)
    const invoice = await invoiceFor(tx, studentId, termId)

    const lines: LedgerLine[] = charges.map((c) => ({
      label: c.label,
      chargedPaise: c.chargedPaise,
      waivedPaise: c.waivedPaise ?? 0,
    }))
    const l = ledger(lines, payments, refunds)

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
      refundedPaise: l.refundedPaise,
      unreconciledPaise: l.unreconciledPaise,
      outstandingPaise: l.outstandingPaise,
      overpaidPaise: overpaidPaise(l),
      invoicedAt: invoice?.issuedAt.toISOString() ?? null,
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
        await refundsFor(tx, s.studentId, termId),
      )
      if (l.payablePaise === 0 && l.paidPaise === 0) continue

      rows.push({
        studentId: s.studentId,
        studentName: s.studentName,
        studentEmail: s.studentEmail,
        programCode: s.programCode,
        payablePaise: l.payablePaise,
        paidPaise: l.paidPaise,
        refundedPaise: l.refundedPaise,
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
