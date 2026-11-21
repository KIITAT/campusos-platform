import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'
import * as z from 'zod'
import { audit, users, withTenant } from '@campusos/db'
import { notify } from '@campusos/module-notices/api'
import {
  assertCanAccessStudent,
  cursorColumn,
  finishPage,
  keyset,
  orderKeys,
  readPage,
  searchAny,
  type Role,
  type SortSpec,
} from '@campusos/module-framework'
import { programs, terms } from '@campusos/module-academic/schema'
import { studentProfile, type Actor as AcademicActor } from '@campusos/module-academic/api'
import { formatPaise, parseRupeesToPaise } from '@campusos/money'
import {
  bankAccounts,
  demandLetters,
  feePayments,
  letterSettings,
  transferClaims,
  type DemandLetterContent,
} from '../schema'
import { FeeError, lockTermIssue, recordPaymentWithin, studentLedger, type Actor } from './operations'
import { rupeesInWords } from './words'
import { enrolledPrograms } from './enrolment'

/**
 * Paying by bank transfer, and saying what is owed -- KIIT's "RTGS Submit
 * Application" and "Download Demand Letter".
 */

const MODULE = 'fees'
type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]

const tenantOf = (actor: Actor) => {
  if (!actor.institutionId) throw new FeeError(400, 'no_institution', 'no institution for this session')
  return actor.institutionId
}
const isFinance = (r: Role) => r === 'accounts_staff' || r === 'institution_admin' || r === 'super_admin'
const isAdmin = (r: Role) => r === 'institution_admin' || r === 'super_admin'
const requireFinance = (actor: Actor) => {
  const t = tenantOf(actor)
  if (!isFinance(actor.role)) throw new FeeError(403, 'forbidden', 'not permitted')
  return t
}
const requireAdmin = (actor: Actor) => {
  const t = tenantOf(actor)
  if (!isAdmin(actor.role)) throw new FeeError(403, 'forbidden', 'not permitted')
  return t
}
const requireStudent = (actor: Actor) => {
  const t = tenantOf(actor)
  if (actor.role !== 'student') throw new FeeError(403, 'forbidden', 'a transfer is claimed by the student who made it')
  return t
}
/** The student, or a guardian (who then names the student, and is checked in the transaction). */
const requireReporter = (actor: Actor) => {
  const t = tenantOf(actor)
  if (actor.role !== 'student' && actor.role !== 'parent') {
    throw new FeeError(403, 'forbidden', 'a payment is reported by the student, or by a guardian through the parents portal')
  }
  return t
}

const REFUSALS: Record<string, [400 | 403 | 409, string]> = {
  fee_bank_accounts_number: [409, 'that account is already listed'],
  fee_bank_accounts_ifsc: [400, 'an IFSC is four letters, a zero and six letters or digits'],
  fee_bank_accounts_number_digits: [400, 'an account number is 6 to 20 digits'],
  fee_bank_account_used: [409, 'students have paid into that account; retire it and add the new one'],
  fee_transfer_claims_utr: [409, 'that UTR has already been claimed'],
  fee_bank_accounts_vpa: [400, "a UPI ID is a name, an @ and the bank's handle, for example fees.kiit@sbi"],
  fee_bank_accounts_merchant: [400, 'only an account with a UPI ID can be a merchant account'],
  fee_transfer_claims_upi_shape: [400, 'a UPI reference is the 12-digit number your UPI app shows (UTR or RRN)'],
  fee_transfer_claims_cheque_shape: [400, 'a cheque needs its 6-digit number, and the IFSC and account number printed on it'],
  fee_transfer_claims_cheque: [409, 'that cheque has already been reported'],
  fee_transfer_claims_utr_shape: [400, 'a UTR is 6 to 30 letters and digits, as the bank gave it'],
  fee_transfer_claims_ifsc: [400, 'an IFSC is four letters, a zero and six letters or digits'],
  fee_transfer_claims_phone: [400, 'a phone number'],
  fee_claim_student: [403, 'a transfer is claimed by a student'],
  fee_claim_account: [409, 'that account no longer takes fees'],
  fee_claim_future: [400, 'a transfer is claimed after it is made'],
  fee_claim_decided: [409, 'that claim has been decided'],
  fee_claim_fixed: [409, 'a claim is decided, not edited'],
  fee_claim_payment: [409, 'a verified claim is the payment it describes'],
  fee_claim_reason: [400, 'say why it was rejected'],
  fee_claim_kept: [409, 'a claim is kept'],
  fee_demand_letter_kept: [409, 'a demand letter is kept as it was issued'],
}

async function named<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof FeeError) throw e
    const c = (e as { cause?: { constraint?: string } }).cause?.constraint ?? (e as { constraint?: string }).constraint
    const known = c ? REFUSALS[c] : undefined
    if (known) throw new FeeError(known[0], c!, known[1])
    throw e
  }
}

const ifsc = z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'an IFSC: four letters, a zero, six letters or digits')
const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v)

export const addBankAccountSchema = z
  .object({
    label: z.string().trim().min(3).max(120),
    accountName: z.string().trim().min(3).max(160),
    bankName: z.string().trim().min(2).max(120),
    branch: z.string().trim().min(2).max(120),
    accountNumber: z.string().trim().regex(/^[0-9]{6,20}$/, '6 to 20 digits'),
    ifsc,
  })
  .meta({ id: 'FeeBankAccountAdd' })

export const setAccountUpiSchema = z
  .object({
    accountId: z.uuid(),
    vpa: z.preprocess(blankToUndefined, z.string().trim().toLowerCase().optional()),
    merchant: z.preprocess((v) => v === true || v === 'on' || v === 'true', z.boolean()),
  })
  .meta({ id: 'FeeBankAccountUpi' })

export const retireBankAccountSchema = z.object({ accountId: z.uuid() }).meta({ id: 'FeeBankAccountRetire' })

export const claimTransferSchema = z
  .object({
    termId: z.uuid(),
    accountId: z.uuid(),
    mode: z.enum(['rtgs', 'neft', 'imps', 'upi', 'cheque']),
    remitterBank: z.string().trim().min(2).max(120),
    remitterBranch: z.preprocess(blankToUndefined, z.string().trim().max(120).optional()),
    remitterIfsc: z.preprocess(blankToUndefined, ifsc.optional()),
    /** A deposited cheque's account number, as printed on it. */
    drawerAccount: z.preprocess(blankToUndefined, z.string().optional()),
    accountHolder: z.string().trim().min(2).max(120),
    contactPhone: z.string().trim().regex(/^[0-9+() -]{7,20}$/, 'a phone number'),
    transferredOn: z.iso.date(),
    /** Rupees, as typed. */
    amount: z.string().trim().min(1),
    /** For the guardian reporting a child's payment; a student's own claim ignores it. */
    studentId: z.preprocess(blankToUndefined, z.string().min(1).optional()),
    utr: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9]{6,30}$/, '6 to 30 letters and digits, as the bank gave it'),
    bankReference: z.preprocess(blankToUndefined, z.string().trim().max(60).optional()),
  })
  .meta({ id: 'FeeTransferClaim' })

export const verifyClaimSchema = z
  .object({ claimId: z.uuid(), note: z.preprocess(blankToUndefined, z.string().trim().max(300).optional()) })
  .meta({ id: 'FeeTransferVerify' })

export const rejectClaimSchema = z
  .object({ claimId: z.uuid(), reason: z.string().trim().min(5).max(500) })
  .meta({ id: 'FeeTransferReject' })

export const letterSettingsSchema = z
  .object({
    signatoryName: z.string().trim().min(2).max(120),
    signatoryTitle: z.string().trim().min(2).max(120),
    opening: z.preprocess(blankToUndefined, z.string().trim().max(2000).optional()),
    closing: z.preprocess(blankToUndefined, z.string().trim().max(2000).optional()),
  })
  .meta({ id: 'FeeLetterSettings' })

export const issueLetterSchema = z
  .object({
    termId: z.uuid(),
    /** For the office issuing on a student's behalf; a student issues their own. */
    studentId: z.preprocess(blankToUndefined, z.string().min(1).optional()),
    addressee: z.string().trim().min(3).max(300),
    purpose: z.enum(['education_loan', 'scholarship', 'other']),
  })
  .meta({ id: 'FeeDemandLetterIssue' })

// --- the institution's accounts -------------------------------------------------

export async function listBankAccounts(actor: Actor) {
  const tenant = tenantOf(actor)
  return withTenant(tenant, async (tx) => {
    const rows = await tx.select().from(bankAccounts).orderBy(asc(bankAccounts.retiredAt), asc(bankAccounts.label))
    return rows.map((a) => ({ ...a, state: a.retiredAt ? 'retired' : 'active', summary: `${a.bankName}, ${a.branch} · A/c ${a.accountNumber} · IFSC ${a.ifsc}` }))
  })
}

export async function addBankAccount(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = addBankAccountSchema.parse(input)
  return named(() =>
    withTenant(tenant, async (tx) => {
      const [a] = await tx.insert(bankAccounts).values({ institutionId: tenant, ...d }).returning()
      await audit(tx, {
        institutionId: tenant,
        actorId: actor.id,
        actorEmail: actor.email ?? null,
        moduleId: MODULE,
        action: 'fee.bank_account_added',
        entity: 'fee_bank_accounts',
        entityId: a!.id,
        reason: `${d.bankName} ${d.accountNumber}`,
      })
      return { ...a!, notice: 'Added. Students see it when they report a transfer.' }
    }),
  )
}

export async function retireBankAccount(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = retireBankAccountSchema.parse(input)
  return named(() =>
    withTenant(tenant, async (tx) => {
      const rows = await tx
        .update(bankAccounts)
        .set({ retiredAt: new Date() })
        .where(and(eq(bankAccounts.id, d.accountId), isNull(bankAccounts.retiredAt)))
        .returning({ id: bankAccounts.id })
      if (!rows.length) throw new FeeError(404, 'no_such_account', 'no such live account')
      await audit(tx, {
        institutionId: tenant,
        actorId: actor.id,
        actorEmail: actor.email ?? null,
        moduleId: MODULE,
        action: 'fee.bank_account_retired',
        entity: 'fee_bank_accounts',
        entityId: d.accountId,
        reason: 'retired',
      })
      return { notice: 'Retired. Claims already made into it stand.' }
    }),
  )
}

/**
 * The account's UPI ID, shown to payers as a QR. Editable at any time: the
 * statement match keys on the reference, never on the VPA, so changing it
 * rewrites no money record. A blank ID clears it and the merchant flag.
 */
export async function setAccountUpi(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = setAccountUpiSchema.parse(input)
  return named(() =>
    withTenant(tenant, async (tx) => {
      const [old] = await tx
        .select({ vpa: bankAccounts.upiVpa })
        .from(bankAccounts)
        .where(and(eq(bankAccounts.id, d.accountId), isNull(bankAccounts.retiredAt)))
        .for('update')
      if (!old) throw new FeeError(404, 'no_such_account', 'no such live account')
      // A blank ID with the merchant box ticked is refused by the table's check, not silently cleared.
      const merchant = d.merchant
      await tx
        .update(bankAccounts)
        .set({ upiVpa: d.vpa ?? null, upiMerchant: merchant })
        .where(eq(bankAccounts.id, d.accountId))
      await audit(tx, {
        institutionId: tenant,
        actorId: actor.id,
        actorEmail: actor.email ?? null,
        moduleId: MODULE,
        action: 'fee.bank_account_upi',
        entity: 'fee_bank_accounts',
        entityId: d.accountId,
        reason: `${old.vpa ?? 'none'} -> ${d.vpa ?? 'none'}${merchant ? ' (merchant)' : ''}`,
      })
      return { notice: d.vpa ? `UPI ID ${d.vpa} saved. Payers see its QR on their fee page.` : 'UPI ID removed.' }
    }),
  )
}

// --- claims ------------------------------------------------------------------------

export async function claimTransfer(actor: Actor, input: unknown) {
  const tenant = requireReporter(actor)
  const d = claimTransferSchema.parse(input)
  // A student reports for themselves, whatever the input says (D12).
  const studentId = actor.role === 'student' ? actor.id : d.studentId
  if (!studentId) throw new FeeError(400, 'no_student', 'say which student the payment is for')
  const amountPaise = parseRupeesToPaise(d.amount)
  if (amountPaise === null || amountPaise <= 0) throw new FeeError(400, 'bad_amount', 'enter the amount in rupees, as transferred')
  return named(() =>
    withTenant(tenant, async (tx) => {
      // A guardian passes only through the parents portal's viewerOf (not_your_student otherwise).
      await assertCanAccessStudent(tx, actor, studentId, 'fee_ledger')
      const [c] = await tx
        .insert(transferClaims)
        .values({
          institutionId: tenant,
          studentId,
          termId: d.termId,
          accountId: d.accountId,
          mode: d.mode,
          remitterBank: d.remitterBank,
          remitterBranch: d.remitterBranch ?? null,
          remitterIfsc: d.remitterIfsc ?? null,
          drawerAccount: d.drawerAccount ? d.drawerAccount.replace(/\s+/g, '').toUpperCase() : null,
          accountHolder: d.accountHolder,
          contactPhone: d.contactPhone,
          transferredOn: d.transferredOn,
          amountPaise,
          utr: d.utr.toUpperCase(),
          bankReference: d.bankReference ?? null,
        })
        .returning()
      await audit(tx, {
        institutionId: tenant,
        actorId: actor.id,
        actorEmail: actor.email ?? null,
        moduleId: MODULE,
        action: 'fee.transfer_claimed',
        entity: 'fee_transfer_claims',
        entityId: c!.id,
        reason: `${d.mode.toUpperCase()} ${c!.utr} for ${formatPaise(amountPaise)}`,
        detail: { studentId, submittedBy: actor.id, role: actor.role },
      })
      return {
        ...c!,
        notice: `Submitted: ${formatPaise(amountPaise)} (${rupeesInWords(amountPaise)}), UTR ${c!.utr}. The accounts office checks it against the bank statement; it becomes a receipt when they do.`,
      }
    }),
  )
}

const CLAIM_COLUMNS = {
  c: transferClaims,
  student: users.name,
  email: users.email,
  term: terms.code,
  account: bankAccounts.label,
  receiptNo: feePayments.receiptNo,
}

const shapeClaim = (r: {
  c: typeof transferClaims.$inferSelect
  student: string | null
  email: string | null
  term: string
  account: string
  receiptNo: string | null
}) => ({
  ...r.c,
  student: r.student ?? r.email ?? r.c.studentId,
  term: r.term,
  account: r.account,
  receiptNo: r.receiptNo,
  amount: formatPaise(r.c.amountPaise),
  amountWords: rupeesInWords(r.c.amountPaise),
  modeText: r.c.mode.toUpperCase(),
})

function claimsQuery(tx: Tx) {
  return tx
    .select(CLAIM_COLUMNS)
    .from(transferClaims)
    .innerJoin(users, eq(users.id, transferClaims.studentId))
    .innerJoin(terms, eq(terms.id, transferClaims.termId))
    .innerJoin(bankAccounts, eq(bankAccounts.id, transferClaims.accountId))
    .leftJoin(feePayments, eq(feePayments.id, transferClaims.paymentId))
}

/** One student's claims, for the student or a guardian through the parents portal. */
export async function studentClaims(actor: Actor, studentId: string) {
  const tenant = tenantOf(actor)
  return withTenant(tenant, async (tx) => {
    await assertCanAccessStudent(tx, actor, studentId, 'fee_ledger')
    return (await claimsQuery(tx).where(eq(transferClaims.studentId, studentId)).orderBy(desc(transferClaims.submittedAt))).map(shapeClaim)
  })
}

export async function myClaims(actor: Actor) {
  requireStudent(actor)
  return studentClaims(actor, actor.id)
}

// Pending first, then oldest first; the one sort, because the office works the queue in order.
const CLAIM_SORTS: SortSpec = {
  queue: {
    dir: 'asc',
    keys: [
      { sql: sql`case when ${transferClaims.status} = 'pending' then 0 else 1 end`, type: 'bigint' },
      { sql: sql`${transferClaims.submittedAt}`, type: 'timestamptz' },
      { sql: sql`${transferClaims.id}`, type: 'uuid' },
    ],
  },
}
export const claimPage = (req: Request, prefix: string) => readPage(req, prefix, CLAIM_SORTS, 'queue', 50)

export async function claimQueue(actor: Actor, status?: string | null, page = claimPage(new Request('https://x/'), '')) {
  const tenant = requireFinance(actor)
  return withTenant(tenant, async (tx) => {
    const keys = CLAIM_SORTS[page.sort]!.keys
    const filter = and(
      status === 'pending' || status === 'verified' || status === 'rejected' ? eq(transferClaims.status, status) : undefined,
      searchAny(page.q, [sql`${users.name}`, sql`${users.email}`, sql`${transferClaims.utr}`]),
    )
    const rows = await tx
      .select({ ...CLAIM_COLUMNS, _cursor: cursorColumn(keys) })
      .from(transferClaims)
      .innerJoin(users, eq(users.id, transferClaims.studentId))
      .innerJoin(terms, eq(terms.id, transferClaims.termId))
      .innerJoin(bankAccounts, eq(bankAccounts.id, transferClaims.accountId))
      .leftJoin(feePayments, eq(feePayments.id, transferClaims.paymentId))
      .where(and(filter, keyset(keys, page)))
      .orderBy(...orderKeys(keys, page.dir))
      .limit(page.limit + 1)
    const [count] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(transferClaims)
      .innerJoin(users, eq(users.id, transferClaims.studentId))
      .where(filter)
    const out = finishPage(rows, page, Number(count!.n))
    return { ...out, rows: out.rows.map(shapeClaim) }
  })
}

/** What the queue's header shows: every claim, not just the page. */
export async function claimCounts(actor: Actor) {
  const tenant = requireFinance(actor)
  return withTenant(tenant, async (tx) => {
    const [r] = (
      await tx.execute(sql`
        select count(*) filter (where status = 'pending')::int as pending,
               coalesce(sum(amount_paise) filter (where status = 'pending'), 0)::bigint as paise,
               count(*) filter (where status = 'verified')::int as verified
          from fee_transfer_claims`)
    ).rows as { pending: number; paise: string | number; verified: number }[]
    return { pending: Number(r!.pending), pendingPaise: Number(r!.paise), verified: Number(r!.verified) }
  })
}

/** The oldest pending claims, for the verify and reject pickers. */
// ponytail: a cap of 200 until P1-09's searchable picker; the queue page itself is complete.
export async function pendingClaimOptions(actor: Actor) {
  const tenant = requireFinance(actor)
  return withTenant(tenant, async (tx) =>
    (await claimsQuery(tx).where(eq(transferClaims.status, 'pending')).orderBy(asc(transferClaims.submittedAt), asc(transferClaims.id)).limit(200))
      .map(shapeClaim)
      .map((c) => ({ value: c.id, label: `${c.student}: ${c.amount} ${c.modeText} ${c.utr} (${c.transferredOn})` })),
  )
}

/** How each way of reporting a payment is receipted (D11). */
const METHOD = { rtgs: 'bank_transfer', neft: 'bank_transfer', imps: 'bank_transfer', upi: 'upi', cheque: 'cheque' } as const

/** Tell the student, and their guardians, that money arrived (D21). */
export async function paymentReceived(
  tx: Tx,
  tenant: string,
  p: { studentId: string; amountPaise: number; reference: string | null; receiptNo: string | null },
) {
  await notify(tx, tenant, {
    userIds: [p.studentId],
    moduleId: MODULE,
    title: 'Payment received',
    body: `${formatPaise(p.amountPaise)} received, reference ${p.reference ?? 'none'}. Receipt ${p.receiptNo ?? 'pending'}.`,
    link: '/m/fees/me',
    alsoGuardians: { link: '/m/parents' },
  })
}

/**
 * Reconciled in the same act that recorded it: finding a payment on the bank
 * statement is exactly what reconciling means (LOW-05). The audit row goes
 * first, because the payment's guard lets a reconciliation through only after it.
 */
export async function reconcileFound(
  tx: Tx,
  tenant: string,
  actor: Actor,
  paymentId: string,
  reason: string,
  detail: Record<string, unknown> = {},
) {
  await audit(tx, {
    institutionId: tenant,
    actorId: actor.id,
    actorEmail: actor.email ?? null,
    moduleId: MODULE,
    action: 'fee.payment_reconciled',
    entity: 'fee_payments',
    entityId: paymentId,
    reason,
    // Recording and reconciling are one act here, by design (LOW-05).
    detail: { recordedBy: actor.id, selfReconciled: true, ...detail },
  })
  await tx.update(feePayments).set({ reconciledAt: new Date(), reconciledBy: actor.id }).where(eq(feePayments.id, paymentId))
}

/**
 * Turn a pending claim into its payment, in the caller's transaction. Takes the
 * term's issue lock first, as every path that moves a term's money does (NEW-93),
 * then the claim's row; the claim's term never changes, so the caller reads it
 * without a lock and passes it in. A claim decided meanwhile is a 409.
 */
export async function verifyWithin(
  tx: Tx,
  tenant: string,
  actor: Actor,
  claimId: string,
  termId: string,
  note: string | null,
  detail: Record<string, unknown> = {},
  receivedAt?: Date,
) {
  await lockTermIssue(tx, termId)
  const [c] = await tx.select().from(transferClaims).where(eq(transferClaims.id, claimId)).for('update')
  if (!c) throw new FeeError(404, 'no_such_claim', 'no such claim')
  if (c.status !== 'pending') throw new FeeError(409, 'fee_claim_decided', 'that claim has been decided')
  const payment = await recordPaymentWithin(tx, tenant, actor, {
    studentId: c.studentId,
    termId: c.termId,
    amountPaise: c.amountPaise,
    method: METHOD[c.mode],
    reference: c.utr,
    receivedAt: receivedAt ?? new Date(`${c.transferredOn}T00:00:00+05:30`),
    notes:
      c.mode === 'upi'
        ? `UPI from ${c.remitterBank} (${c.accountHolder})`
        : c.mode === 'cheque'
          ? `Cheque ${c.utr} on ${c.remitterIfsc} ${c.drawerAccount} (${c.accountHolder})`
          : `${c.mode.toUpperCase()} from ${c.remitterBank}${c.remitterBranch ? `, ${c.remitterBranch}` : ''} (${c.accountHolder})`,
    ...(c.mode === 'cheque' ? { drawerIfsc: c.remitterIfsc, drawerAccount: c.drawerAccount } : {}),
  })
  await reconcileFound(tx, tenant, actor, payment.id, note ?? `transfer ${c.utr} found on the bank statement`, detail)
  await tx
    .update(transferClaims)
    .set({ status: 'verified', decidedBy: actor.id, paymentId: payment.id, decisionNote: note })
    .where(eq(transferClaims.id, c.id))
  await paymentReceived(tx, tenant, payment)
  return { claim: c, payment }
}

/**
 * Found on the bank statement: the claim becomes a payment -- receipted, in the
 * books, and reconciled, because finding it on the statement is exactly what
 * reconciling means -- in one act.
 */
export async function verifyClaim(actor: Actor, input: unknown) {
  const tenant = requireFinance(actor)
  const d = verifyClaimSchema.parse(input)
  return named(() =>
    withTenant(tenant, async (tx) => {
      const [seen] = await tx.select({ termId: transferClaims.termId }).from(transferClaims).where(eq(transferClaims.id, d.claimId))
      if (!seen) throw new FeeError(404, 'no_such_claim', 'no such claim')
      const { claim, payment } = await verifyWithin(tx, tenant, actor, d.claimId, seen.termId, d.note ?? null)
      return { id: claim.id, receiptNo: payment.receiptNo, notice: `Verified: receipt ${payment.receiptNo}, reconciled.` }
    }),
  )
}

export async function rejectClaim(actor: Actor, input: unknown) {
  const tenant = requireFinance(actor)
  const d = rejectClaimSchema.parse(input)
  return named(() =>
    withTenant(tenant, async (tx) => {
      const rows = await tx
        .update(transferClaims)
        .set({ status: 'rejected', decidedBy: actor.id, decisionNote: d.reason })
        .where(eq(transferClaims.id, d.claimId))
        .returning({ id: transferClaims.id, utr: transferClaims.utr })
      if (!rows.length) throw new FeeError(404, 'no_such_claim', 'no such claim')
      await audit(tx, {
        institutionId: tenant,
        actorId: actor.id,
        actorEmail: actor.email ?? null,
        moduleId: MODULE,
        action: 'fee.transfer_rejected',
        entity: 'fee_transfer_claims',
        entityId: d.claimId,
        reason: d.reason,
      })
      return { id: d.claimId, notice: 'Rejected. The student sees why, and may claim again with the right details.' }
    }),
  )
}

// --- demand letters -----------------------------------------------------------------

const DEFAULT_OPENING =
  'This is to certify that the student named below is enrolled with us, and that the fees set out below are payable for the term shown.'
const DEFAULT_CLOSING =
  'Fees may be paid directly into the account given below. This letter is issued at the student’s request for the purpose stated, and can be confirmed with the accounts office by its number.'
const PURPOSE = { education_loan: 'Education loan', scholarship: 'Scholarship', other: 'As requested' } as const

export async function letterSettingsOf(actor: Actor) {
  const tenant = requireFinance(actor)
  return withTenant(tenant, async (tx) => {
    const [s] = await tx.select().from(letterSettings).where(eq(letterSettings.institutionId, tenant))
    return {
      signatoryName: s?.signatoryName ?? 'Accounts Officer',
      signatoryTitle: s?.signatoryTitle ?? 'Accounts Office',
      opening: s?.opening ?? DEFAULT_OPENING,
      closing: s?.closing ?? DEFAULT_CLOSING,
    }
  })
}

export async function setLetterSettings(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = letterSettingsSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const values = { signatoryName: d.signatoryName, signatoryTitle: d.signatoryTitle, opening: d.opening ?? null, closing: d.closing ?? null, updatedAt: new Date() }
    await tx.insert(letterSettings).values({ institutionId: tenant, ...values }).onConflictDoUpdate({ target: letterSettings.institutionId, set: values })
    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: 'fee.letter_settings',
      entity: 'fee_letter_settings',
      entityId: tenant,
      reason: `signed by ${d.signatoryName}, ${d.signatoryTitle}`,
    })
    return { notice: 'Saved. Letters issued from now on say this.' }
  })
}

async function nextLetterNumber(tx: Tx, tenant: string, year: number) {
  const [row] = await tx
    .insert(letterSettings)
    .values({ institutionId: tenant, signatoryName: 'Accounts Officer', signatoryTitle: 'Accounts Office', nextNumber: 2 })
    .onConflictDoUpdate({ target: letterSettings.institutionId, set: { nextNumber: sql`${letterSettings.nextNumber} + 1` } })
    .returning({ next: letterSettings.nextNumber })
  return `DL/${year}/${String(row!.next - 1).padStart(5, '0')}`
}

/**
 * Issue a demand letter for a term: the charges, what was waived or paid for
 * by the institution, what is payable, paid and still due -- from the same
 * ledger the student and the dues report read -- numbered and kept as issued.
 */
export async function issueDemandLetter(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  const d = issueLetterSchema.parse(input)
  const studentId = actor.role === 'student' ? actor.id : d.studentId
  if (!studentId) throw new FeeError(400, 'no_student', 'say which student')
  if (actor.role !== 'student' && !isFinance(actor.role)) throw new FeeError(403, 'forbidden', 'not permitted')

  const ledger = await studentLedger(actor, studentId, d.termId)
  const profile = await studentProfile(actor as unknown as AcademicActor, studentId, 'fee_ledger').catch(() => null)
  return named(() =>
    withTenant(tenant, async (tx) => {
      const [t] = await tx.select().from(terms).where(eq(terms.id, d.termId))
      // The programme the student is enrolled in for that term, primary first
      // (ACC-19) -- not whichever section they happen to sit in.
      const [enrolled] = await enrolledPrograms(tx, studentId, d.termId)
      const [prog] = enrolled
        ? await tx.select({ code: programs.code, name: programs.name }).from(programs).where(eq(programs.id, enrolled.programId))
        : []
      const [account] = await tx
        .select()
        .from(bankAccounts)
        .where(isNull(bankAccounts.retiredAt))
        .orderBy(asc(bankAccounts.createdAt))
        .limit(1)
      const deductions = [
        ...ledger.lines.filter((l) => l.waivedPaise > 0).map((l) => ({ label: `Waived: ${l.label}`, amountPaise: l.waivedPaise })),
        ...(ledger.creditedPaise > 0 ? [{ label: 'Scholarships and credits', amountPaise: ledger.creditedPaise }] : []),
      ]
      const chargedPaise = ledger.lines.reduce((n, l) => n + l.chargedPaise, 0)
      const deductedPaise = deductions.reduce((n, d) => n + d.amountPaise, 0)
      const payablePaise = Math.max(0, chargedPaise - deductedPaise)
      const content: DemandLetterContent = {
        lines: ledger.lines.map((l) => ({ label: l.label, amountPaise: l.chargedPaise })),
        deductions,
        chargedPaise,
        deductedPaise,
        payablePaise,
        paidPaise: ledger.paidPaise,
        balancePaise: Math.max(0, payablePaise - ledger.paidPaise),
        student: {
          name: ledger.studentName ?? ledger.studentEmail ?? studentId,
          rollNo: profile?.rollNo ?? null,
          registrationNo: profile?.registrationNo ?? null,
          programme: prog ? `${prog.code} ${prog.name}` : null,
        },
        term: { code: t!.code, name: t!.name, startsOn: String(t!.startsOn), endsOn: String(t!.endsOn) },
        account: account
          ? { accountName: account.accountName, bankName: account.bankName, branch: account.branch, accountNumber: account.accountNumber, ifsc: account.ifsc, upiVpa: account.upiVpa ?? null }
          : null,
      }
      if (content.lines.length === 0) throw new FeeError(409, 'nothing_charged', 'there are no fees for that term to state')
      const number = await nextLetterNumber(tx, tenant, new Date().getFullYear())
      const [l] = await tx
        .insert(demandLetters)
        .values({
          institutionId: tenant,
          number,
          studentId,
          termId: d.termId,
          addressee: d.addressee,
          purpose: PURPOSE[d.purpose],
          content,
          payablePaise: content.payablePaise,
          issuedBy: actor.id,
        })
        .returning()
      await audit(tx, {
        institutionId: tenant,
        actorId: actor.id,
        actorEmail: actor.email ?? null,
        moduleId: MODULE,
        action: 'fee.demand_letter',
        entity: 'fee_demand_letters',
        entityId: l!.id,
        reason: `${number} to ${d.addressee}`,
      })
      return { ...l!, notice: `Letter ${number} issued.`, link: `/api/v1/modules/fees/demand-letter.pdf?letterId=${l!.id}` }
    }),
  )
}

export interface DemandLetterView {
  number: string
  institution: string
  addressee: string
  purpose: string
  issuedAt: Date
  content: DemandLetterContent
  signatory: { name: string; title: string }
  opening: string
  closing: string
  payableWords: string
}

export async function demandLetter(actor: Actor, letterId: string): Promise<DemandLetterView> {
  const tenant = tenantOf(actor)
  return withTenant(tenant, async (tx) => {
    const [l] = await tx.select().from(demandLetters).where(eq(demandLetters.id, letterId))
    if (!l) throw new FeeError(404, 'no_such_letter', 'no such letter')
    if (actor.role === 'student' ? l.studentId !== actor.id : !isFinance(actor.role)) throw new FeeError(403, 'forbidden', 'not permitted')
    const [s] = await tx.select().from(letterSettings).where(eq(letterSettings.institutionId, tenant))
    const inst = await tx.execute(sql`select name from institutions where id = ${tenant}`)
    return {
      number: l.number,
      institution: String((inst.rows[0] as { name?: string } | undefined)?.name ?? ''),
      addressee: l.addressee,
      purpose: l.purpose,
      issuedAt: l.issuedAt,
      content: l.content,
      signatory: { name: s?.signatoryName ?? 'Accounts Officer', title: s?.signatoryTitle ?? 'Accounts Office' },
      opening: s?.opening ?? DEFAULT_OPENING,
      closing: s?.closing ?? DEFAULT_CLOSING,
      payableWords: rupeesInWords(l.content.balancePaise > 0 ? l.content.balancePaise : l.content.payablePaise),
    }
  })
}

/** Letters issued: a student's own, or the office's register. */
export async function listDemandLetters(actor: Actor) {
  const tenant = tenantOf(actor)
  if (actor.role !== 'student' && !isFinance(actor.role)) throw new FeeError(403, 'forbidden', 'not permitted')
  return withTenant(tenant, async (tx) => {
    const rows = await tx
      .select({ l: demandLetters, student: users.name, email: users.email, term: terms.code })
      .from(demandLetters)
      .innerJoin(users, eq(users.id, demandLetters.studentId))
      .innerJoin(terms, eq(terms.id, demandLetters.termId))
      .where(actor.role === 'student' ? eq(demandLetters.studentId, actor.id) : undefined)
      .orderBy(desc(demandLetters.issuedAt))
    return rows.map((r) => ({
      id: r.l.id,
      number: r.l.number,
      student: r.student ?? r.email ?? r.l.studentId,
      term: r.term,
      addressee: r.l.addressee,
      purpose: r.l.purpose,
      payable: formatPaise(r.l.payablePaise),
      balance: formatPaise(r.l.content.balancePaise),
      issuedAt: r.l.issuedAt,
    }))
  })
}

/** Is this a letter we issued? What a bank asks the accounts office. */
export async function verifyDemandLetter(actor: Actor, number: string) {
  const tenant = requireFinance(actor)
  return withTenant(tenant, async (tx) => {
    const [r] = await tx
      .select({ l: demandLetters, student: users.name, term: terms.code })
      .from(demandLetters)
      .innerJoin(users, eq(users.id, demandLetters.studentId))
      .innerJoin(terms, eq(terms.id, demandLetters.termId))
      .where(eq(demandLetters.number, number.trim().toUpperCase()))
    if (!r) return { found: false as const, number }
    return {
      found: true as const,
      number: r.l.number,
      student: r.student,
      term: r.term,
      addressee: r.l.addressee,
      payable: formatPaise(r.l.payablePaise),
      issuedAt: r.l.issuedAt,
    }
  })
}
