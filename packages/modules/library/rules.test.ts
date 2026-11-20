import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_RULES,
  daysOverdue,
  dueDate,
  fineFor,
  refusalToBorrow,
  refusalToRenew,
  renewedDueDate,
  type LoanRules,
} from './api/rules'

// Every instant is written in India's time, so the tests mean the same on a
// server in any zone (LOW-09).
const at = (iso: string) => new Date(/[zZ]|[+-]\d\d:\d\d$/.test(iso) ? iso : `${iso}+05:30`)
/** An instant as India reads it: `2026-09-15 23:59`. */
const india = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 16).replace('T', ' ')
const rules = (over: Partial<LoanRules> = {}): LoanRules => ({ ...DEFAULT_RULES, ...over })

// --- due dates -------------------------------------------------------------

test('a due date lands at the end of the day, not at the hour of issue', () => {
  const due = dueDate(at('2026-09-01T16:05:00'), 14)
  assert.equal(india(due), '2026-09-15 23:59')
})

test('a book issued in the afternoon is not overdue that same hour a fortnight on', () => {
  const issued = at('2026-09-01T16:05:00')
  const due = dueDate(issued, 14)
  assert.equal(daysOverdue(due, at('2026-09-15T16:06:00')), 0)
})

test('a renewal extends from the due date, not from today', () => {
  const due = at('2026-09-15T23:59:59.999')
  const next = renewedDueDate(due, 14)
  assert.equal(india(next), '2026-09-29 23:59')
})

test('a due date ends the day in the institution zone, not the server zone (LOW-09)', () => {
  // 20:00 UTC on the 1st is 01:30 on the 2nd in India.
  assert.equal(dueDate(new Date('2026-09-01T20:00:00Z'), 14).toISOString(), '2026-09-16T18:29:59.999Z')
  assert.equal(dueDate(new Date('2026-09-01T20:00:00Z'), 14, 'UTC').toISOString(), '2026-09-15T23:59:59.999Z')
})

// --- overdue days ----------------------------------------------------------

test('days overdue is never negative', () => {
  const due = at('2026-09-15T23:59:59.999')
  assert.equal(daysOverdue(due, at('2026-09-01T09:00:00')), 0)
  assert.equal(daysOverdue(due, at('2026-09-15T23:59:00')), 0)
})

test('a part day late counts as a whole day', () => {
  const due = at('2026-09-15T23:59:59.999')
  assert.equal(daysOverdue(due, at('2026-09-16T00:30:00')), 1)
  assert.equal(daysOverdue(due, at('2026-09-16T23:00:00')), 1)
  assert.equal(daysOverdue(due, at('2026-09-17T00:30:00')), 2)
})

// --- fines -----------------------------------------------------------------

const due = at('2026-09-15T23:59:59.999')

test('no fine before the due date', () => {
  assert.equal(fineFor({ dueOn: due, at: at('2026-09-10T10:00:00'), rules: rules() }), 0)
})

test('a fine is days late times the daily rate', () => {
  assert.equal(
    fineFor({ dueOn: due, at: at('2026-09-20T10:00:00'), rules: rules() }),
    500,
  )
})

test('grace days are free, and the count resumes after them', () => {
  const r = rules({ graceDays: 3 })
  assert.equal(fineFor({ dueOn: due, at: at('2026-09-18T10:00:00'), rules: r }), 0)
  assert.equal(fineFor({ dueOn: due, at: at('2026-09-19T10:00:00'), rules: r }), 100)
})

test('a zero daily rate means the library fines nobody', () => {
  assert.equal(
    fineFor({ dueOn: due, at: at('2026-12-31T10:00:00'), rules: rules({ finePerDayPaise: 0 }) }),
    0,
  )
})

test('the institution ceiling caps a long overdue', () => {
  const r = rules({ maxFinePaise: 20_000 })
  assert.equal(fineFor({ dueOn: due, at: at('2028-09-15T10:00:00'), rules: r }), 20_000)
})

test('a fine never exceeds what the book is worth', () => {
  // Otherwise losing it is the cheaper option, which is the wrong incentive.
  assert.equal(
    fineFor({
      dueOn: due,
      at: at('2029-09-15T10:00:00'),
      rules: rules(),
      replacementPaise: 45_000,
    }),
    45_000,
  )
})

test('the tighter of the two caps wins', () => {
  const r = rules({ maxFinePaise: 10_000 })
  assert.equal(
    fineFor({ dueOn: due, at: at('2027-09-15T10:00:00'), rules: r, replacementPaise: 45_000 }),
    10_000,
  )
})

test('an unknown replacement cost does not become a zero cap', () => {
  assert.equal(
    fineFor({ dueOn: due, at: at('2026-09-20T10:00:00'), rules: rules(), replacementPaise: null }),
    500,
  )
})

test('fines stay whole paise across a long overdue', () => {
  // Integers in, integers out: no fractional paise can appear.
  for (let d = 1; d < 400; d++) {
    const f = fineFor({
      dueOn: due,
      at: new Date(due.getTime() + d * 86_400_000),
      rules: rules({ finePerDayPaise: 333 }),
    })
    assert.ok(Number.isInteger(f), `day ${d} gave ${f}`)
  }
})

// --- borrowing limits ------------------------------------------------------

test('a borrower under both limits may borrow', () => {
  assert.equal(
    refusalToBorrow({ openLoans: 2, outstandingFinePaise: 0 }, rules()),
    null,
  )
})

test('the loan limit is a refusal the desk can explain', () => {
  assert.equal(
    refusalToBorrow({ openLoans: 3, outstandingFinePaise: 0 }, rules()),
    'loan_limit_reached',
  )
})

test('outstanding fines block only once past the threshold', () => {
  const r = rules({ blockAtOutstandingPaise: 5_000 })
  assert.equal(refusalToBorrow({ openLoans: 0, outstandingFinePaise: 5_000 }, r), null)
  assert.equal(
    refusalToBorrow({ openLoans: 0, outstandingFinePaise: 5_001 }, r),
    'fines_outstanding',
  )
})

test('a zero threshold never blocks, however much is owed', () => {
  assert.equal(
    refusalToBorrow({ openLoans: 0, outstandingFinePaise: 9_999_999 }, rules()),
    null,
  )
})

// --- renewals --------------------------------------------------------------

const openLoan = { renewals: 0, dueOn: due, returnedAt: null }

test('a loan in good standing renews', () => {
  assert.equal(refusalToRenew(openLoan, rules(), at('2026-09-14T10:00:00')), null)
})

test('an overdue loan cannot be renewed, because that would erase the fine', () => {
  assert.equal(refusalToRenew(openLoan, rules(), at('2026-09-20T10:00:00')), 'overdue')
})

test('renewals run out', () => {
  assert.equal(
    refusalToRenew({ ...openLoan, renewals: 1 }, rules(), at('2026-09-14T10:00:00')),
    'renewal_limit_reached',
  )
})

test('a returned loan is not renewable', () => {
  assert.equal(
    refusalToRenew(
      { ...openLoan, returnedAt: at('2026-09-10T10:00:00') },
      rules(),
      at('2026-09-14T10:00:00'),
    ),
    'already_returned',
  )
})

test('a library that forbids renewal says so rather than silently allowing one', () => {
  assert.equal(
    refusalToRenew(openLoan, rules({ maxRenewals: 0 }), at('2026-09-14T10:00:00')),
    'renewal_limit_reached',
  )
})

test('a due date is the end of the local day N calendar days on, across clock changes (review HIGH 7)', () => {
  // New York springs forward on 8 March 2026: 14 days from 22 February 01:00 is the end of 8 March (EDT).
  assert.equal(dueDate(new Date('2026-02-22T06:00:00Z'), 14, 'America/New_York').toISOString(), '2026-03-09T03:59:59.999Z')
  // And falls back on 1 November 2026: 14 days from 18 October 23:30 EDT is the end of 1 November, which closes in EST.
  assert.equal(dueDate(new Date('2026-10-19T03:30:00Z'), 14, 'America/New_York').toISOString(), '2026-11-02T04:59:59.999Z')
  // A renewal from a due date near the change keeps the same rule.
  assert.equal(renewedDueDate(new Date('2026-02-22T06:00:00Z'), 14, 'America/New_York').toISOString(), '2026-03-09T03:59:59.999Z')
})
