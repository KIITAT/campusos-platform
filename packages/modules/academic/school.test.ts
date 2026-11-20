import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { and, desc, eq, like } from 'drizzle-orm'
import { auditLog, authDb, institutions, users, withTenant } from '@campusos/db'
import { createDepartment, createProgram, setStudentProfile, studentProfile, type Actor } from './api'

/**
 * A school on the academic core (P1-13a): a class is a programme of level
 * `school`, and a student's house is kept on their profile.
 */

const SLUG = 'acad-school-'
let n = 0

async function campus() {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'School', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const id = i!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Office' },
      { email: `a@${tag}.test`, institutionId: id, role: 'student', name: 'Asha' },
    ])
    .returning({ id: users.id })
  const [adm, asha] = people.map((p) => p.id) as [string, string]
  return {
    id,
    admin: { id: adm, role: 'institution_admin', institutionId: id } as Actor,
    asha: { id: asha, role: 'student', institutionId: id } as Actor,
  }
}

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

test('a school class is a programme of level school', async () => {
  const c = await campus()
  const d = await createDepartment(c.admin, { code: 'pri', name: 'Primary' })
  const p = await createProgram(c.admin, { departmentId: d.id, code: 'class-6', name: 'Class 6', level: 'school', durationTerms: 2 })
  assert.equal(p.level, 'school')
})

test('a student’s house is kept on the profile and its change is on the record', async () => {
  const c = await campus()
  await setStudentProfile(c.admin, { studentId: c.asha.id, house: 'Tagore' })
  assert.equal((await studentProfile(c.asha, c.asha.id)).house, 'Tagore')
  const [latest] = await withTenant(c.id, (tx) =>
    tx
      .select({ reason: auditLog.reason })
      .from(auditLog)
      .where(and(eq(auditLog.entity, 'academic_student_profiles'), eq(auditLog.entityId, c.asha.id)))
      .orderBy(desc(auditLog.at))
      .limit(1),
  )
  assert.match(latest!.reason, /house/)

  await setStudentProfile(c.admin, { studentId: c.asha.id, rollNo: '7' })
  assert.equal((await studentProfile(c.asha, c.asha.id)).house, 'Tagore', 'a field left out is kept')

  await setStudentProfile(c.admin, { studentId: c.asha.id, house: '' })
  assert.equal((await studentProfile(c.asha, c.asha.id)).house, null)
})

test('a house name is at most 40 characters', async () => {
  const c = await campus()
  await assert.rejects(
    setStudentProfile(c.admin, { studentId: c.asha.id, house: 'x'.repeat(41) }),
    (e) => (e as Error).name === 'ZodError',
  )
})
