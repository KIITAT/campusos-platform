import { randomUUID } from 'node:crypto'
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm'
import { audit, auditLog, withTenant } from '@campusos/db'
import { courses, offerings } from './joins'
import { examMarks, exams, markRequests } from '../schema'
import {
  ExamError,
  assertOwnsOffering,
  canMark,
  isAdmin,
  lockOfferingMarks,
  tenantOf,
  type Actor,
  type MarkTx,
} from './operations'
import {
  decideMarkReviewSchema,
  listMarkReviewsSchema,
  requestMarkReviewSchema,
  reviseMarkSchema,
} from './schemas'

/**
 * Maker and checker for a published mark (P1-07c, decisions 876-879).
 *
 * A student asks for a recheck or re-evaluation of a mark they can see; staff
 * propose a different score or an absence; a different administrator approves
 * or rejects. The approval writes the audit row, the request's decision and the
 * mark in one transaction, and the database refuses the mark change unless all
 * of that evidence is present and matches (migration 0007). Everything here
 * runs under the offering's lock, so a decision is either wholly before or
 * wholly after a finalisation of the same course.
 */

const MODULE = 'examinations'

export type ReviewStatus = 'requested' | 'proposed' | 'approved' | 'rejected'
export type ReviewResult = { requestId: string; status: ReviewStatus; notice: string }
export type ReviewRow = {
  requestId: string
  markId: string
  examId: string
  kind: 'correction' | 'recheck' | 're_evaluation'
  status: ReviewStatus
  createdAt: string
  decidedAt: string | null
  staff?: {
    studentId: string
    makerId: string | null
    baseRevision: number
    proposedScore: number | null
    proposedAbsent: boolean | null
  }
}

const NOTICE = {
  requested: 'Review requested.',
  proposed: 'Revision proposed.',
  approved: 'Revision approved. Re-finalise the course.',
  rejected: 'Review closed.',
} as const

const num = (v: string | null) => (v === null ? null : Number(v))

const noMark = () => new ExamError(404, 'no_such_mark', 'No such mark.')
const noRequest = () => new ExamError(404, 'no_such_mark_request', 'No such mark request.')
const stale = () =>
  new ExamError(409, 'mark_request_stale', 'The review no longer matches the current mark.')
const closed = () => new ExamError(409, 'mark_request_closed', 'This review is closed.')
const open = () => new ExamError(409, 'mark_request_open', 'A review is already open for this mark.')

/** The mark and its exam, read, then re-read once the offering's lock is held. */
async function lockedMark(tx: MarkTx, tenant: string, markId: string) {
  const read = () =>
    tx
      .select({ mark: examMarks, exam: exams })
      .from(examMarks)
      .innerJoin(exams, eq(exams.id, examMarks.examId))
      .where(eq(examMarks.id, markId))
  const [first] = await read()
  if (!first) throw noMark()
  await lockOfferingMarks(tx, tenant, first.exam.offeringId)
  const [row] = await read()
  if (!row) throw noMark()
  return row
}

const liveRequestFor = async (tx: MarkTx, markId: string) =>
  (
    await tx
      .select()
      .from(markRequests)
      .where(and(eq(markRequests.markId, markId), inArray(markRequests.status, ['requested', 'proposed'])))
  )[0]

/** A student asks for one of their own visible marks to be looked at again. */
export async function requestMarkReview(actor: Actor, input: unknown): Promise<ReviewResult> {
  const tenant = tenantOf(actor)
  if (actor.role !== 'student') throw new ExamError(403, 'forbidden', 'not permitted')
  const data = requestMarkReviewSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const { mark, exam } = await lockedMark(tx, tenant, data.markId)
    // Not theirs, or not published to them: the same answer, so a student
    // cannot probe for other people's mark ids.
    if (mark.studentId !== actor.id || !exam.publishedAt) throw noMark()
    if (await liveRequestFor(tx, mark.id)) throw open()

    const requestId = randomUUID()
    await tx.insert(markRequests).values({
      id: requestId,
      institutionId: tenant,
      markId: mark.id,
      studentId: mark.studentId,
      kind: data.kind,
      status: 'requested',
      baseRevision: mark.revision,
    })
    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: 'mark.review_requested',
      entity: 'exam_marks',
      entityId: mark.id,
      reason: data.reason,
      detail: { requestId, baseRevision: mark.revision },
    })
    return { requestId, status: 'requested', notice: NOTICE.requested }
  })
}

/**
 * Staff propose a different score, or an absence, for a published mark. This
 * changes nothing: the proposal waits for a different administrator.
 */
export async function reviseMark(actor: Actor, input: unknown): Promise<ReviewResult> {
  const tenant = tenantOf(actor)
  if (!canMark(actor.role)) throw new ExamError(403, 'forbidden', 'not permitted')
  const data = reviseMarkSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const [found] = await tx
      .select({ id: examMarks.id })
      .from(examMarks)
      .where(and(eq(examMarks.examId, data.examId), eq(examMarks.studentId, data.studentId)))
    if (!found) throw noMark()
    const { mark, exam } = await lockedMark(tx, tenant, found.id)
    await assertOwnsOffering(tx, actor, exam.offeringId)
    if (!exam.everPublished) {
      throw new ExamError(409, 'not_published', 'results are not published: enter the marks normally')
    }

    const max = Number(exam.maxMarks)
    if (data.obtained != null && data.obtained > max) {
      throw new ExamError(400, 'above_max', `${data.obtained} exceeds the maximum of ${max}`)
    }
    if (mark.revision !== data.expectedRevision) throw stale()
    const proposedScore = data.absent ? null : data.obtained!
    if (num(mark.obtained) === proposedScore && mark.absent === data.absent) {
      throw new ExamError(409, 'mark_proposal_unchanged', 'The proposed mark is unchanged.')
    }

    const live = await liveRequestFor(tx, mark.id)
    let requestId: string
    if (data.requestId) {
      const [named] = await tx.select().from(markRequests).where(eq(markRequests.id, data.requestId))
      if (!named || named.markId !== mark.id) throw noRequest()
      if (named.status === 'approved' || named.status === 'rejected') throw closed()
      if (named.status !== 'requested') throw open()
      if (named.baseRevision !== mark.revision) throw stale()
      await tx
        .update(markRequests)
        .set({
          status: 'proposed',
          makerId: actor.id,
          proposedScore: proposedScore === null ? null : proposedScore.toFixed(2),
          proposedAbsent: data.absent,
        })
        .where(eq(markRequests.id, named.id))
      requestId = named.id
    } else {
      if (live) throw open()
      requestId = randomUUID()
      await tx.insert(markRequests).values({
        id: requestId,
        institutionId: tenant,
        markId: mark.id,
        studentId: mark.studentId,
        kind: 'correction',
        status: 'proposed',
        makerId: actor.id,
        baseRevision: mark.revision,
        proposedScore: proposedScore === null ? null : proposedScore.toFixed(2),
        proposedAbsent: data.absent,
      })
    }
    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: 'mark.revision_proposed',
      entity: 'exam_marks',
      entityId: mark.id,
      reason: data.reason,
      detail: { requestId, baseRevision: mark.revision },
    })
    return { requestId, status: 'proposed', notice: NOTICE.proposed }
  })
}

/**
 * An administrator other than the proposer approves a proposal, or closes a
 * review. Approval is the only code path that moves a published mark.
 */
export async function decideMarkReview(actor: Actor, input: unknown): Promise<ReviewResult> {
  const tenant = tenantOf(actor)
  if (!isAdmin(actor.role)) throw new ExamError(403, 'forbidden', 'not permitted')
  const data = decideMarkReviewSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const [first] = await tx.select().from(markRequests).where(eq(markRequests.id, data.requestId))
    if (!first) throw noRequest()
    const { mark } = await lockedMark(tx, tenant, first.markId)
    const [req] = await tx.select().from(markRequests).where(eq(markRequests.id, data.requestId))
    if (!req) throw noRequest()

    if (req.status === 'approved' || req.status === 'rejected') throw closed()
    if (req.makerId === actor.id) {
      throw new ExamError(403, 'mark_self_decision', 'Another administrator must decide this revision.')
    }
    if (req.baseRevision !== mark.revision) throw stale()

    if (data.decision === 'reject') {
      await tx
        .update(markRequests)
        .set({ status: 'rejected', checkerId: actor.id, decidedAt: new Date() })
        .where(eq(markRequests.id, req.id))
      await audit(tx, {
        institutionId: tenant,
        actorId: actor.id,
        actorEmail: actor.email ?? null,
        moduleId: MODULE,
        action: 'mark.review_rejected',
        entity: 'exam_marks',
        entityId: mark.id,
        reason: data.reason,
        detail: { requestId: req.id, baseRevision: req.baseRevision },
      })
      return { requestId: req.id, status: 'rejected', notice: NOTICE.rejected }
    }

    // Nothing to approve until staff have proposed a value.
    if (req.status !== 'proposed') throw stale()
    const revision = mark.revision + 1
    const to = { obtained: num(req.proposedScore), absent: req.proposedAbsent!, revision }
    const from = { obtained: num(mark.obtained), absent: mark.absent, revision: mark.revision }

    await tx
      .update(markRequests)
      .set({ status: 'approved', checkerId: actor.id, decidedAt: new Date() })
      .where(eq(markRequests.id, req.id))
    // The audit row carries the request's id: the database joins the two.
    await tx.execute(sql`select set_config('app.audit_reason', ${data.reason}, true)`)
    await tx.insert(auditLog).values({
      id: req.id,
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: 'mark.revised',
      entity: 'exam_marks',
      entityId: mark.id,
      reason: data.reason,
      detail: { requestId: req.id, studentId: mark.studentId, revision, from, to },
    })
    await tx
      .update(examMarks)
      .set({
        obtained: to.obtained === null ? null : to.obtained.toFixed(2),
        absent: to.absent,
        revision,
        enteredBy: actor.id,
        enteredAt: new Date(),
      })
      .where(eq(examMarks.id, mark.id))
    return { requestId: req.id, status: 'approved', notice: NOTICE.approved }
  })
}

/**
 * One page of reviews, newest first. A student sees their own, without the
 * staff detail; staff see those of one exam they may mark. Keyset by id, so
 * a page never repeats or skips a row while new ones arrive.
 */
export async function listMarkReviews(
  actor: Actor,
  input: { examId?: string; after?: string },
): Promise<{ rows: ReviewRow[]; next: string | null }> {
  const tenant = tenantOf(actor)
  const q = listMarkReviewsSchema.parse(input)
  const student = actor.role === 'student'
  if (!student && !canMark(actor.role)) throw new ExamError(403, 'forbidden', 'not permitted')
  if (!student && !q.examId) throw new ExamError(400, 'exam_required', 'Choose an exam.')

  return withTenant(tenant, async (tx) => {
    if (!student) {
      const [exam] = await tx.select().from(exams).where(eq(exams.id, q.examId!))
      if (!exam) throw new ExamError(404, 'no_such_exam', 'no such exam')
      await assertOwnsOffering(tx, actor, exam.offeringId)
    }
    const rows = await tx
      .select({ r: markRequests, examId: examMarks.examId })
      .from(markRequests)
      .innerJoin(examMarks, eq(examMarks.id, markRequests.markId))
      .where(
        and(
          student ? eq(markRequests.studentId, actor.id) : eq(examMarks.examId, q.examId!),
          student && q.examId ? eq(examMarks.examId, q.examId) : undefined,
          q.after ? lt(markRequests.id, q.after) : undefined,
        ),
      )
      .orderBy(desc(markRequests.id))
      .limit(51)
    const page = rows.slice(0, 50)
    return {
      rows: page.map(({ r, examId }): ReviewRow => ({
        requestId: r.id,
        markId: r.markId,
        examId,
        kind: r.kind,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
        decidedAt: r.decidedAt?.toISOString() ?? null,
        ...(student
          ? {}
          : {
              staff: {
                studentId: r.studentId,
                makerId: r.makerId,
                baseRevision: r.baseRevision,
                proposedScore: num(r.proposedScore),
                proposedAbsent: r.proposedAbsent,
              },
            }),
      })),
      next: rows.length > 50 ? page[page.length - 1]!.r.id : null,
    }
  })
}

/**
 * The visible marks a student may ask about, 50 at a time by id (the portal's
 * "Request a mark review" form). Not a route: the page reads it in-process.
 */
export async function reviewableMarks(
  actor: Actor,
  after?: string,
): Promise<{ rows: { markId: string; label: string }[]; next: string | null }> {
  const tenant = tenantOf(actor)
  if (actor.role !== 'student') return { rows: [], next: null }
  return withTenant(tenant, async (tx) => {
    const rows = await tx
      .select({ id: examMarks.id, exam: exams.name, code: courses.code, title: courses.title })
      .from(examMarks)
      .innerJoin(exams, eq(exams.id, examMarks.examId))
      .innerJoin(offerings, eq(offerings.id, exams.offeringId))
      .innerJoin(courses, eq(courses.id, offerings.courseId))
      .where(
        and(
          eq(examMarks.studentId, actor.id),
          sql`${exams.publishedAt} is not null`,
          after ? lt(examMarks.id, after) : undefined,
        ),
      )
      .orderBy(desc(examMarks.id))
      .limit(51)
    const page = rows.slice(0, 50)
    return {
      rows: page.map((r) => ({ markId: r.id, label: `${r.code} ${r.title}: ${r.exam}` })),
      next: rows.length > 50 ? page[page.length - 1]!.id : null,
    }
  })
}
