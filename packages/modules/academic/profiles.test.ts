import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { and, eq, like } from 'drizzle-orm'
import { auditLog, authDb, institutions, users, withTenant } from '@campusos/db'
import { AcademicError, setStudentProfile, studentProfile, type Actor } from './api'

/**
 * A student's roll and registration numbers, phone and address: kept by the
 * office, read by the student, audited when they change.
 */

const SLUG = 'acad-profile-'
let n = 0

async function campus() {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Profile College', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const id = i!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Office' },
      { email: `t@${tag}.test`, institutionId: id, role: 'faculty', name: 'Dr Rao' },
      { email: `a@${tag}.test`, institutionId: id, role: 'student', name: 'Asha' },
      { email: `b@${tag}.test`, institutionId: id, role: 'student', name: 'Bilal' },
    ])
    .returning({ id: users.id })
  const [adm, t, asha, bilal] = people.map((p) => p.id) as [string, string, string, string]
  return {
    id,
    admin: { id: adm, role: 'institution_admin', institutionId: id } as Actor,
    teacher: { id: t, role: 'faculty', institutionId: id } as Actor,
    asha: { id: asha, role: 'student', institutionId: id } as Actor,
    bilal: { id: bilal, role: 'student', institutionId: id } as Actor,
  }
}

const code = (e: unknown) => (e as AcademicError).code

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

test('the office keeps it, the student reads their own, and every change is on the record', async () => {
  const c = await campus()
  const empty = await studentProfile(c.asha, c.asha.id)
  assert.equal(empty.rollNo, null)
  assert.equal(empty.address, null)

  const r = await setStudentProfile(c.admin, {
    studentId: c.asha.id,
    rollNo: '2515590',
    registrationNo: '25168011857',
    phone: '+91 98765 43210',
    addressLine: '12 Patia Road',
    city: 'Bhubaneswar',
    state: 'Odisha',
    postalCode: '751024',
  })
  assert.match(r.notice, /rollNo/)
  const p = await studentProfile(c.asha, c.asha.id)
  assert.equal(p.address, '12 Patia Road, Bhubaneswar, Odisha, 751024')
  assert.equal((await studentProfile(c.teacher, c.asha.id)).rollNo, '2515590')

  await assert.rejects(studentProfile(c.bilal, c.asha.id), (e) => code(e) === 'forbidden')
  await assert.rejects(setStudentProfile(c.asha, { studentId: c.asha.id, phone: '1234567' }), (e) => code(e) === 'forbidden')
  await assert.rejects(setStudentProfile(c.admin, { studentId: c.bilal.id, rollNo: '2515590' }), (e) => code(e) === 'academic_student_profiles_roll')
  await assert.rejects(setStudentProfile(c.admin, { studentId: c.teacher.id, rollNo: 'T1' }), (e) => code(e) === 'academic_student_profile_student')
  await assert.rejects(setStudentProfile(c.admin, { studentId: c.asha.id, phone: 'call me' }), /phone number/)

  await setStudentProfile(c.admin, { studentId: c.asha.id, phone: '+91 90000 00000' })
  const kept = await studentProfile(c.asha, c.asha.id)
  assert.equal(kept.rollNo, '2515590', 'a field left out is kept')
  assert.equal(kept.phone, '+91 90000 00000')
  const trail = await withTenant(c.id, (tx) =>
    tx.select().from(auditLog).where(and(eq(auditLog.entity, 'academic_student_profiles'), eq(auditLog.entityId, c.asha.id))),
  )
  assert.equal(trail.length, 2)
  assert.ok(trail.some((t) => /phone/.test(t.reason ?? '')))
})
