/**
 * Circulation arithmetic, as pure functions.
 *
 * Every rule a borrower can argue about lives here and nowhere else, so the
 * desk, the student's own view and the overdue report cannot quote three
 * different numbers at the same person.
 */

export interface LoanRules {
  loanDays: number
  graceDays: number
  finePerDayPaise: number
  maxConcurrentLoans: number
  maxRenewals: number
  /** Absolute ceiling for one loan. Null means the copy's value caps it. */
  maxFinePaise: number | null
  /** Owing more than this blocks further borrowing. Zero means never block. */
  blockAtOutstandingPaise: number
}

export const DEFAULT_RULES: LoanRules = {
  loanDays: 14,
  graceDays: 0,
  finePerDayPaise: 100,
  maxConcurrentLoans: 3,
  maxRenewals: 1,
  maxFinePaise: null,
  blockAtOutstandingPaise: 0,
}

const DAY_MS = 86_400_000

/**
 * Due dates land at the end of the day, not at the hour the book was handed
 * over. A book issued at 16:05 is not overdue at 16:06 a fortnight later, and
 * telling a student otherwise is the argument this function exists to avoid.
 */
export function dueDate(issuedAt: Date, loanDays: number): Date {
  const due = new Date(issuedAt.getTime() + loanDays * DAY_MS)
  due.setHours(23, 59, 59, 999)
  return due
}

/** Whole days late, counting from the end of the due day. Never negative. */
export function daysOverdue(dueOn: Date, at: Date): number {
  const late = at.getTime() - dueOn.getTime()
  return late <= 0 ? 0 : Math.ceil(late / DAY_MS)
}

export interface FineInput {
  dueOn: Date
  at: Date
  rules: LoanRules
  /** What the copy would cost to replace, if known. */
  replacementPaise?: number | null
}

/**
 * The fine for one loan, in paise.
 *
 * Capped twice over: by the institution's own ceiling if it set one, and by
 * what the book is worth. A fine that exceeds the replacement cost turns
 * "I lost it" into the cheaper option, which is the wrong incentive to hand a
 * library.
 */
export function fineFor({ dueOn, at, rules, replacementPaise }: FineInput): number {
  const late = daysOverdue(dueOn, at)
  const chargeable = Math.max(0, late - rules.graceDays)
  if (chargeable === 0 || rules.finePerDayPaise === 0) return 0

  const caps = [chargeable * rules.finePerDayPaise]
  if (rules.maxFinePaise !== null) caps.push(rules.maxFinePaise)
  if (replacementPaise != null) caps.push(replacementPaise)
  return Math.min(...caps)
}

export type RefusalCode =
  | 'copy_not_available'
  | 'loan_limit_reached'
  | 'fines_outstanding'
  | 'renewal_limit_reached'
  | 'not_overdue_yet'

export interface BorrowerState {
  openLoans: number
  outstandingFinePaise: number
}

/**
 * Whether this borrower may take another book, and if not, which rule says so.
 *
 * Returns the reason rather than a boolean: the desk has to tell the student
 * standing in front of it *why*, and "no" is not an answer a librarian can use.
 */
export function refusalToBorrow(
  state: BorrowerState,
  rules: LoanRules,
): RefusalCode | null {
  if (state.openLoans >= rules.maxConcurrentLoans) return 'loan_limit_reached'
  if (
    rules.blockAtOutstandingPaise > 0 &&
    state.outstandingFinePaise > rules.blockAtOutstandingPaise
  ) {
    return 'fines_outstanding'
  }
  return null
}

/**
 * Whether a loan can be renewed. Deliberately refuses to renew an already
 * overdue loan: renewal is an extension granted in advance, and quietly
 * extending a late book erases the fine that had already accrued.
 */
export function refusalToRenew(
  loan: { renewals: number; dueOn: Date; returnedAt: Date | null },
  rules: LoanRules,
  at: Date,
): RefusalCode | 'already_returned' | 'overdue' | null {
  if (loan.returnedAt) return 'already_returned'
  if (loan.renewals >= rules.maxRenewals) return 'renewal_limit_reached'
  if (daysOverdue(loan.dueOn, at) > 0) return 'overdue'
  return null
}

/** A renewal extends from the current due date, not from today. */
export const renewedDueDate = (dueOn: Date, loanDays: number) =>
  dueDate(dueOn, loanDays)
