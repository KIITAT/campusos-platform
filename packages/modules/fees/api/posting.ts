import { postWithin } from '@campusos/module-finance/api'
import { withTenant } from '@campusos/db'
import type { paymentMethodEnum } from '../schema'

/**
 * Everything fees says to the books, in one file.
 *
 * Kept apart from operations.ts on purpose: an accountant reviewing "what does
 * a payment do to the ledger" reads this and nothing else, and the day the
 * answer changes there is one place it changes in.
 *
 * Every posting here runs inside the caller's transaction. Recording a payment
 * and posting it are one act -- a crash between them would leave money received
 * and books that never heard about it -- and the only way to have that
 * guarantee is to never open a second transaction.
 */

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]
type Method = (typeof paymentMethodEnum.enumValues)[number]

/**
 * Which asset the money landed in.
 *
 * Cash is cash; everything else arrives through a bank, including the cheque
 * that has not cleared yet. Separating cleared from uncleared is what the
 * reconciliation flag already does, and doing it again with a second account
 * would make the two able to disagree.
 */
const landedIn = (method: Method): 'cash' | 'bank' => (method === 'cash' ? 'cash' : 'bank')

/**
 * The charges of a term becoming money owed.
 *
 *   debit  fees receivable   the net the student actually has to pay
 *   debit  scholarships      what the institution chose to forgo
 *   credit fee income        the gross, because that is what was charged
 *
 * The waiver is an expense rather than a reduction of income: an institution
 * that gives away twelve lakh in scholarships should be able to see twelve
 * lakh, and netting it off income hides exactly that number.
 */
export async function postInvoice(
  tx: Tx,
  institutionId: string,
  actorId: string | null,
  invoice: {
    id: string
    version: number
    studentName: string | null
    termCode: string
    chargedPaise: number
    waivedPaise: number
  },
): Promise<void> {
  const net = invoice.chargedPaise - invoice.waivedPaise
  const who = invoice.studentName ?? 'student'

  await postWithin(tx, institutionId, actorId, {
    memo: `${invoice.termCode} fees, ${who}`,
    sourceModule: 'fees',
    sourceRef: `invoice:${invoice.id}:v${invoice.version}`,
    lines: [
      ...(net > 0 ? [{ purpose: 'fees_receivable', debitPaise: net }] : []),
      ...(invoice.waivedPaise > 0
        ? [{ purpose: 'fee_waiver', debitPaise: invoice.waivedPaise }]
        : []),
      { purpose: 'fee_income', creditPaise: invoice.chargedPaise },
    ],
  })
}

/**
 * Money in.
 *
 *   debit  cash or bank      it arrived
 *   credit fees receivable   they owe that much less
 *
 * A partial payment is not a special case: it is this, for less. A payment
 * beyond what was invoiced drives the receivable negative, which is the books
 * correctly reporting an advance, and the student ledger reports it as a
 * credit rather than as a debt owed backwards.
 */
export async function postPayment(
  tx: Tx,
  institutionId: string,
  actorId: string | null,
  payment: {
    id: string
    receiptNo: string
    amountPaise: number
    method: Method
    receivedAt: Date
  },
): Promise<void> {
  await postWithin(tx, institutionId, actorId, {
    occurredAt: payment.receivedAt,
    memo: `Receipt ${payment.receiptNo}`,
    sourceModule: 'fees',
    sourceRef: `payment:${payment.id}`,
    lines: [
      { purpose: landedIn(payment.method), debitPaise: payment.amountPaise },
      { purpose: 'fees_receivable', creditPaise: payment.amountPaise },
    ],
  })
}

/**
 * Money back out. The mirror of a payment, and deliberately not a reversal of
 * it: the payment happened, and a ledger that erased it would be answering a
 * different question from the one the student's receipt asks.
 */
export async function postRefund(
  tx: Tx,
  institutionId: string,
  actorId: string | null,
  refund: {
    id: string
    receiptNo: string
    amountPaise: number
    method: Method
    refundedAt: Date
  },
): Promise<void> {
  await postWithin(tx, institutionId, actorId, {
    occurredAt: refund.refundedAt,
    memo: `Refund against receipt ${refund.receiptNo}`,
    sourceModule: 'fees',
    sourceRef: `refund:${refund.id}`,
    lines: [
      { purpose: 'fees_receivable', debitPaise: refund.amountPaise },
      { purpose: landedIn(refund.method), creditPaise: refund.amountPaise },
    ],
  })
}

/**
 * A waiver granted, revised or revoked after the invoice went out.
 *
 * `deltaPaise` is the change in what is forgiven, so a revision upward posts
 * only the difference and a revocation posts the negative. Negative debits do
 * not exist, so the sides swap instead -- which is also what an accountant
 * would write.
 *
 * A waiver granted *before* the invoice is issued posts nothing here: it is
 * already in the invoice entry, and posting it again would forgive it twice.
 */
export async function postWaiverChange(
  tx: Tx,
  institutionId: string,
  actorId: string | null,
  change: {
    waiverId: string
    posting: number
    deltaPaise: number
    label: string
    studentName: string | null
  },
): Promise<void> {
  if (change.deltaPaise === 0) return

  const size = Math.abs(change.deltaPaise)
  const forgiving = change.deltaPaise > 0
  const who = change.studentName ?? 'student'

  await postWithin(tx, institutionId, actorId, {
    memo: forgiving
      ? `Waiver of ${change.label}, ${who}`
      : `Waiver withdrawn on ${change.label}, ${who}`,
    sourceModule: 'fees',
    sourceRef: `waiver:${change.waiverId}:p${change.posting}`,
    lines: forgiving
      ? [
          { purpose: 'fee_waiver', debitPaise: size },
          { purpose: 'fees_receivable', creditPaise: size },
        ]
      : [
          { purpose: 'fees_receivable', debitPaise: size },
          { purpose: 'fee_waiver', creditPaise: size },
        ],
  })
}

/**
 * A scholarship the institution funds.
 *
 *   debit  scholarships awarded   what it cost the institution
 *   credit fees receivable        the student owes that much less
 *
 * Its own expense account, not the waiver one. A waiver is a charge the
 * institution decided not to make; a scholarship is a charge it decided to pay.
 * A principal asking what the scholarship programme cost this year should not
 * have to read it out of a line that also holds every hardship concession the
 * bursar granted at the counter.
 *
 * Nothing moves between accounts outside the institution, which is the honest
 * shape: no cash leaves, the student's bill simply gets smaller.
 */
export async function postScholarship(
  tx: Tx,
  institutionId: string,
  actorId: string | null,
  award: {
    id: string
    studentName: string | null
    termCode: string
    scholarshipName: string
    amountPaise: number
    reversing?: boolean
  },
): Promise<void> {
  if (award.amountPaise <= 0) return
  const who = award.studentName ?? 'student'
  const back = award.reversing === true

  await postWithin(tx, institutionId, actorId, {
    memo: `${back ? 'Scholarship withdrawn' : 'Scholarship'}, ${award.scholarshipName}, ${who} (${award.termCode})`,
    sourceModule: 'fees',
    sourceRef: `${back ? 'award-revoked' : 'award'}:${award.id}`,
    lines: back
      ? [
          { purpose: 'fees_receivable', debitPaise: award.amountPaise },
          { purpose: 'scholarship_expense', creditPaise: award.amountPaise },
        ]
      : [
          { purpose: 'scholarship_expense', debitPaise: award.amountPaise },
          { purpose: 'fees_receivable', creditPaise: award.amountPaise },
        ],
  })
}

/**
 * A course dropped inside the refund window.
 *
 *   debit  fee income        revenue for teaching that did not happen
 *   credit fees receivable   the student owes that much less
 *
 * Deliberately against income rather than into the waiver account. The
 * institution has not forgiven anything: it billed for a term of teaching, some
 * of that teaching was cancelled by the student inside the window the calendar
 * allows, and the revenue was never earned. Filing that as a concession would
 * overstate both what was earned and what was given away.
 *
 * If the student had already paid, this leaves them in credit, and money going
 * back out is a refund against the payment it came in on -- which fees already
 * knows how to do, and which needs a bank instruction rather than a calendar.
 */
export async function postDropCredit(
  tx: Tx,
  institutionId: string,
  actorId: string | null,
  credit: {
    id: string
    studentName: string | null
    termCode: string
    courseCode: string
    effectiveOn: string
    amountPaise: number
  },
): Promise<void> {
  if (credit.amountPaise <= 0) return

  await postWithin(tx, institutionId, actorId, {
    memo: `${credit.courseCode} dropped ${credit.effectiveOn}, ${credit.studentName ?? 'student'} (${credit.termCode})`,
    sourceModule: 'fees',
    sourceRef: `drop:${credit.id}`,
    lines: [
      { purpose: 'fee_income', debitPaise: credit.amountPaise },
      { purpose: 'fees_receivable', creditPaise: credit.amountPaise },
    ],
  })
}
