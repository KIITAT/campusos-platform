import { sql, type SQL } from 'drizzle-orm'

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

/** The institution's zone when it keeps none of its own (decision 583). */
export const DEFAULT_ZONE = 'Asia/Kolkata'

/** How far `timeZone` is ahead of UTC at `at`, in milliseconds. */
function offsetMs(at: Date, timeZone: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  )
  const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second))
  return wall - (at.getTime() - at.getUTCMilliseconds())
}

/**
 * Due dates land at the end of the day, not at the hour the book was handed
 * over. A book issued at 16:05 is not overdue at 16:06 a fortnight later, and
 * telling a student otherwise is the argument this function exists to avoid.
 * The day is the institution's, not the server's (LOW-09).
 */
export function dueDate(issuedAt: Date, loanDays: number, timeZone = DEFAULT_ZONE): Date {
  // Add days to the local calendar date, then resolve the end of that date with
  // the offset in force on it: a clock change in between must not move the day.
  const wall = new Date(issuedAt.getTime() + offsetMs(issuedAt, timeZone))
  wall.setUTCDate(wall.getUTCDate() + loanDays)
  wall.setUTCHours(23, 59, 59, 999)
  let at = new Date(wall.getTime() - offsetMs(wall, timeZone))
  at = new Date(wall.getTime() - offsetMs(at, timeZone))
  return at
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
export const renewedDueDate = (dueOn: Date, loanDays: number, timeZone = DEFAULT_ZONE) =>
  dueDate(dueOn, loanDays, timeZone)

/**
 * `fineFor` in SQL, for an open loan read now: the overdue total is summed in
 * the database over every overdue loan, not over a page of them (LOW-08,
 * decision 582). Keep the two in step; a test pins them together.
 */
export function fineSql(rules: LoanRules, dueOn: SQL, replacementPaise: SQL): SQL {
  if (rules.finePerDayPaise === 0) return sql`0::bigint`
  const days = sql`greatest(ceil(extract(epoch from (now() - ${dueOn})) / 86400)::bigint - ${rules.graceDays}::bigint, 0)`
  const accrued = sql`(${days} * ${rules.finePerDayPaise}::bigint)`
  const cap = rules.maxFinePaise === null ? accrued : sql`${rules.maxFinePaise}::bigint`
  return sql`least(${accrued}, ${cap}, coalesce(${replacementPaise}, ${accrued}))`
}
