import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { users, withTenant } from '@campusos/db'
import {
  appraisalCycles,
  appraisalFeedback,
  appraisalKras,
  appraisals,
  goals,
  kras,
  staff,
} from '../schema'
import {
  HrError,
  isHr,
  requireAdmin,
  requireHr,
  tenantOf,
  type Actor,
  type Tx,
} from './guards'
import {
  createCycleSchema,
  createKraSchema,
  enrolSchema,
  giveAppraisalFeedbackSchema,
  reviewInput,
  selfReviewInput,
  setCycleStatusSchema,
  setGoalSchema,
  updateGoalSchema,
} from './schemas'

/**
 * Performance: a review period, the key result areas people are judged on,
 * the goals they set, and what colleagues say.
 *
 * An appraisal goes self review -> reviewer -> completed, in that order. The
 * score is the weighted mean of the reviewer's ratings, computed here and
 * frozen on completion; it is what an increment or a promotion is argued from,
 * so after that it moves only with an audited reason (a trigger says so).
 *
 * Kept apart from academic grading on purpose: a lecturer's appraisal and a
 * student's mark share a 1-to-5 scale and nothing else.
 */

// --- cycles and KRAs -------------------------------------------------------

export async function createCycle(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = createCycleSchema.parse(input)
  if (d.endsOn <= d.startsOn) throw new HrError(400, 'bad_dates', 'a cycle has to end after it starts')
  return withTenant(tenant, async (tx) => {
    const [row] = await tx
      .insert(appraisalCycles)
      .values({ institutionId: tenant, name: d.name, startsOn: d.startsOn, endsOn: d.endsOn })
      .onConflictDoNothing()
      .returning()
    if (!row) throw new HrError(409, 'exists', 'a cycle with that name already exists')
    return row
  })
}

/** Draft -> open -> closed, one way. */
export async function setCycleStatus(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = setCycleStatusSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [row] = await tx.select().from(appraisalCycles).where(eq(appraisalCycles.id, d.cycleId))
    if (!row) throw new HrError(404, 'no_such_cycle', 'no such cycle')
    const allowed = (row.status === 'draft' && d.status === 'open') ||
      (row.status === 'open' && d.status === 'closed')
    if (!allowed) throw new HrError(409, 'bad_move', `a ${row.status} cycle cannot become ${d.status}`)
    const [updated] = await tx
      .update(appraisalCycles)
      .set({ status: d.status })
      .where(eq(appraisalCycles.id, row.id))
      .returning()
    return updated!
  })
}

export async function listCycles(actor: Actor) {
  const tenant = requireHr(actor)
  return withTenant(tenant, async (tx) => {
    const rows = await tx.select().from(appraisalCycles).orderBy(desc(appraisalCycles.startsOn))
    const counts = await tx
      .select({
        cycleId: appraisals.cycleId,
        status: appraisals.status,
        n: sql<number>`count(*)::int`,
      })
      .from(appraisals)
      .groupBy(appraisals.cycleId, appraisals.status)
    return rows.map((c) => {
      const mine = counts.filter((x) => x.cycleId === c.id)
      const n = (s: string) => mine.find((x) => x.status === s)?.n ?? 0
      return {
        ...c,
        people: mine.reduce((t, x) => t + x.n, 0),
        selfReview: n('self_review'),
        managerReview: n('manager_review'),
        completed: n('completed'),
      }
    })
  })
}

export async function createKra(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = createKraSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [row] = await tx
      .insert(kras)
      .values({ institutionId: tenant, code: d.code, name: d.name, description: d.description ?? null })
      .onConflictDoNothing()
      .returning()
    if (!row) throw new HrError(409, 'exists', 'that KRA code already exists')
    return row
  })
}

export async function listKras(actor: Actor) {
  const tenant = tenantOf(actor)
  return withTenant(tenant, (tx) => tx.select().from(kras).orderBy(asc(kras.code)))
}

// --- enrolment -------------------------------------------------------------

/**
 * Put people into a cycle, each with a reviewer and the weighted KRAs they
 * are judged on. Weights add up to 100, and nobody reviews themselves.
 * Anybody already in the cycle is skipped and counted.
 */
export async function enrol(actor: Actor, input: unknown) {
  const tenant = requireHr(actor)
  const d = enrolSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [cycle] = await tx.select().from(appraisalCycles).where(eq(appraisalCycles.id, d.cycleId))
    if (!cycle) throw new HrError(404, 'no_such_cycle', 'no such cycle')
    if (cycle.status === 'closed') throw new HrError(409, 'closed', 'that cycle is closed')

    const [reviewer] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, d.reviewerId), eq(users.institutionId, tenant)))
    if (!reviewer) throw new HrError(400, 'bad_reviewer', 'the reviewer has to be somebody at this institution')

    const known = await tx.select({ id: kras.id }).from(kras).where(inArray(kras.id, d.kras.map((k) => k.kraId)))
    if (known.length !== new Set(d.kras.map((k) => k.kraId)).size || known.length !== d.kras.length) {
      throw new HrError(400, 'bad_kras', 'every KRA has to exist, and appear once')
    }

    const people = await tx.select().from(staff).where(inArray(staff.id, d.staffIds))
    if (people.length !== new Set(d.staffIds).size) {
      throw new HrError(404, 'no_such_staff', 'somebody in that list is not on record')
    }
    if (people.some((p) => p.userId === d.reviewerId)) {
      throw new HrError(400, 'self_review', 'nobody is their own reviewer')
    }

    let enrolled = 0
    let skipped = 0
    for (const p of people) {
      const [row] = await tx
        .insert(appraisals)
        .values({ institutionId: tenant, cycleId: cycle.id, staffId: p.id, reviewerId: d.reviewerId })
        .onConflictDoNothing()
        .returning({ id: appraisals.id })
      if (!row) {
        skipped++
        continue
      }
      await tx.insert(appraisalKras).values(
        d.kras.map((k) => ({ institutionId: tenant, appraisalId: row.id, kraId: k.kraId, weight: k.weight })),
      )
      enrolled++
    }
    return { enrolled, skipped }
  })
}

// --- reviews ---------------------------------------------------------------

async function loadAppraisal(tx: Tx, appraisalId: string) {
  const [row] = await tx.select().from(appraisals).where(eq(appraisals.id, appraisalId))
  if (!row) throw new HrError(404, 'no_such_appraisal', 'no such appraisal')
  const [cycle] = await tx.select().from(appraisalCycles).where(eq(appraisalCycles.id, row.cycleId))
  if (cycle!.status !== 'open') {
    throw new HrError(409, 'cycle_not_open', `that cycle is ${cycle!.status}`)
  }
  const [person] = await tx.select().from(staff).where(eq(staff.id, row.staffId))
  const lines = await tx.select().from(appraisalKras).where(eq(appraisalKras.appraisalId, row.id))
  return { row, person: person!, lines }
}

/** Every KRA on the appraisal rated, and nothing that is not on it. */
function checkRatings(lines: { kraId: string }[], ratings: { kraId: string }[]) {
  const want = new Set(lines.map((l) => l.kraId))
  const got = new Set(ratings.map((r) => r.kraId))
  if (want.size !== got.size || [...want].some((k) => !got.has(k)) || got.size !== ratings.length) {
    throw new HrError(400, 'incomplete', 'rate every KRA on the appraisal, once each')
  }
}

/** The appraisee's own assessment. Only theirs, and only once. */
export async function submitSelfReview(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  const d = selfReviewInput.parse(input)
  return withTenant(tenant, async (tx) => {
    const { row, person, lines } = await loadAppraisal(tx, d.appraisalId)
    if (person.userId !== actor.id) {
      throw new HrError(403, 'forbidden', 'a self review is written by the person being appraised')
    }
    if (row.status !== 'self_review') {
      throw new HrError(409, 'already_submitted', 'the self review is already in')
    }
    checkRatings(lines, d.ratings)
    for (const r of d.ratings) {
      await tx
        .update(appraisalKras)
        .set({ selfRating: r.rating, selfComment: r.comment ?? null })
        .where(and(eq(appraisalKras.appraisalId, row.id), eq(appraisalKras.kraId, r.kraId)))
    }
    const [updated] = await tx
      .update(appraisals)
      .set({ status: 'manager_review', selfSummary: d.summary, selfSubmittedAt: new Date() })
      .where(eq(appraisals.id, row.id))
      .returning()
    return updated!
  })
}

/** Weighted mean of the ratings, in hundredths: weights 60/40, ratings 4/3 -> 360. */
export const weightedScore = (lines: { weight: number; rating: number }[]) => {
  const total = lines.reduce((n, l) => n + l.weight, 0)
  return total === 0 ? 0 : Math.round((lines.reduce((n, l) => n + l.weight * l.rating, 0) * 100) / total)
}

/** The reviewer's assessment, after the self review, which completes the appraisal. */
export async function submitReview(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  const d = reviewInput.parse(input)
  return withTenant(tenant, async (tx) => {
    const { row, lines } = await loadAppraisal(tx, d.appraisalId)
    if (row.reviewerId !== actor.id) {
      throw new HrError(403, 'forbidden', 'only the assigned reviewer completes the review')
    }
    if (row.status === 'self_review') {
      throw new HrError(409, 'awaiting_self_review', 'the self review comes first')
    }
    if (row.status === 'completed') throw new HrError(409, 'completed', 'that appraisal is complete')
    checkRatings(lines, d.ratings)

    for (const r of d.ratings) {
      await tx
        .update(appraisalKras)
        .set({ reviewerRating: r.rating, reviewerComment: r.comment ?? null })
        .where(and(eq(appraisalKras.appraisalId, row.id), eq(appraisalKras.kraId, r.kraId)))
    }
    const score = weightedScore(
      lines.map((l) => ({ weight: l.weight, rating: d.ratings.find((r) => r.kraId === l.kraId)!.rating })),
    )
    const [updated] = await tx
      .update(appraisals)
      .set({ status: 'completed', reviewerSummary: d.summary, scoreCenti: score, completedAt: new Date() })
      .where(eq(appraisals.id, row.id))
      .returning()
    return updated!
  })
}

/** An appraisal with its KRAs and colleague feedback, for the people entitled to read it. */
export async function appraisalView(actor: Actor, appraisalId: string) {
  const tenant = tenantOf(actor)
  return withTenant(tenant, async (tx) => {
    const [row] = await tx.select().from(appraisals).where(eq(appraisals.id, appraisalId))
    if (!row) throw new HrError(404, 'no_such_appraisal', 'no such appraisal')
    const [person] = await tx.select().from(staff).where(eq(staff.id, row.staffId))
    const mayRead = isHr(actor.role) || row.reviewerId === actor.id || person?.userId === actor.id
    if (!mayRead) throw new HrError(403, 'forbidden', 'not permitted')

    const lines = await tx
      .select({
        kraId: appraisalKras.kraId,
        code: kras.code,
        name: kras.name,
        weight: appraisalKras.weight,
        selfRating: appraisalKras.selfRating,
        selfComment: appraisalKras.selfComment,
        reviewerRating: appraisalKras.reviewerRating,
        reviewerComment: appraisalKras.reviewerComment,
      })
      .from(appraisalKras)
      .innerJoin(kras, eq(kras.id, appraisalKras.kraId))
      .where(eq(appraisalKras.appraisalId, row.id))
      .orderBy(asc(kras.code))

    // Colleague feedback is shown to the appraisee without names: candour is
    // the point of it. HR and the reviewer see who said what.
    const named = isHr(actor.role) || row.reviewerId === actor.id
    const feedback = await tx
      .select({
        from: users.name,
        relation: appraisalFeedback.relation,
        strengths: appraisalFeedback.strengths,
        improvements: appraisalFeedback.improvements,
        rating: appraisalFeedback.rating,
      })
      .from(appraisalFeedback)
      .innerJoin(users, eq(users.id, appraisalFeedback.fromUserId))
      .where(eq(appraisalFeedback.appraisalId, row.id))

    return {
      ...row,
      staffName: person?.name ?? '',
      score: row.scoreCenti === null ? null : row.scoreCenti / 100,
      lines,
      feedback: feedback.map((f) => (named ? f : { ...f, from: null })),
    }
  })
}

export async function listAppraisals(actor: Actor, cycleId: string) {
  const tenant = requireHr(actor)
  return withTenant(tenant, (tx) =>
    tx
      .select({
        id: appraisals.id,
        staffId: appraisals.staffId,
        staffName: staff.name,
        employeeCode: staff.employeeCode,
        reviewer: users.name,
        status: appraisals.status,
        scoreCenti: appraisals.scoreCenti,
      })
      .from(appraisals)
      .innerJoin(staff, eq(staff.id, appraisals.staffId))
      .innerJoin(users, eq(users.id, appraisals.reviewerId))
      .where(eq(appraisals.cycleId, cycleId))
      .orderBy(asc(staff.employeeCode)),
  )
}

/** Appraisals where this person is the appraisee or the reviewer, and what is waiting on them. */
export async function myAppraisals(actor: Actor) {
  const tenant = tenantOf(actor)
  return withTenant(tenant, async (tx) => {
    const [me] = await tx.select({ id: staff.id }).from(staff).where(eq(staff.userId, actor.id))
    const rows = await tx
      .select({
        id: appraisals.id,
        cycle: appraisalCycles.name,
        cycleStatus: appraisalCycles.status,
        staffId: appraisals.staffId,
        staffName: staff.name,
        reviewerId: appraisals.reviewerId,
        status: appraisals.status,
        scoreCenti: appraisals.scoreCenti,
      })
      .from(appraisals)
      .innerJoin(appraisalCycles, eq(appraisalCycles.id, appraisals.cycleId))
      .innerJoin(staff, eq(staff.id, appraisals.staffId))
      .where(
        me
          ? sql`${appraisals.reviewerId} = ${actor.id} or ${appraisals.staffId} = ${me.id}`
          : eq(appraisals.reviewerId, actor.id),
      )
      .orderBy(desc(appraisalCycles.startsOn))
    return rows.map((r) => {
      const mine = me?.id === r.staffId
      return {
        ...r,
        role: mine ? 'appraisee' : 'reviewer',
        waiting:
          r.cycleStatus === 'open' &&
          ((mine && r.status === 'self_review') || (!mine && r.status === 'manager_review')),
      }
    })
  })
}

// --- feedback --------------------------------------------------------------

export async function giveAppraisalFeedback(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  const d = giveAppraisalFeedbackSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const { row, person } = await loadAppraisal(tx, d.appraisalId)
    if (person.userId === actor.id) {
      throw new HrError(403, 'self_feedback', 'nobody writes feedback on their own appraisal')
    }
    if (row.status === 'completed') throw new HrError(409, 'completed', 'that appraisal is complete')
    const [created] = await tx
      .insert(appraisalFeedback)
      .values({
        institutionId: tenant,
        appraisalId: row.id,
        fromUserId: actor.id,
        relation: d.relation,
        strengths: d.strengths,
        improvements: d.improvements,
        rating: d.rating,
      })
      .onConflictDoNothing()
      .returning()
    if (!created) throw new HrError(409, 'already_given', 'you have already given feedback on this')
    return created
  })
}

// --- goals -----------------------------------------------------------------

/** HR sets goals for anybody; a member of staff sets their own. */
export async function setGoal(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  const d = setGoalSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [person] = await tx.select().from(staff).where(eq(staff.id, d.staffId))
    if (!person) throw new HrError(404, 'no_such_staff', 'no such staff record')
    if (!isHr(actor.role) && person.userId !== actor.id) {
      throw new HrError(403, 'forbidden', 'not permitted')
    }
    const [row] = await tx
      .insert(goals)
      .values({
        institutionId: tenant,
        staffId: d.staffId,
        title: d.title,
        description: d.description ?? null,
        cycleId: d.cycleId ?? null,
        kraId: d.kraId ?? null,
        targetOn: d.targetOn ?? null,
        createdBy: actor.id,
      })
      .returning()
    return row!
  })
}

export async function updateGoal(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  const d = updateGoalSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [goal] = await tx.select().from(goals).where(eq(goals.id, d.goalId))
    if (!goal) throw new HrError(404, 'no_such_goal', 'no such goal')
    const [person] = await tx.select().from(staff).where(eq(staff.id, goal.staffId))
    if (!isHr(actor.role) && person?.userId !== actor.id) {
      throw new HrError(403, 'forbidden', 'not permitted')
    }
    if (goal.status !== 'open') throw new HrError(409, 'closed', `that goal is already ${goal.status}`)
    const status = d.status ?? goal.status
    // Achieved means all the way there; saying so fills the bar.
    const progress = status === 'achieved' ? 100 : (d.progress ?? goal.progress)
    const [updated] = await tx
      .update(goals)
      .set({ progress, status })
      .where(eq(goals.id, goal.id))
      .returning()
    return updated!
  })
}

export async function listGoals(actor: Actor, staffId?: string) {
  const tenant = tenantOf(actor)
  return withTenant(tenant, async (tx) => {
    let target = staffId
    if (!isHr(actor.role)) {
      const [me] = await tx.select({ id: staff.id }).from(staff).where(eq(staff.userId, actor.id))
      if (!me) return []
      target = me.id
    }
    return tx
      .select({
        id: goals.id,
        staffId: goals.staffId,
        staffName: staff.name,
        title: goals.title,
        kra: kras.code,
        targetOn: goals.targetOn,
        progress: goals.progress,
        status: goals.status,
      })
      .from(goals)
      .innerJoin(staff, eq(staff.id, goals.staffId))
      .leftJoin(kras, eq(kras.id, goals.kraId))
      .where(target ? eq(goals.staffId, target) : undefined)
      .orderBy(asc(goals.status), asc(goals.targetOn))
      .limit(300)
  })
}
