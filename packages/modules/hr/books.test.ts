import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { like } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import { entryLines, listEntries, trialBalance, type Actor as Books } from '@campusos/module-finance/api'
import {
  HrError,
  createStaff,
  generatePayroll,
  listSalaryPayments,
  paySalaries,
  setComponent,
  type Actor,
} from './api'
import { payslips, salaryPayments } from './schema'

/**
 * What payroll says to the books.
 *
 * A fresh institution per test: the journal is append-only by design, so there
 * is no supported way to empty it between them.
 */

let n = 0
const SLUG = 'hr-books-'

interface Payroll {
  id: string
  admin: Actor
  clerk: Actor
}

async function payrollFor(): Promise<Payroll> {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Books College', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const id = i!.id

  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Adm' },
      { email: `clerk@${tag}.test`, institutionId: id, role: 'accounts_staff', name: 'Clerk' },
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
    clerk: {
      id: people[1]!.id,
      email: `clerk@${tag}.test`,
      role: 'accounts_staff',
      institutionId: id,
    },
  }
}

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

/** One lecturer on 56,000 gross with 4,800 held back, joined before the year. */
async function hire(
  p: Payroll,
  over: { employeeCode?: string; department?: string | null; basic?: string } = {},
) {
  const person = await createStaff(p.admin, {
    employeeCode: over.employeeCode ?? 'E-001',
    name: 'A Lecturer',
    designation: 'Assistant Professor',
    department: over.department ?? 'CSE',
    joinedOn: '2026-01-01',
  })
  await setComponent(p.admin, {
    staffId: person.id,
    code: 'basic',
    label: 'Basic',
    kind: 'earning',
    amount: over.basic ?? '40000',
    effectiveFrom: '2026-01-01',
  })
  await setComponent(p.admin, {
    staffId: person.id,
    code: 'hra',
    label: 'HRA',
    kind: 'earning',
    amount: '16000',
    effectiveFrom: '2026-01-01',
  })
  await setComponent(p.admin, {
    staffId: person.id,
    code: 'pf',
    label: 'Provident fund',
    kind: 'deduction',
    amount: '4800',
    effectiveFrom: '2026-01-01',
  })
  return person
}

const books = (p: Payroll): Books => p.admin as unknown as Books

async function balance(p: Payroll, code: string, window: object = {}): Promise<number> {
  const tb = await trialBalance(books(p), window)
  return tb.rows.find((r) => r.code === code)?.balancePaise ?? 0
}

const EXPENSE = '5100'
const PAYABLE = '2100'
const WITHHELD = '2200'
const BANK = '1010'
const CASH = '1000'

const MARCH = { from: '2026-03-01T00:00:00Z', to: '2026-03-31T23:59:59Z' }
const APRIL = { from: '2026-04-01T00:00:00Z', to: '2026-04-30T23:59:59Z' }

const hrCode = (e: unknown) => (e as HrError).code

const chain = (e: unknown): string => {
  let text = ''
  for (let x: unknown = e; x instanceof Error; x = (x as { cause?: unknown }).cause) {
    text += x.message + String.fromCharCode(10)
  }
  return text
}

// --- accruing ---------------------------------------------------------------

test('a payroll run is a cost and a liability, not a payment', async () => {
  const p = await payrollFor()
  await hire(p)

  await generatePayroll(p.admin, { period: '2026-03' })

  assert.equal(await balance(p, EXPENSE), 56_000_00)
  assert.equal(await balance(p, WITHHELD), 4_800_00)
  assert.equal(await balance(p, PAYABLE), 51_200_00)
  // Nothing has left the bank. That is a separate act.
  assert.equal(await balance(p, BANK), 0)
  assert.equal((await trialBalance(books(p))).differencePaise, 0)
})

test('each payslip carries its own department into the books', async () => {
  const p = await payrollFor()
  await hire(p, { employeeCode: 'E-001', department: 'CSE' })
  await hire(p, { employeeCode: 'E-002', department: 'Hostel', basic: '20000' })

  await generatePayroll(p.admin, { period: '2026-03' })

  const entries = await listEntries(books(p))
  assert.equal(entries.length, 2)

  const centres = new Set<string>()
  for (const e of entries) {
    for (const line of await entryLines(books(p), e.id)) {
      if (line.costCenter) centres.add(line.costCenter)
    }
  }
  assert.deepEqual([...centres].sort(), ['CSE', 'Hostel'])
})

test('somebody with no pay set puts nothing in the books', async () => {
  const p = await payrollFor()
  await createStaff(p.admin, {
    employeeCode: 'E-009',
    name: 'A Volunteer',
    designation: 'Visiting',
    joinedOn: '2026-01-01',
  })

  const run = await generatePayroll(p.admin, { period: '2026-03' })
  assert.equal(run.generated, 1)
  assert.equal((await listEntries(books(p))).length, 0)
})

test('running payroll twice does not accrue twice', async () => {
  const p = await payrollFor()
  await hire(p)

  await generatePayroll(p.admin, { period: '2026-03' })
  const again = await generatePayroll(p.admin, { period: '2026-03' })

  assert.equal(again.generated, 0)
  assert.equal(await balance(p, EXPENSE), 56_000_00)
  assert.equal((await listEntries(books(p))).length, 1)
})

// --- two months -------------------------------------------------------------

test("March's payroll paid in April is a cost of March and cash of April", async () => {
  const p = await payrollFor()
  await hire(p)
  await generatePayroll(p.admin, { period: '2026-03' })

  await paySalaries(p.admin, { period: '2026-03', paidOn: '2026-04-07', paidFrom: 'bank' })

  // March: the whole cost, and the liability standing at the month end.
  assert.equal(await balance(p, EXPENSE, MARCH), 56_000_00)
  assert.equal(await balance(p, PAYABLE, MARCH), 51_200_00)
  assert.equal(await balance(p, BANK, MARCH), 0)

  // April: no cost at all, the money gone, the liability discharged.
  assert.equal(await balance(p, EXPENSE, APRIL), 0)
  assert.equal(await balance(p, BANK, APRIL), -51_200_00)
  assert.equal(await balance(p, PAYABLE, APRIL), -51_200_00)

  // Over both: salaries payable is back to nothing, withholdings still owed.
  assert.equal(await balance(p, PAYABLE), 0)
  assert.equal(await balance(p, WITHHELD), 4_800_00)
  assert.equal(await balance(p, EXPENSE), 56_000_00)
  assert.equal((await trialBalance(books(p))).differencePaise, 0)
})

test('salaries can go out in cash as easily as from the bank', async () => {
  const p = await payrollFor()
  await hire(p)
  await generatePayroll(p.admin, { period: '2026-03' })

  await paySalaries(p.admin, { period: '2026-03', paidOn: '2026-04-01', paidFrom: 'cash' })

  assert.equal(await balance(p, CASH), -51_200_00)
  assert.equal(await balance(p, BANK), 0)
  assert.equal(await balance(p, PAYABLE), 0)
})

test('the amount paid is the payroll, not whatever was typed', async () => {
  const p = await payrollFor()
  await hire(p)
  await generatePayroll(p.admin, { period: '2026-03' })

  // The schema takes no amount at all, and the row that lands carries the
  // payroll's own total.
  const row = await paySalaries(p.admin, {
    period: '2026-03',
    paidOn: '2026-04-07',
    amountPaise: 1,
  })
  assert.equal(row.amountPaise, 51_200_00)
})

// --- what is refused --------------------------------------------------------

test('a month is paid once', async () => {
  const p = await payrollFor()
  await hire(p)
  await generatePayroll(p.admin, { period: '2026-03' })
  await paySalaries(p.admin, { period: '2026-03', paidOn: '2026-04-07' })

  await assert.rejects(
    () => paySalaries(p.admin, { period: '2026-03', paidOn: '2026-04-08' }),
    (e: unknown) => hrCode(e) === 'already_paid',
  )
  assert.equal((await listSalaryPayments(p.admin)).length, 1)
})

test('a month nobody was paid for cannot be paid', async () => {
  const p = await payrollFor()
  await hire(p)

  await assert.rejects(
    () => paySalaries(p.admin, { period: '2026-03', paidOn: '2026-04-07' }),
    (e: unknown) => hrCode(e) === 'no_payroll',
  )
})

test('the database refuses a payment that does not match the payroll', async () => {
  const p = await payrollFor()
  await hire(p)
  await generatePayroll(p.admin, { period: '2026-03' })

  await assert.rejects(
    () =>
      withTenant(p.id, (tx) =>
        tx.insert(salaryPayments).values({
          institutionId: p.id,
          period: '2026-03-01',
          paidOn: '2026-04-07',
          amountPaise: 1_00,
        }),
      ),
    (e: unknown) => /come to /.test(chain(e)),
  )
})

test('a paid month is closed to new payslips', async () => {
  const p = await payrollFor()
  await hire(p, { employeeCode: 'E-001' })
  await generatePayroll(p.admin, { period: '2026-03' })
  await paySalaries(p.admin, { period: '2026-03', paidOn: '2026-04-07' })

  // Somebody hired late, whose March salary this payment never covered.
  await hire(p, { employeeCode: 'E-002' })
  await assert.rejects(
    () => generatePayroll(p.admin, { period: '2026-03' }),
    (e: unknown) => hrCode(e) === 'period_paid',
  )

  // April is a different month and runs for both of them.
  const april = await generatePayroll(p.admin, { period: '2026-04' })
  assert.equal(april.generated, 2)
})

test('the database closes a paid month too, not only the module', async () => {
  const p = await payrollFor()
  const person = await hire(p, { employeeCode: 'E-001' })
  await generatePayroll(p.admin, { period: '2026-03' })
  await paySalaries(p.admin, { period: '2026-03', paidOn: '2026-04-07' })

  await assert.rejects(
    () =>
      withTenant(p.id, (tx) =>
        tx.insert(payslips).values({
          institutionId: p.id,
          staffId: person.id,
          period: '2026-03-01',
          grossPaise: 1_00,
          deductionsPaise: 0,
          netPaise: 1_00,
          lines: [],
        }),
      ),
    (e: unknown) => /have already been paid/.test(chain(e)),
  )
})

test('the finance office runs payroll but does not decide to pay it', async () => {
  const p = await payrollFor()
  await hire(p)

  await generatePayroll(p.clerk, { period: '2026-03' })
  await assert.rejects(
    () => paySalaries(p.clerk, { period: '2026-03', paidOn: '2026-04-07' }),
    (e: unknown) => (e as HrError).status === 403,
  )
})

// --- tenants ----------------------------------------------------------------

test("one institution's payroll is invisible in another's books", async () => {
  const one = await payrollFor()
  const two = await payrollFor()
  await hire(one)
  await hire(two, { basic: '10000' })

  await generatePayroll(one.admin, { period: '2026-03' })
  await generatePayroll(two.admin, { period: '2026-03' })

  assert.equal(await balance(one, EXPENSE), 56_000_00)
  assert.equal(await balance(two, EXPENSE), 26_000_00)

  const rows = await withTenant(two.id, (tx) => tx.select().from(salaryPayments))
  assert.equal(rows.length, 0)
  assert.equal((await listEntries(books(two))).length, 1)
})

// --- the whole cycle --------------------------------------------------------

test('two months of payroll leave the books balanced and the liability clear', async () => {
  const p = await payrollFor()
  await hire(p, { employeeCode: 'E-001', department: 'CSE' })
  await hire(p, { employeeCode: 'E-002', department: 'Library', basic: '20000' })

  await generatePayroll(p.admin, { period: '2026-03' })
  await paySalaries(p.admin, { period: '2026-03', paidOn: '2026-04-05' })
  await generatePayroll(p.admin, { period: '2026-04' })
  await paySalaries(p.admin, { period: '2026-04', paidOn: '2026-05-05' })

  const tb = await trialBalance(books(p))
  assert.equal(tb.differencePaise, 0)

  // 56,000 + 36,000 a month, twice over.
  assert.equal(await balance(p, EXPENSE), 184_000_00)
  assert.equal(await balance(p, PAYABLE), 0)
  assert.equal(await balance(p, WITHHELD), 19_200_00)
  assert.equal(await balance(p, BANK), -164_800_00)

  const paid = await listSalaryPayments(p.admin)
  assert.deepEqual(
    paid.map((x) => x.period),
    ['2026-04-01', '2026-03-01'],
  )
})

test('an entry for one person names the person it is for', async () => {
  const p = await payrollFor()
  await hire(p, { employeeCode: 'E-777' })
  await generatePayroll(p.admin, { period: '2026-03' })

  const [entry] = await listEntries(books(p))
  assert.match(entry!.memo, /E-777/)
  assert.match(entry!.memo, /2026-03/)
  assert.equal(entry!.sourceModule, 'hr')

  const lines = await entryLines(books(p), entry!.id)
  assert.equal(lines.find((l) => l.code === EXPENSE)!.debitPaise, 56_000_00)
  assert.equal(lines.find((l) => l.code === PAYABLE)!.creditPaise, 51_200_00)
  assert.equal(lines.find((l) => l.code === WITHHELD)!.creditPaise, 4_800_00)
})
