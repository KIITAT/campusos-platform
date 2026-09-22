import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, like } from 'drizzle-orm'
import { auditLog, authDb, institutions, users, withTenant } from '@campusos/db'
import {
  FinanceError,
  budgetReport,
  closePeriod,
  listPeriods,
  postEntry,
  reopenPeriod,
  setBudget,
  trialBalance,
  type Actor,
} from './api'

/**
 * The close, and the budget a department argues about.
 *
 * A fresh institution per test: a closed period is a statement about everything
 * in the journal, and a shared fixture would make each failure a question about
 * what some earlier test posted.
 */

let n = 0
const SLUG = 'fin-close-'

interface Books {
  id: string
  admin: Actor
  staff: Actor
}

async function books(): Promise<Books> {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Closing College', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const id = i!.id

  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Adm' },
      { email: `acc@${tag}.test`, institutionId: id, role: 'accounts_staff', name: 'Clerk' },
    ])
    .returning({ id: users.id })

  return {
    id,
    admin: {
      id: people[0]!.id,
      email: `adm@${tag}.test`,
      role: 'institution_admin',
      institutionId: id,
    },
    staff: {
      id: people[1]!.id,
      email: `acc@${tag}.test`,
      role: 'accounts_staff',
      institutionId: id,
    },
  }
}

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

/** A month safely in the past, so closing it is allowed. */
const lastMonth = () => {
  const d = new Date()
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() - 1)
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, on: d }
}

const entry = (b: Books, over: Record<string, unknown> = {}) =>
  postEntry(b.admin, {
    memo: 'An ordinary entry',
    sourceModule: 'manual',
    sourceRef: `ref:${++n}`,
    lines: [
      { purpose: 'cash', debitPaise: 10_000 },
      { purpose: 'fee_income', creditPaise: 10_000 },
    ],
    ...over,
  })

const errorCode = (e: unknown) => (e as FinanceError).code

// --- the close -------------------------------------------------------------

test('a month with no row is open, and nothing has to be created in advance', async () => {
  const b = await books()
  await entry(b)
  assert.equal((await listPeriods(b.admin, {})).length, 0)
  assert.equal((await trialBalance(b.admin)).differencePaise, 0)
})

test('nothing lands in a closed month, including something backdated into it', async () => {
  const b = await books()
  const past = lastMonth()
  await entry(b, { occurredAt: past.on.toISOString(), sourceRef: 'before-the-close' })

  const closed = await closePeriod(b.admin, { year: past.year, month: past.month })
  assert.equal(closed.status, 'closed')
  assert.ok(closed.closedAt)

  // Backdating into it is exactly what closing prevents, so it is checked
  // against the date the entry says it happened on.
  await assert.rejects(
    () => entry(b, { occurredAt: past.on.toISOString(), sourceRef: 'after-the-close' }),
    (e: unknown) => /closed/.test(String((e as Error).message)) || errorCode(e) === undefined,
  )

  // This month is untouched.
  const now = await entry(b)
  assert.ok(now.id)
})

test('a month that has not finished cannot be closed', async () => {
  const b = await books()
  const now = new Date()
  await assert.rejects(
    () =>
      closePeriod(b.admin, {
        year: now.getUTCFullYear(),
        month: now.getUTCMonth() + 1,
      }),
    (e: unknown) => errorCode(e) === 'period_not_over',
  )
})

test('closing twice is refused, and the first close is the one on the record', async () => {
  const b = await books()
  const past = lastMonth()
  await closePeriod(b.admin, { year: past.year, month: past.month })

  await assert.rejects(
    () => closePeriod(b.admin, { year: past.year, month: past.month }),
    (e: unknown) => errorCode(e) === 'already_closed',
  )
  assert.equal((await listPeriods(b.admin, { year: past.year })).length, 1)
})

test('reopening is a decision with a reason, and the reason stays on the row', async () => {
  const b = await books()
  const past = lastMonth()
  await closePeriod(b.admin, { year: past.year, month: past.month })

  const reopened = await reopenPeriod(b.admin, {
    year: past.year,
    month: past.month,
    reason: 'a supplier invoice for March arrived in June',
  })
  assert.equal(reopened.status, 'open')
  assert.equal(reopened.closedAt, null)
  assert.match(String(reopened.reopenedReason), /supplier invoice/)

  // And the month takes entries again.
  const late = await entry(b, {
    occurredAt: past.on.toISOString(),
    sourceRef: 'the-late-invoice',
  })
  assert.ok(late.id)

  const trail = await withTenant(b.id, (tx) =>
    tx.select().from(auditLog).where(eq(auditLog.action, 'period.reopened')),
  )
  assert.equal(trail.length, 1)
  assert.match(String(trail[0]!.reason), /supplier invoice/)
})

test('a period that is not closed cannot be reopened', async () => {
  const b = await books()
  const past = lastMonth()
  await assert.rejects(
    () =>
      reopenPeriod(b.admin, {
        year: past.year,
        month: past.month,
        reason: 'nothing to reopen here',
      }),
    (e: unknown) => errorCode(e) === 'not_closed',
  )
})

test('closing the books is not a clerk’s decision', async () => {
  const b = await books()
  const past = lastMonth()
  await assert.rejects(
    () => closePeriod(b.staff, { year: past.year, month: past.month }),
    (e: unknown) => errorCode(e) === 'forbidden',
  )
})

test('one institution closing its books does not close anybody else’s', async () => {
  const one = await books()
  const two = await books()
  const past = lastMonth()
  await closePeriod(one.admin, { year: past.year, month: past.month })

  const posted = await postEntry(two.admin, {
    memo: 'Still open over here',
    sourceModule: 'manual',
    sourceRef: 'other-tenant',
    occurredAt: past.on.toISOString(),
    lines: [
      { purpose: 'cash', debitPaise: 500 },
      { purpose: 'fee_income', creditPaise: 500 },
    ],
  })
  assert.ok(posted.id)
  assert.equal((await listPeriods(two.admin, {})).length, 0)
})

// --- budgets ---------------------------------------------------------------

test('what a cost centre was given, and what it has actually spent', async () => {
  const b = await books()
  const year = new Date().getUTCFullYear()
  await setBudget(b.admin, {
    year,
    costCenter: 'Computing',
    accountCode: '5100',
    amountPaise: 1_000_000,
  })

  await postEntry(b.admin, {
    memo: 'March salaries',
    sourceModule: 'manual',
    sourceRef: 'salaries:march',
    lines: [
      { purpose: 'salaries_expense', debitPaise: 400_000, costCenter: 'Computing' },
      { purpose: 'salaries_payable', creditPaise: 400_000 },
    ],
  })

  const report = await budgetReport(b.admin, { year })
  assert.equal(report.rows.length, 1)
  assert.equal(report.rows[0]!.budgetPaise, 1_000_000)
  assert.equal(report.rows[0]!.actualPaise, 400_000)
  assert.equal(report.rows[0]!.remainingPaise, 600_000)
  assert.equal(report.rows[0]!.overspent, false)
})

test('spending on another cost centre is not this one’s spending', async () => {
  const b = await books()
  const year = new Date().getUTCFullYear()
  await setBudget(b.admin, {
    year,
    costCenter: 'Computing',
    accountCode: '5100',
    amountPaise: 1_000_000,
  })
  await postEntry(b.admin, {
    memo: 'Physics salaries',
    sourceModule: 'manual',
    sourceRef: 'salaries:physics',
    lines: [
      { purpose: 'salaries_expense', debitPaise: 900_000, costCenter: 'Physics' },
      { purpose: 'salaries_payable', creditPaise: 900_000 },
    ],
  })

  const report = await budgetReport(b.admin, { year })
  assert.equal(report.rows[0]!.actualPaise, 0)
})

test('an overspend is recorded and reported, not refused', async () => {
  const b = await books()
  const year = new Date().getUTCFullYear()
  await setBudget(b.admin, {
    year,
    costCenter: 'Computing',
    accountCode: '5100',
    amountPaise: 100_000,
  })

  // Books that refuse to record what happened are worse than an overspend
  // somebody has to explain.
  const posted = await postEntry(b.admin, {
    memo: 'Salaries, over the number',
    sourceModule: 'manual',
    sourceRef: 'salaries:over',
    lines: [
      { purpose: 'salaries_expense', debitPaise: 250_000, costCenter: 'Computing' },
      { purpose: 'salaries_payable', creditPaise: 250_000 },
    ],
  })
  assert.ok(posted.id)

  const report = await budgetReport(b.admin, { year })
  assert.equal(report.rows[0]!.overspent, true)
  assert.equal(report.rows[0]!.remainingPaise, -150_000)
  assert.equal(report.overspentCount, 1)
})

test('a budget asked to be enforced refuses the entry that would pass it', async () => {
  const b = await books()
  const year = new Date().getUTCFullYear()
  await setBudget(b.admin, {
    year,
    costCenter: 'Library',
    accountCode: '5100',
    amountPaise: 100_000,
    hardLimit: true,
  })

  const within = await postEntry(b.admin, {
    memo: 'Within the number',
    sourceModule: 'manual',
    sourceRef: 'lib:within',
    lines: [
      { purpose: 'salaries_expense', debitPaise: 60_000, costCenter: 'Library' },
      { purpose: 'salaries_payable', creditPaise: 60_000 },
    ],
  })
  assert.ok(within.id)

  await assert.rejects(
    () =>
      postEntry(b.admin, {
        memo: 'Past the number',
        sourceModule: 'manual',
        sourceRef: 'lib:past',
        lines: [
          { purpose: 'salaries_expense', debitPaise: 60_000, costCenter: 'Library' },
          { purpose: 'salaries_payable', creditPaise: 60_000 },
        ],
      }),
    (e: unknown) => errorCode(e) === 'over_budget',
  )

  // Refused means refused: the rolled-back entry left nothing behind.
  const report = await budgetReport(b.admin, { year })
  assert.equal(report.rows[0]!.actualPaise, 60_000)
  assert.equal((await trialBalance(b.admin)).differencePaise, 0)
})

test('an unbudgeted cost centre spends freely, and a budget can be revised', async () => {
  const b = await books()
  const year = new Date().getUTCFullYear()

  const free = await postEntry(b.admin, {
    memo: 'Nobody budgeted this',
    sourceModule: 'manual',
    sourceRef: 'free:1',
    lines: [
      { purpose: 'salaries_expense', debitPaise: 900_000, costCenter: 'Estates' },
      { purpose: 'salaries_payable', creditPaise: 900_000 },
    ],
  })
  assert.ok(free.id)

  await setBudget(b.admin, {
    year,
    costCenter: 'Estates',
    accountCode: '5100',
    amountPaise: 500_000,
  })
  const revised = await setBudget(b.admin, {
    year,
    costCenter: 'Estates',
    accountCode: '5100',
    amountPaise: 1_000_000,
    note: 'increased at the November meeting',
  })
  assert.equal(revised.amountPaise, 1_000_000)

  const report = await budgetReport(b.admin, { year })
  assert.equal(report.rows.length, 1)
  assert.equal(report.rows[0]!.overspent, false)
})
