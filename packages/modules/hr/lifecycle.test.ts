import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, sql } from 'drizzle-orm'
import { auditLog, authDb, institutions, users, withTenant } from '@campusos/db'
import {
  HrError,
  completeOnboardingActivity,
  createGrade,
  createOnboardingTemplate,
  createStaff,
  endEmployment,
  exitInterviewsOutstanding,
  gradeUsage,
  listChanges,
  listGrades,
  listSeparations,
  onboardingFor,
  openOnboardings,
  recordChange,
  recordExitInterview,
  separate,
  serviceDays,
  startOnboarding,
  type Actor,
} from './api'
import {
  employeeGrades,
  employmentChanges,
  onboardingTemplates,
  onboardings,
  separations,
  staff,
} from './schema'

/**
 * The employment over time: the checklist a joiner is put through, the changes
 * to their post, and the end of it.
 *
 * Two institutions throughout, because everything here is a statement about one
 * person at one college and the interesting failure is a grade or a separation
 * leaking sideways.
 */

const SLUG = 'hr-life'
const OTHER = 'hr-life-other'
let inst: string
let other: string
const ids = { adm: '', clerk: '', fac: '', otherAdm: '' }

const A = (over: Partial<Actor>): Actor => ({
  id: ids.adm,
  email: 'adm@hrlife.test',
  role: 'institution_admin',
  institutionId: inst,
  ...over,
})
const admin = () => A({})
const clerk = () => A({ id: ids.clerk, email: 'clerk@hrlife.test', role: 'accounts_staff' })
const teacher = () => A({ id: ids.fac, email: 'fac@hrlife.test', role: 'faculty' })
const outsider = () =>
  A({ id: ids.otherAdm, email: 'adm@hrlifeother.test', institutionId: other })

const code = (e: unknown) => (e as HrError).code
const status = (e: unknown) => (e as HrError).status

/** Any message in the cause chain, so a trigger's words can be asserted on. */
const saysDb = (re: RegExp) => (e: unknown) => {
  let text = ''
  for (let x: unknown = e; x instanceof Error; x = (x as { cause?: unknown }).cause) {
    text += x.message + String.fromCharCode(10)
  }
  return re.test(text)
}

const hire = (over: Record<string, unknown> = {}) =>
  createStaff(admin(), {
    employeeCode: 'E-001',
    name: 'A Lecturer',
    designation: 'Assistant Professor',
    department: 'Computing',
    joinedOn: '2026-01-01',
    ...over,
  })

const joiningChecklist = (over: Record<string, unknown> = {}) =>
  createOnboardingTemplate(admin(), {
    code: 'faculty',
    name: 'New teaching staff',
    activities: [
      { title: 'Order a laptop', owner: 'IT', dueDayOffset: -7 },
      { title: 'Open a salary account', owner: 'Accounts', dueDayOffset: 1 },
      { title: 'Department induction', owner: 'Head of department', dueDayOffset: 3 },
    ],
    ...over,
  })

before(async () => {
  const rows = await authDb
    .insert(institutions)
    .values([
      { slug: SLUG, name: 'Lifecycle College', allowedEmailDomains: ['hrlife.test'] },
      { slug: OTHER, name: 'Other College', allowedEmailDomains: ['hrlifeother.test'] },
    ])
    .returning({ id: institutions.id })
  inst = rows[0]!.id
  other = rows[1]!.id

  const people = await authDb
    .insert(users)
    .values([
      { email: 'adm@hrlife.test', institutionId: inst, role: 'institution_admin', name: 'Adm' },
      { email: 'clerk@hrlife.test', institutionId: inst, role: 'accounts_staff', name: 'Clerk' },
      { email: 'fac@hrlife.test', institutionId: inst, role: 'faculty', name: 'Fac' },
      {
        email: 'adm@hrlifeother.test',
        institutionId: other,
        role: 'institution_admin',
        name: 'Other',
      },
    ])
    .returning({ id: users.id })
  ids.adm = people[0]!.id
  ids.clerk = people[1]!.id
  ids.fac = people[2]!.id
  ids.otherAdm = people[3]!.id
})

beforeEach(async () => {
  for (const tenant of [() => inst, () => other]) {
    await withTenant(tenant(), async (tx) => {
      await tx.execute(sql`select set_config('app.audit_reason', 'test reset', true)`)
      await tx.delete(separations)
      await tx.delete(employmentChanges)
      await tx.delete(onboardings)
      await tx.delete(onboardingTemplates)
      await tx.delete(staff)
      await tx.delete(employeeGrades)
      await tx.delete(auditLog)
    })
  }
})

after(async () => {
  await authDb.delete(institutions).where(eq(institutions.slug, SLUG))
  await authDb.delete(institutions).where(eq(institutions.slug, OTHER))
})

// --- grades ----------------------------------------------------------------

test('a grade is a band, and the band may not be upside down', async () => {
  const g = await createGrade(admin(), {
    code: 'AP-1',
    name: 'Assistant Professor, stage 1',
    rank: 10,
    minPaise: '50000',
    maxPaise: '80000',
  })
  assert.equal(g.rank, 10)
  assert.equal(g.minPaise, 5_000_000)
  assert.equal(g.maxPaise, 8_000_000)

  await assert.rejects(
    () =>
      createGrade(admin(), {
        code: 'AP-2',
        name: 'Upside down',
        minPaise: '80000',
        maxPaise: '50000',
      }),
    (e: unknown) => code(e) === 'bad_band',
  )
  await assert.rejects(
    () => createGrade(admin(), { code: 'AP-1', name: 'Again' }),
    (e: unknown) => code(e) === 'exists',
  )
})

test('a grade with no band is ordinary, and pay outside one is still recorded', async () => {
  // The band is advisory. A college that hires one person outside its scale has
  // made a decision, and refusing to record it only moves the figure into a
  // spreadsheet.
  const flat = await createGrade(admin(), { code: 'FLAT', name: 'One scale' })
  assert.equal(flat.minPaise, null)
  assert.equal(flat.maxPaise, null)

  const person = await hire()
  await recordChange(admin(), {
    staffId: person.id,
    kind: 'grade_change',
    effectiveOn: '2026-02-01',
    toGradeId: flat.id,
    reason: 'placed on the single scale',
  })

  const usage = await gradeUsage(admin())
  assert.equal(usage.find((g) => g.code === 'FLAT')?.people, 1)
})

test('one college’s grades are not another’s', async () => {
  await createGrade(admin(), { code: 'AP-1', name: 'Ours' })
  assert.equal((await listGrades(outsider())).length, 0)
  assert.equal((await listGrades(admin())).length, 1)
})

// --- onboarding ------------------------------------------------------------

test('a checklist is copied onto the joiner, dated from the day they start', async () => {
  const template = await joiningChecklist()
  const person = await hire({ joinedOn: '2026-03-10' })
  const run = await startOnboarding(admin(), { staffId: person.id, templateId: template.id })
  assert.equal(run.activities, 3)

  const view = (await onboardingFor(admin(), person.id))!
  assert.equal(view.outstanding, 3)
  assert.equal(view.completedAt, null)
  // -7 from the joining date: the laptop is ordered before they arrive.
  assert.equal(view.activities[0]!.dueOn, '2026-03-03')
  assert.equal(view.activities[1]!.dueOn, '2026-03-11')
  assert.equal(view.activities[2]!.dueOn, '2026-03-13')
  assert.equal(view.templateName, 'New teaching staff')
})

test('editing the template later does not rewrite what somebody was asked to do', async () => {
  const template = await joiningChecklist()
  const person = await hire()
  await startOnboarding(admin(), { staffId: person.id, templateId: template.id })

  // The template goes; the run stays, because its titles were copied.
  await withTenant(inst, (tx) =>
    tx.delete(onboardingTemplates).where(eq(onboardingTemplates.id, template.id)),
  )

  const view = (await onboardingFor(admin(), person.id))!
  assert.equal(view.activities.length, 3)
  assert.equal(view.templateCode, 'faculty')
  assert.equal(view.activities[0]!.title, 'Order a laptop')
})

test('an onboarding finishes when its last activity does, and not before', async () => {
  const template = await joiningChecklist()
  const person = await hire()
  await startOnboarding(admin(), { staffId: person.id, templateId: template.id })

  let view = (await onboardingFor(admin(), person.id))!
  await completeOnboardingActivity(admin(), { activityId: view.activities[0]!.id })
  await completeOnboardingActivity(clerk(), {
    activityId: view.activities[1]!.id,
    note: 'account opened at the campus branch',
  })

  view = (await onboardingFor(admin(), person.id))!
  assert.equal(view.outstanding, 1)
  assert.equal(view.completedAt, null)

  await completeOnboardingActivity(admin(), { activityId: view.activities[2]!.id })
  view = (await onboardingFor(admin(), person.id))!
  assert.equal(view.outstanding, 0)
  assert.ok(view.completedAt, 'the last activity completes the onboarding')
})

test('completion is derived, so it cannot be declared by hand', async () => {
  const template = await joiningChecklist()
  const person = await hire()
  const run = await startOnboarding(admin(), { staffId: person.id, templateId: template.id })

  await assert.rejects(
    () =>
      withTenant(inst, (tx) =>
        tx
          .update(onboardings)
          .set({ completedAt: new Date() })
          .where(eq(onboardings.id, run.id)),
      ),
    saysDb(/completes when its activities do/),
  )
})

test('the same activity is not completed twice, and somebody is onboarded once', async () => {
  const template = await joiningChecklist()
  const person = await hire()
  await startOnboarding(admin(), { staffId: person.id, templateId: template.id })

  const view = (await onboardingFor(admin(), person.id))!
  await completeOnboardingActivity(admin(), { activityId: view.activities[0]!.id })
  await assert.rejects(
    () => completeOnboardingActivity(admin(), { activityId: view.activities[0]!.id }),
    (e: unknown) => code(e) === 'already_done',
  )
  await assert.rejects(
    () => startOnboarding(admin(), { staffId: person.id, templateId: template.id }),
    (e: unknown) => code(e) === 'already_onboarding',
  )
})

test('the desk’s worklist is what is still open, oldest due first', async () => {
  const template = await joiningChecklist()
  const person = await hire({ joinedOn: '2020-01-01' })
  await startOnboarding(admin(), { staffId: person.id, templateId: template.id })

  const open = await openOnboardings(admin())
  assert.equal(open.length, 3)
  assert.equal(open[0]!.owner, 'IT')
  assert.equal(open[0]!.employeeCode, 'E-001')
  // Due in 2019 and 2020 and still not done.
  assert.ok(open.every((o) => o.overdue))

  const view = (await onboardingFor(admin(), person.id))!
  for (const a of view.activities) {
    await completeOnboardingActivity(admin(), { activityId: a.id })
  }
  assert.equal((await openOnboardings(admin())).length, 0)
})

// --- transfer, promotion, confirmation -------------------------------------

test('a transfer moves the department and leaves everything else alone', async () => {
  const person = await hire()
  const { change, staff: after } = await recordChange(admin(), {
    staffId: person.id,
    kind: 'transfer',
    effectiveOn: '2026-04-01',
    toDepartment: 'Electronics',
    reason: 'departmental reorganisation',
  })

  assert.equal(after.department, 'Electronics')
  assert.equal(after.designation, 'Assistant Professor', 'a transfer is not a promotion')
  assert.equal(change.fromDepartment, 'Computing')
  assert.equal(change.toDepartment, 'Electronics')
  assert.equal(change.toDesignation, null)
})

test('a promotion keeps what they were, which is the point of keeping it', async () => {
  const senior = await createGrade(admin(), { code: 'AP-2', name: 'Stage 2', rank: 20 })
  const person = await hire()

  await recordChange(admin(), {
    staffId: person.id,
    kind: 'promotion',
    effectiveOn: '2026-07-01',
    toDesignation: 'Associate Professor',
    toGradeId: senior.id,
    reason: 'promoted at the June board',
  })

  const history = await listChanges(admin(), person.id)
  assert.equal(history.length, 1)
  assert.equal(history[0]!.kind, 'promotion')
  assert.equal(history[0]!.fromDesignation, 'Assistant Professor')
  assert.equal(history[0]!.toDesignation, 'Associate Professor')
  assert.equal(history[0]!.toGrade, 'AP-2')
  assert.equal(history[0]!.fromGrade, null)

  // And the second change knows what the first one left behind.
  const third = await createGrade(admin(), { code: 'PROF', name: 'Professor', rank: 30 })
  await recordChange(admin(), {
    staffId: person.id,
    kind: 'promotion',
    effectiveOn: '2028-07-01',
    toDesignation: 'Professor',
    toGradeId: third.id,
    reason: 'promoted at the 2028 board',
  })
  const again = await listChanges(admin(), person.id)
  assert.equal(again[0]!.fromGrade, 'AP-2')
  assert.equal(again[0]!.fromDesignation, 'Associate Professor')
})

test('confirmation off probation is a change of employment, not of post', async () => {
  const person = await hire({ employment: 'probation' })
  const { staff: after } = await recordChange(admin(), {
    staffId: person.id,
    kind: 'confirmation',
    effectiveOn: '2026-07-01',
    toEmployment: 'permanent',
    reason: 'confirmed after six months',
  })
  assert.equal(after.employment, 'permanent')
  assert.equal(after.designation, 'Assistant Professor')
})

test('nothing changes about an employment before it began', async () => {
  const person = await hire({ joinedOn: '2026-01-01' })
  await assert.rejects(
    () =>
      recordChange(admin(), {
        staffId: person.id,
        kind: 'transfer',
        effectiveOn: '2025-12-31',
        toDepartment: 'Electronics',
        reason: 'a transfer before they arrived',
      }),
    saysDb(/before it began/),
  )
})

test('a change has to change something, and has to say why', async () => {
  const person = await hire()
  await assert.rejects(() =>
    recordChange(admin(), {
      staffId: person.id,
      kind: 'transfer',
      effectiveOn: '2026-04-01',
      reason: 'a transfer to nowhere',
    }),
  )
  await assert.rejects(() =>
    recordChange(admin(), {
      staffId: person.id,
      kind: 'transfer',
      effectiveOn: '2026-04-01',
      toDepartment: 'Electronics',
      reason: 'x',
    }),
  )
})

test('a lecturer does not promote themselves, and the clerk does not either', async () => {
  const person = await hire()
  for (const who of [teacher(), clerk()]) {
    await assert.rejects(
      () =>
        recordChange(who, {
          staffId: person.id,
          kind: 'promotion',
          effectiveOn: '2026-07-01',
          toDesignation: 'Professor',
          reason: 'self service promotion',
        }),
      (e: unknown) => status(e) === 403,
    )
  }
})

// --- separation ------------------------------------------------------------

test('separating ends the employment, records the change, and says how', async () => {
  const person = await hire()
  const row = await separate(admin(), {
    staffId: person.id,
    kind: 'resignation',
    lastDayOn: '2026-08-31',
    noticeGivenOn: '2026-06-30',
    reason: 'resigned to join another university',
  })

  assert.equal(row.kind, 'resignation')
  assert.equal(row.lastDayOn, '2026-08-31')
  assert.equal(row.exitInterviewOn, null)
  assert.equal(row.rehireEligible, null)

  const [after] = await withTenant(inst, (tx) =>
    tx.select().from(staff).where(eq(staff.id, person.id)),
  )
  assert.equal(after!.leftOn, '2026-08-31')

  const history = await listChanges(admin(), person.id)
  assert.equal(history[0]!.kind, 'separation')
  assert.equal(history[0]!.fromDesignation, 'Assistant Professor')

  const trail = await withTenant(inst, (tx) =>
    tx.select().from(auditLog).where(eq(auditLog.action, 'hr.separated')),
  )
  assert.equal(trail.length, 1)
  assert.match(String(trail[0]!.reason), /another university/)
})

test('an employment ends once, and not before it started', async () => {
  const person = await hire({ joinedOn: '2026-01-01' })
  await assert.rejects(
    () =>
      separate(admin(), {
        staffId: person.id,
        kind: 'resignation',
        lastDayOn: '2025-06-30',
        reason: 'left before arriving',
      }),
    (e: unknown) => code(e) === 'bad_dates',
  )
  await assert.rejects(
    () =>
      separate(admin(), {
        staffId: person.id,
        kind: 'resignation',
        lastDayOn: '2026-08-31',
        noticeGivenOn: '2026-09-30',
        reason: 'notice given after the last day',
      }),
    (e: unknown) => code(e) === 'bad_dates',
  )

  await separate(admin(), {
    staffId: person.id,
    kind: 'resignation',
    lastDayOn: '2026-08-31',
    reason: 'resigned to join another university',
  })
  await assert.rejects(
    () =>
      separate(admin(), {
        staffId: person.id,
        kind: 'termination',
        lastDayOn: '2026-09-30',
        reason: 'separating somebody who already left',
      }),
    (e: unknown) => code(e) === 'already_ended',
  )
})

test('a separation cannot exist over somebody still employed', async () => {
  const person = await hire()
  await assert.rejects(
    () =>
      withTenant(inst, (tx) =>
        tx.insert(separations).values({
          institutionId: inst,
          staffId: person.id,
          kind: 'resignation',
          lastDayOn: '2026-08-31',
          reason: 'written straight into the table',
        }),
      ),
    saysDb(/has not been ended/),
  )
})

test('a separation and the leaving date cannot drift apart', async () => {
  const person = await hire()
  await separate(admin(), {
    staffId: person.id,
    kind: 'resignation',
    lastDayOn: '2026-08-31',
    reason: 'resigned to join another university',
  })

  // Moving the leaving date underneath a recorded separation is how the two
  // answers to "when did they leave" start disagreeing.
  await assert.rejects(
    () =>
      withTenant(inst, (tx) =>
        tx.update(staff).set({ leftOn: '2026-09-30' }).where(eq(staff.id, person.id)),
      ),
    saysDb(/recorded separation says when/),
  )
})

test('endEmployment still ends an employment, and a separation may follow it', async () => {
  // The older, plainer path is not withdrawn: plenty of records are ended by
  // somebody who has nothing to add beyond the date.
  const person = await hire()
  await endEmployment(admin(), {
    staffId: person.id,
    leftOn: '2026-08-31',
    reason: 'end of a fixed-term contract',
  })

  const [after] = await withTenant(inst, (tx) =>
    tx.select().from(staff).where(eq(staff.id, person.id)),
  )
  assert.equal(after!.leftOn, '2026-08-31')
  assert.equal((await listSeparations(admin())).length, 0)
})

// --- the exit interview ----------------------------------------------------

test('the exit interview is a later conversation, recorded once', async () => {
  const person = await hire()
  await separate(admin(), {
    staffId: person.id,
    kind: 'resignation',
    lastDayOn: '2026-08-31',
    reason: 'resigned to join another university',
  })

  assert.equal((await exitInterviewsOutstanding(admin())).length, 1)

  const row = await recordExitInterview(admin(), {
    staffId: person.id,
    on: '2026-08-30',
    notes: 'Left for a post closer to family. No complaints about the department.',
    rehireEligible: true,
  })
  assert.equal(row.rehireEligible, true)
  assert.equal(row.exitInterviewOn, '2026-08-30')

  assert.equal((await exitInterviewsOutstanding(admin())).length, 0)
  await assert.rejects(
    () =>
      recordExitInterview(admin(), {
        staffId: person.id,
        on: '2026-09-01',
        notes: 'A second version of the same conversation',
      }),
    (e: unknown) => code(e) === 'already_interviewed',
  )
})

test('asked and undecided is a different answer from never asked', async () => {
  const person = await hire()
  await separate(admin(), {
    staffId: person.id,
    kind: 'resignation',
    lastDayOn: '2026-08-31',
    reason: 'resigned to join another university',
  })

  const before = await listSeparations(admin())
  assert.equal(before[0]!.interviewPending, true)
  assert.equal(before[0]!.rehireEligible, null)

  await recordExitInterview(admin(), {
    staffId: person.id,
    on: '2026-08-30',
    notes: 'Spoke to them. Rehire is a decision for the head of department.',
  })

  const rows = await listSeparations(admin())
  assert.equal(rows[0]!.interviewPending, false)
  assert.equal(rows[0]!.rehireEligible, null, 'asked, and not decided')
})

test('nobody is exit-interviewed before they have left', async () => {
  const person = await hire()
  await assert.rejects(
    () =>
      recordExitInterview(admin(), {
        staffId: person.id,
        on: '2026-08-30',
        notes: 'An interview about an employment that has not ended',
      }),
    (e: unknown) => code(e) === 'no_such_separation',
  )
})

test('a death is not on anybody’s list of interviews to hold', async () => {
  const person = await hire()
  await separate(admin(), {
    staffId: person.id,
    kind: 'death',
    lastDayOn: '2026-08-31',
    reason: 'died in service; pension office informed',
  })
  assert.equal((await exitInterviewsOutstanding(admin())).length, 0)
  assert.equal((await listSeparations(admin())).length, 1)
})

// --- service ---------------------------------------------------------------

test('service is counted to today, or to the day they left', async () => {
  const person = await hire({ joinedOn: '2020-01-01' })
  const open = await serviceDays(admin(), person.id, '2026-01-01')
  assert.equal(open.days, 2192) // six years, two of them leap

  await separate(admin(), {
    staffId: person.id,
    kind: 'retirement',
    lastDayOn: '2023-01-01',
    reason: 'retired on reaching the age of superannuation',
  })
  const closed = await serviceDays(admin(), person.id, '2026-01-01')
  assert.equal(closed.to, '2023-01-01')
  assert.equal(closed.days, 1096)
})

// --- tenancy ---------------------------------------------------------------

test('a separation at one college is invisible at another', async () => {
  const person = await hire()
  await separate(admin(), {
    staffId: person.id,
    kind: 'resignation',
    lastDayOn: '2026-08-31',
    reason: 'resigned to join another university',
  })

  assert.equal((await listSeparations(admin())).length, 1)
  assert.equal((await listSeparations(outsider())).length, 0)
  assert.equal((await listChanges(outsider())).length, 0)
  assert.equal(await onboardingFor(outsider(), person.id), null)
})
