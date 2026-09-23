import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, sql } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import { trialBalance } from '@campusos/module-finance/api'
import {
  HrError,
  claimLines,
  createStaff,
  decideAdvance,
  decideClaim,
  generatePayroll,
  listAdvances,
  listClaims,
  payAdvance,
  repayAdvance,
  requestAdvance,
  setComponent,
  settleClaim,
  submitClaim,
  type Actor,
} from './api'
import { advanceRecoveries, expenseClaimLines } from './schema'

/**
 * Claims and advances, and that the books agree with HR about every rupee.
 *
 * A fresh institution per test: every assertion here ends in a ledger balance,
 * and a shared fixture would make each one a question about what an earlier
 * test posted.
 */

let n = 0
const SLUG = 'hr-exp-'
const code = (e: unknown) => (e as HrError).code

interface College {
  id: string
  admin: Actor
  principal: Actor
  lecturer: Actor
  staffId: string
}

async function college(): Promise<College> {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Claims College', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const id = i!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Bursar' },
      { email: `pri@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Principal' },
      { email: `fac@${tag}.test`, institutionId: id, role: 'faculty', name: 'Dr Traveller' },
    ])
    .returning({ id: users.id })
  const mk = (k: number, role: Actor['role']): Actor => ({
    id: people[k]!.id, email: null, role, institutionId: id,
  })
  const c = {
    id,
    admin: mk(0, 'institution_admin'),
    principal: mk(1, 'institution_admin'),
    lecturer: mk(2, 'faculty'),
    staffId: '',
  }
  const s = await createStaff(c.admin, {
    employeeCode: 'F-1', name: 'Dr Traveller', designation: 'Associate Professor',
    department: 'Physics', joinedOn: '2024-01-01', userId: c.lecturer.id,
  })
  c.staffId = s.id
  return c
}

/** A ledger balance by account code. */
const balance = async (c: College, accountCode: string) =>
  (await trialBalance(c.admin)).rows.find((r) => r.code === accountCode)?.balancePaise ?? 0

after(async () => {
  await authDb.delete(institutions).where(sql`${institutions.slug} like ${SLUG + '%'}`)
})

// --- claims ----------------------------------------------------------------

test('a claim is asked, agreed for less, and paid -- and the books say so', async () => {
  const c = await college()
  const claim = await submitClaim(c.lecturer, {
    staffId: c.staffId,
    title: 'IIT Bombay workshop',
    lines: [
      { spentOn: '2026-08-10', category: 'Travel', description: 'Train, 3AC return', amount: '4200', receiptRef: 'PNR 482' },
      { spentOn: '2026-08-11', category: 'Conference fee', description: 'Registration', amount: '6000' },
    ],
  })
  assert.equal(claim.claimedPaise, 1_020_000)

  const lines = await claimLines(c.lecturer, claim.id)
  const fee = lines.find((l) => l.category === 'Conference fee')!
  const decided = await decideClaim(c.admin, {
    claimId: claim.id, approve: true,
    sanction: [{ lineId: fee.id, amount: '5000' }],
    note: 'fee capped at the early-bird rate',
  })
  assert.equal(decided.sanctionedPaise, 920_000)
  assert.equal(await balance(c, '5300'), 920_000, 'the expense lands when the claim is agreed')
  assert.equal(await balance(c, '2300'), 920_000, 'and is owed to the claimant')

  await settleClaim(c.admin, { claimId: claim.id, paidOn: '2026-09-05', paidFrom: 'bank' })
  assert.equal(await balance(c, '2300'), 0, 'settling clears what was owed')
  assert.equal(await balance(c, '1010'), -920_000)
  assert.equal((await trialBalance(c.admin)).differencePaise, 0)

  const [row] = await listClaims(c.lecturer)
  assert.equal(row!.status, 'paid')
  assert.equal(row!.paidPaise, 920_000)
})

test('nobody approves their own claim, and a rejected one posts nothing', async () => {
  const c = await college()
  const self = await createStaff(c.admin, {
    employeeCode: 'A-1', name: 'Bursar', designation: 'Bursar', joinedOn: '2020-01-01', userId: c.admin.id,
  })
  const mine = await submitClaim(c.admin, {
    staffId: self.id, title: 'Stationery',
    lines: [{ spentOn: '2026-09-01', category: 'Supplies', description: 'Ledger books', amount: '800' }],
  })
  await assert.rejects(
    () => decideClaim(c.admin, { claimId: mine.id, approve: true }),
    (e: unknown) => code(e) === 'self_approval',
  )
  await decideClaim(c.principal, { claimId: mine.id, approve: false, note: 'buy through stores' })
  assert.equal(await balance(c, '5300'), 0)
})

test('a lecturer claims for themselves and sees only their own', async () => {
  const c = await college()
  const other = await createStaff(c.admin, {
    employeeCode: 'F-2', name: 'Somebody else', designation: 'Lecturer', joinedOn: '2024-01-01',
  })
  await assert.rejects(
    () => submitClaim(c.lecturer, {
      staffId: other.id, title: 'Not mine',
      lines: [{ spentOn: '2026-09-01', category: 'Travel', description: 'Taxi', amount: '300' }],
    }),
    (e: unknown) => code(e) === 'forbidden',
  )
  await submitClaim(c.admin, {
    staffId: other.id, title: 'Theirs',
    lines: [{ spentOn: '2026-09-01', category: 'Travel', description: 'Taxi', amount: '300' }],
  })
  assert.equal((await listClaims(c.lecturer)).length, 0)
  assert.equal((await listClaims(c.admin)).length, 1)
})

test('nothing is claimed before it is spent, or sanctioned beyond the claim', async () => {
  const c = await college()
  await assert.rejects(
    () => submitClaim(c.lecturer, {
      staffId: c.staffId, title: 'Future',
      lines: [{ spentOn: '2099-01-01', category: 'Travel', description: 'Time machine', amount: '100' }],
    }),
    (e: unknown) => code(e) === 'bad_dates',
  )
  const claim = await submitClaim(c.lecturer, {
    staffId: c.staffId, title: 'Books',
    lines: [{ spentOn: '2026-09-01', category: 'Books', description: 'Two textbooks', amount: '1500' }],
  })
  const [line] = await claimLines(c.admin, claim.id)
  await assert.rejects(
    () => decideClaim(c.admin, { claimId: claim.id, approve: true, sanction: [{ lineId: line!.id, amount: '2000' }] }),
    (e: unknown) => code(e) === 'over_claimed',
  )
})

test('the lines of a claim do not change once it is in', async () => {
  const c = await college()
  const claim = await submitClaim(c.lecturer, {
    staffId: c.staffId, title: 'Books',
    lines: [{ spentOn: '2026-09-01', category: 'Books', description: 'Two textbooks', amount: '1500' }],
  })
  await assert.rejects(() =>
    withTenant(c.id, (tx) =>
      tx.update(expenseClaimLines).set({ amountPaise: 999_999 }).where(eq(expenseClaimLines.claimId, claim.id)),
    ),
  )
})

// --- advances --------------------------------------------------------------

test('an advance is an asset until accounted for, then a claim clears it', async () => {
  const c = await college()
  const adv = await requestAdvance(c.lecturer, {
    staffId: c.staffId, purpose: 'Field trip to the Sundarbans', amount: '10000',
  })
  await decideAdvance(c.admin, { advanceId: adv.id, approve: true })
  await payAdvance(c.admin, { advanceId: adv.id, paidOn: '2026-08-01', paidFrom: 'cash' })
  assert.equal(await balance(c, '1200'), 1_000_000, 'still the institution’s money')
  assert.equal(await balance(c, '5300'), 0, 'not yet an expense')

  const claim = await submitClaim(c.lecturer, {
    staffId: c.staffId, title: 'Sundarbans trip',
    lines: [{ spentOn: '2026-08-05', category: 'Travel', description: 'Boat hire and bus', amount: '12500' }],
  })
  await decideClaim(c.admin, { claimId: claim.id, approve: true })
  const settled = await settleClaim(c.admin, {
    claimId: claim.id, advanceId: adv.id, paidOn: '2026-08-20', paidFrom: 'bank',
  })
  assert.equal(settled.advanceAppliedPaise, 1_000_000)
  assert.equal(settled.paidPaise, 250_000, 'only the difference leaves the bank')

  assert.equal(await balance(c, '1200'), 0)
  assert.equal(await balance(c, '5300'), 1_250_000)
  assert.equal(await balance(c, '2300'), 0)
  assert.equal((await trialBalance(c.admin)).differencePaise, 0)

  const [a] = await listAdvances(c.admin)
  assert.equal(a!.status, 'settled', 'fully back is settled, by trigger')
  assert.equal(a!.outstandingPaise, 0)
})

test('an advance comes back out of pay, a month at a time, and stops when it is back', async () => {
  const c = await college()
  await setComponent(c.admin, {
    staffId: c.staffId, code: 'basic', label: 'Basic', kind: 'earning', amount: '50000', effectiveFrom: '2024-01-01',
  })
  await setComponent(c.admin, {
    staffId: c.staffId, code: 'pf', label: 'Provident fund', kind: 'deduction', amount: '6000', effectiveFrom: '2024-01-01',
  })
  const adv = await requestAdvance(c.admin, { staffId: c.staffId, purpose: 'Medical emergency at home', amount: '25000' })
  await decideAdvance(c.principal, { advanceId: adv.id, approve: true, monthlyRecovery: '10000' })
  await payAdvance(c.admin, { advanceId: adv.id, paidOn: '2026-06-15', paidFrom: 'bank' })

  const july = (await generatePayroll(c.admin, { period: '2026-07' })).payslips[0]!
  assert.equal(july.deductionsPaise, 600_000 + 1_000_000)
  assert.ok(july.lines.some((l) => l.label === 'Advance recovery: Medical emergency at home'))
  await generatePayroll(c.admin, { period: '2026-08' })
  const sept = (await generatePayroll(c.admin, { period: '2026-09' })).payslips[0]!
  assert.equal(sept.deductionsPaise, 600_000 + 500_000, 'only what is left, not the monthly figure')
  const oct = (await generatePayroll(c.admin, { period: '2026-10' })).payslips[0]!
  assert.equal(oct.deductionsPaise, 600_000, 'nothing once it is back')

  // The provident fund is a withholding; the recovery is the advance coming home.
  assert.equal(await balance(c, '1200'), 0)
  assert.equal(await balance(c, '2200'), 4 * 600_000)
  assert.equal((await trialBalance(c.admin)).differencePaise, 0)
  assert.equal((await listAdvances(c.admin))[0]!.status, 'settled')
})

test('a recovery never pushes a payslip below zero', async () => {
  const c = await college()
  await setComponent(c.admin, {
    staffId: c.staffId, code: 'basic', label: 'Basic', kind: 'earning', amount: '8000', effectiveFrom: '2024-01-01',
  })
  const adv = await requestAdvance(c.admin, { staffId: c.staffId, purpose: 'House deposit loan', amount: '50000' })
  await decideAdvance(c.principal, { advanceId: adv.id, approve: true, monthlyRecovery: '20000' })
  await payAdvance(c.admin, { advanceId: adv.id, paidOn: '2026-06-15', paidFrom: 'bank' })
  const slip = (await generatePayroll(c.admin, { period: '2026-07' })).payslips[0]!
  assert.equal(slip.netPaise, 0)
  assert.equal(slip.deductionsPaise, 800_000)
  assert.equal((await trialBalance(c.admin)).differencePaise, 0)
})

test('repaying in money, and never more than is outstanding', async () => {
  const c = await college()
  const adv = await requestAdvance(c.admin, { staffId: c.staffId, purpose: 'Conference registration', amount: '5000' })
  await decideAdvance(c.principal, { advanceId: adv.id, approve: true })
  await payAdvance(c.admin, { advanceId: adv.id, paidOn: '2026-06-15', paidFrom: 'bank' })
  await repayAdvance(c.admin, { advanceId: adv.id, amount: '2000', on: '2026-07-01', into: 'cash' })
  await assert.rejects(
    () => repayAdvance(c.admin, { advanceId: adv.id, amount: '3500', on: '2026-07-02', into: 'cash' }),
    (e: unknown) => code(e) === 'over_recovery',
  )
  // And the table refuses it too, whoever writes to it.
  await assert.rejects(() =>
    withTenant(c.id, (tx) =>
      tx.insert(advanceRecoveries).values({
        institutionId: c.id, advanceId: adv.id, source: 'cash', amountPaise: 400_000, recoveredOn: '2026-07-03',
      }),
    ),
  )
  assert.equal(await balance(c, '1200'), 300_000)
})

test('an unpaid advance has nothing to recover, and nobody approves their own', async () => {
  const c = await college()
  const adv = await requestAdvance(c.lecturer, { staffId: c.staffId, purpose: 'Books for the course', amount: '3000' })
  await assert.rejects(
    () => payAdvance(c.admin, { advanceId: adv.id, paidOn: '2026-06-15', paidFrom: 'bank' }),
    (e: unknown) => code(e) === 'not_approved',
  )
  await assert.rejects(
    () => decideAdvance(c.lecturer, { advanceId: adv.id, approve: true }),
    (e: unknown) => code(e) === 'forbidden',
  )
})

test('one college’s claims are invisible at another', async () => {
  const a = await college()
  const b = await college()
  await submitClaim(a.lecturer, {
    staffId: a.staffId, title: 'Ours',
    lines: [{ spentOn: '2026-09-01', category: 'Travel', description: 'Taxi', amount: '300' }],
  })
  assert.equal((await listClaims(b.admin)).length, 0)
})
