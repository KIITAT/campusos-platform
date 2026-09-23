import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { audit, users, withTenant } from '@campusos/db'
import {
  interviewFeedback,
  interviews,
  jobApplicants,
  jobOffers,
  jobOpenings,
  jobRequisitions,
  staff,
} from '../schema'
import {
  HrError,
  MODULE,
  isHr,
  requireAdmin,
  requireHr,
  tenantOf,
  today,
  type Actor,
  type Tx,
} from './guards'
import { onboardIn } from './lifecycle'
import {
  addApplicantSchema,
  closeOpeningSchema,
  decideRequisitionSchema,
  giveFeedbackSchema,
  hireSchema,
  makeOfferSchema,
  moveApplicantSchema,
  openPositionSchema,
  raiseRequisitionSchema,
  respondToOfferSchema,
  scheduleInterviewSchema,
  withdrawOfferSchema,
} from './schemas'

/**
 * Recruitment: requisition -> opening -> applicant -> interview -> offer ->
 * staff record.
 *
 * Each arrow is a decision somebody signs. The requisition is the institution
 * agreeing the post exists and is paid for; nothing is advertised before it.
 * Feedback is given by the panel and nobody else. The offer carries the terms,
 * and hiring turns it into a staff record in the same transaction, linked, so
 * the terms somebody was hired on are never a question for the filing cabinet.
 */

const errCode = (e: unknown) =>
  (e as { cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code

/** Who may ask for a post: the HR desk, and a head of department for their own. */
const mayRequest = (actor: Actor) => isHr(actor.role) || actor.role === 'hod'

// --- requisitions ----------------------------------------------------------

export async function raiseRequisition(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  if (!mayRequest(actor)) throw new HrError(403, 'forbidden', 'not permitted')
  const d = raiseRequisitionSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [row] = await tx
      .insert(jobRequisitions)
      .values({
        institutionId: tenant,
        designation: d.designation,
        department: d.department ?? null,
        positions: d.positions,
        reason: d.reason,
        expectedBy: d.expectedBy ?? null,
        requestedBy: actor.id,
      })
      .returning()
    return row!
  })
}

/** Agreeing a post exists is an administrative decision, and a one-way one. */
export async function decideRequisition(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = decideRequisitionSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [row] = await tx
      .select()
      .from(jobRequisitions)
      .where(eq(jobRequisitions.id, d.requisitionId))
    if (!row) throw new HrError(404, 'no_such_requisition', 'no such requisition')
    if (row.status !== 'pending') {
      throw new HrError(409, 'already_decided', `that requisition is already ${row.status}`)
    }
    if (row.requestedBy === actor.id) {
      throw new HrError(403, 'self_approval', 'a requisition is not approved by whoever raised it')
    }
    const [updated] = await tx
      .update(jobRequisitions)
      .set({
        status: d.approve ? 'approved' : 'rejected',
        decidedBy: actor.id,
        decidedAt: new Date(),
        decisionNote: d.note ?? null,
      })
      .where(eq(jobRequisitions.id, row.id))
      .returning()
    return updated!
  })
}

export async function listRequisitions(actor: Actor) {
  const tenant = tenantOf(actor)
  if (!mayRequest(actor)) throw new HrError(403, 'forbidden', 'not permitted')
  return withTenant(tenant, async (tx) => {
    const rows = await tx
      .select()
      .from(jobRequisitions)
      .orderBy(desc(jobRequisitions.createdAt))
      .limit(300)
    const hires = await hiresByRequisition(tx)
    return rows.map((r) => ({ ...r, hired: hires.get(r.id) ?? 0 }))
  })
}

async function hiresByRequisition(tx: Tx) {
  const rows = await tx
    .select({
      requisitionId: jobOpenings.requisitionId,
      n: sql<number>`count(*)::int`,
    })
    .from(jobOffers)
    .innerJoin(jobApplicants, eq(jobApplicants.id, jobOffers.applicantId))
    .innerJoin(jobOpenings, eq(jobOpenings.id, jobApplicants.openingId))
    .where(sql`${jobOffers.staffId} is not null`)
    .groupBy(jobOpenings.requisitionId)
  return new Map(rows.map((r) => [r.requisitionId, r.n]))
}

// --- openings --------------------------------------------------------------

export async function openPosition(actor: Actor, input: unknown) {
  const tenant = requireHr(actor)
  const d = openPositionSchema.parse(input)
  const opensOn = d.opensOn ?? today()
  if (d.closesOn && d.closesOn < opensOn) {
    throw new HrError(400, 'bad_dates', 'an opening cannot close before it opens')
  }
  return withTenant(tenant, async (tx) => {
    const [req] = await tx
      .select()
      .from(jobRequisitions)
      .where(eq(jobRequisitions.id, d.requisitionId))
    if (!req) throw new HrError(404, 'no_such_requisition', 'no such requisition')
    if (req.status !== 'approved') {
      throw new HrError(
        409,
        'not_approved',
        `that requisition is ${req.status}; nothing is advertised before the post is agreed`,
      )
    }
    const [row] = await tx
      .insert(jobOpenings)
      .values({
        institutionId: tenant,
        requisitionId: req.id,
        title: d.title,
        description: d.description ?? null,
        opensOn,
        closesOn: d.closesOn ?? null,
      })
      .onConflictDoNothing()
      .returning()
    if (!row) throw new HrError(409, 'already_open', 'that requisition is already advertised')
    return row
  })
}

export async function closeOpening(actor: Actor, input: unknown) {
  const tenant = requireHr(actor)
  const d = closeOpeningSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [row] = await tx
      .update(jobOpenings)
      .set({ closedAt: new Date() })
      .where(and(eq(jobOpenings.id, d.openingId), isNull(jobOpenings.closedAt)))
      .returning()
    if (!row) throw new HrError(409, 'not_open', 'that opening is not open')
    return row
  })
}

/** Every opening with its pipeline: how many applicants stand where. */
export async function listOpenings(actor: Actor) {
  const tenant = requireHr(actor)
  return withTenant(tenant, async (tx) => {
    const rows = await tx
      .select({
        id: jobOpenings.id,
        requisitionId: jobOpenings.requisitionId,
        title: jobOpenings.title,
        designation: jobRequisitions.designation,
        department: jobRequisitions.department,
        positions: jobRequisitions.positions,
        opensOn: jobOpenings.opensOn,
        closesOn: jobOpenings.closesOn,
        closedAt: jobOpenings.closedAt,
      })
      .from(jobOpenings)
      .innerJoin(jobRequisitions, eq(jobRequisitions.id, jobOpenings.requisitionId))
      .orderBy(desc(jobOpenings.opensOn))
      .limit(200)
    const counts = await tx
      .select({
        openingId: jobApplicants.openingId,
        status: jobApplicants.status,
        n: sql<number>`count(*)::int`,
      })
      .from(jobApplicants)
      .groupBy(jobApplicants.openingId, jobApplicants.status)
    return rows.map((o) => {
      const mine = counts.filter((c) => c.openingId === o.id)
      const n = (s: string) => mine.find((c) => c.status === s)?.n ?? 0
      return {
        ...o,
        live: o.closedAt === null,
        applied: mine.reduce((t, c) => t + c.n, 0),
        shortlisted: n('shortlisted'),
        interviewing: n('interviewing'),
        offered: n('offered'),
        hired: n('hired'),
      }
    })
  })
}

// --- applicants ------------------------------------------------------------

export async function addApplicant(actor: Actor, input: unknown) {
  const tenant = requireHr(actor)
  const d = addApplicantSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [opening] = await tx.select().from(jobOpenings).where(eq(jobOpenings.id, d.openingId))
    if (!opening) throw new HrError(404, 'no_such_opening', 'no such opening')
    if (opening.closedAt || (opening.closesOn && opening.closesOn < today())) {
      throw new HrError(409, 'closed', 'that opening has closed')
    }
    try {
      const [row] = await tx
        .insert(jobApplicants)
        .values({
          institutionId: tenant,
          openingId: opening.id,
          name: d.name,
          email: d.email,
          phone: d.phone ?? null,
          source: d.source ?? null,
          notes: d.notes ?? null,
        })
        .returning()
      return row!
    } catch (e) {
      if (errCode(e) === '23505') {
        throw new HrError(409, 'already_applied', 'that address has already applied for this opening')
      }
      throw e
    }
  })
}

/** Which moves are allowed from where. Hired and offered are reached only by their own acts. */
const MOVES: Record<string, string[]> = {
  applied: ['shortlisted', 'rejected', 'withdrawn'],
  shortlisted: ['rejected', 'withdrawn'],
  interviewing: ['rejected', 'withdrawn'],
  offered: ['withdrawn'],
}

export async function moveApplicant(actor: Actor, input: unknown) {
  const tenant = requireHr(actor)
  const d = moveApplicantSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [row] = await tx.select().from(jobApplicants).where(eq(jobApplicants.id, d.applicantId))
    if (!row) throw new HrError(404, 'no_such_applicant', 'no such applicant')
    if (!(MOVES[row.status] ?? []).includes(d.to)) {
      throw new HrError(409, 'bad_move', `an applicant who is ${row.status} cannot be ${d.to}`)
    }
    const notes = d.note ? [row.notes, `${d.to}: ${d.note}`].filter(Boolean).join('\n') : row.notes
    const [updated] = await tx
      .update(jobApplicants)
      .set({ status: d.to, notes })
      .where(eq(jobApplicants.id, row.id))
      .returning()
    return updated!
  })
}

export async function listApplicants(actor: Actor, openingId: string) {
  const tenant = requireHr(actor)
  return withTenant(tenant, (tx) =>
    tx
      .select()
      .from(jobApplicants)
      .where(eq(jobApplicants.openingId, openingId))
      .orderBy(asc(jobApplicants.createdAt)),
  )
}

/** One applicant, with every round, every signed piece of feedback, and the offer. */
export async function applicantFile(actor: Actor, applicantId: string) {
  const tenant = requireHr(actor)
  return withTenant(tenant, async (tx) => {
    const [applicant] = await tx.select().from(jobApplicants).where(eq(jobApplicants.id, applicantId))
    if (!applicant) throw new HrError(404, 'no_such_applicant', 'no such applicant')
    const rounds = await tx
      .select()
      .from(interviews)
      .where(eq(interviews.applicantId, applicantId))
      .orderBy(asc(interviews.round))
    const feedback = rounds.length
      ? await tx
          .select({
            interviewId: interviewFeedback.interviewId,
            interviewer: users.name,
            rating: interviewFeedback.rating,
            recommendation: interviewFeedback.recommendation,
            notes: interviewFeedback.notes,
          })
          .from(interviewFeedback)
          .innerJoin(users, eq(users.id, interviewFeedback.interviewerId))
          .where(inArray(interviewFeedback.interviewId, rounds.map((r) => r.id)))
      : []
    const offers = await tx
      .select()
      .from(jobOffers)
      .where(eq(jobOffers.applicantId, applicantId))
      .orderBy(desc(jobOffers.createdAt))
    return {
      applicant,
      rounds: rounds.map((r) => ({
        ...r,
        feedback: feedback.filter((f) => f.interviewId === r.id),
      })),
      offers,
    }
  })
}

// --- interviews ------------------------------------------------------------

export async function scheduleInterview(actor: Actor, input: unknown) {
  const tenant = requireHr(actor)
  const d = scheduleInterviewSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [applicant] = await tx.select().from(jobApplicants).where(eq(jobApplicants.id, d.applicantId))
    if (!applicant) throw new HrError(404, 'no_such_applicant', 'no such applicant')
    if (applicant.status !== 'shortlisted' && applicant.status !== 'interviewing') {
      throw new HrError(409, 'not_shortlisted', `an applicant who is ${applicant.status} is not interviewed`)
    }
    // The panel is people at this institution. Somebody else's staff cannot
    // sign feedback on our candidates.
    const panel = [...new Set(d.panel)]
    const known = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(inArray(users.id, panel), eq(users.institutionId, tenant)))
    if (known.length !== panel.length) {
      throw new HrError(400, 'bad_panel', 'every panel member has to be somebody at this institution')
    }
    const [last] = await tx
      .select({ round: sql<number>`coalesce(max(${interviews.round}), 0)::int` })
      .from(interviews)
      .where(eq(interviews.applicantId, applicant.id))
    const [row] = await tx
      .insert(interviews)
      .values({
        institutionId: tenant,
        applicantId: applicant.id,
        round: (last?.round ?? 0) + 1,
        scheduledAt: new Date(d.scheduledAt),
        panel,
      })
      .returning()
    await tx
      .update(jobApplicants)
      .set({ status: 'interviewing' })
      .where(eq(jobApplicants.id, applicant.id))
    return row!
  })
}

/**
 * Feedback from somebody on the panel, once. When the whole panel has spoken,
 * the round is complete.
 */
export async function giveFeedback(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  const d = giveFeedbackSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [round] = await tx.select().from(interviews).where(eq(interviews.id, d.interviewId))
    if (!round) throw new HrError(404, 'no_such_interview', 'no such interview')
    if (!round.panel.includes(actor.id)) {
      throw new HrError(403, 'not_on_panel', 'only the interview panel gives feedback on it')
    }
    if (round.status === 'cancelled') {
      throw new HrError(409, 'cancelled', 'that interview was cancelled')
    }
    const [row] = await tx
      .insert(interviewFeedback)
      .values({
        institutionId: tenant,
        interviewId: round.id,
        interviewerId: actor.id,
        rating: d.rating,
        recommendation: d.recommendation,
        notes: d.notes,
      })
      .onConflictDoNothing()
      .returning()
    if (!row) throw new HrError(409, 'already_given', 'you have already given feedback on this round')

    const [given] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(interviewFeedback)
      .where(eq(interviewFeedback.interviewId, round.id))
    if ((given?.n ?? 0) >= round.panel.length) {
      await tx.update(interviews).set({ status: 'completed' }).where(eq(interviews.id, round.id))
    }
    return row
  })
}

/** Interviews this person sits on, and whether they still owe feedback. */
export async function myInterviews(actor: Actor) {
  const tenant = tenantOf(actor)
  return withTenant(tenant, async (tx) => {
    const rows = await tx
      .select({
        id: interviews.id,
        round: interviews.round,
        scheduledAt: interviews.scheduledAt,
        status: interviews.status,
        applicant: jobApplicants.name,
        opening: jobOpenings.title,
      })
      .from(interviews)
      .innerJoin(jobApplicants, eq(jobApplicants.id, interviews.applicantId))
      .innerJoin(jobOpenings, eq(jobOpenings.id, jobApplicants.openingId))
      .where(sql`${actor.id} = any(${interviews.panel})`)
      .orderBy(desc(interviews.scheduledAt))
      .limit(100)
    const mine = rows.length
      ? await tx
          .select({ interviewId: interviewFeedback.interviewId })
          .from(interviewFeedback)
          .where(
            and(
              eq(interviewFeedback.interviewerId, actor.id),
              inArray(interviewFeedback.interviewId, rows.map((r) => r.id)),
            ),
          )
      : []
    const done = new Set(mine.map((m) => m.interviewId))
    return rows.map((r) => ({
      ...r,
      scheduledAt: r.scheduledAt.toISOString(),
      owed: r.status !== 'cancelled' && !done.has(r.id),
    }))
  })
}

// --- offers ----------------------------------------------------------------

export async function makeOffer(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = makeOfferSchema.parse(input)
  if (d.expiresOn < today()) throw new HrError(400, 'bad_dates', 'an offer cannot expire in the past')
  return withTenant(tenant, async (tx) => {
    const [applicant] = await tx.select().from(jobApplicants).where(eq(jobApplicants.id, d.applicantId))
    if (!applicant) throw new HrError(404, 'no_such_applicant', 'no such applicant')
    if (applicant.status !== 'interviewing') {
      throw new HrError(409, 'not_interviewed', `an applicant who is ${applicant.status} is not offered a post`)
    }
    // An offer rests on somebody having actually spoken to them.
    const [heard] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(interviewFeedback)
      .innerJoin(interviews, eq(interviews.id, interviewFeedback.interviewId))
      .where(eq(interviews.applicantId, applicant.id))
    if ((heard?.n ?? 0) === 0) {
      throw new HrError(409, 'no_feedback', 'nobody on a panel has given feedback on them yet')
    }
    const [opening] = await tx.select().from(jobOpenings).where(eq(jobOpenings.id, applicant.openingId))
    const [req] = await tx
      .select()
      .from(jobRequisitions)
      .where(eq(jobRequisitions.id, opening!.requisitionId))

    const [row] = await tx
      .insert(jobOffers)
      .values({
        institutionId: tenant,
        applicantId: applicant.id,
        designation: d.designation ?? req!.designation,
        department: d.department ?? req!.department,
        employment: d.employment,
        monthlyPaise: d.monthly,
        joiningOn: d.joiningOn,
        expiresOn: d.expiresOn,
        issuedBy: actor.id,
      })
      .returning()
    await tx.update(jobApplicants).set({ status: 'offered' }).where(eq(jobApplicants.id, applicant.id))
    return row!
  })
}

/** The candidate's answer, recorded by the desk. An expired offer cannot be accepted. */
export async function respondToOffer(actor: Actor, input: unknown) {
  const tenant = requireHr(actor)
  const d = respondToOfferSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [offer] = await tx.select().from(jobOffers).where(eq(jobOffers.id, d.offerId))
    if (!offer) throw new HrError(404, 'no_such_offer', 'no such offer')
    if (offer.status !== 'issued') {
      throw new HrError(409, 'already_answered', `that offer is already ${offer.status}`)
    }
    if (d.accept && offer.expiresOn < today()) {
      throw new HrError(409, 'offer_expired', `that offer expired on ${offer.expiresOn}`)
    }
    const [updated] = await tx
      .update(jobOffers)
      .set({ status: d.accept ? 'accepted' : 'declined', respondedAt: new Date() })
      .where(eq(jobOffers.id, offer.id))
      .returning()
    if (!d.accept) {
      await tx
        .update(jobApplicants)
        .set({ status: 'withdrawn' })
        .where(eq(jobApplicants.id, offer.applicantId))
    }
    return updated!
  })
}

export async function withdrawOffer(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = withdrawOfferSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [offer] = await tx.select().from(jobOffers).where(eq(jobOffers.id, d.offerId))
    if (!offer) throw new HrError(404, 'no_such_offer', 'no such offer')
    if (offer.staffId) throw new HrError(409, 'already_hired', 'that offer has already become a hire')
    if (offer.status !== 'issued' && offer.status !== 'accepted') {
      throw new HrError(409, 'not_standing', `that offer is already ${offer.status}`)
    }
    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: 'hr.offer_withdrawn',
      entity: 'hr_job_offers',
      entityId: offer.id,
      reason: d.reason,
      detail: { applicantId: offer.applicantId, was: offer.status },
    })
    const [updated] = await tx
      .update(jobOffers)
      .set({ status: 'withdrawn', respondedAt: offer.respondedAt ?? new Date() })
      .where(eq(jobOffers.id, offer.id))
      .returning()
    await tx
      .update(jobApplicants)
      .set({ status: 'rejected' })
      .where(eq(jobApplicants.id, offer.applicantId))
    return updated!
  })
}

/**
 * The accepted offer becomes a staff record, in one transaction: the record,
 * the link back to the offer, the applicant marked hired, the requisition
 * marked filled once every position is, and -- if asked -- their onboarding
 * started. Pay is not set here: the offer's figure is the term agreed, and the
 * salary structure that delivers it is its own decision.
 */
export async function hire(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = hireSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [offer] = await tx.select().from(jobOffers).where(eq(jobOffers.id, d.offerId))
    if (!offer) throw new HrError(404, 'no_such_offer', 'no such offer')
    if (offer.status !== 'accepted') {
      throw new HrError(409, 'not_accepted', `that offer is ${offer.status}, not accepted`)
    }
    if (offer.staffId) throw new HrError(409, 'already_hired', 'that offer has already become a hire')

    const [applicant] = await tx.select().from(jobApplicants).where(eq(jobApplicants.id, offer.applicantId))
    const [opening] = await tx.select().from(jobOpenings).where(eq(jobOpenings.id, applicant!.openingId))
    const [req] = await tx
      .select()
      .from(jobRequisitions)
      .where(eq(jobRequisitions.id, opening!.requisitionId))

    const hires = await hiresByRequisition(tx)
    if ((hires.get(req!.id) ?? 0) >= req!.positions) {
      throw new HrError(409, 'filled', 'every position on that requisition is already filled')
    }

    const [person] = await tx
      .insert(staff)
      .values({
        institutionId: tenant,
        employeeCode: d.employeeCode,
        name: applicant!.name,
        email: applicant!.email,
        phone: applicant!.phone,
        designation: offer.designation,
        department: offer.department,
        employment: offer.employment,
        joinedOn: offer.joiningOn,
      })
      .onConflictDoNothing()
      .returning()
    if (!person) throw new HrError(409, 'exists', 'that employee code is already on record')

    await tx.update(jobOffers).set({ staffId: person.id }).where(eq(jobOffers.id, offer.id))
    await tx.update(jobApplicants).set({ status: 'hired' }).where(eq(jobApplicants.id, applicant!.id))

    if ((hires.get(req!.id) ?? 0) + 1 >= req!.positions) {
      await tx.update(jobRequisitions).set({ status: 'filled' }).where(eq(jobRequisitions.id, req!.id))
      await tx
        .update(jobOpenings)
        .set({ closedAt: new Date() })
        .where(and(eq(jobOpenings.requisitionId, req!.id), isNull(jobOpenings.closedAt)))
    }

    const onboarding = d.onboardingTemplateId
      ? await onboardIn(tx, tenant, person.id, d.onboardingTemplateId, today())
      : null

    return { staff: person, offerId: offer.id, onboarding }
  })
}
