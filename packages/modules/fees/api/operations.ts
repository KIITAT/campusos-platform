import { and, asc, eq, inArray, isNull, notLike, sql } from 'drizzle-orm'
import { audit, auditLog, users, withIdempotencyKey, withTenant } from '@campusos/db'
import {
  assertCanAccessStudent,
  cursorColumn,
  finishPage,
  keyset,
  orderKeys,
  readPage,
  searchAny,
  viewsOnBehalf,
  type Role,
  type SortSpec,
  type ViewerScope,
} from '@campusos/module-framework'
import { programs, terms } from '@campusos/module-academic/schema'
import {
  feeIdempotencyKeys,
  feeInvoices,
  feeItems,
  feePayments,
  feeRefunds,
  feeWaivers,
  receiptCounters,
  studentCharges,
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
import { postedOf, postedSql } from './books'
import { postInvoice, postPayment, postRefund, postWaiverChange } from './posting'
import { enrolledPrograms, notEnrolled, priceListSql, termRoster } from './enrolment'
import { checkOtherPerson } from '@campusos/module-finance/api'
import { notify } from '@campusos/module-notices/api'

const MODULE = 'fees'

/**
 * Methods whose reference names one transfer in the whole banking system -- a
 * UTR, a UPI reference -- and so is receipted once (ACC-18). A cheque number
 * does not: two banks' cheques can both be 000123.
 */
export const ONE_RECEIPT_PER_REFERENCE = ['bank_transfer', 'upi'] as const
const onePerReference = (m: string) => (ONE_RECEIPT_PER_REFERENCE as readonly string[]).includes(m)

/** The constraint a drizzle error carries, down its cause chain. */
const constraintOf = (e: unknown): string | undefined => {
  for (let x: unknown = e; x instanceof Error; x = (x as { cause?: unknown }).cause) {
    const c = (x as { constraint?: string }).constraint
    if (c) return c
  }
  return undefined
}

export interface Actor extends ViewerScope {
  id: string
  email?: string | null
  role: Role
  institutionId: string | null
  /** The caller's idempotency key, from the host (ACC-18). */
  idempotencyKey?: string | null
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
export const requireAdmin = (actor: Actor) => {
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
        proratable: data.proratable,
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
        programId: feeItems.programId,
      })
      .from(feeItems)
      .where(eq(feeItems.id, data.feeItemId))
    if (!item) throw new FeeError(404, 'no_such_item', 'no such charge')

    // Only a charge the student actually has (ACC-22): an item of a programme
    // they are enrolled in for its term, by the rule that bills them. Anything
    // else would post waiver expense against a debt that was never raised.
    const enrolled = await enrolledPrograms(tx, data.studentId, item.termId)
    if (!enrolled.some((p) => p.programId === item.programId)) {
      throw new FeeError(
        400,
        'item_not_charged',
        `the ${item.label} charge does not apply to this student in that term`,
      )
    }

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

/**
 * Money received at the counter, once per idempotency key (ACC-18).
 *
 * The key is claimed before anything else is written -- before the receipt
 * number above all -- so a form submitted twice waits for the first
 * submission and is answered with its receipt, and the series keeps no gap.
 */
export async function recordPayment(actor: Actor, input: unknown) {
  const tenant = requireFinance(actor)
  const data = recordPaymentSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const { value, replayed } = await withIdempotencyKey(
      tx,
      feeIdempotencyKeys,
      { institutionId: tenant, actorId: actor.id, operation: 'payment', key: actor.idempotencyKey, request: data },
      () =>
        recordPaymentWithin(tx, tenant, actor, {
          studentId: data.studentId,
          termId: data.termId,
          amountPaise: data.amount,
          method: data.method,
          reference: data.reference ?? null,
          receivedAt: data.receivedAt ? new Date(data.receivedAt) : new Date(),
          notes: data.notes ?? null,
        }),
      async (id) => (await tx.select().from(feePayments).where(eq(feePayments.id, id)))[0],
    )
    return replayed
      ? { ...value, replayed: true, notice: `Already recorded as receipt ${value.receiptNo}. Nothing was recorded twice.` }
      : value
  })
}

export interface PaymentInput {
  studentId: string
  termId: string
  amountPaise: number
  method: (typeof feePayments.$inferInsert)['method']
  reference: string | null
  receivedAt: Date
  notes: string | null
}

/**
 * Record money received, in the caller's transaction: the receipt number, the
 * audit row and the journal entry land together or not at all.
 */
export async function recordPaymentWithin(tx: Tx, tenant: string, actor: Actor, data: PaymentInput) {
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

  // A UTR already receipted -- typed twice, or typed once and now arriving as
  // the student's verified claim -- is refused before it takes a receipt
  // number. The unique index is what holds when two requests race past this.
  const reference = data.reference?.trim() || null
  if (reference && onePerReference(data.method)) {
    const [prior] = await tx
      .select({ receiptNo: feePayments.receiptNo })
      .from(feePayments)
      .where(
        and(
          inArray(feePayments.method, [...ONE_RECEIPT_PER_REFERENCE]),
          sql`${feePayments.reference} is not null and btrim(${feePayments.reference}) <> ''`,
          sql`upper(btrim(${feePayments.reference})) = upper(${reference})`,
        ),
      )
    if (prior) {
      throw new FeeError(409, 'duplicate_reference', `${reference} is already receipted as ${prior.receiptNo}`)
    }
  }

  const receiptNo = await nextReceiptNo(tx, tenant)

  let row: typeof feePayments.$inferSelect | undefined
  try {
    ;[row] = await tx
      .insert(feePayments)
      .values({
        institutionId: tenant,
        studentId: data.studentId,
        termId: data.termId,
        amountPaise: data.amountPaise,
        method: data.method,
        reference,
        receivedAt: data.receivedAt,
        recordedBy: actor.id,
        receiptNo,
        notes: data.notes,
      })
      .returning()
  } catch (e) {
    if (constraintOf(e) === 'fee_payments_reference') {
      throw new FeeError(409, 'duplicate_reference', `${reference} has just been receipted by another request`)
    }
    throw e
  }

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
      amountPaise: data.amountPaise,
      method: data.method,
      reference,
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
}

/** Students per transaction when a term is issued (REL-09, decision 528). */
export const ISSUE_CHUNK = 500

interface IssuedInvoice {
  studentId: string
  studentName: string | null
  invoiceId: string
  version: number
  chargedPaise: number
  waivedPaise: number
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

  // Enrolled in the term, by programme declaration (ACC-19): not every
  // section member, who may have left, or be there for an elective.
  const { term, roster } = await withTenant(tenant, async (tx) => {
    const [term] = await tx
      .select({ code: terms.code })
      .from(terms)
      .where(eq(terms.id, data.termId))
    if (!term) throw new FeeError(404, 'no_such_term', 'no such term')
    return { term, roster: await termRoster(tx, data.termId, data.studentId) }
  })

  const issued: IssuedInvoice[] = []
  let unchanged = 0
  let chunks = 0
  // ponytail: the whole term runs inside the request; move the loop into a job per chunk if a proxy ever cuts a long request.
  for (let i = 0; i < roster.length; i += ISSUE_CHUNK) {
    const r = await withTenant(tenant, (tx) =>
      issueChunk(tx, tenant, actor, data.termId, term.code, roster.slice(i, i + ISSUE_CHUNK)),
    )
    issued.push(...r.issued)
    unchanged += r.unchanged
    chunks++
  }

  // Sitting in a section, never declared: not billed, and named, so a
  // forgotten declaration is fixed rather than quietly going unbilled.
  const missing = await withTenant(tenant, (tx) => notEnrolled(tx, data.termId, data.studentId))
  const named = missing.slice(0, 10).map((m) => `${m.studentName ?? m.studentEmail} (${m.programCode})`)
  const notice =
    `Invoiced ${issued.length} for ${term.code}; ${unchanged} unchanged.` +
    (missing.length > 0
      ? ` Not invoiced, because they are in a section but not enrolled in its programme: ${named.join(', ')}${missing.length > named.length ? ` and ${missing.length - named.length} more` : ''}.`
      : '')

  return { termCode: term.code, issued, unchanged, notEnrolled: missing, notice, chunks }
}

/**
 * One chunk of a term, in its own transaction. The term lock makes two runs of
 * the same term take their chunks in turn, so the second sees the first's
 * invoices and reports them unchanged instead of failing on a unique key.
 */
async function issueChunk(
  tx: Tx,
  tenant: string,
  actor: Actor,
  termId: string,
  termCode: string,
  students: { studentId: string; studentName: string | null }[],
) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'fees.issue:' + termId}, 0))`)

  const ids = students.map((s) => s.studentId)
  const lines = (await tx.execute(priceListSql(termId, ids))).rows as Record<string, unknown>[]
  const priced = new Map<string, { listed: number; unposted: number; freshWaivers: string[] }>()
  for (const l of lines) {
    const g = priced.get(String(l.student_id)) ?? { listed: 0, unposted: 0, freshWaivers: [] }
    g.listed += Number(l.charged)
    g.unposted += Number(l.unposted_waived)
    if (l.waiver_id && Number(l.unposted_waived) > 0) g.freshWaivers.push(String(l.waiver_id))
    priced.set(String(l.student_id), g)
  }

  const existing = new Map(
    (
      await tx
        .select({
          id: feeInvoices.id,
          studentId: feeInvoices.studentId,
          chargedPaise: feeInvoices.chargedPaise,
          version: feeInvoices.version,
        })
        .from(feeInvoices)
        .where(and(eq(feeInvoices.termId, termId), inArray(feeInvoices.studentId, ids)))
    ).map((i) => [i.studentId, i]),
  )

  const issued: IssuedInvoice[] = []
  let unchanged = 0
  const freshWaiverIds: string[] = []
  for (const s of students) {
    const group = priced.get(s.studentId)
    const listed = group?.listed ?? 0
    if (!group || listed === 0) continue

    const invoice = existing.get(s.studentId)
    const delta = listed - (invoice?.chargedPaise ?? 0)
    if (delta <= 0) {
      unchanged++
      continue
    }

    const version = (invoice?.version ?? 0) + 1
    const id =
      invoice?.id ??
      (
        await tx
          .insert(feeInvoices)
          .values({
            institutionId: tenant,
            studentId: s.studentId,
            termId,
            chargedPaise: listed,
            issuedBy: actor.id,
          })
          .returning({ id: feeInvoices.id })
      )[0]!.id

    if (invoice) {
      await tx.update(feeInvoices).set({ chargedPaise: listed, version }).where(eq(feeInvoices.id, invoice.id))
    }

    // Waivers the books have not been told about: everything granted before
    // this student was ever invoiced, plus anything against a charge added
    // since. Both ride along in this entry.
    await postInvoice(tx, tenant, actor.id, {
      id,
      version,
      studentName: s.studentName,
      termCode,
      chargedPaise: delta,
      waivedPaise: group.unposted,
    })
    freshWaiverIds.push(...group.freshWaivers)
    issued.push({
      studentId: s.studentId,
      studentName: s.studentName,
      invoiceId: id,
      version,
      chargedPaise: delta,
      waivedPaise: group.unposted,
    })
  }

  if (freshWaiverIds.length > 0) {
    await tx
      .update(feeWaivers)
      .set({ postedPaise: sql`${feeWaivers.amountPaise}` })
      .where(inArray(feeWaivers.id, freshWaiverIds))
  }

  if (issued.length > 0) {
    const issuedIds = issued.map((i) => i.studentId)
    // The student's own charges are in the books now: from here they are
    // waived or refunded, not cancelled.
    await tx
      .update(studentCharges)
      .set({ invoicedAt: new Date() })
      .where(
        and(
          eq(studentCharges.termId, termId),
          inArray(studentCharges.studentId, issuedIds),
          isNull(studentCharges.cancelledAt),
          isNull(studentCharges.invoicedAt),
        ),
      )
    await notify(tx, tenant, {
      userIds: issuedIds,
      moduleId: 'fees',
      title: `Fees invoiced for ${termCode}`,
      body: `Fees for ${termCode} have been invoiced. See your fee account for what is due.`,
      link: '/m/fees/me',
      alsoGuardians: { link: '/m/parents' },
    })
  }

  return { issued, unchanged }
}

export async function listInvoices(actor: Actor, termId: string, page = invoicePage(new Request('https://x/'), '')) {
  const tenant = requireFinance(actor)
  return withTenant(tenant, async (tx) => {
    const keys = INVOICE_SORTS[page.sort]!.keys
    const rows = await tx
      .select({
        id: feeInvoices.id,
        studentId: feeInvoices.studentId,
        studentName: users.name,
        studentEmail: users.email,
        chargedPaise: feeInvoices.chargedPaise,
        version: feeInvoices.version,
        issuedAt: feeInvoices.issuedAt,
        _cursor: cursorColumn(keys),
      })
      .from(feeInvoices)
      .innerJoin(users, eq(users.id, feeInvoices.studentId))
      .where(and(eq(feeInvoices.termId, termId), keyset(keys, page)))
      .orderBy(...orderKeys(keys, page.dir))
      .limit(page.limit + 1)
    const [count] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(feeInvoices)
      .where(eq(feeInvoices.termId, termId))
    return finishPage(rows, page, Number(count!.n))
  })
}

/**
 * Money back out, against the payment it came in on.
 *
 * Never a deletion of the payment: the money did arrive, and a ledger that
 * erased it would answer a different question from the one the student's
 * receipt asks. The database refuses a refund larger than its payment too, so
 * that the check surviving is not a matter of remembering to call it.
 *
 * Once per idempotency key, as a payment is (NEW-15): a refund form submitted
 * twice pays out once.
 */
export async function refundPayment(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const data = refundPaymentSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const { value, replayed } = await withIdempotencyKey(
      tx,
      feeIdempotencyKeys,
      { institutionId: tenant, actorId: actor.id, operation: 'refund', key: actor.idempotencyKey, request: data },
      () => refundWithin(tx, tenant, actor, data),
      async (id) => (await tx.select().from(feeRefunds).where(eq(feeRefunds.id, id)))[0],
    )
    return replayed ? { ...value, replayed: true, notice: 'Already refunded. Nothing was refunded twice.' } : value
  })
}

type RefundInput = ReturnType<typeof refundPaymentSchema.parse>

async function refundWithin(tx: Tx, tenant: string, actor: Actor, data: RefundInput) {
  const [payment] = await tx
    .select()
    .from(feePayments)
    .where(eq(feePayments.id, data.paymentId))
  if (!payment) throw new FeeError(404, 'no_such_payment', 'no such payment')
  if ((await checkOtherPerson(tx, actor, tenant, { creatorId: payment.recordedBy, act: 'refund', moduleId: MODULE, entity: 'fee_payments', entityId: payment.id })) === 'refused') {
    throw new FeeError(403, 'separation_of_duties', 'you recorded this payment, so someone else must refund it')
  }

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
    if ((await checkOtherPerson(tx, actor, tenant, { creatorId: row.recordedBy, act: 'reconcile', moduleId: MODULE, entity: 'fee_payments', entityId: row.id })) === 'refused') {
      throw new FeeError(403, 'separation_of_duties', 'you recorded this payment, so someone else must confirm it')
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
        // LOW-05: refused unless single-officer mode is on (P0-07).
        recordedBy: row.recordedBy,
        selfReconciled: row.recordedBy === actor.id,
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
      .where(and(eq(auditLog.entity, 'fee_payments'), eq(auditLog.entityId, paymentId), notLike(auditLog.action, 'sod.%')))
      .orderBy(asc(auditLog.at)),
  )
}

// --- reads ----------------------------------------------------------------

/**
 * Charges applying to one student in one term: the fee items of the
 * programmes they are enrolled in for it (ACC-19), and their own charges.
 */
async function chargesFor(tx: Tx, studentId: string, termId: string) {
  const progs = await enrolledPrograms(tx, studentId, termId)

  // Charges on this student alone -- a backlog paper -- whatever programme
  // they read, billed beside the programme's own lines.
  const own = (
    await tx
      .select({ id: studentCharges.id, label: studentCharges.label, chargedPaise: studentCharges.amountPaise })
      .from(studentCharges)
      .where(
        and(
          eq(studentCharges.studentId, studentId),
          eq(studentCharges.termId, termId),
          isNull(studentCharges.cancelledAt),
        ),
      )
      .orderBy(asc(studentCharges.createdAt))
  ).map((c) => ({
    feeItemId: null as string | null,
    studentChargeId: c.id as string | null,
    label: c.label,
    chargedPaise: c.chargedPaise,
    waiverId: null as string | null,
    waivedPaise: null as number | null,
    waiverReason: null as string | null,
    postedPaise: null as number | null,
  }))

  if (progs.length === 0) return own

  const items = await tx
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
  return [...items.map((i) => ({ ...i, feeItemId: i.feeItemId as string | null, studentChargeId: null as string | null })), ...own]
}

export async function studentLedger(
  actor: Actor,
  studentId: string,
  termId: string,
): Promise<StudentLedger> {
  const tenant = tenantOf(actor)

  return withTenant(tenant, async (tx): Promise<StudentLedger> => {
    // The student, a verified guardian, the accounts office, and the HoD of the
    // student's department only (SEC-07).
    await assertCanAccessStudent(tx, actor, studentId, 'fee_ledger')
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
    const invoice = await invoiceFor(tx, studentId, termId)

    const [row] = (await tx.execute(sql`select * from (${postedSql({ termId, studentId })}) p`)).rows
    const p = postedOf(row as Record<string, unknown> | undefined)
    const listed = charges.reduce((n, c) => n + c.chargedPaise, 0)
    const unposted = charges.reduce((n, c) => n + Math.max(0, (c.waivedPaise ?? 0) - (c.postedPaise ?? 0)), 0)
    const payablePaise = p.invoicedPaise - p.waivedPaise - p.creditedPaise

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
      chargedPaise: p.invoicedPaise,
      waivedPaise: p.waivedPaise,
      creditedPaise: p.creditedPaise,
      payablePaise,
      paidPaise: p.paidPaise - p.refundedPaise,
      refundedPaise: p.refundedPaise,
      unreconciledPaise: p.unreconciledPaise,
      balancePaise: p.balancePaise,
      outstandingPaise: Math.max(0, p.balancePaise),
      overpaidPaise: Math.max(0, -p.balancePaise),
      notYetInvoicedPaise: Math.max(0, listed - unposted - p.invoicedPaise),
      invoicedAt: invoice?.issuedAt.toISOString() ?? null,
    }
  })
}

const DUES_SORTS: SortSpec = {
  outstanding: { dir: 'desc', keys: [{ sql: sql`d.outstanding_paise`, type: 'bigint' }, { sql: sql`d.student_id`, type: 'text' }] },
  name: { dir: 'asc', keys: [{ sql: sql`coalesce(u.name, u.email, '')`, type: 'text' }, { sql: sql`d.student_id`, type: 'text' }] },
}
export const duesPage = (req: Request, prefix: string) => readPage(req, prefix, DUES_SORTS, 'outstanding', 50)

const INVOICE_SORTS: SortSpec = {
  email: { dir: 'asc', keys: [{ sql: sql`coalesce(${users.email}, '')`, type: 'text' }, { sql: sql`${feeInvoices.id}`, type: 'uuid' }] },
}
export const invoicePage = (req: Request, prefix: string) => readPage(req, prefix, INVOICE_SORTS, 'email', 50)

/**
 * Balances for a term from the books, worst first, a page at a time (REL-09,
 * decision 529). Every student the books or today's price list know for the
 * term, so one who left owing stays on it and one not yet invoiced shows what
 * is coming. Two statements on one `with` block: the page and the totals.
 */
export async function duesReport(
  actor: Actor,
  termId: string,
  page = duesPage(new Request('https://x/'), ''),
): Promise<DuesReport> {
  const tenant = requireFinance(actor)

  return withTenant(tenant, async (tx): Promise<DuesReport> => {
    const [term] = await tx
      .select({ code: terms.code })
      .from(terms)
      .where(eq(terms.id, termId))
    if (!term) throw new FeeError(404, 'no_such_term', 'no such term')

    const cte = sql`
      with posted as (${postedSql({ termId })}),
      listed as (select student_id, sum(charged)::bigint as listed_paise, sum(unposted_waived)::bigint as unposted_paise
                   from (${priceListSql(termId, null)}) l group by student_id),
      d as (
        select coalesce(p.student_id, l.student_id) as student_id,
               coalesce(p.credited_paise, 0) as credited_paise,
               coalesce(p.invoiced_paise, 0) - coalesce(p.waived_paise, 0) - coalesce(p.credited_paise, 0) as payable_paise,
               coalesce(p.paid_paise, 0) - coalesce(p.refunded_paise, 0) as paid_paise,
               coalesce(p.refunded_paise, 0) as refunded_paise,
               coalesce(p.unreconciled_paise, 0) as unreconciled_paise,
               greatest(coalesce(p.balance_paise, 0), 0) as outstanding_paise,
               greatest(-coalesce(p.balance_paise, 0), 0) as overpaid_paise,
               greatest(coalesce(l.listed_paise, 0) - coalesce(l.unposted_paise, 0) - coalesce(p.invoiced_paise, 0), 0) as not_yet_invoiced_paise
          from posted p full join listed l on l.student_id = p.student_id)`
    const shown = sql`(d.payable_paise <> 0 or d.paid_paise <> 0 or d.not_yet_invoiced_paise <> 0)`
    const search = searchAny(page.q, [sql`u.name`, sql`u.email`])
    const where = search ? sql`${shown} and ${search}` : shown
    const keys = DUES_SORTS[page.sort]!.keys
    const after = keyset(keys, page)
    const rows = (await tx.execute(sql`${cte}
      select d.*, u.name as student_name, u.email as student_email,
         coalesce((select string_agg(distinct pr.code, ', ' order by pr.code)
                     from academic_student_programs sp
                     join academic_programs pr on pr.id = sp.program_id
                     join academic_terms t on t.id = ${termId}::uuid
                    where sp.student_id = d.student_id and sp.declared_on <= t.ends_on
                      and (sp.ended_on is null or sp.ended_on > t.starts_on)
                      and (sp.ended_on is null or sp.ended_on > sp.declared_on)), '—') as program_code,
         ${cursorColumn(keys)} as _cursor
       from d join users u on u.id = d.student_id
      where ${where}${after ? sql` and ${after}` : sql``}
      order by ${sql.join(orderKeys(keys, page.dir), sql`, `)}
      limit ${page.limit + 1}`)).rows as Record<string, unknown>[]
    const [sum] = (await tx.execute(sql`${cte}
      select count(*)::int as total,
             coalesce(sum(d.outstanding_paise), 0)::bigint as outstanding,
             count(*) filter (where d.outstanding_paise > 0)::int as defaulters,
             coalesce(sum(d.not_yet_invoiced_paise), 0)::bigint as nyi,
             count(*) filter (where d.not_yet_invoiced_paise > 0)::int as nyi_count
        from d join users u on u.id = d.student_id
       where ${where}`)).rows as Record<string, unknown>[]

    const mapped = rows.map((r) => ({
      studentId: String(r.student_id),
      studentName: (r.student_name as string | null) ?? null,
      studentEmail: (r.student_email as string | null) ?? null,
      programCode: String(r.program_code),
      creditedPaise: Number(r.credited_paise),
      payablePaise: Number(r.payable_paise),
      paidPaise: Number(r.paid_paise),
      refundedPaise: Number(r.refunded_paise),
      unreconciledPaise: Number(r.unreconciled_paise),
      outstandingPaise: Number(r.outstanding_paise),
      overpaidPaise: Number(r.overpaid_paise),
      notYetInvoicedPaise: Number(r.not_yet_invoiced_paise),
      _cursor: r._cursor as string[],
    }))
    return {
      termCode: term.code,
      totalOutstandingPaise: Number(sum!.outstanding),
      defaulterCount: Number(sum!.defaulters),
      notYetInvoicedPaise: Number(sum!.nyi),
      notYetInvoicedCount: Number(sum!.nyi_count),
      ...finishPage(mapped, page, Number(sum!.total)),
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
