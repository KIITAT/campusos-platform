import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { and, eq, like, sql } from 'drizzle-orm'
import { auditLog, authDb, institutions, users, withTenant } from '@campusos/db'
import { AcademicError, recordStudentConsent, setStudentProfile, studentConsents, studentProfile, type Actor } from './api'
import { plugin } from './plugin'

/**
 * Date of birth, the APAAR ID and the choices recorded about them (AUD-04,
 * FUNC-09). The ID is stored as given: nothing here checks it with APAAR.
 */

const SLUG = 'acad-consent-'
let n = 0

/** A college with an office, a lecturer who is a student's class teacher, a minor, an adult and a parent for each. */
async function campus() {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Consent College', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const id = i!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Office' },
      { email: `t@${tag}.test`, institutionId: id, role: 'faculty', name: 'Dr Rao' },
      { email: `kid@${tag}.test`, institutionId: id, role: 'student', name: 'Kid' },
      { email: `grown@${tag}.test`, institutionId: id, role: 'student', name: 'Grown' },
      { email: `pk@${tag}.test`, institutionId: id, role: 'parent', name: 'Kid Parent' },
      { email: `pg@${tag}.test`, institutionId: id, role: 'parent', name: 'Grown Parent' },
    ])
    .returning({ id: users.id })
  const [adm, t, kid, grown, pk, pgr] = people.map((p) => p.id) as [string, string, string, string, string, string]
  await withTenant(id, async (tx) => {
    await tx.execute(sql`update users set date_of_birth = ((now() at time zone 'Asia/Kolkata')::date - interval '15 years')::date where id = ${kid}`)
    await tx.execute(sql`update users set date_of_birth = ((now() at time zone 'Asia/Kolkata')::date - interval '19 years')::date where id = ${grown}`)
    // The lecturer is the class teacher of both: a relation that lets them read a profile.
    const d = (await tx.execute(sql`insert into academic_departments (institution_id, code, name) values (${id}, 'D', 'D') returning id`)).rows[0]!.id
    const p = (await tx.execute(sql`insert into academic_programs (institution_id, department_id, code, name, level, duration_terms) values (${id}, ${d}, 'P', 'P', 'undergraduate', 8) returning id`)).rows[0]!.id
    const sec = (await tx.execute(sql`insert into academic_sections (institution_id, program_id, label, admission_year, class_teacher_id) values (${id}, ${p}, 'A', 2025, ${t}) returning id`)).rows[0]!.id
    for (const u of [kid, grown]) await tx.execute(sql`insert into academic_section_members (institution_id, section_id, user_id) values (${id}, ${sec}, ${u})`)
  })
  const actor = (uid: string, role: string, viewerOf?: string[]) => ({ id: uid, role, institutionId: id, ...(viewerOf ? { viewerOf } : {}) }) as Actor
  return {
    id,
    admin: actor(adm, 'institution_admin'),
    teacher: actor(t, 'faculty'),
    kid: actor(kid, 'student'),
    grown: actor(grown, 'student'),
    kidParent: actor(pk, 'parent', [kid]),
    grownParent: actor(pgr, 'parent', [grown]),
    strayParent: actor(pk, 'parent'),
  }
}

const code = (e: unknown) => (e as AcademicError).code
const APAAR = '123456789012'

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

test('the office records a date of birth, and a student cannot set their own', async () => {
  const c = await campus()
  await setStudentProfile(c.admin, { studentId: c.kid.id, dateOfBirth: '2010-05-01' })
  assert.equal((await studentProfile(c.admin, c.kid.id)).dateOfBirth, '2010-05-01')
  const trail = await withTenant(c.id, (tx) =>
    tx.select().from(auditLog).where(and(eq(auditLog.entity, 'academic_student_profiles'), eq(auditLog.entityId, c.kid.id))),
  )
  assert.ok(trail.some((t) => /dateOfBirth/.test(t.reason ?? '')))
  await assert.rejects(setStudentProfile(c.kid, { studentId: c.kid.id, dateOfBirth: '2009-01-01' }), (e) => code(e) === 'forbidden')
})

test('an APAAR ID needs consent, in the operation and in the database', async () => {
  const c = await campus()
  await assert.rejects(setStudentProfile(c.admin, { studentId: c.kid.id, apaarId: APAAR }), (e) => code(e) === 'apaar_needs_consent')
  await setStudentProfile(c.admin, { studentId: c.kid.id, phone: '+91 90000 00000' })
  await assert.rejects(
    withTenant(c.id, (tx) =>
      tx.execute(sql`update academic_student_profiles set apaar_id = ${APAAR} where student_id = ${c.kid.id}`),
    ),
    (e: Error) => /academic_apaar_needs_consent|record the parent/.test(`${e.message} ${(e.cause as Error | undefined)?.message ?? ''}`),
  )
})

test('a guardian gives APAAR consent for a minor, and refusing clears the ID', async () => {
  const c = await campus()
  await recordStudentConsent(c.kidParent, { studentId: c.kid.id, purpose: 'apaar', decision: 'given' })
  const [now] = (await studentConsents(c.kidParent, c.kid.id)).filter((x) => x.purpose === 'apaar')
  assert.deepEqual([now!.decision, now!.basis], ['given', 'guardian'])
  await setStudentProfile(c.admin, { studentId: c.kid.id, apaarId: APAAR })
  assert.equal((await studentProfile(c.admin, c.kid.id)).apaarId, APAAR)

  await recordStudentConsent(c.kidParent, { studentId: c.kid.id, purpose: 'apaar', decision: 'refused' })
  assert.equal((await studentProfile(c.admin, c.kid.id)).apaarId, null)
  await assert.rejects(setStudentProfile(c.admin, { studentId: c.kid.id, apaarId: APAAR }), (e) => code(e) === 'apaar_needs_consent')
})

test('an adult student decides for themselves; a minor and a parent of an adult cannot', async () => {
  const c = await campus()
  await recordStudentConsent(c.grown, { studentId: c.grown.id, purpose: 'apaar', decision: 'given' })
  const [now] = (await studentConsents(c.grown, c.grown.id)).filter((x) => x.purpose === 'apaar')
  assert.equal(now!.basis, 'student')
  await assert.rejects(
    recordStudentConsent(c.grownParent, { studentId: c.grown.id, purpose: 'apaar', decision: 'refused' }),
    (e) => code(e) === 'student_is_adult',
  )
  await assert.rejects(
    recordStudentConsent(c.kid, { studentId: c.kid.id, purpose: 'apaar', decision: 'given' }),
    (e) => code(e) === 'guardian_must_consent',
  )
})

test('the office records a paper form, with a note', async () => {
  const c = await campus()
  await assert.rejects(
    recordStudentConsent(c.admin, { studentId: c.kid.id, purpose: 'care_self_checks', decision: 'given' }),
    (e) => code(e) === 'note_required',
  )
  await recordStudentConsent(c.admin, { studentId: c.kid.id, purpose: 'care_self_checks', decision: 'given', note: 'form 12, 3 Nov' })
  const [now] = (await studentConsents(c.admin, c.kid.id)).filter((x) => x.purpose === 'care_self_checks')
  assert.equal(now!.basis, 'office_record')
})

test('others may not record', async () => {
  const c = await campus()
  await assert.rejects(
    recordStudentConsent(c.teacher, { studentId: c.kid.id, purpose: 'apaar', decision: 'given' }),
    (e) => code(e) === 'not_permitted_consent',
  )
  await assert.rejects(
    recordStudentConsent(c.strayParent, { studentId: c.kid.id, purpose: 'apaar', decision: 'given' }),
    (e) => code(e) === 'not_permitted_consent',
  )
})

test('the APAAR ID is shown to the student, a guardian and the office only', async () => {
  const c = await campus()
  await recordStudentConsent(c.kidParent, { studentId: c.kid.id, purpose: 'apaar', decision: 'given' })
  await setStudentProfile(c.admin, { studentId: c.kid.id, apaarId: APAAR })
  assert.equal((await studentProfile(c.teacher, c.kid.id)).apaarId, null)
  for (const who of [c.kid, c.kidParent, c.admin]) assert.equal((await studentProfile(who, c.kid.id)).apaarId, APAAR)
})

test('dates of birth are imported, and a rerun changes nothing', async () => {
  const c = await campus()
  const emailOf = async (id: string) => (await withTenant(c.id, (tx) => tx.select({ email: users.email }).from(users).where(eq(users.id, id))))[0]!.email
  const email = await emailOf(c.kid.id)
  const grownEmail = await emailOf(c.grown.id)
  const csv = `email,date_of_birth\n${email},2010-05-01\n${grownEmail},2005-02-03\n`
  const run = () =>
    plugin.routes
      .find((r) => r.path === '/imports/run')!
      .handler(c.admin as never, new Request('http://x/imports/run', { method: 'POST', body: JSON.stringify({ importId: 'student-dates-of-birth', csv, apply: true }) })) as Promise<{
      created: number
      skipped: number
    }>
  const first = await run()
  assert.deepEqual([first.created, first.skipped], [2, 0])
  const again = await run()
  assert.deepEqual([again.created, again.skipped], [0, 2])
})

/** Until `n` sessions are waiting on a lock in a statement that matches. */
async function waitingOn(pattern: string, n = 1) {
  const deadline = Date.now() + 10_000
  for (;;) {
    const r = await authDb.execute<{ n: number }>(sql`
      select count(*)::int as n from pg_stat_activity
       where wait_event_type = 'Lock' and query ilike ${pattern}`)
    if (r.rows[0]!.n >= n) return
    if (Date.now() > deadline) throw new Error(`nobody is waiting on ${pattern}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

test('a refusal cannot lose to a first save of the ID: both wait on the student, then one wins whole', async () => {
  const c = await campus()
  await recordStudentConsent(c.kidParent, { studentId: c.kid.id, purpose: 'apaar', decision: 'given' })
  // The student has no profile row yet, so locking the profile would lock nothing.
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  let holding!: () => void
  const locked = new Promise<void>((resolve) => (holding = resolve))
  const holder = authDb.transaction(async (tx) => {
    await tx.execute(sql`select 1 from users where id = ${c.kid.id} for no key update`)
    holding()
    await held
  })
  await locked
  const save = setStudentProfile(c.admin, { studentId: c.kid.id, apaarId: APAAR })
  const refuse = recordStudentConsent(c.kidParent, { studentId: c.kid.id, purpose: 'apaar', decision: 'refused' })
  try {
    await waitingOn('%"users"%no key update%', 2)
  } finally {
    release()
    await holder
  }
  await Promise.allSettled([save, refuse])
  // Whatever the order, the refusal stands and the ID does not.
  const [now] = (await studentConsents(c.kidParent, c.kid.id)).filter((x) => x.purpose === 'apaar')
  assert.equal(now!.decision, 'refused')
  assert.equal((await studentProfile(c.admin, c.kid.id)).apaarId, null)
})
