import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { and, eq, like, sql } from 'drizzle-orm'
import { auditLog, authDb, institutions, users, withTenant } from '@campusos/db'
import * as academic from '@campusos/module-academic/api'
import {
  ExamError,
  createExam,
  enterMarks,
  finaliseCourse,
  officialTranscript,
  publishExam,
  reviseMark,
  unpublishExam,
  type Actor,
} from './api'
import { examMarks } from './schema'

/**
 * AUD-05 and the re-evaluation workflow (P1-07c): a published mark moves only
 * by one person proposing and a different administrator approving, the draft
 * history is kept, and an official output waits for the course to be
 * finalised again.
 *
 * One institution for the file; every test makes its own exams (and, where it
 * finalises, its own offering) so no test depends on another's leftovers.
 */

const SLUG = 'marks-int'
let inst: string
let other: string
const ids = {
  fac: '',
  fac2: '',
  adm: '',
  adm2: '',
  s1: '',
  s2: '',
  dept: '',
  term: '',
  section: '',
  offering: '',
  otherOffering: '',
  otherStudent: '',
  otherAdmin: '',
}
let n = 0

const A = (id: string, role: Actor['role'], email: string, institutionId = inst): Actor => ({
  id,
  email,
  role,
  institutionId,
})
const fac = () => A(ids.fac, 'faculty', 'fac@marks-int.test')
const fac2 = () => A(ids.fac2, 'faculty', 'fac2@marks-int.test')
const adm = () => A(ids.adm, 'institution_admin', 'adm@marks-int.test')
const adm2 = () => A(ids.adm2, 'institution_admin', 'adm2@marks-int.test')
const stu = (id: string) => A(id, 'student', 'student@marks-int.test')
const code = (e: unknown) => (e as ExamError).code
const cause = (e: unknown) => String((e as Error).cause ?? e)

before(async () => {
  const mk = async (slug: string) =>
    (
      await authDb
        .insert(institutions)
        .values({ slug, name: `College ${slug}`, allowedEmailDomains: [`${slug}.test`] })
        .returning({ id: institutions.id })
    )[0]!.id
  inst = await mk(SLUG)
  other = await mk(`${SLUG}-other`)
  const people = await authDb
    .insert(users)
    .values([
      { email: 'fac@marks-int.test', institutionId: inst, role: 'faculty', name: 'Fac' },
      { email: 'fac2@marks-int.test', institutionId: inst, role: 'faculty', name: 'Fac Two' },
      { email: 'adm@marks-int.test', institutionId: inst, role: 'institution_admin', name: 'Adm' },
      { email: 'adm2@marks-int.test', institutionId: inst, role: 'institution_admin', name: 'Adm Two' },
      { email: 's1@marks-int.test', institutionId: inst, role: 'student', name: 'One Student' },
      { email: 's2@marks-int.test', institutionId: inst, role: 'student', name: 'Two Student' },
      { email: 'os@marks-int-other.test', institutionId: other, role: 'student', name: 'Other Student' },
      { email: 'oa@marks-int-other.test', institutionId: other, role: 'institution_admin', name: 'Other Admin' },
    ])
    .returning({ id: users.id })
  ;[ids.fac, ids.fac2, ids.adm, ids.adm2, ids.s1, ids.s2, ids.otherStudent, ids.otherAdmin] = people.map((p) => p.id) as [
    string, string, string, string, string, string, string, string,
  ]

  const st = adm()
  const dept = await academic.createDepartment(st, { code: 'cse', name: 'CSE' })
  const prog = await academic.createProgram(st, {
    departmentId: dept.id,
    code: 'btech',
    name: 'BTech',
    level: 'undergraduate',
    durationTerms: 8,
  })
  const term = await academic.createTerm(st, {
    code: 't1',
    name: 'Sem 1',
    startsOn: '2026-01-05',
    endsOn: '2026-05-30',
  })
  const section = await academic.createSection(st, { programId: prog.id, label: 'a', admissionYear: 2026 })
  for (const s of [ids.s1, ids.s2]) await academic.addSectionMember(st, { sectionId: section.id, userId: s })
  ids.dept = dept.id
  ids.term = term.id
  ids.section = section.id
  ids.offering = (await newOffering(fac())).id
  // An offering taught by someone else, to prove a lecturer cannot reach it.
  ids.otherOffering = (await newOffering(fac2())).id
})

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

async function newOffering(teacher: Actor) {
  const course = await academic.createCourse(adm(), {
    departmentId: ids.dept,
    code: `mi${++n}`,
    title: `Course ${n}`,
    credits: 4,
  })
  return academic.createOffering(adm(), {
    termId: ids.term,
    courseId: course.id,
    sectionId: ids.section,
    facultyUserId: teacher.id,
  })
}

/** A small exam on the shared offering: weight 1 so any number of them fit. */
const mkExam = (over: Record<string, unknown> = {}) =>
  createExam(fac(), {
    offeringId: ids.offering,
    name: `Exam ${++n}`,
    kind: 'quiz',
    maxMarks: 50,
    weightPercent: 1,
    ...over,
  })

const markOf = async (examId: string, studentId: string) =>
  (
    await withTenant(inst, (tx) =>
      tx
        .select()
        .from(examMarks)
        .where(and(eq(examMarks.examId, examId), eq(examMarks.studentId, studentId))),
    )
  )[0]!

/** One exam worth a whole course on its own offering, marked and published. */
async function wholeCourse(marks: { studentId: string; obtained: number }[]) {
  const off = await newOffering(fac())
  const exam = await createExam(fac(), {
    offeringId: off.id,
    name: 'Final',
    kind: 'final',
    maxMarks: 100,
    weightPercent: 100,
  })
  await enterMarks(fac(), { examId: exam.id, marks })
  await publishExam(fac(), { examId: exam.id })
  return { off, exam }
}

/**
 * The correction the way the code of the day does it. Step 4 replaces this body
 * with a proposal and an approval by a second administrator.
 */
async function correct(examId: string, studentId: string, obtained: number) {
  await reviseMark(fac(), { examId, studentId, obtained, reason: 'recount found a missed answer sheet page' })
}

// --- the single-actor loophole ---------------------------------------------

test('revision requires separate approval', async () => {
  const e = await mkExam()
  await enterMarks(fac(), { examId: e.id, marks: [{ studentId: ids.s1, obtained: 15 }] })
  await publishExam(fac(), { examId: e.id })

  await reviseMark(fac(), {
    examId: e.id,
    studentId: ids.s1,
    obtained: 25,
    reason: 'a lecturer alone proposes this change',
  }).catch(() => undefined)

  const row = await markOf(e.id, ids.s1)
  assert.equal(Number(row.obtained), 15, 'a proposal must not move the score')
  assert.equal(row.revision, 0)
})

test('hidden exam still protected', async () => {
  const e = await mkExam()
  await enterMarks(fac(), { examId: e.id, marks: [{ studentId: ids.s1, obtained: 15 }] })
  await publishExam(fac(), { examId: e.id })
  await unpublishExam(adm(), { examId: e.id, reason: 'withdrawing for a day to fix the cohort' })

  await assert.rejects(
    () => enterMarks(fac(), { examId: e.id, marks: [{ studentId: ids.s1, obtained: 45 }] }),
    (err: unknown) => code(err) === 'published',
  )
  assert.equal(Number((await markOf(e.id, ids.s1)).obtained), 15)
})

// --- draft history -----------------------------------------------------------

const historyOf = async (markId: string) =>
  (
    await withTenant(inst, (tx) =>
      tx.execute(
        sql`select event, before_mark, after_mark from exam_marks_history where mark_id = ${markId} order by at, id`,
      ),
    )
  ).rows as { event: string; before_mark: { obtained: number | null } | null; after_mark: { obtained: number | null } | null }[]

test('draft changes have distinct before/after', async () => {
  const e = await mkExam()
  await enterMarks(fac(), { examId: e.id, marks: [{ studentId: ids.s1, obtained: 15 }] })
  await enterMarks(fac(), { examId: e.id, marks: [{ studentId: ids.s1, obtained: 25 }] })
  const h = await historyOf((await markOf(e.id, ids.s1)).id)
  assert.deepEqual(
    h.map((r) => [r.event, r.before_mark?.obtained ?? null, r.after_mark?.obtained ?? null]),
    [
      ['insert', null, 15],
      ['update', 15, 25],
    ],
  )
})

// --- official outputs wait ----------------------------------------------------

test('affected official report waits', async () => {
  const { off, exam } = await wholeCourse([
    { studentId: ids.s1, obtained: 49 },
    { studentId: ids.s2, obtained: 80 },
  ])
  await finaliseCourse(adm(), { offeringId: off.id })
  await officialTranscript(adm(), ids.s1) // fine before the correction

  await correct(exam.id, ids.s1, 75)

  await assert.rejects(
    () => officialTranscript(adm(), ids.s1),
    (err: unknown) => code(err) === 'marks_recompute_required',
  )
  // The other student's record is unaffected.
  await officialTranscript(adm(), ids.s2)

  await finaliseCourse(adm(), { offeringId: off.id, reason: 'correcting after the approved revision' })
  const t = await officialTranscript(adm(), ids.s1)
  assert.equal(t.terms[0]!.grades[0]!.courseCode.startsWith('MI'), true)
})

// --- the database holds the line without the application ------------------------

interface Evidence {
  /** Request approved in the same transaction as the mark change. */
  sameTx: boolean
  requestScore: number
  markScore: number
  withAudit: boolean
}

/** Drives the guard with hand-built evidence, as a future code path or psql session might. */
async function rawRevision(markId: string, studentId: string, ev: Evidence) {
  const approve = (tx: Parameters<Parameters<typeof withTenant>[1]>[0]) =>
    tx
      .execute(
        sql`insert into exam_mark_requests (institution_id, mark_id, student_id, kind, status, maker_id, base_revision, proposed_score, proposed_absent)
            values (${inst}, ${markId}, ${studentId}, 'correction', 'proposed', ${ids.adm}, 0, ${ev.requestScore}, false) returning id`,
      )
      .then(async (r) => {
        const id = (r.rows[0] as { id: string }).id
        await tx.execute(
          sql`update exam_mark_requests set status = 'approved', checker_id = ${ids.adm2}, decided_at = now() where id = ${id}`,
        )
        return id
      })
  const write = async (tx: Parameters<Parameters<typeof withTenant>[1]>[0], requestId: string | null) => {
    await tx.execute(sql`select set_config('app.audit_reason', 'hand-built evidence for the test', true)`)
    if (requestId && ev.withAudit) {
      await tx.insert(auditLog).values({
        id: requestId,
        institutionId: inst,
        actorId: ids.adm2,
        actorEmail: 'adm2@marks-int.test',
        moduleId: 'examinations',
        action: 'mark.revised',
        entity: 'exam_marks',
        entityId: markId,
        reason: 'hand-built evidence for the test',
        detail: {
          requestId,
          studentId,
          revision: 1,
          from: { obtained: 15, absent: false, revision: 0 },
          to: { obtained: ev.markScore, absent: false, revision: 1 },
        },
      })
    }
    await tx.execute(
      sql`update exam_marks set obtained = ${ev.markScore}, revision = 1, entered_by = ${ids.adm2} where id = ${markId}`,
    )
  }
  if (ev.sameTx) {
    await withTenant(inst, async (tx) => write(tx, await approve(tx)))
  } else {
    const requestId = await withTenant(inst, async (tx) => {
      const id = await approve(tx)
      await tx.insert(auditLog).values({
        id,
        institutionId: inst,
        actorId: ids.adm2,
        actorEmail: 'adm2@marks-int.test',
        moduleId: 'examinations',
        action: 'mark.revised',
        entity: 'exam_marks',
        entityId: markId,
        reason: 'hand-built evidence for the test',
        detail: {
          requestId: id,
          studentId,
          revision: 1,
          from: { obtained: 15, absent: false, revision: 0 },
          to: { obtained: ev.markScore, absent: false, revision: 1 },
        },
      })
      return id
    })
    await withTenant(inst, (tx) => write(tx, requestId))
  }
}

async function publishedMark() {
  const e = await mkExam()
  await enterMarks(fac(), { examId: e.id, marks: [{ studentId: ids.s1, obtained: 15 }] })
  await publishExam(fac(), { examId: e.id })
  return (await markOf(e.id, ids.s1)).id
}

const refused = (err: unknown) => /approved audited revision|approved_revision/i.test(cause(err))

test('the database refuses a published change with no approval evidence', async () => {
  const id = await publishedMark()
  await assert.rejects(
    () =>
      withTenant(inst, async (tx) => {
        await tx.execute(sql`select set_config('app.audit_reason', 'a reason alone is not enough', true)`)
        await tx.execute(sql`update exam_marks set obtained = 30, revision = 1 where id = ${id}`)
      }),
    refused,
  )
})

test('the database refuses evidence that names a different score', async () => {
  const id = await publishedMark()
  await assert.rejects(
    () => rawRevision(id, ids.s1, { sameTx: true, requestScore: 25, markScore: 26, withAudit: true }),
    refused,
  )
})

test('the database refuses approval evidence without its audit row', async () => {
  const id = await publishedMark()
  await assert.rejects(
    () => rawRevision(id, ids.s1, { sameTx: true, requestScore: 25, markScore: 25, withAudit: false }),
    refused,
  )
})

test('the database refuses an approval from an earlier transaction', async () => {
  const id = await publishedMark()
  await assert.rejects(
    () => rawRevision(id, ids.s1, { sameTx: false, requestScore: 25, markScore: 25, withAudit: true }),
    refused,
  )
})

test('the database accepts complete evidence and flags the mark for re-finalisation', async () => {
  const id = await publishedMark()
  await rawRevision(id, ids.s1, { sameTx: true, requestScore: 25, markScore: 25, withAudit: true })
  const [row] = (
    await withTenant(inst, (tx) => tx.execute(sql`select obtained, revision, needs_recompute from exam_marks where id = ${id}`))
  ).rows as { obtained: string; revision: number; needs_recompute: boolean }[]
  assert.equal(Number(row!.obtained), 25)
  assert.equal(row!.revision, 1)
  assert.equal(row!.needs_recompute, true)
})
