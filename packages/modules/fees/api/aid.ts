import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { audit, users, withTenant } from '@campusos/db'
import { moduleEnabled } from '@campusos/module-framework'
import { degreeAudit, type Actor as Academic } from '@campusos/module-academic/api'
import { sectionMembers, sections, terms } from '@campusos/module-academic/schema'
import { manifest as enrollmentManifest } from '@campusos/module-enrollment/manifest'
import { creditLoad, listRegistrationEvents } from '@campusos/module-enrollment/api'
import { manifest as feesManifest } from '../manifest'
import {
  dropCredits,
  feeItems,
  refundRules,
  scholarshipAwards,
  scholarships,
} from '../schema'
import { FeeError, requireAdmin, type Actor } from './operations'
import {
  assessAidSchema,
  awardScholarshipSchema,
  createScholarshipSchema,
  prorateDropsSchema,
  revokeAwardSchema,
  setRefundRulesSchema,
  type AidAssessment,
} from './schemas'
import { postDropCredit, postScholarship } from './posting'

/**
 * Student financials: the aid an institution funds itself, and what a course
 * dropped inside the window is worth back.
 *
 * Only institution-funded scholarships are modelled. Government and state
 * schemes are not, and that is a decision rather than an omission: their
 * eligibility is statutory, it changes by notification, and a plausible guess
 * at it produces a number that looks right and is not. An institution
 * administering one records the outcome here as an ordinary award with the
 * scheme named on it, and works the eligibility out where the rules actually
 * live.
 */

const MODULE = 'fees'

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]

/**
 * Whether registration is being kept in the product at all. A soft dependency:
 * an institution that registers students on paper still awards scholarships,
 * and still has fee items -- what it does not have is a credit load anybody can
 * compute, so a rule that asks for one cannot be assessed rather than being
 * quietly assumed to pass.
 */
const registrationIsKept = (institutionId: string) =>
  moduleEnabled([feesManifest, enrollmentManifest], 'enrollment', institutionId)

const asAcademic = (a: Actor): Academic => ({
  id: a.id,
  role: a.role,
  institutionId: a.institutionId,
})

/** The programmes this student is taught in, which is what they are charged for. */
async function programsOf(tx: Tx, studentId: string): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ programId: sections.programId })
    .from(sectionMembers)
    .innerJoin(sections, eq(sections.id, sectionMembers.sectionId))
    .where(eq(sectionMembers.userId, studentId))
  return rows.map((r) => r.programId)
}

/** What a term's charges come to for this student, gross of anything forgiven. */
async function chargedPaise(
  tx: Tx,
  studentId: string,
  termId: string,
  proratableOnly = false,
): Promise<number> {
  const progs = await programsOf(tx, studentId)
  if (progs.length === 0) return 0

  const [row] = await tx
    .select({ total: sql<number>`coalesce(sum(${feeItems.amountPaise}), 0)::bigint` })
    .from(feeItems)
    .where(
      and(
        eq(feeItems.termId, termId),
        inArray(feeItems.programId, progs),
        proratableOnly ? eq(feeItems.proratable, true) : undefined,
      ),
    )
  return Number(row?.total ?? 0)
}

// --- the rules an institution writes down ----------------------------------

export async function createScholarship(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const data = createScholarshipSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [row] = await tx
      .insert(scholarships)
      .values({
        institutionId: tenant,
        code: data.code,
        name: data.name,
        kind: data.kind,
        basis: data.basis,
        amountPaise: data.basis === 'fixed' ? (data.amountPaise ?? null) : null,
        percentBps: data.basis === 'proportional' ? (data.percentBps ?? null) : null,
        minCredits: data.minCredits,
        minCgpa: data.minCgpa === undefined ? null : data.minCgpa.toFixed(2),
      })
      .onConflictDoNothing()
      .returning()
    if (!row) throw new FeeError(409, 'code_taken', `scholarship ${data.code} exists`)
    return row
  })
}

export async function listScholarships(actor: Actor) {
  const tenant = requireAdmin(actor)
  return withTenant(tenant, (tx) =>
    tx.select().from(scholarships).orderBy(asc(scholarships.code)),
  )
}

// --- who qualifies ---------------------------------------------------------

/**
 * Every live scholarship, and whether this student qualifies for it this term.
 *
 * Computed from what the product actually knows -- registered credits and the
 * cumulative average on the academic record -- rather than entered by hand. An
 * unknown is reported as an unknown: a rule asking for twelve credits at an
 * institution not keeping registrations is unassessable, and saying so is the
 * only honest answer. Awarding it anyway would be a number nobody could defend.
 */
export async function assessAid(actor: Actor, input: unknown): Promise<AidAssessment> {
  const tenant = requireAdmin(actor)
  const data = assessAidSchema.parse(input)

  const registration = await registrationIsKept(tenant)
  const load = registration
    ? await creditLoad(actor as never, { studentId: data.studentId, termId: data.termId })
    : null
  const record = await degreeAudit(asAcademic(actor), { studentId: data.studentId }).catch(
    () => null,
  )
  const cgpa = record?.cgpa ?? null

  return withTenant(tenant, async (tx): Promise<AidAssessment> => {
    const [student] = await tx
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, data.studentId))
    if (!student) throw new FeeError(404, 'no_such_user', 'no such user')

    const rules = await tx
      .select()
      .from(scholarships)
      .where(eq(scholarships.isActive, true))
      .orderBy(asc(scholarships.code))

    const held = await tx
      .select({ scholarshipId: scholarshipAwards.scholarshipId })
      .from(scholarshipAwards)
      .where(
        and(
          eq(scholarshipAwards.studentId, data.studentId),
          eq(scholarshipAwards.termId, data.termId),
          eq(scholarshipAwards.status, 'awarded'),
        ),
      )

    const charges = await chargedPaise(tx, data.studentId, data.termId)

    return {
      studentId: data.studentId,
      studentName: student.name ?? null,
      termId: data.termId,
      credits: load?.credits ?? null,
      cgpa,
      chargedPaise: charges,
      offers: rules.map((r) => {
        const why: string[] = []
        if (held.some((h) => h.scholarshipId === r.id)) why.push('already_awarded')
        if (r.minCredits > 0) {
          if (load === null) why.push('credit_load_unknown')
          else if (load.credits < r.minCredits) why.push('below_minimum_credits')
        }
        if (r.minCgpa !== null) {
          if (cgpa === null) why.push('no_grades_yet')
          else if (cgpa < Number(r.minCgpa)) why.push('below_minimum_average')
        }

        const amountPaise =
          r.basis === 'fixed'
            ? (r.amountPaise ?? 0)
            : Math.round((charges * (r.percentBps ?? 0)) / 10000)
        if (amountPaise <= 0) why.push('nothing_to_award')

        return {
          scholarshipId: r.id,
          code: r.code,
          name: r.name,
          kind: r.kind,
          amountPaise,
          eligible: why.length === 0,
          reasons: why,
        }
      }),
    }
  })
}

/**
 * Award it, and tell the books.
 *
 * The amount is settled here and frozen on the row. A proportional award is a
 * share of what the student was charged when it was granted, and re-deriving it
 * after a supplementary charge would silently change an award somebody was told
 * about in writing.
 */
export async function awardScholarship(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const data = awardScholarshipSchema.parse(input)

  const assessment = await assessAid(actor, {
    studentId: data.studentId,
    termId: data.termId,
  })
  const offer = assessment.offers.find((o) => o.scholarshipId === data.scholarshipId)
  if (!offer) throw new FeeError(404, 'no_such_scholarship', 'no such live scholarship')
  if (!offer.eligible) {
    throw new FeeError(
      409,
      'not_eligible',
      `not eligible: ${offer.reasons.join(', ')}`,
    )
  }

  return withTenant(tenant, async (tx) => {
    const [term] = await tx
      .select({ code: terms.code })
      .from(terms)
      .where(eq(terms.id, data.termId))
    if (!term) throw new FeeError(404, 'no_such_term', 'no such term')

    const [row] = await tx
      .insert(scholarshipAwards)
      .values({
        institutionId: tenant,
        scholarshipId: data.scholarshipId,
        studentId: data.studentId,
        termId: data.termId,
        amountPaise: offer.amountPaise,
        creditsAtAward: assessment.credits,
        cgpaAtAward: assessment.cgpa === null ? null : assessment.cgpa.toFixed(2),
        reason: data.reason ?? null,
        awardedBy: actor.id,
      })
      .onConflictDoNothing()
      .returning()
    if (!row) throw new FeeError(409, 'already_awarded', 'already awarded this term')

    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: 'scholarship.awarded',
      entity: 'fee_scholarship_awards',
      entityId: row.id,
      reason: data.reason ?? `${offer.code} awarded`,
      detail: {
        scholarship: offer.code,
        amountPaise: offer.amountPaise,
        credits: assessment.credits,
        cgpa: assessment.cgpa,
      },
    })

    await postScholarship(tx, tenant, actor.id, {
      id: row.id,
      studentName: assessment.studentName,
      termCode: term.code,
      scholarshipName: offer.name,
      amountPaise: offer.amountPaise,
    })

    return row
  })
}

/** Taken away, with a reason and a reversal. Never deleted. */
export async function revokeAward(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const data = revokeAwardSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const [award] = await tx
      .select({
        id: scholarshipAwards.id,
        status: scholarshipAwards.status,
        amountPaise: scholarshipAwards.amountPaise,
        studentName: users.name,
        termCode: terms.code,
        scholarshipName: scholarships.name,
      })
      .from(scholarshipAwards)
      .innerJoin(users, eq(users.id, scholarshipAwards.studentId))
      .innerJoin(terms, eq(terms.id, scholarshipAwards.termId))
      .innerJoin(scholarships, eq(scholarships.id, scholarshipAwards.scholarshipId))
      .where(eq(scholarshipAwards.id, data.awardId))
    if (!award) throw new FeeError(404, 'no_such_award', 'no such award')
    if (award.status === 'revoked') {
      throw new FeeError(409, 'already_revoked', 'that award has already been revoked')
    }

    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: 'scholarship.revoked',
      entity: 'fee_scholarship_awards',
      entityId: award.id,
      reason: data.reason,
      detail: { amountPaise: award.amountPaise },
    })

    await tx
      .update(scholarshipAwards)
      .set({ status: 'revoked', revokedReason: data.reason })
      .where(eq(scholarshipAwards.id, award.id))

    await postScholarship(tx, tenant, actor.id, {
      id: award.id,
      studentName: award.studentName,
      termCode: award.termCode,
      scholarshipName: award.scholarshipName,
      amountPaise: award.amountPaise,
      reversing: true,
    })

    return { id: award.id, status: 'revoked' as const }
  })
}

export async function listAwards(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const data = prorateDropsSchema.parse(input)
  return withTenant(tenant, (tx) =>
    tx
      .select({
        id: scholarshipAwards.id,
        studentId: scholarshipAwards.studentId,
        studentName: users.name,
        code: scholarships.code,
        name: scholarships.name,
        amountPaise: scholarshipAwards.amountPaise,
        status: scholarshipAwards.status,
        creditsAtAward: scholarshipAwards.creditsAtAward,
        cgpaAtAward: scholarshipAwards.cgpaAtAward,
        revokedReason: scholarshipAwards.revokedReason,
      })
      .from(scholarshipAwards)
      .innerJoin(users, eq(users.id, scholarshipAwards.studentId))
      .innerJoin(scholarships, eq(scholarships.id, scholarshipAwards.scholarshipId))
      .where(
        data.studentId
          ? and(
              eq(scholarshipAwards.termId, data.termId),
              eq(scholarshipAwards.studentId, data.studentId),
            )
          : eq(scholarshipAwards.termId, data.termId),
      )
      .orderBy(asc(users.email), asc(scholarships.code)),
  )
}

// --- what a drop is worth back ---------------------------------------------

/**
 * The refund brackets for a term, replaced as a set.
 *
 * As a set rather than one at a time because a bracket only means anything
 * beside the others: "all of it through the 14th, three quarters through the
 * 28th, none after" is one policy, and editing it a row at a time leaves a
 * moment when it says something nobody decided.
 */
export async function setRefundRules(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const data = setRefundRulesSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const [term] = await tx.select({ id: terms.id }).from(terms).where(eq(terms.id, data.termId))
    if (!term) throw new FeeError(404, 'no_such_term', 'no such term')

    await tx.delete(refundRules).where(eq(refundRules.termId, data.termId))
    if (data.brackets.length === 0) return []

    return tx
      .insert(refundRules)
      .values(
        data.brackets.map((b) => ({
          institutionId: tenant,
          termId: data.termId,
          throughOn: b.throughOn,
          refundBps: b.refundBps,
        })),
      )
      .returning()
  })
}

export async function listRefundRules(actor: Actor, termId: string) {
  const tenant = requireAdmin(actor)
  return withTenant(tenant, (tx) =>
    tx
      .select()
      .from(refundRules)
      .where(eq(refundRules.termId, termId))
      .orderBy(asc(refundRules.throughOn)),
  )
}

/**
 * Work the term's drops into credits, once each.
 *
 * The share is the dropped credits against everything the student was carrying
 * when the term's charges were worked out -- what they still carry plus what
 * they have dropped -- so dropping one course of four returns a quarter of the
 * proratable charges, times whatever the bracket the drop date falls in allows.
 *
 * Only proratable lines move. A registration or examination fee is not returned
 * because somebody dropped a paper, and defaulting that flag to false is the
 * safe direction: refunding nothing is an argument, refunding wrongly is an
 * audit finding.
 *
 * Idempotent per offering, because this is a sweep somebody runs over a term
 * and a sweep that double-credits is worse than one nobody runs.
 */
export async function prorateDrops(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const data = prorateDropsSchema.parse(input)

  if (!(await registrationIsKept(tenant))) {
    throw new FeeError(
      409,
      'registration_not_kept',
      'there is nothing to prorate: this institution does not keep registrations in the product',
    )
  }

  const events = await listRegistrationEvents(actor as never, {
    termId: data.termId,
    studentId: data.studentId,
  })
  const departures = events.filter((e) => e.kind === 'dropped' || e.kind === 'withdrawn')

  return withTenant(tenant, async (tx) => {
    const [term] = await tx
      .select({ code: terms.code })
      .from(terms)
      .where(eq(terms.id, data.termId))
    if (!term) throw new FeeError(404, 'no_such_term', 'no such term')

    const brackets = await tx
      .select({ throughOn: refundRules.throughOn, refundBps: refundRules.refundBps })
      .from(refundRules)
      .where(eq(refundRules.termId, data.termId))
      .orderBy(asc(refundRules.throughOn))

    const already = await tx
      .select({ studentId: dropCredits.studentId, offeringId: dropCredits.offeringId })
      .from(dropCredits)
      .where(eq(dropCredits.termId, data.termId))

    const credited: {
      studentId: string
      courseCode: string
      amountPaise: number
      refundBps: number
    }[] = []
    let skipped = 0

    for (const event of departures) {
      if (already.some((a) => a.studentId === event.studentId && a.offeringId === event.offeringId)) {
        skipped++
        continue
      }

      // The first bracket the drop date falls within. Past every bracket, the
      // charge is kept in full and there is nothing to record.
      const bracket = brackets.find((b) => event.effectiveOn <= b.throughOn)
      if (!bracket || bracket.refundBps === 0) {
        skipped++
        continue
      }

      const load = await creditLoad(actor as never, {
        studentId: event.studentId,
        termId: data.termId,
      })
      const droppedHere = events
        .filter(
          (e) =>
            e.studentId === event.studentId &&
            (e.kind === 'dropped' || e.kind === 'withdrawn'),
        )
        .reduce((n, e) => n + e.credits, 0)
      const carried = load.credits + droppedHere
      if (carried === 0) {
        skipped++
        continue
      }

      const proratable = await chargedPaise(tx, event.studentId, data.termId, true)
      const amountPaise = Math.round(
        (proratable * event.credits * bracket.refundBps) / (carried * 10000),
      )
      if (amountPaise <= 0) {
        skipped++
        continue
      }

      const [row] = await tx
        .insert(dropCredits)
        .values({
          institutionId: tenant,
          studentId: event.studentId,
          termId: data.termId,
          offeringId: event.offeringId,
          creditsDropped: event.credits,
          effectiveOn: event.effectiveOn,
          refundBps: bracket.refundBps,
          amountPaise,
        })
        .onConflictDoNothing()
        .returning()
      if (!row) {
        skipped++
        continue
      }

      const [student] = await tx
        .select({ name: users.name })
        .from(users)
        .where(eq(users.id, event.studentId))

      await postDropCredit(tx, tenant, actor.id, {
        id: row.id,
        studentName: student?.name ?? null,
        termCode: term.code,
        courseCode: event.courseCode,
        effectiveOn: event.effectiveOn,
        amountPaise,
      })

      credited.push({
        studentId: event.studentId,
        courseCode: event.courseCode,
        amountPaise,
        refundBps: bracket.refundBps,
      })
    }

    return { termCode: term.code, credited, skipped }
  })
}

export async function listDropCredits(actor: Actor, termId: string) {
  const tenant = requireAdmin(actor)
  return withTenant(tenant, (tx) =>
    tx
      .select({
        id: dropCredits.id,
        studentId: dropCredits.studentId,
        studentName: users.name,
        creditsDropped: dropCredits.creditsDropped,
        effectiveOn: dropCredits.effectiveOn,
        refundBps: dropCredits.refundBps,
        amountPaise: dropCredits.amountPaise,
      })
      .from(dropCredits)
      .innerJoin(users, eq(users.id, dropCredits.studentId))
      .where(eq(dropCredits.termId, termId))
      .orderBy(asc(users.email)),
  )
}
