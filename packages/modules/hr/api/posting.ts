import { postWithin } from '@campusos/module-finance/api'
import { withTenant } from '@campusos/db'

/**
 * Everything payroll says to the books, in one file.
 *
 * Two events, deliberately not one. Generating a payslip is a cost of the month
 * it covers; paying it is money leaving the bank, whenever that happens. An
 * institution reading its March expenses should see March's salaries there
 * rather than wherever the transfer cleared, and the gap between the two is
 * what salaries payable is for.
 *
 * Both post inside the caller's transaction. A payslip written and books that
 * never heard about it is the same failure fees cannot have.
 */

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]

/**
 * One payslip becoming a cost and a liability.
 *
 *   debit  salaries and wages    the gross, against the department it belongs to
 *   credit statutory withholdings  what was kept back and is owed to somebody else
 *   credit salaries payable      what the person is actually owed
 *
 * Per payslip rather than one entry for the whole run: each has a cost centre
 * of its own, each is traceable to the document the employee was handed, and a
 * correction to one person's pay reverses one entry instead of the month.
 *
 * Employer contributions are not posted, because HR does not model them -- pay
 * components belong to the employee. The account exists in the chart for when
 * that changes; inventing the data model here would be guessing at somebody
 * else's statutory arithmetic.
 */
export async function postPayslip(
  tx: Tx,
  institutionId: string,
  actorId: string | null,
  slip: {
    id: string
    period: string
    staffName: string
    employeeCode: string
    department: string | null
    grossPaise: number
    deductionsPaise: number
    netPaise: number
    /** The part of the deductions that is an advance coming back, not a withholding. */
    advanceRecoveryPaise?: number
  },
): Promise<void> {
  if (slip.grossPaise === 0) return
  const recovered = slip.advanceRecoveryPaise ?? 0
  const withheld = slip.deductionsPaise - recovered

  const costCenter = slip.department ?? null

  await postWithin(tx, institutionId, actorId, {
    // The last day of the month it covers: the cost belongs to that month, and
    // a payroll generated late still lands where the work happened.
    occurredAt: monthEnd(slip.period),
    memo: `${slip.period.slice(0, 7)} salary, ${slip.staffName} (${slip.employeeCode})`,
    sourceModule: 'hr',
    sourceRef: `payslip:${slip.id}`,
    lines: [
      { purpose: 'salaries_expense', debitPaise: slip.grossPaise, costCenter },
      ...(withheld > 0
        ? [{ purpose: 'withholdings_payable', creditPaise: withheld, costCenter }]
        : []),
      // An advance deducted from pay is the advance coming home, not money owed
      // to a tax office.
      ...(recovered > 0
        ? [{ purpose: 'employee_advances', creditPaise: recovered, costCenter }]
        : []),
      ...(slip.netPaise > 0
        ? [{ purpose: 'salaries_payable', creditPaise: slip.netPaise, costCenter }]
        : []),
    ],
  })
}

/**
 * The month's salaries leaving the bank.
 *
 *   debit  salaries payable   the liability accrued when the payslips were made
 *   credit bank or cash       the money itself
 *
 * Which is why the two events are separate: this one is dated when the transfer
 * happened, and the accrual above is dated to the month worked. A March payroll
 * paid in April shows up in both months, correctly, and salaries payable is
 * back to zero once it has.
 */
export async function postSalaryPayment(
  tx: Tx,
  institutionId: string,
  actorId: string | null,
  payment: {
    id: string
    period: string
    paidOn: string
    amountPaise: number
    paidFrom: string
  },
): Promise<void> {
  await postWithin(tx, institutionId, actorId, {
    occurredAt: new Date(`${payment.paidOn}T00:00:00Z`),
    memo: `${payment.period.slice(0, 7)} salaries paid`,
    sourceModule: 'hr',
    sourceRef: `salaries:${payment.id}`,
    lines: [
      { purpose: 'salaries_payable', debitPaise: payment.amountPaise },
      {
        purpose: payment.paidFrom === 'cash' ? 'cash' : 'bank',
        creditPaise: payment.amountPaise,
      },
    ],
  })
}

/** The last instant of the month a period names. */
function monthEnd(period: string): Date {
  const year = Number(period.slice(0, 4))
  const month = Number(period.slice(5, 7))
  return new Date(Date.UTC(year, month, 0, 23, 59, 59))
}

// --- staff money outside payroll --------------------------------------------

type Route = 'bank' | 'cash'
const routeOf = (r: string | null | undefined): Route => (r === 'cash' ? 'cash' : 'bank')

/**
 * An advance handed over: still the institution's money, now in somebody's
 * pocket rather than its bank.
 *
 *   debit  advances to staff
 *   credit bank or cash
 */
export async function postAdvancePaid(
  tx: Tx,
  institutionId: string,
  actorId: string | null,
  a: { id: string; amountPaise: number; paidOn: string; paidFrom: string; staffName: string },
): Promise<void> {
  await postWithin(tx, institutionId, actorId, {
    occurredAt: new Date(`${a.paidOn}T00:00:00Z`),
    memo: `Advance to ${a.staffName}`,
    sourceModule: 'hr',
    sourceRef: `advance:${a.id}`,
    lines: [
      { purpose: 'employee_advances', debitPaise: a.amountPaise },
      { purpose: routeOf(a.paidFrom), creditPaise: a.amountPaise },
    ],
  })
}

/** An advance handed back in money. */
export async function postAdvanceRepaid(
  tx: Tx,
  institutionId: string,
  actorId: string | null,
  r: { id: string; amountPaise: number; on: string; into: string; staffName: string },
): Promise<void> {
  await postWithin(tx, institutionId, actorId, {
    occurredAt: new Date(`${r.on}T00:00:00Z`),
    memo: `Advance repaid by ${r.staffName}`,
    sourceModule: 'hr',
    sourceRef: `advance-repaid:${r.id}`,
    lines: [
      { purpose: routeOf(r.into), debitPaise: r.amountPaise },
      { purpose: 'employee_advances', creditPaise: r.amountPaise },
    ],
  })
}

/**
 * A claim approved: the expense happened, and the claimant is owed it.
 *
 *   debit  staff expenses          against their department
 *   credit expense claims payable
 */
export async function postClaimApproved(
  tx: Tx,
  institutionId: string,
  actorId: string | null,
  c: { id: string; sanctionedPaise: number; title: string; staffName: string; department: string | null },
): Promise<void> {
  if (c.sanctionedPaise === 0) return
  await postWithin(tx, institutionId, actorId, {
    memo: `Expense claim: ${c.title} (${c.staffName})`,
    sourceModule: 'hr',
    sourceRef: `claim:${c.id}`,
    lines: [
      { purpose: 'staff_expenses', debitPaise: c.sanctionedPaise, costCenter: c.department },
      { purpose: 'expense_claims_payable', creditPaise: c.sanctionedPaise },
    ],
  })
}

/**
 * A claim settled: what is owed discharged, partly against an advance they
 * already hold and partly in money.
 *
 *   debit  expense claims payable   the whole sanctioned amount
 *   credit advances to staff        the part set against an advance
 *   credit bank or cash             the rest
 */
export async function postClaimSettled(
  tx: Tx,
  institutionId: string,
  actorId: string | null,
  c: {
    id: string
    advancePaise: number
    paidPaise: number
    paidOn: string
    paidFrom: string | null
    staffName: string
  },
): Promise<void> {
  const total = c.advancePaise + c.paidPaise
  if (total === 0) return
  await postWithin(tx, institutionId, actorId, {
    occurredAt: new Date(`${c.paidOn}T00:00:00Z`),
    memo: `Expense claim settled, ${c.staffName}`,
    sourceModule: 'hr',
    sourceRef: `claim-settled:${c.id}`,
    lines: [
      { purpose: 'expense_claims_payable', debitPaise: total },
      ...(c.advancePaise > 0 ? [{ purpose: 'employee_advances', creditPaise: c.advancePaise }] : []),
      ...(c.paidPaise > 0 ? [{ purpose: routeOf(c.paidFrom), creditPaise: c.paidPaise }] : []),
    ],
  })
}
