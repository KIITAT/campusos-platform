import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, like } from 'drizzle-orm'
import {
  authDb,
  db,
  institutionModules,
  institutions,
  users,
  withTenant,
} from '@campusos/db'
import * as academic from '@campusos/module-academic/api'
import * as enrollment from '@campusos/module-enrollment/api'
import { listEntries, trialBalance, type Actor as Books } from '@campusos/module-finance/api'
import {
  FeeError,
  assessAid,
  awardScholarship,
  createFeeItem,
  createScholarship,
  listAwards,
  listDropCredits,
  prorateDrops,
  recordPayment,
  revokeAward,
  setRefundRules,
  studentLedger,
  type Actor,
} from './api'
import { scholarshipAwards } from './schema'

/**
 * Student financials: the aid an institution funds itself, and what a course
 * dropped inside the window is worth back.
 *
 * A fresh institution per test. Both halves post to an append-only journal, and
 * half the point of these is what the books say afterwards.
 */

let n = 0
const SLUG = 'fees-aid-'

const day = (offset: number) => {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + offset)
  return d.toISOString().slice(0, 10)
}

interface Campus {
  id: string
  admin: Actor
  a: string
  b: string
  programId: string
  termId: string
  sectionId: string
  deptId: string
}

const asAcademic = (a: Actor): academic.Actor => ({
  id: a.id,
  role: a.role,
  institutionId: a.institutionId,
})
const asEnrollment = (a: Actor): enrollment.Actor => ({
  id: a.id,
  role: a.role,
  institutionId: a.institutionId,
})
const books = (c: Campus): Books => c.admin as unknown as Books

async function turnOn(id: string, moduleId: string, enabled = true) {
  await db
    .insert(institutionModules)
    .values({ institutionId: id, moduleId, enabled })
    .onConflictDoUpdate({
      target: [institutionModules.institutionId, institutionModules.moduleId],
      set: { enabled },
    })
}

async function campus(): Promise<Campus> {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Aid College', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const id = i!.id
  await turnOn(id, 'finance')
  await turnOn(id, 'enrollment')

  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Adm' },
      { email: `a@${tag}.test`, institutionId: id, role: 'student', name: 'Aiyla Student' },
      { email: `b@${tag}.test`, institutionId: id, role: 'student', name: 'Bran Student' },
    ])
    .returning({ id: users.id })

  const admin: Actor = {
    id: people[0]!.id,
    email: `adm@${tag}.test`,
    role: 'institution_admin',
    institutionId: id,
  }

  const dept = await academic.createDepartment(asAcademic(admin), {
    code: 'CSE',
    name: 'Computing',
  })
  const program = await academic.createProgram(asAcademic(admin), {
    departmentId: dept.id,
    code: 'BTCS',
    name: 'B.Tech Computing',
    level: 'undergraduate',
    durationTerms: 8,
  })
  const term = await academic.createTerm(asAcademic(admin), {
    code: `T${++n}`,
    name: 'Autumn',
    startsOn: day(-30),
    endsOn: day(60),
  })
  await academic.setTermCalendar(asAcademic(admin), {
    termId: term.id,
    registrationOpensOn: day(-20),
    registrationClosesOn: day(10),
    addDropEndsOn: day(20),
    withdrawEndsOn: day(40),
  })
  const section = await academic.createSection(asAcademic(admin), {
    programId: program.id,
    label: 'A',
    admissionYear: 2025,
  })
  for (const student of [people[1]!.id, people[2]!.id]) {
    await academic.addSectionMember(asAcademic(admin), {
      sectionId: section.id,
      userId: student,
    })
  }

  return {
    id,
    admin,
    a: people[1]!.id,
    b: people[2]!.id,
    programId: program.id,
    termId: term.id,
    sectionId: section.id,
    deptId: dept.id,
  }
}

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

/** Tuition that prorates, and an examination fee that does not. */
async function charges(c: Campus, tuition = '40000', exam = '2000') {
  await createFeeItem(c.admin, {
    programId: c.programId,
    termId: c.termId,
    label: 'Tuition',
    amount: tuition,
    proratable: true,
  })
  await createFeeItem(c.admin, {
    programId: c.programId,
    termId: c.termId,
    label: 'Examination fee',
    amount: exam,
  })
}

/** A course this cohort is taught, registered by `who`. */
async function takes(c: Campus, who: string, credits: number, title = 'Algorithms') {
  const course = await academic.createCourse(asAcademic(c.admin), {
    departmentId: c.deptId,
    code: `C${++n}`,
    title,
    credits,
  })
  const offering = await academic.createOffering(asAcademic(c.admin), {
    termId: c.termId,
    courseId: course.id,
    sectionId: c.sectionId,
  })
  await enrollment.register(asEnrollment(c.admin), { studentId: who, offeringId: offering.id })
  return offering
}

const errorCode = (e: unknown) => (e as FeeError).code

const balance = async (c: Campus, code: string) => {
  const tb = await trialBalance(books(c))
  return tb.rows.find((r) => r.code === code)?.balancePaise ?? 0
}

const SCHOLARSHIPS = '5200'
const RECEIVABLE = '1100'
const INCOME = '4000'

// --- who qualifies ---------------------------------------------------------

test('a scholarship is awarded on numbers the product already has', async () => {
  const c = await campus()
  await charges(c)
  await takes(c, c.a, 4)
  const rule = await createScholarship(c.admin, {
    code: 'MERIT',
    name: 'Merit scholarship',
    kind: 'merit',
    basis: 'fixed',
    amountPaise: '10000',
    minCredits: 4,
  })

  const assessed = await assessAid(c.admin, { studentId: c.a, termId: c.termId })
  assert.equal(assessed.credits, 4)
  assert.equal(assessed.offers[0]!.eligible, true)
  assert.equal(assessed.offers[0]!.amountPaise, 1_000_000)

  const award = await awardScholarship(c.admin, {
    scholarshipId: rule.id,
    studentId: c.a,
    termId: c.termId,
  })
  assert.equal(award.amountPaise, 1_000_000)
  // What was true when it was granted, kept so the decision can be explained.
  assert.equal(award.creditsAtAward, 4)
})

test('a student carrying too little does not qualify, and is told which rule', async () => {
  const c = await campus()
  await charges(c)
  await takes(c, c.a, 2)
  await createScholarship(c.admin, {
    code: 'FULLTIME',
    name: 'Full-time award',
    kind: 'merit',
    basis: 'fixed',
    amountPaise: '5000',
    minCredits: 12,
  })

  const assessed = await assessAid(c.admin, { studentId: c.a, termId: c.termId })
  assert.equal(assessed.offers[0]!.eligible, false)
  assert.deepEqual(assessed.offers[0]!.reasons, ['below_minimum_credits'])

  await assert.rejects(
    () =>
      awardScholarship(c.admin, {
        scholarshipId: assessed.offers[0]!.scholarshipId,
        studentId: c.a,
        termId: c.termId,
      }),
    (e: unknown) => errorCode(e) === 'not_eligible',
  )
})

test('an institution that keeps no registrations cannot be told a credit load', async () => {
  const c = await campus()
  await turnOn(c.id, 'enrollment', false)
  await charges(c)
  await createScholarship(c.admin, {
    code: 'FULLTIME',
    name: 'Full-time award',
    kind: 'merit',
    basis: 'fixed',
    amountPaise: '5000',
    minCredits: 12,
  })

  // Not "fails the rule" -- nobody can tell, and awarding on it anyway would be
  // a number nobody could defend.
  const assessed = await assessAid(c.admin, { studentId: c.a, termId: c.termId })
  assert.equal(assessed.credits, null)
  assert.deepEqual(assessed.offers[0]!.reasons, ['credit_load_unknown'])
})

test('a rule asking nothing works without registrations at all', async () => {
  const c = await campus()
  await turnOn(c.id, 'enrollment', false)
  await charges(c)
  const rule = await createScholarship(c.admin, {
    code: 'STAFF',
    name: "Staff children's concession",
    kind: 'staff',
    basis: 'proportional',
    percentBps: 5000,
  })

  const assessed = await assessAid(c.admin, { studentId: c.a, termId: c.termId })
  // Half of forty-two thousand rupees charged.
  assert.equal(assessed.offers[0]!.amountPaise, 2_100_000)
  assert.equal(assessed.offers[0]!.eligible, true)

  const award = await awardScholarship(c.admin, {
    scholarshipId: rule.id,
    studentId: c.a,
    termId: c.termId,
  })
  assert.equal(award.amountPaise, 2_100_000)
})

test('a grade rule waits for grades rather than assuming them', async () => {
  const c = await campus()
  await charges(c)
  await createScholarship(c.admin, {
    code: 'DEAN',
    name: "Dean's list",
    kind: 'merit',
    basis: 'fixed',
    amountPaise: '15000',
    minCgpa: 8,
  })

  const assessed = await assessAid(c.admin, { studentId: c.a, termId: c.termId })
  assert.deepEqual(assessed.offers[0]!.reasons, ['no_grades_yet'])
})

test('the same scholarship is awarded once a term', async () => {
  const c = await campus()
  await charges(c)
  const rule = await createScholarship(c.admin, {
    code: 'MERIT',
    name: 'Merit',
    kind: 'merit',
    basis: 'fixed',
    amountPaise: '10000',
  })
  await awardScholarship(c.admin, {
    scholarshipId: rule.id,
    studentId: c.a,
    termId: c.termId,
  })

  const again = await assessAid(c.admin, { studentId: c.a, termId: c.termId })
  assert.deepEqual(again.offers[0]!.reasons, ['already_awarded'])
  await assert.rejects(
    () =>
      awardScholarship(c.admin, {
        scholarshipId: rule.id,
        studentId: c.a,
        termId: c.termId,
      }),
    (e: unknown) => errorCode(e) === 'not_eligible',
  )
})

// --- what the books say ----------------------------------------------------

test('a scholarship is a cost, not a discount, and the books say which', async () => {
  const c = await campus()
  await charges(c)
  const rule = await createScholarship(c.admin, {
    code: 'MERIT',
    name: 'Merit',
    kind: 'merit',
    basis: 'fixed',
    amountPaise: '10000',
  })
  await awardScholarship(c.admin, {
    scholarshipId: rule.id,
    studentId: c.a,
    termId: c.termId,
  })

  assert.equal(await balance(c, SCHOLARSHIPS), 1_000_000)
  assert.equal(await balance(c, RECEIVABLE), -1_000_000)
  assert.equal((await trialBalance(books(c))).differencePaise, 0)

  // Not filed with waivers: an institution asking what its scholarship
  // programme cost should not read it out of the concessions line.
  assert.equal(await balance(c, '5000'), 0)
})

test('an award withdrawn is reversed, kept, and not un-withdrawn', async () => {
  const c = await campus()
  await charges(c)
  const rule = await createScholarship(c.admin, {
    code: 'MERIT',
    name: 'Merit',
    kind: 'merit',
    basis: 'fixed',
    amountPaise: '10000',
  })
  const award = await awardScholarship(c.admin, {
    scholarshipId: rule.id,
    studentId: c.a,
    termId: c.termId,
  })

  await revokeAward(c.admin, {
    awardId: award.id,
    reason: 'the committee found the marks had been mis-entered',
  })

  assert.equal(await balance(c, SCHOLARSHIPS), 0)
  assert.equal(await balance(c, RECEIVABLE), 0)
  assert.equal((await listEntries(books(c))).length, 2)

  const [row] = await listAwards(c.admin, { termId: c.termId })
  assert.equal(row!.status, 'revoked')
  assert.match(String(row!.revokedReason), /mis-entered/)

  await assert.rejects(
    () => revokeAward(c.admin, { awardId: award.id, reason: 'again, for luck' }),
    (e: unknown) => errorCode(e) === 'already_revoked',
  )
  // The row does not travel backwards, and it is not deleted either.
  await assert.rejects(() =>
    withTenant(c.id, (tx) =>
      tx
        .update(scholarshipAwards)
        .set({ status: 'awarded', revokedReason: null })
        .where(eq(scholarshipAwards.id, award.id)),
    ),
  )
  await assert.rejects(() =>
    withTenant(c.id, (tx) =>
      tx.delete(scholarshipAwards).where(eq(scholarshipAwards.id, award.id)),
    ),
  )
})

test('aid reduces what the student is asked for, not only what the ledger says', async () => {
  const c = await campus()
  await charges(c)
  const rule = await createScholarship(c.admin, {
    code: 'MERIT',
    name: 'Merit',
    kind: 'merit',
    basis: 'fixed',
    amountPaise: '10000',
  })
  await awardScholarship(c.admin, {
    scholarshipId: rule.id,
    studentId: c.a,
    termId: c.termId,
  })

  // Forty-two thousand charged, ten thousand of it funded by the institution.
  const l = await studentLedger(c.admin, c.a, c.termId)
  assert.equal(l.chargedPaise, 4_200_000)
  assert.equal(l.creditedPaise, 1_000_000)
  assert.equal(l.payablePaise, 3_200_000)
  assert.equal(l.outstandingPaise, 3_200_000)
})

// --- what a drop is worth back ---------------------------------------------

test('a course dropped inside the window comes back at the bracket that covers it', async () => {
  const c = await campus()
  await charges(c)
  const one = await takes(c, c.a, 4, 'Algorithms')
  await takes(c, c.a, 4, 'Databases')
  await setRefundRules(c.admin, {
    termId: c.termId,
    brackets: [
      { throughOn: day(7), refundBps: 10_000 },
      { throughOn: day(21), refundBps: 5_000 },
    ],
  })

  await enrollment.drop(asEnrollment(c.admin), {
    studentId: c.a,
    offeringId: one.id,
    effectiveOn: day(3),
  })

  const out = await prorateDrops(c.admin, { termId: c.termId })
  assert.equal(out.credited.length, 1)
  // Four credits of eight, all of the bracket, of forty thousand proratable --
  // and the two thousand examination fee stays where it is.
  assert.equal(out.credited[0]!.amountPaise, 2_000_000)

  const l = await studentLedger(c.admin, c.a, c.termId)
  assert.equal(l.creditedPaise, 2_000_000)
  assert.equal(l.payablePaise, 2_200_000)
})

test('the later bracket returns less, and past every bracket nothing comes back', async () => {
  const c = await campus()
  await charges(c)
  const late = await takes(c, c.a, 4, 'Algorithms')
  const never = await takes(c, c.b, 4, 'Databases')
  await takes(c, c.a, 4, 'Networks')
  await takes(c, c.b, 4, 'Graphics')
  await setRefundRules(c.admin, {
    termId: c.termId,
    brackets: [{ throughOn: day(7), refundBps: 10_000 }, { throughOn: day(14), refundBps: 2_500 }],
  })

  await enrollment.drop(asEnrollment(c.admin), {
    studentId: c.a,
    offeringId: late.id,
    effectiveOn: day(12),
  })
  await enrollment.drop(asEnrollment(c.admin), {
    studentId: c.b,
    offeringId: never.id,
    effectiveOn: day(19),
  })

  const out = await prorateDrops(c.admin, { termId: c.termId })
  assert.equal(out.credited.length, 1)
  assert.equal(out.credited[0]!.studentId, c.a)
  // A quarter of half the tuition.
  assert.equal(out.credited[0]!.amountPaise, 500_000)
  assert.equal(out.skipped, 1)
})

test('the sweep credits each dropped course once, however often it is run', async () => {
  const c = await campus()
  await charges(c)
  const one = await takes(c, c.a, 4, 'Algorithms')
  await takes(c, c.a, 4, 'Databases')
  await setRefundRules(c.admin, {
    termId: c.termId,
    brackets: [{ throughOn: day(21), refundBps: 10_000 }],
  })
  await enrollment.drop(asEnrollment(c.admin), {
    studentId: c.a,
    offeringId: one.id,
    effectiveOn: day(3),
  })

  await prorateDrops(c.admin, { termId: c.termId })
  const again = await prorateDrops(c.admin, { termId: c.termId })

  assert.equal(again.credited.length, 0)
  assert.equal(again.skipped, 1)
  assert.equal((await listDropCredits(c.admin, c.termId)).length, 1)
  assert.equal(await balance(c, INCOME), -2_000_000)
})

test('a drop credit is revenue never earned, not a concession granted', async () => {
  const c = await campus()
  await charges(c)
  const one = await takes(c, c.a, 4, 'Algorithms')
  await takes(c, c.a, 4, 'Databases')
  await setRefundRules(c.admin, {
    termId: c.termId,
    brackets: [{ throughOn: day(21), refundBps: 10_000 }],
  })
  await enrollment.drop(asEnrollment(c.admin), {
    studentId: c.a,
    offeringId: one.id,
    effectiveOn: day(3),
  })
  await prorateDrops(c.admin, { termId: c.termId })

  assert.equal(await balance(c, RECEIVABLE), -2_000_000)
  assert.equal(await balance(c, '5000'), 0)
  assert.equal((await trialBalance(books(c))).differencePaise, 0)
})

test('a term with no brackets returns nothing, which is the safe way to be wrong', async () => {
  const c = await campus()
  await charges(c)
  const one = await takes(c, c.a, 4, 'Algorithms')
  await enrollment.drop(asEnrollment(c.admin), {
    studentId: c.a,
    offeringId: one.id,
    effectiveOn: day(1),
  })

  const out = await prorateDrops(c.admin, { termId: c.termId })
  assert.equal(out.credited.length, 0)
  assert.equal(out.skipped, 1)
})

test('without registrations there is nothing to prorate, and it says so', async () => {
  const c = await campus()
  await charges(c)
  await turnOn(c.id, 'enrollment', false)

  await assert.rejects(
    () => prorateDrops(c.admin, { termId: c.termId }),
    (e: unknown) => errorCode(e) === 'registration_not_kept',
  )
})

test('a student who already paid ends up in credit, which is a refund to make', async () => {
  const c = await campus()
  await charges(c)
  const one = await takes(c, c.a, 4, 'Algorithms')
  await takes(c, c.a, 4, 'Databases')
  await recordPayment(c.admin, {
    studentId: c.a,
    termId: c.termId,
    amount: '42000',
    method: 'upi',
  })
  await setRefundRules(c.admin, {
    termId: c.termId,
    brackets: [{ throughOn: day(21), refundBps: 10_000 }],
  })
  await enrollment.drop(asEnrollment(c.admin), {
    studentId: c.a,
    offeringId: one.id,
    effectiveOn: day(3),
  })
  await prorateDrops(c.admin, { termId: c.termId })

  const l = await studentLedger(c.admin, c.a, c.termId)
  assert.equal(l.payablePaise, 2_200_000)
  assert.equal(l.paidPaise, 4_200_000)
  assert.equal(l.outstandingPaise, 0)
  // Money going back out is a bank instruction, not a calendar: it stays a
  // refund against the payment it came in on.
  assert.equal(l.overpaidPaise, 2_000_000)
})

test('another institution cannot award out of this one', async () => {
  const one = await campus()
  const two = await campus()
  await charges(one)
  const rule = await createScholarship(one.admin, {
    code: 'MERIT',
    name: 'Merit',
    kind: 'merit',
    basis: 'fixed',
    amountPaise: '10000',
  })

  await assert.rejects(
    () =>
      awardScholarship(two.admin, {
        scholarshipId: rule.id,
        studentId: one.a,
        termId: one.termId,
      }),
    (e: unknown) => errorCode(e) === 'no_such_user',
  )
  assert.equal((await listAwards(one.admin, { termId: one.termId })).length, 0)
})
