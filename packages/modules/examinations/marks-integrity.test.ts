import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { and, eq, like, sql } from 'drizzle-orm'
import { auditLog, authDb, institutions, users, withTenant } from '@campusos/db'
import * as academic from '@campusos/module-academic/api'
import {
  ExamError,
  createExam,
  decideMarkReview,
  enterMarks,
  finaliseCourse,
  lockOfferingMarks,
  officialTranscript,
  listMarkReviews,
  publishExam,
  reviewableMarks,
  requestMarkReview,
  reviseMark,
  unpublishExam,
  type Actor,
} from './api'
import { examMarks } from './schema'
import { pages } from './pages'
import { routes } from './routes'
import { routeRoles } from './route-roles'

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

/** A correction as the workflow has it: a lecturer proposes, an administrator approves. */
async function correct(examId: string, studentId: string, obtained: number, expectedRevision = 0) {
  const p = await reviseMark(fac(), {
    examId,
    studentId,
    obtained,
    expectedRevision,
    reason: 'recount found a missed answer sheet page',
  })
  await decideMarkReview(adm(), { requestId: p.requestId, decision: 'approve', reason: 'checked against the script' })
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
    expectedRevision: 0,
    reason: 'a lecturer alone proposes this change',
  })

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
  const write = async (tx: Parameters<Parameters<typeof withTenant>[1]>[0], requestId: string | null, writeAudit = true) => {
    await tx.execute(sql`select set_config('app.audit_reason', 'hand-built evidence for the test', true)`)
    if (requestId && ev.withAudit && writeAudit) {
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
    await withTenant(inst, (tx) => write(tx, requestId, false))
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

// --- history and request tables: tenancy and append-only -----------------------

test('history is visible to its own institution only', async () => {
  const e = await mkExam()
  await enterMarks(fac(), { examId: e.id, marks: [{ studentId: ids.s1, obtained: 15 }] })
  const id = (await markOf(e.id, ids.s1)).id
  const count = (tenant: string) =>
    withTenant(tenant, (tx) => tx.execute(sql`select count(*)::int as n from exam_marks_history where mark_id = ${id}`)).then(
      (r) => (r.rows[0] as { n: number }).n,
    )
  assert.equal(await count(inst), 1)
  assert.equal(await count(other), 0)
})

test('a review cannot be written against another institution’s mark', async () => {
  const e = await mkExam()
  await enterMarks(fac(), { examId: e.id, marks: [{ studentId: ids.s1, obtained: 15 }] })
  const id = (await markOf(e.id, ids.s1)).id
  await assert.rejects(
    () =>
      withTenant(other, (tx) =>
        tx.execute(
          sql`insert into exam_mark_requests (institution_id, mark_id, student_id, kind, status, base_revision)
              values (${other}, ${id}, ${ids.s1}, 'recheck', 'requested', 0)`,
        ),
      ),
    (err: unknown) => /ownership mismatch|violates/i.test(cause(err)),
  )
})

test('history cannot be edited or deleted, even by the application role', async () => {
  const e = await mkExam()
  await enterMarks(fac(), { examId: e.id, marks: [{ studentId: ids.s1, obtained: 15 }] })
  const id = (await markOf(e.id, ids.s1)).id
  for (const stmt of [
    sql`update exam_marks_history set event = 'update' where mark_id = ${id}`,
    sql`delete from exam_marks_history where mark_id = ${id}`,
    sql`insert into exam_marks_history (institution_id, mark_id, student_id, event) values (${inst}, ${id}, ${ids.s1}, 'insert')`,
  ]) {
    await assert.rejects(() => withTenant(inst, (tx) => tx.execute(stmt)), (err: unknown) => /append-only/i.test(cause(err)))
  }
})

test('a draft mark deleted by hand is recorded with its value', async () => {
  const e = await mkExam()
  await enterMarks(fac(), { examId: e.id, marks: [{ studentId: ids.s1, obtained: 15 }] })
  const id = (await markOf(e.id, ids.s1)).id
  await withTenant(inst, (tx) => tx.delete(examMarks).where(eq(examMarks.id, id)))
  const h = await historyOf(id)
  assert.deepEqual(h.map((r) => r.event), ['insert', 'delete'])
  assert.equal(h[1]!.before_mark?.obtained, 15)
})

// --- sticky publication and the offering lock ----------------------------------

test('first publication gives the whole cohort a pending mark; hiding flags them; marks stay locked', async () => {
  const e = await mkExam()
  await enterMarks(fac(), { examId: e.id, marks: [{ studentId: ids.s1, obtained: 15 }] })
  await publishExam(fac(), { examId: e.id })
  const s2 = await markOf(e.id, ids.s2)
  assert.equal(s2.obtained, null)
  assert.equal(s2.absent, false)
  assert.equal(s2.needsRecompute, false)

  await unpublishExam(adm(), { examId: e.id, reason: 'withdrawn while the cohort is checked' })
  assert.equal((await markOf(e.id, ids.s1)).needsRecompute, true)
  assert.equal((await markOf(e.id, ids.s2)).needsRecompute, true)

  await publishExam(fac(), { examId: e.id }) // republication needs no new rows
  await assert.rejects(
    () => enterMarks(fac(), { examId: e.id, marks: [{ studentId: ids.s2, obtained: 5 }] }),
    (err: unknown) => code(err) === 'published',
  )
})

test('marking requests queue behind the offering lock and run in the order they arrived', async () => {
  const e = await mkExam()
  const waiters = async () =>
    Number(
      (
        await withTenant(inst, (tx) =>
          tx.execute(
            sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted
                 and database = (select oid from pg_database where datname = current_database())`,
          ),
        )
      ).rows[0]!.n,
    )
  const until = async (n: number) => {
    for (let i = 0; i < 200 && (await waiters()) < n; i++) await new Promise((r) => setTimeout(r, 25))
    assert.equal(await waiters(), n, 'the requests are not queued on the lock')
  }
  let release!: () => void
  const held = new Promise<void>((r) => (release = r))
  let locked!: () => void
  const lockTaken = new Promise<void>((r) => (locked = r))
  const holder = withTenant(inst, async (tx) => {
    await lockOfferingMarks(tx, inst, ids.offering)
    locked()
    await held
  })
  await lockTaken

  const first = enterMarks(fac(), { examId: e.id, marks: [{ studentId: ids.s1, obtained: 10 }] })
  await until(1)
  const second = enterMarks(fac(), { examId: e.id, marks: [{ studentId: ids.s1, obtained: 20 }] })
  await until(2)
  release()
  await Promise.all([holder, first, second])
  assert.equal(Number((await markOf(e.id, ids.s1)).obtained), 20, 'the later request must win')
})

// --- the maker-checker workflow --------------------------------------------------

const published = async (marks: { studentId: string; obtained: number }[] = [{ studentId: ids.s1, obtained: 15 }]) => {
  const e = await mkExam()
  await enterMarks(fac(), { examId: e.id, marks })
  await publishExam(fac(), { examId: e.id })
  return e
}
const REASON = 'the sum of the parts was added up wrongly'
const randomId = () => '00000000-0000-4000-8000-000000000001'
const propose = (examId: string, studentId: string, over: Record<string, unknown> = {}, who: Actor = fac()) =>
  reviseMark(who, { examId, studentId, obtained: 25, expectedRevision: 0, reason: REASON, ...over })
const decide = (requestId: string, decision: 'approve' | 'reject', who: Actor = adm2()) =>
  decideMarkReview(who, { requestId, decision, reason: 'decided after reading the script' })

/** How many sessions are queued on an advisory lock in this database. */
const advisoryWaiters = async () =>
  Number(
    (
      await withTenant(inst, (tx) =>
        tx.execute(
          sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted
               and database = (select oid from pg_database where datname = current_database())`,
        ),
      )
    ).rows[0]!.n,
  )

test('a student asks for a review, staff propose, a different administrator approves', async () => {
  const e = await published()
  const m = await markOf(e.id, ids.s1)
  const asked = await requestMarkReview(stu(ids.s1), { markId: m.id, kind: 'recheck', reason: 'I think a page was missed' })
  assert.deepEqual([asked.status, asked.notice], ['requested', 'Review requested.'])

  const mine = await listMarkReviews(stu(ids.s1), {})
  const ownRows = mine.rows.filter((r) => r.markId === m.id)
  assert.equal(ownRows.length, 1)
  assert.equal(ownRows[0]!.staff, undefined, 'a student never sees the staff detail')
  assert.ok(mine.rows.every((r) => !('staff' in r)))

  const proposed = await propose(e.id, ids.s1, { requestId: asked.requestId })
  assert.equal(proposed.requestId, asked.requestId)
  assert.deepEqual([proposed.status, proposed.notice], ['proposed', 'Revision proposed.'])
  assert.equal(Number((await markOf(e.id, ids.s1)).obtained), 15, 'a proposal does not move the score')

  const staffView = await listMarkReviews(fac(), { examId: e.id })
  assert.deepEqual(staffView.rows.find((r) => r.markId === m.id)!.staff, {
    studentId: ids.s1,
    makerId: ids.fac,
    baseRevision: 0,
    proposedScore: 25,
    proposedAbsent: false,
  })

  const done = await decide(asked.requestId, 'approve')
  assert.deepEqual([done.status, done.notice], ['approved', 'Revision approved. Re-finalise the course.'])
  const after = await markOf(e.id, ids.s1)
  assert.deepEqual([Number(after.obtained), after.revision, after.needsRecompute, after.enteredBy], [25, 1, true, ids.adm2])

  const audit = await withTenant(inst, (tx) =>
    tx.select().from(auditLog).where(and(eq(auditLog.entity, 'exam_marks'), eq(auditLog.entityId, m.id))),
  )
  assert.deepEqual(
    audit.map((a) => a.action).sort(),
    ['mark.review_requested', 'mark.revised', 'mark.revision_proposed'],
  )
  const revised = audit.find((a) => a.action === 'mark.revised')!
  assert.equal(revised.id, asked.requestId)
  assert.deepEqual(revised.detail, {
    requestId: asked.requestId,
    studentId: ids.s1,
    revision: 1,
    from: { obtained: 15, absent: false, revision: 0 },
    to: { obtained: 25, absent: false, revision: 1 },
  })
})

test('only the student who owns a visible mark may ask for its review', async () => {
  const e = await published([
    { studentId: ids.s1, obtained: 15 },
    { studentId: ids.s2, obtained: 20 },
  ])
  const m1 = await markOf(e.id, ids.s1)
  const ask = (who: Actor) => requestMarkReview(who, { markId: m1.id, kind: 'recheck', reason: 'please look again at it' })
  await assert.rejects(() => ask(stu(ids.s2)), (err: unknown) => code(err) === 'no_such_mark')
  await assert.rejects(() => ask(fac()), (err: unknown) => code(err) === 'forbidden')
  await assert.rejects(() => ask(A(ids.otherStudent, 'student', 'os@x.test', other)), (err: unknown) => code(err) === 'no_such_mark')

  await unpublishExam(adm(), { examId: e.id, reason: 'hidden while the cohort is checked' })
  await assert.rejects(() => ask(stu(ids.s1)), (err: unknown) => code(err) === 'no_such_mark')
})

test('one open review per mark, and staff answer the open one by naming it', async () => {
  const e = await published()
  const m = await markOf(e.id, ids.s1)
  const asked = await requestMarkReview(stu(ids.s1), { markId: m.id, kind: 're_evaluation', reason: 'please re-evaluate it' })
  await assert.rejects(
    () => requestMarkReview(stu(ids.s1), { markId: m.id, kind: 'recheck', reason: 'asking a second time' }),
    (err: unknown) => code(err) === 'mark_request_open',
  )
  await assert.rejects(() => propose(e.id, ids.s1), (err: unknown) => code(err) === 'mark_request_open')
  await propose(e.id, ids.s1, { requestId: asked.requestId })
  await assert.rejects(
    () => propose(e.id, ids.s1, { requestId: asked.requestId, obtained: 30 }),
    (err: unknown) => code(err) === 'mark_request_open',
  )
})

test('the proposer cannot decide, a lecturer cannot decide, another offering’s lecturer cannot propose', async () => {
  const e = await published()
  const p = await propose(e.id, ids.s1, {}, adm())
  await assert.rejects(() => decide(p.requestId, 'approve', adm()), (err: unknown) => code(err) === 'mark_self_decision')
  await assert.rejects(() => decide(p.requestId, 'reject', adm()), (err: unknown) => code(err) === 'mark_self_decision')
  await assert.rejects(() => decide(p.requestId, 'approve', fac()), (err: unknown) => code(err) === 'forbidden')
  assert.equal(Number((await markOf(e.id, ids.s1)).obtained), 15)

  const e2 = await published()
  await assert.rejects(() => propose(e2.id, ids.s1, {}, fac2()), (err: unknown) => code(err) === 'not_your_offering')
  await decide(p.requestId, 'approve', adm2())
})

test('stale, unchanged and out-of-range proposals are refused', async () => {
  const e = await published()
  await assert.rejects(() => propose(e.id, ids.s1, { expectedRevision: 3 }), (err: unknown) => code(err) === 'mark_request_stale')
  await assert.rejects(() => propose(e.id, ids.s1, { obtained: 15 }), (err: unknown) => code(err) === 'mark_proposal_unchanged')
  await assert.rejects(() => propose(e.id, ids.s1, { obtained: 51 }), (err: unknown) => code(err) === 'above_max')
  await assert.rejects(() => propose(e.id, ids.s1, { obtained: 12.345 }))
  await assert.rejects(() => propose(e.id, ids.s1, { obtained: -1 }))
  await assert.rejects(() => propose(e.id, 'nobody'), (err: unknown) => code(err) === 'no_such_mark')
  // a draft exam has no published mark to revise
  const draft = await mkExam()
  await enterMarks(fac(), { examId: draft.id, marks: [{ studentId: ids.s1, obtained: 5 }] })
  await assert.rejects(() => propose(draft.id, ids.s1), (err: unknown) => code(err) === 'not_published')
})

test('a rejected review changes nothing, is closed, and a new one may follow', async () => {
  const e = await published()
  const m = await markOf(e.id, ids.s1)
  const asked = await requestMarkReview(stu(ids.s1), { markId: m.id, kind: 'recheck', reason: 'please look at it again' })
  const closedNow = await decide(asked.requestId, 'reject', adm())
  assert.deepEqual([closedNow.status, closedNow.notice], ['rejected', 'Review closed.'])
  await assert.rejects(() => decide(asked.requestId, 'approve'), (err: unknown) => code(err) === 'mark_request_closed')
  await assert.rejects(() => decide(randomId(), 'approve'), (err: unknown) => code(err) === 'no_such_mark_request')
  assert.equal(Number((await markOf(e.id, ids.s1)).obtained), 15)

  const again = await requestMarkReview(stu(ids.s1), { markId: m.id, kind: 'recheck', reason: 'a second, better argued request' })
  const p = await propose(e.id, ids.s1, { requestId: again.requestId })
  await decide(p.requestId, 'reject')
  assert.equal(Number((await markOf(e.id, ids.s1)).obtained), 15)
  // an administrator may close a request that was never proposed
  const third = await requestMarkReview(stu(ids.s1), { markId: m.id, kind: 'recheck', reason: 'a third request for the record' })
  await assert.rejects(() => decide(third.requestId, 'approve'), (err: unknown) => code(err) === 'mark_request_stale')
  assert.equal((await decide(third.requestId, 'reject', adm())).notice, 'Review closed.')
})

test('a pending mark can be reviewed and an absence can be proposed', async () => {
  const e = await published() // s2 holds a pending row created at publication
  const m2 = await markOf(e.id, ids.s2)
  const asked = await requestMarkReview(stu(ids.s2), { markId: m2.id, kind: 're_evaluation', reason: 'my result never appeared' })
  const p = await propose(e.id, ids.s2, { requestId: asked.requestId, obtained: 20 })
  await decide(p.requestId, 'approve')
  const row = await markOf(e.id, ids.s2)
  assert.deepEqual([Number(row.obtained), row.revision], [20, 1])
  assert.deepEqual(
    (await historyOf(m2.id)).map((h) => [h.event, h.before_mark?.obtained ?? null, h.after_mark?.obtained ?? null]),
    [
      ['insert', null, null],
      ['update', null, 20],
    ],
  )

  const second = await propose(e.id, ids.s2, { obtained: null, absent: true, expectedRevision: 1 })
  await decide(second.requestId, 'approve')
  const absent = await markOf(e.id, ids.s2)
  assert.deepEqual([absent.obtained, absent.absent, absent.revision], [null, true, 2])
})

test('two administrators approving at once produce one revision and one audit row', async () => {
  const e = await published()
  const p = await propose(e.id, ids.s1)
  let release!: () => void
  const held = new Promise<void>((r) => (release = r))
  let locked!: () => void
  const taken = new Promise<void>((r) => (locked = r))
  const holder = withTenant(inst, async (tx) => {
    await lockOfferingMarks(tx, inst, ids.offering)
    locked()
    await held
  })
  await taken
  const a = decide(p.requestId, 'approve', adm2()).then((v) => ({ ok: v }), (err: unknown) => ({ err }))
  const b = decide(p.requestId, 'approve', adm()).then((v) => ({ ok: v }), (err: unknown) => ({ err }))
  for (let i = 0; i < 200 && (await advisoryWaiters()) < 2; i++) await new Promise((r) => setTimeout(r, 25))
  assert.equal(await advisoryWaiters(), 2)
  release()
  await holder
  const out = await Promise.all([a, b])
  // A lecturer proposed, so both administrators may decide; exactly one wins.
  assert.equal(out.filter((o) => 'ok' in o).length, 1)
  const lost = out.find((o) => 'err' in o) as { err: unknown }
  assert.equal(code(lost.err), 'mark_request_closed')
  const row = await markOf(e.id, ids.s1)
  assert.equal(row.revision, 1)
  const revised = await withTenant(inst, (tx) =>
    tx.select().from(auditLog).where(and(eq(auditLog.entityId, row.id), eq(auditLog.action, 'mark.revised'))),
  )
  assert.equal(revised.length, 1)
})

// --- official output and finalisation -----------------------------------------------

test('transfer credit and an unrelated student never wait; unpublish and republish still wait for a re-finalise', async () => {
  const { off, exam } = await wholeCourse([
    { studentId: ids.s1, obtained: 49 },
    { studentId: ids.s2, obtained: 80 },
  ])
  const abroad = await academic.createCourse(adm(), { departmentId: ids.dept, code: `tr${++n}`, title: 'Accepted elsewhere', credits: 3 })
  await academic.recordCompletion(adm(), { studentId: ids.s1, courseId: abroad.id, gradeLabel: 'P', gradePoints: 5, passed: true, source: 'transfer' })
  await finaliseCourse(adm(), { offeringId: off.id })
  await officialTranscript(adm(), ids.s1)

  // Hide and republish with no change: the course must be finalised again before official output.
  await unpublishExam(adm(), { examId: exam.id, reason: 'withdrawn to fix the cohort list' })
  await assert.rejects(
    () => finaliseCourse(adm(), { offeringId: off.id }),
    (err: unknown) => code(err) === 'marks_recompute_required',
  )
  await assert.rejects(() => officialTranscript(adm(), ids.s2), (err: unknown) => code(err) === 'marks_recompute_required')
  await publishExam(fac(), { examId: exam.id })
  await assert.rejects(() => officialTranscript(adm(), ids.s2), (err: unknown) => code(err) === 'marks_recompute_required')
  await finaliseCourse(adm(), { offeringId: off.id, reason: 'republished, finalising again' })
  await officialTranscript(adm(), ids.s2)
  const flags = await withTenant(inst, (tx) =>
    tx.execute(sql`select count(*)::int as n from exam_marks where exam_id = ${exam.id} and needs_recompute`),
  )
  assert.equal((flags.rows[0] as { n: number }).n, 0)
})

test('an incomplete student keeps the flag and the last completion; a finalise racing an approval lands consistently', async () => {
  const { off, exam } = await wholeCourse([
    { studentId: ids.s1, obtained: 60 },
    { studentId: ids.s2, obtained: 70 },
  ])
  await finaliseCourse(adm(), { offeringId: off.id })
  const p = await reviseMark(fac(), { examId: exam.id, studentId: ids.s1, obtained: 90, expectedRevision: 0, reason: 'recount after a missed page' })

  // Hold the lock, queue a finalise first and the approval second.
  let release!: () => void
  const held = new Promise<void>((r) => (release = r))
  let locked!: () => void
  const taken = new Promise<void>((r) => (locked = r))
  const holder = withTenant(inst, async (tx) => {
    await lockOfferingMarks(tx, inst, off.id)
    locked()
    await held
  })
  await taken
  const wait = async (n: number) => {
    for (let i = 0; i < 200 && (await advisoryWaiters()) < n; i++) await new Promise((r) => setTimeout(r, 25))
    assert.equal(await advisoryWaiters(), n)
  }
  const fin = finaliseCourse(adm(), { offeringId: off.id, reason: 'finalising before the decision' })
  await wait(1)
  const dec = decideMarkReview(adm2(), { requestId: p.requestId, decision: 'approve', reason: 'checked against the script' })
  await wait(2)
  release()
  await Promise.all([holder, fin, dec])

  // The finalise ran first (unchanged), the approval second: the mark is flagged and the outputs wait.
  const row = await markOf(exam.id, ids.s1)
  assert.deepEqual([Number(row.obtained), row.needsRecompute], [90, true])
  await assert.rejects(() => officialTranscript(adm(), ids.s1), (err: unknown) => code(err) === 'marks_recompute_required')
})

// --- routes and portal ----------------------------------------------------------------

test('the review routes are declared with the roles the decisions name', () => {
  const declared = routes.map((r) => `${r.method} ${r.path}`)
  for (const key of ['POST /marks/revise', 'POST /marks/recheck', 'POST /marks/decide', 'GET /marks/requests']) {
    assert.ok(declared.includes(key), `${key} is not routed`)
    assert.ok(key in routeRoles, `${key} has no role entry`)
  }
  assert.deepEqual(routeRoles['POST /marks/recheck'], ['student'])
  assert.deepEqual([...routeRoles['POST /marks/decide']!].sort(), ['institution_admin', 'super_admin'])
  assert.ok(routeRoles['GET /marks/requests']!.includes('student'))
  assert.ok(!routeRoles['POST /marks/decide']!.includes('faculty'))
})

test('the review list is scoped: staff must pick an exam they may mark; a student sees only their own', async () => {
  const e = await published([
    { studentId: ids.s1, obtained: 15 },
    { studentId: ids.s2, obtained: 20 },
  ])
  const m1 = await markOf(e.id, ids.s1)
  await requestMarkReview(stu(ids.s1), { markId: m1.id, kind: 'recheck', reason: 'please look again at it' })
  await assert.rejects(() => listMarkReviews(fac(), {}), (err: unknown) => code(err) === 'exam_required')
  await assert.rejects(() => listMarkReviews(fac2(), { examId: e.id }), (err: unknown) => code(err) === 'not_your_offering')
  assert.equal((await listMarkReviews(stu(ids.s2), {})).rows.filter((r) => r.markId === m1.id).length, 0)
  assert.equal((await listMarkReviews(fac(), { examId: e.id })).rows.length, 1)
  // another institution's administrator cannot see it
  await assert.rejects(
    () => listMarkReviews(A(ids.otherAdmin, 'institution_admin', 'oa@x.test', other), { examId: e.id }),
    (err: unknown) => code(err) === 'no_such_exam',
  )
})

test('the student page offers the visible marks and the form; the exam page shows the reviews and an admin-only decision form', async () => {
  const e = await published([{ studentId: ids.s1, obtained: 15 }])
  const m1 = await markOf(e.id, ids.s1)
  const hidden = await published([{ studentId: ids.s1, obtained: 11 }])
  await unpublishExam(adm(), { examId: hidden.id, reason: 'hidden while the cohort is checked' })
  const hiddenMark = await markOf(hidden.id, ids.s1)
  const asked = await requestMarkReview(stu(ids.s1), { markId: m1.id, kind: 'recheck', reason: 'please look again at it' })

  const mine = pages.find((p) => p.path === '/me')!
  const data = (await mine.load(stu(ids.s1) as never, new Request('http://x/m/examinations/me'))) as Record<string, unknown>
  const options = data.markOptions as { value: string }[]
  assert.ok(options.some((o) => o.value === m1.id), 'a visible mark is offered')
  assert.ok(!options.some((o) => o.value === hiddenMark.id), 'a hidden mark is not')
  const forms = (mine.sections(data) as { kind: string; path?: string }[]).filter((s) => s.kind === 'form')
  assert.deepEqual(forms.map((f) => f.path), ['/marks/recheck'])
  assert.ok((data.myReviews as { requestId: string; staff?: unknown }[]).every((r) => !('staff' in r) || r.staff === undefined))

  const staffPage = pages.find((p) => p.path === '/')!
  const sdata = (await staffPage.load(
    fac() as never,
    new Request(`http://x/m/examinations?offeringId=${ids.offering}&examId=${e.id}`),
  )) as Record<string, unknown>
  assert.ok((sdata.reviews as { requestId: string }[]).some((r) => r.requestId === asked.requestId))
  const sections = staffPage.sections(sdata) as { kind: string; title?: string; path?: string; roles?: string[] }[]
  const decide = sections.find((s) => s.path === '/marks/decide')!
  assert.deepEqual([...decide.roles!].sort(), ['institution_admin', 'super_admin'])
  const proposal = sections.find((s) => s.path === '/marks/revise')!
  assert.equal(proposal.title, 'Propose revision')
  assert.ok(sections.some((s) => s.title === 'Mark reviews'))
})

// --- review fixes (P1-07c FIX) -----------------------------------------------

test('the application role cannot clear the re-finalise flag by hand', async () => {
  const id = await publishedMark()
  await rawRevision(id, ids.s1, { sameTx: true, requestScore: 25, markScore: 25, withAudit: true })
  await assert.rejects(
    () => withTenant(inst, (tx) => tx.execute(sql`update exam_marks set needs_recompute = false where id = ${id}`)),
    (err: unknown) => /re-finalis/i.test(cause(err)),
  )
})

test('a malformed paging cursor on the student marks list is a 400, not a 500', async () => {
  await assert.rejects(() => reviewableMarks(stu(ids.s1), 'x'), (err: unknown) => (err as ExamError).status === 400)
})

test('a lecturer who does not own the exam learns nothing about its marks', async () => {
  const e = await published()
  await assert.rejects(
    () => reviseMark(fac2(), { examId: e.id, studentId: randomUUID(), obtained: 5, expectedRevision: 0, reason: 'checking something' }),
    (err: unknown) => code(err) === 'not_your_offering',
  )
})
