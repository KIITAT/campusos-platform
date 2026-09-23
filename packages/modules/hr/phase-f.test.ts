import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { sql } from 'drizzle-orm'
import { authDb, institutions, users } from '@campusos/db'
import { listEntries, trialBalance } from '@campusos/module-finance/api'
import {
  assignShift,
  assignStructure,
  completeOnboardingActivity,
  createCycle,
  createKra,
  createLeaveType,
  createOnboardingTemplate,
  createShiftType,
  createStaff,
  createStructure,
  decideLeave,
  enrol,
  generatePayroll,
  listSeparations,
  listStaff,
  myAppraisals,
  onboardingFor,
  recordExitInterview,
  requestLeave,
  roster,
  separate,
  setCycleStatus,
  startOnboarding,
  submitReview,
  submitSelfReview,
  type Actor,
} from './api'

/**
 * Phase F, as one employment.
 *
 * Somebody is onboarded, put on nights, takes unpaid leave in the middle of
 * them, goes through an appraisal, and leaves. The November payslip has to
 * know about the leave and the shifts, the books have to agree with it to the
 * paisa, and a second college must not see any of it.
 */

const SLUG = 'hr-phase-f-'
let n = 0
after(async () => {
  await authDb.delete(institutions).where(sql`${institutions.slug} like ${SLUG + '%'}`)
})

async function college() {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Phase F College', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: i!.id, role: 'institution_admin', name: 'Registrar' },
      { email: `hod@${tag}.test`, institutionId: i!.id, role: 'hod', name: 'Chief Warden' },
      { email: `w@${tag}.test`, institutionId: i!.id, role: 'faculty', name: 'A Warden' },
    ])
    .returning({ id: users.id })
  const as = (k: number, role: Actor['role']): Actor => ({
    id: people[k]!.id, email: null, role, institutionId: i!.id,
  })
  return { id: i!.id, admin: as(0, 'institution_admin'), chief: as(1, 'hod'), warden: as(2, 'faculty') }
}

test('one employment, from the first day to the last, through payroll and the books', async () => {
  const c = await college()

  // --- joining: a record, a structure, a checklist worked through ----------
  const person = await createStaff(c.admin, {
    employeeCode: 'W-7', name: 'A Warden', designation: 'Hostel warden', department: 'Hostels',
    joinedOn: '2026-10-01', userId: c.warden.id,
  })
  const structure = await createStructure(c.admin, {
    code: 'WARDEN', name: 'Wardens',
    lines: [
      { code: 'basic', label: 'Basic', kind: 'earning', calc: 'base' },
      { code: 'pf', label: 'Provident fund', kind: 'deduction', calc: 'percent_of', percentBp: 1200, of: 'basic' },
    ],
  })
  await assignStructure(c.admin, {
    staffId: person.id, structureId: structure.id, base: '30000', effectiveFrom: '2026-10-01',
  })
  const checklist = await createOnboardingTemplate(c.admin, {
    code: 'warden', name: 'New warden',
    activities: [
      { title: 'Hand over hostel keys', owner: 'Estates', dueDayOffset: 0 },
      { title: 'Fire-safety briefing', owner: 'Security', dueDayOffset: 2 },
    ],
  })
  await startOnboarding(c.admin, { staffId: person.id, templateId: checklist.id })
  for (const a of (await onboardingFor(c.admin, person.id))!.activities) {
    await completeOnboardingActivity(c.admin, { activityId: a.id })
  }
  assert.ok((await onboardingFor(c.admin, person.id))!.completedAt, 'onboarding complete')

  // --- nights, and unpaid leave in the middle of them ------------------------
  const days = await createShiftType(c.admin, { code: 'D', name: 'Day', startsAt: '08:00', endsAt: '16:00' })
  const nights = await createShiftType(c.admin, {
    code: 'N', name: 'Night', startsAt: '21:00', endsAt: '06:00', allowance: '500',
  })
  await assignShift(c.admin, { staffId: person.id, shiftTypeId: days.id, fromOn: '2026-10-01' })
  await assignShift(c.admin, {
    staffId: person.id, shiftTypeId: nights.id, fromOn: '2026-11-11', toOn: '2026-11-20',
  })
  const lwp = await createLeaveType(c.admin, { code: 'lwp', name: 'Leave without pay', paid: false })
  const leave = await requestLeave(c.warden, {
    staffId: person.id, leaveTypeId: lwp.id, fromOn: '2026-11-14', toOn: '2026-11-15',
    reason: 'family wedding out of town',
  })
  await decideLeave(c.admin, { requestId: leave.id, approve: true })

  const week = await roster(c.admin, '2026-11-13', '2026-11-16')
  assert.deepEqual(week.rows[0]!.days, ['N', 'leave', 'leave', 'N'])

  // --- an appraisal, start to finish -----------------------------------------
  const cycle = await createCycle(c.admin, { name: 'Probation review', startsOn: '2026-10-01', endsOn: '2027-03-31' })
  await setCycleStatus(c.admin, { cycleId: cycle.id, status: 'open' })
  const care = await createKra(c.admin, { code: 'CARE', name: 'Student welfare' })
  const order = await createKra(c.admin, { code: 'ORDER', name: 'Discipline and safety' })
  await enrol(c.admin, {
    cycleId: cycle.id, staffIds: [person.id], reviewerId: c.chief.id,
    kras: [{ kraId: care.id, weight: 70 }, { kraId: order.id, weight: 30 }],
  })
  const [appraisal] = await myAppraisals(c.warden)
  await submitSelfReview(c.warden, {
    appraisalId: appraisal!.id, summary: 'Settled the first-years in; two night incidents handled.',
    ratings: [{ kraId: care.id, rating: 4 }, { kraId: order.id, rating: 4 }],
  })
  const reviewed = await submitReview(c.chief, {
    appraisalId: appraisal!.id, summary: 'Strong start. Confirm after probation.',
    ratings: [{ kraId: care.id, rating: 5 }, { kraId: order.id, rating: 3 }],
  })
  assert.equal(reviewed.scoreCenti, 440) // 5 x 70% + 3 x 30%

  // --- November's payslip knows about the leave and the nights ---------------
  const nov = (await generatePayroll(c.admin, { period: '2026-11' })).payslips[0]!
  // Two unpaid days in a thirty-day month: 30,000 / 30 x 2 = 2,000 off basic.
  assert.equal(nov.unpaidLeaveDays, 2)
  assert.equal(nov.lossOfPayPaise, 200_000)
  // Ten nights rostered, two of them on leave: eight nights at 500.
  const allowance = nov.lines.find((l) => l.code === 'shift:N')!
  assert.equal(allowance.label, 'Night allowance, 8 days')
  assert.equal(allowance.appliedPaise, 400_000)
  assert.equal(nov.grossPaise, 3_000_000 - 200_000 + 400_000)
  assert.equal(nov.deductionsPaise, 360_000)
  assert.equal(nov.netPaise, 3_200_000 - 360_000)

  // --- and the books agree, to the paisa -------------------------------------
  const tb = await trialBalance(c.admin)
  const bal = (code: string) => tb.rows.find((r) => r.code === code)?.balancePaise ?? 0
  assert.equal(bal('5100'), nov.grossPaise, 'salaries expense is the gross')
  assert.equal(bal('2200'), nov.deductionsPaise, 'the provident fund is a withholding owed')
  assert.equal(bal('2100'), nov.netPaise, 'and the net is owed to the warden')
  assert.equal(tb.differencePaise, 0)
  const posted = await listEntries(c.admin)
  assert.ok(posted.some((e) => String(e.memo).includes('2026-11 salary, A Warden (W-7)')))

  // --- leaving -----------------------------------------------------------------
  await separate(c.admin, {
    staffId: person.id, kind: 'resignation', noticeGivenOn: '2026-12-01', lastDayOn: '2026-12-31',
    reason: 'moving to a warden post in Pune',
  })
  await recordExitInterview(c.admin, {
    staffId: person.id, on: '2026-12-28', notes: 'Leaving for family reasons; would return.', rehireEligible: true,
  })
  const dec = await generatePayroll(c.admin, { period: '2026-12' })
  assert.equal(dec.generated, 1, 'paid for their last month')
  const jan = await generatePayroll(c.admin, { period: '2027-01' })
  assert.equal(jan.generated, 0, 'and not after it')
  assert.equal((await listStaff(c.admin)).length, 0, 'no longer on the active list')
  assert.equal((await listSeparations(c.admin))[0]!.rehireEligible, true)
  assert.equal((await trialBalance(c.admin)).differencePaise, 0)

  // --- and none of it is visible anywhere else ---------------------------------
  const other = await college()
  assert.equal((await listSeparations(other.admin)).length, 0)
  assert.equal((await roster(other.admin, '2026-11-01', '2026-11-30')).rows.length, 0)
  assert.equal((await trialBalance(other.admin)).rows.filter((r) => r.balancePaise !== 0).length, 0)
  assert.equal((await myAppraisals(other.admin)).length, 0)
})
