import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { eq, like } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import {
  addLevel,
  assess,
  coverage,
  createFramework,
  createSkill,
  levelChoices,
  profile,
  retireSkill,
  selfAssess,
  SkillError,
  type Actor,
} from './api'
import { assessments, levels } from './schema'
import { manifest } from './manifest'

/**
 * Phase I: a skill level is recorded and viewed on its own, apart from any
 * course grade -- by the student, by a teacher with evidence, as a history
 * nobody rewrites.
 */

const SLUG = 'skill-test-'
let n = 0

interface Campus {
  id: string
  admin: Actor
  teacher: Actor
  asha: Actor
  bilal: Actor
  frameworkId: string
  sql: string
  comm: string
}

async function campus(): Promise<Campus> {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Skills College', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const id = i!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Office' },
      { email: `t@${tag}.test`, institutionId: id, role: 'faculty', name: 'Dr Rao' },
      { email: `asha@${tag}.test`, institutionId: id, role: 'student', name: 'Asha' },
      { email: `bilal@${tag}.test`, institutionId: id, role: 'student', name: 'Bilal' },
    ])
    .returning({ id: users.id })
  const [adm, t, asha, bilal] = people.map((p) => p.id) as [string, string, string, string]
  const admin: Actor = { id: adm, email: `adm@${tag}.test`, role: 'institution_admin', institutionId: id }
  const f = await createFramework(admin, {
    name: 'Employability',
    levels: 'Beginner: needs guidance on routine tasks\nPractitioner: works unaided on routine tasks\nProficient: handles unfamiliar problems\nExpert: guides others',
  })
  const sql = await createSkill(admin, { frameworkId: f.id, code: 'sql-query', name: 'Writing SQL queries', category: 'Technical' })
  const comm = await createSkill(admin, { frameworkId: f.id, code: 'COMM-WRITTEN', name: 'Written communication', category: 'Communication' })
  return {
    id,
    admin,
    teacher: { id: t, role: 'faculty', institutionId: id },
    asha: { id: asha, role: 'student', institutionId: id },
    bilal: { id: bilal, role: 'student', institutionId: id },
    frameworkId: f.id,
    sql: sql.id,
    comm: comm.id,
  }
}

const code = (e: unknown) => (e as SkillError).code
const refusedBy = (constraint: string) => (e: unknown) =>
  String((e as { cause?: { constraint?: string } }).cause?.constraint) === constraint

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

test('an institution writes its own scale; nothing is supplied', async () => {
  const c = await campus()
  assert.deepEqual(
    (await levelChoices(c.admin)).map((l) => l.label),
    ['1. Beginner', '2. Practitioner', '3. Proficient', '4. Expert'],
  )
  await assert.rejects(
    createFramework(c.admin, { name: 'One level', levels: 'Only: a single level is not a scale' }),
    /too_small|at least|>=2/i,
  )
  await assert.rejects(createFramework(c.teacher, { name: 'Mine', levels: 'a: aaaaa\nb: bbbbb' }), (e) => code(e) === 'forbidden')
  await assert.rejects(
    createFramework(c.admin, { name: 'Employability', levels: 'a: aaaaa\nb: bbbbb' }),
    (e) => code(e) === 'skill_frameworks_name',
  )
})

test('a skill level is recorded by a teacher with evidence, and by the student, side by side', async () => {
  const c = await campus()
  await selfAssess(c.asha, { skillId: c.sql, rank: 4, evidence: 'I use joins every day' })
  await assess(c.teacher, {
    studentId: c.asha.id,
    skillId: c.sql,
    rank: 2,
    evidence: 'Lab 4: correct joins, but needed help with GROUP BY',
    assessedOn: '2026-09-01',
  })
  const p = await profile(c.asha, c.asha.id)
  const row = p.skills.find((s) => s.skillId === c.sql)!
  assert.equal(row.self, 'Expert')
  assert.equal(row.teacher, 'Practitioner')
  assert.equal(row.teacherBy, 'Dr Rao')
  assert.equal(row.gap, -2, 'the student rates themselves two levels above the teacher')
  assert.equal(p.history.length, 2)

  // A later judgement supersedes; the earlier one stays in the history.
  await assess(c.teacher, { studentId: c.asha.id, skillId: c.sql, rank: 3, evidence: 'Project: wrote the reporting queries alone' })
  const q = await profile(c.teacher, c.asha.id)
  assert.equal(q.skills.find((s) => s.skillId === c.sql)!.teacher, 'Proficient')
  assert.equal(q.history.length, 3)
})

test('who may judge whom', async () => {
  const c = await campus()
  await assert.rejects(
    assess(c.teacher, { studentId: c.asha.id, skillId: c.sql, rank: 2, evidence: 'short' }),
    /evidence|too_small|>=10/i,
  )
  await assert.rejects(
    assess(c.asha, { studentId: c.bilal.id, skillId: c.sql, rank: 1, evidence: 'Bilal cannot write SQL at all' }),
    (e) => code(e) === 'forbidden',
  )
  await assert.rejects(selfAssess(c.teacher, { skillId: c.sql, rank: 1 }), (e) => code(e) === 'forbidden')
  await assert.rejects(
    assess(c.teacher, { studentId: c.teacher.id, skillId: c.sql, rank: 4, evidence: 'I am very good at SQL' }),
    (e) => code(e) === 'no_such_student',
  )
  // A student sees their own profile, not a classmate's.
  await assert.rejects(profile(c.asha, c.bilal.id), (e) => code(e) === 'forbidden')

  // Past the module: the database holds the same line.
  await assert.rejects(
    withTenant(c.id, (tx) =>
      tx.insert(assessments).values({ institutionId: c.id, studentId: c.bilal.id, skillId: c.sql, rank: 4, source: 'self', assessorId: c.asha.id }),
    ),
    refusedBy('skill_assessment_self'),
  )
  await assert.rejects(
    withTenant(c.id, (tx) =>
      tx.insert(assessments).values({
        institutionId: c.id,
        studentId: c.bilal.id,
        skillId: c.sql,
        rank: 4,
        source: 'faculty',
        assessorId: c.asha.id,
        evidence: 'a classmate posing as a teacher',
      }),
    ),
    refusedBy('skill_assessment_assessor'),
  )
})

test('a level off the scale, a retired skill, or a date in the future is refused', async () => {
  const c = await campus()
  await assert.rejects(selfAssess(c.asha, { skillId: c.sql, rank: 7 }), (e) => code(e) === 'skill_assessment_level')
  await assert.rejects(
    assess(c.teacher, { studentId: c.asha.id, skillId: c.sql, rank: 2, evidence: 'Seen in the lab next week', assessedOn: '2099-01-01' }),
    (e) => code(e) === 'skill_assessment_date',
  )
  await selfAssess(c.asha, { skillId: c.comm, rank: 2 })
  await retireSkill(c.admin, { skillIds: [c.comm] })
  await assert.rejects(selfAssess(c.asha, { skillId: c.comm, rank: 3 }), (e) => code(e) === 'skill_assessment_retired')
  // Its history is still shown.
  const p = await profile(c.asha, c.asha.id)
  assert.equal(p.skills.find((s) => s.skillId === c.comm)?.retired, true)
})

test('a judgement is never changed or deleted, and a used level never rewritten', async () => {
  const c = await campus()
  const a = await assess(c.teacher, { studentId: c.asha.id, skillId: c.sql, rank: 2, evidence: 'Lab 4: joins, with help' })
  await assert.rejects(
    withTenant(c.id, (tx) => tx.update(assessments).set({ rank: 4 }).where(eq(assessments.id, a.id))),
    refusedBy('skill_assessment_final'),
  )
  await assert.rejects(
    withTenant(c.id, (tx) => tx.delete(assessments).where(eq(assessments.id, a.id))),
    refusedBy('skill_assessment_kept'),
  )
  await assert.rejects(
    withTenant(c.id, (tx) =>
      tx.update(levels).set({ descriptor: 'something easier than it was' }).where(eq(levels.rank, 2)),
    ),
    refusedBy('skill_level_in_use'),
  )
  // Unused levels may still be reworded; new ones go on top.
  await withTenant(c.id, (tx) => tx.update(levels).set({ descriptor: 'leads a team through unfamiliar work' }).where(eq(levels.rank, 4)))
  const top = await addLevel(c.admin, { frameworkId: c.frameworkId, name: 'Master', descriptor: 'sets practice for the field' })
  assert.equal(top.rank, 5)
})

test('coverage counts each student’s latest judgement from each side', async () => {
  const c = await campus()
  await assess(c.teacher, { studentId: c.asha.id, skillId: c.sql, rank: 1, evidence: 'Week 1: could not write a join' })
  await assess(c.teacher, { studentId: c.asha.id, skillId: c.sql, rank: 3, evidence: 'Week 9: wrote the reporting queries' })
  await assess(c.teacher, { studentId: c.bilal.id, skillId: c.sql, rank: 2, evidence: 'Week 9: joins, with some help' })
  await selfAssess(c.asha, { skillId: c.sql, rank: 4 })
  await selfAssess(c.bilal, { skillId: c.sql, rank: 3 })
  const row = (await coverage(c.teacher)).find((r) => r.code === 'SQL-QUERY')!
  assert.equal(row.judged, 2)
  assert.equal(row.teacherAvg, 2.5)
  assert.equal(row.selfAvg, 3.5)
})

test('skills stand alone: no dependency, and nothing that reads or writes a grade', () => {
  assert.deepEqual(manifest.dependsOn, [])
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f)
      if (f === 'node_modules') return []
      return statSync(p).isDirectory() ? walk(p) : [p]
    })
  const source = walk(import.meta.dirname)
    .filter((f) => /\.(ts|sql)$/.test(f) && !f.endsWith('.test.ts'))
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n')
  // The framework is the contract every module is written against; any other
  // module's package, or its tables, would be a dependency by the back door.
  for (const other of [/@campusos\/module-(?!framework)/, /exam_marks/, /course_completions/, /academic_/]) {
    assert.ok(!other.test(source), `skills reaches into ${other}`)
  }
})
