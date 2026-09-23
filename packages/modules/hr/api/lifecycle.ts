import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'
import { audit, withTenant } from '@campusos/db'
import {
  employeeGrades,
  employmentChanges,
  onboardingActivities,
  onboardingTemplateActivities,
  onboardingTemplates,
  onboardings,
  separations,
  staff,
} from '../schema'
import {
  HrError,
  MODULE,
  requireAdmin,
  requireHr,
  shiftDays,
  today,
  type Actor,
  type Tx,
} from './guards'
import {
  completeActivitySchema,
  createGradeSchema,
  createOnboardingTemplateSchema,
  recordChangeSchema,
  recordExitInterviewSchema,
  separateSchema,
  startOnboardingSchema,
  type ChangeRow,
  type OnboardingView,
  type SeparationRow,
} from './schemas'

/**
 * The employment, over time.
 *
 * `hr_staff` says where somebody is now. Everything in this file says how they
 * got there and, eventually, how it ended -- because "what were they when they
 * signed that", "when were they confirmed" and "did anybody ask them why they
 * left" are ordinary questions here, and none of them can be answered by a row
 * that only remembers its latest value.
 */

// --- grades ----------------------------------------------------------------

export async function createGrade(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = createGradeSchema.parse(input)
  if (d.minPaise !== null && d.maxPaise !== null && d.maxPaise < d.minPaise) {
    throw new HrError(400, 'bad_band', 'the top of a grade cannot be below its floor')
  }

  return withTenant(tenant, async (tx) => {
    const [row] = await tx
      .insert(employeeGrades)
      .values({
        institutionId: tenant,
        code: d.code,
        name: d.name,
        rank: d.rank,
        minPaise: d.minPaise,
        maxPaise: d.maxPaise,
      })
      .onConflictDoNothing()
      .returning()
    if (!row) throw new HrError(409, 'exists', 'that grade code already exists')
    return row
  })
}

export async function listGrades(actor: Actor) {
  const tenant = requireHr(actor)
  return withTenant(tenant, (tx) =>
    tx
      .select()
      .from(employeeGrades)
      .orderBy(asc(employeeGrades.rank), asc(employeeGrades.code)),
  )
}

// --- onboarding ------------------------------------------------------------

export async function createOnboardingTemplate(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = createOnboardingTemplateSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const [row] = await tx
      .insert(onboardingTemplates)
      .values({ institutionId: tenant, code: d.code, name: d.name, note: d.note ?? null })
      .onConflictDoNothing()
      .returning()
    if (!row) throw new HrError(409, 'exists', 'that template code already exists')

    await tx.insert(onboardingTemplateActivities).values(
      d.activities.map((a, i) => ({
        institutionId: tenant,
        templateId: row.id,
        seq: i + 1,
        title: a.title,
        owner: a.owner,
        dueDayOffset: a.dueDayOffset,
      })),
    )

    return { ...row, activities: d.activities.length }
  })
}

export async function listOnboardingTemplates(actor: Actor) {
  const tenant = requireHr(actor)
  return withTenant(tenant, async (tx) => {
    const templates = await tx
      .select()
      .from(onboardingTemplates)
      .orderBy(asc(onboardingTemplates.code))
    if (templates.length === 0) return []

    const activities = await tx
      .select()
      .from(onboardingTemplateActivities)
      .orderBy(asc(onboardingTemplateActivities.seq))

    return templates.map((t) => ({
      ...t,
      activities: activities.filter((a) => a.templateId === t.id),
    }))
  })
}

/**
 * Put somebody through a checklist.
 *
 * The template's rows are copied, not referenced: editing the checklist next
 * year must not rewrite what this person was actually asked to do, and a
 * template deleted afterwards must not take their history with it.
 *
 * Due dates are computed from the joining date rather than from today, so an
 * onboarding started late is visibly late instead of quietly on time.
 */
export async function startOnboarding(actor: Actor, input: unknown) {
  const tenant = requireHr(actor)
  const d = startOnboardingSchema.parse(input)
  return withTenant(tenant, (tx) =>
    onboardIn(tx, tenant, d.staffId, d.templateId, d.startedOn ?? today()),
  )
}

/** The same, inside a transaction somebody else opened -- hiring, for one. */
export async function onboardIn(
  tx: Tx,
  tenant: string,
  staffId: string,
  templateId: string,
  startedOn: string,
) {
  const [person] = await tx.select().from(staff).where(eq(staff.id, staffId))
  if (!person) throw new HrError(404, 'no_such_staff', 'no such staff record')

  const [template] = await tx
    .select()
    .from(onboardingTemplates)
    .where(eq(onboardingTemplates.id, templateId))
  if (!template) throw new HrError(404, 'no_such_template', 'no such onboarding template')

  const steps = await tx
    .select()
    .from(onboardingTemplateActivities)
    .where(eq(onboardingTemplateActivities.templateId, template.id))
    .orderBy(asc(onboardingTemplateActivities.seq))
  if (steps.length === 0) {
    throw new HrError(400, 'empty_template', 'that template has no activities')
  }

  const [run] = await tx
    .insert(onboardings)
    .values({
      institutionId: tenant,
      staffId: person.id,
      templateCode: template.code,
      templateName: template.name,
      startedOn,
    })
    .onConflictDoNothing()
    .returning()
  if (!run) {
    throw new HrError(409, 'already_onboarding', 'that person is already being onboarded')
  }

  await tx.insert(onboardingActivities).values(
    steps.map((s) => ({
      institutionId: tenant,
      onboardingId: run.id,
      seq: s.seq,
      title: s.title,
      owner: s.owner,
      dueOn: shiftDays(person.joinedOn, s.dueDayOffset),
    })),
  )

  return { ...run, activities: steps.length }
}

export async function completeOnboardingActivity(actor: Actor, input: unknown) {
  const tenant = requireHr(actor)
  const d = completeActivitySchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const [row] = await tx
      .select()
      .from(onboardingActivities)
      .where(eq(onboardingActivities.id, d.activityId))
    if (!row) throw new HrError(404, 'no_such_activity', 'no such onboarding activity')
    if (row.doneAt) throw new HrError(409, 'already_done', 'that activity is already done')

    const [updated] = await tx
      .update(onboardingActivities)
      .set({ doneAt: new Date(), doneBy: actor.id, note: d.note ?? null })
      .where(eq(onboardingActivities.id, d.activityId))
      .returning()
    return updated!
  })
}

async function onboardingViewFor(tx: Tx, staffId: string): Promise<OnboardingView | null> {
  const [run] = await tx.select().from(onboardings).where(eq(onboardings.staffId, staffId))
  if (!run) return null

  const activities = await tx
    .select()
    .from(onboardingActivities)
    .where(eq(onboardingActivities.onboardingId, run.id))
    .orderBy(asc(onboardingActivities.seq))

  const now = today()
  return {
    id: run.id,
    staffId: run.staffId,
    templateCode: run.templateCode,
    templateName: run.templateName,
    startedOn: run.startedOn,
    completedAt: run.completedAt ? run.completedAt.toISOString() : null,
    outstanding: activities.filter((a) => !a.doneAt).length,
    activities: activities.map((a) => ({
      id: a.id,
      seq: a.seq,
      title: a.title,
      owner: a.owner,
      dueOn: a.dueOn,
      doneAt: a.doneAt ? a.doneAt.toISOString() : null,
      note: a.note,
      overdue: !a.doneAt && a.dueOn < now,
    })),
  }
}

export async function onboardingFor(actor: Actor, staffId: string) {
  const tenant = requireHr(actor)
  return withTenant(tenant, (tx) => onboardingViewFor(tx, staffId))
}

/** Everything still open, across everybody. The HR desk's actual worklist. */
export async function openOnboardings(actor: Actor) {
  const tenant = requireHr(actor)
  const now = today()

  return withTenant(tenant, async (tx) => {
    const rows = await tx
      .select({
        activityId: onboardingActivities.id,
        staffId: onboardings.staffId,
        staffName: staff.name,
        employeeCode: staff.employeeCode,
        templateName: onboardings.templateName,
        seq: onboardingActivities.seq,
        title: onboardingActivities.title,
        owner: onboardingActivities.owner,
        dueOn: onboardingActivities.dueOn,
      })
      .from(onboardingActivities)
      .innerJoin(onboardings, eq(onboardings.id, onboardingActivities.onboardingId))
      .innerJoin(staff, eq(staff.id, onboardings.staffId))
      .where(isNull(onboardingActivities.doneAt))
      .orderBy(asc(onboardingActivities.dueOn), asc(staff.employeeCode))
      .limit(300)

    return rows.map((r) => ({ ...r, overdue: r.dueOn < now }))
  })
}

// --- transfer, promotion, confirmation -------------------------------------

/**
 * One dated change to somebody's post, applied to the staff record and kept.
 *
 * The from-columns are snapshotted here rather than joined later, so the
 * history still reads correctly after a grade is renamed or removed. What the
 * caller omits does not change: a transfer that moves a department leaves the
 * designation exactly where it was.
 */
export async function recordChange(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = recordChangeSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const [person] = await tx.select().from(staff).where(eq(staff.id, d.staffId))
    if (!person) throw new HrError(404, 'no_such_staff', 'no such staff record')
    if (person.leftOn) {
      throw new HrError(
        409,
        'employment_ended',
        `that employment ended on ${person.leftOn}`,
      )
    }
    // The trigger refuses this too; asking first means the caller is told in a
    // sentence rather than handed the insert statement (decision 110).
    if (d.effectiveOn < person.joinedOn) {
      throw new HrError(
        400,
        'before_joining',
        `nothing about an employment changes before it began on ${person.joinedOn}`,
      )
    }

    const fromGrade = person.gradeId
      ? ((await tx
          .select()
          .from(employeeGrades)
          .where(eq(employeeGrades.id, person.gradeId)))[0] ?? null)
      : null

    let toGrade = null
    if (d.toGradeId) {
      const [g] = await tx
        .select()
        .from(employeeGrades)
        .where(eq(employeeGrades.id, d.toGradeId))
      if (!g) throw new HrError(404, 'no_such_grade', 'no such grade')
      toGrade = g
    }

    const [change] = await tx
      .insert(employmentChanges)
      .values({
        institutionId: tenant,
        staffId: person.id,
        kind: d.kind,
        effectiveOn: d.effectiveOn,
        fromDesignation: person.designation,
        toDesignation: d.toDesignation ?? null,
        fromDepartment: person.department,
        toDepartment: d.toDepartment ?? null,
        fromGrade: fromGrade?.code ?? null,
        toGradeId: toGrade?.id ?? null,
        toGrade: toGrade?.code ?? null,
        fromEmployment: person.employment,
        toEmployment: d.toEmployment ?? null,
        reason: d.reason,
        decidedBy: actor.id,
      })
      .returning()

    const [updated] = await tx
      .update(staff)
      .set({
        designation: d.toDesignation ?? person.designation,
        department: d.toDepartment ?? person.department,
        gradeId: toGrade?.id ?? person.gradeId,
        employment: d.toEmployment ?? person.employment,
      })
      .where(eq(staff.id, person.id))
      .returning()

    return { change: change!, staff: updated! }
  })
}

const changeColumns = {
  id: employmentChanges.id,
  staffId: employmentChanges.staffId,
  staffName: staff.name,
  employeeCode: staff.employeeCode,
  kind: employmentChanges.kind,
  effectiveOn: employmentChanges.effectiveOn,
  fromDesignation: employmentChanges.fromDesignation,
  toDesignation: employmentChanges.toDesignation,
  fromDepartment: employmentChanges.fromDepartment,
  toDepartment: employmentChanges.toDepartment,
  fromGrade: employmentChanges.fromGrade,
  toGrade: employmentChanges.toGrade,
  fromEmployment: employmentChanges.fromEmployment,
  toEmployment: employmentChanges.toEmployment,
  reason: employmentChanges.reason,
}

export async function listChanges(actor: Actor, staffId?: string): Promise<ChangeRow[]> {
  const tenant = requireHr(actor)
  return withTenant(tenant, async (tx) => {
    const rows = await tx
      .select(changeColumns)
      .from(employmentChanges)
      .innerJoin(staff, eq(staff.id, employmentChanges.staffId))
      .where(staffId ? eq(employmentChanges.staffId, staffId) : undefined)
      .orderBy(desc(employmentChanges.effectiveOn), desc(employmentChanges.createdAt))
      .limit(300)
    return rows as ChangeRow[]
  })
}

// --- separation ------------------------------------------------------------

/**
 * Ending an employment, as one act.
 *
 * The leaving date, the change on the record and the separation are written
 * together because they are one fact. The database will not accept a
 * separation over a staff record that is still employed, or one that disagrees
 * with the leaving date, which is what stops the two from drifting apart the
 * first time somebody corrects only one of them.
 */
export async function separate(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = separateSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const [person] = await tx.select().from(staff).where(eq(staff.id, d.staffId))
    if (!person) throw new HrError(404, 'no_such_staff', 'no such staff record')
    if (person.leftOn) {
      throw new HrError(409, 'already_ended', 'that employment already ended')
    }
    if (d.lastDayOn < person.joinedOn) {
      throw new HrError(400, 'bad_dates', 'they cannot leave before they joined')
    }
    if (d.noticeGivenOn && d.noticeGivenOn > d.lastDayOn) {
      throw new HrError(400, 'bad_dates', 'notice cannot be given after the last day')
    }

    // Sets app.audit_reason for this transaction, which the triggers on
    // hr_staff read: a leaving date is not moved silently once it exists.
    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: 'hr.separated',
      entity: 'hr_staff',
      entityId: person.id,
      reason: d.reason,
      detail: {
        employeeCode: person.employeeCode,
        name: person.name,
        kind: d.kind,
        lastDayOn: d.lastDayOn,
      },
    })

    await tx.update(staff).set({ leftOn: d.lastDayOn }).where(eq(staff.id, person.id))

    const [change] = await tx
      .insert(employmentChanges)
      .values({
        institutionId: tenant,
        staffId: person.id,
        kind: 'separation',
        effectiveOn: d.lastDayOn,
        fromDesignation: person.designation,
        fromDepartment: person.department,
        fromEmployment: person.employment,
        reason: d.reason,
        decidedBy: actor.id,
      })
      .returning()

    const [row] = await tx
      .insert(separations)
      .values({
        institutionId: tenant,
        staffId: person.id,
        changeId: change!.id,
        kind: d.kind,
        noticeGivenOn: d.noticeGivenOn ?? null,
        lastDayOn: d.lastDayOn,
        reason: d.reason,
      })
      .returning()

    return row!
  })
}

/**
 * The conversation after the decision.
 *
 * Separate from the separation itself because it happens later, sometimes
 * never, and the difference between "nobody asked" and "asked, nothing to
 * report" is worth being able to see.
 */
export async function recordExitInterview(actor: Actor, input: unknown) {
  const tenant = requireHr(actor)
  const d = recordExitInterviewSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const [row] = await tx
      .select()
      .from(separations)
      .where(eq(separations.staffId, d.staffId))
    if (!row) throw new HrError(404, 'no_such_separation', 'that employment has not ended')
    if (row.exitInterviewOn) {
      throw new HrError(409, 'already_interviewed', 'that exit interview is already recorded')
    }
    // Before the last day is the usual time to hold one. Before notice was even
    // given is a typo, not a sequence of events.
    if (row.noticeGivenOn && d.on < row.noticeGivenOn) {
      throw new HrError(400, 'bad_dates', 'that interview predates the notice')
    }

    const [updated] = await tx
      .update(separations)
      .set({
        exitInterviewOn: d.on,
        exitInterviewBy: actor.id,
        exitInterviewNotes: d.notes,
        rehireEligible: d.rehireEligible,
      })
      .where(eq(separations.id, row.id))
      .returning()
    return updated!
  })
}

export async function listSeparations(actor: Actor): Promise<SeparationRow[]> {
  const tenant = requireHr(actor)
  return withTenant(tenant, async (tx) => {
    const rows = await tx
      .select({
        id: separations.id,
        staffId: separations.staffId,
        staffName: staff.name,
        employeeCode: staff.employeeCode,
        kind: separations.kind,
        noticeGivenOn: separations.noticeGivenOn,
        lastDayOn: separations.lastDayOn,
        reason: separations.reason,
        exitInterviewOn: separations.exitInterviewOn,
        exitInterviewNotes: separations.exitInterviewNotes,
        rehireEligible: separations.rehireEligible,
      })
      .from(separations)
      .innerJoin(staff, eq(staff.id, separations.staffId))
      .orderBy(desc(separations.lastDayOn))
      .limit(300)

    return rows.map((r) => ({ ...r, interviewPending: r.exitInterviewOn === null }))
  })
}

/**
 * How long somebody has served, in whole days, to a given date.
 *
 * Here rather than in payroll because gratuity, notice periods and long-service
 * recognition all ask the same question, and a second implementation that
 * counted the last day differently would be a quiet source of disagreement.
 */
export async function serviceDays(actor: Actor, staffId: string, on?: string) {
  const tenant = requireHr(actor)
  const upTo = on ?? today()

  return withTenant(tenant, async (tx) => {
    const [person] = await tx.select().from(staff).where(eq(staff.id, staffId))
    if (!person) throw new HrError(404, 'no_such_staff', 'no such staff record')

    const end = person.leftOn && person.leftOn < upTo ? person.leftOn : upTo
    const days = Math.max(
      0,
      Math.round(
        (new Date(`${end}T00:00:00Z`).getTime() -
          new Date(`${person.joinedOn}T00:00:00Z`).getTime()) /
          86_400_000,
      ),
    )
    return { staffId, joinedOn: person.joinedOn, to: end, days }
  })
}

/** Grades with how many people are on each. The scale, as it is actually used. */
export async function gradeUsage(actor: Actor) {
  const tenant = requireHr(actor)
  return withTenant(tenant, async (tx) => {
    const rows = await tx
      .select({
        id: employeeGrades.id,
        code: employeeGrades.code,
        name: employeeGrades.name,
        rank: employeeGrades.rank,
        minPaise: employeeGrades.minPaise,
        maxPaise: employeeGrades.maxPaise,
        people: sql<number>`count(${staff.id}) filter (where ${staff.leftOn} is null)::int`,
      })
      .from(employeeGrades)
      .leftJoin(staff, eq(staff.gradeId, employeeGrades.id))
      .groupBy(
        employeeGrades.id,
        employeeGrades.code,
        employeeGrades.name,
        employeeGrades.rank,
        employeeGrades.minPaise,
        employeeGrades.maxPaise,
      )
      .orderBy(asc(employeeGrades.rank), asc(employeeGrades.code))
    return rows
  })
}

/** Everybody who left, and whether anybody has spoken to them since. */
export async function exitInterviewsOutstanding(actor: Actor) {
  const tenant = requireHr(actor)
  return withTenant(tenant, (tx) =>
    tx
      .select({
        staffId: separations.staffId,
        staffName: staff.name,
        employeeCode: staff.employeeCode,
        lastDayOn: separations.lastDayOn,
        kind: separations.kind,
      })
      .from(separations)
      .innerJoin(staff, eq(staff.id, separations.staffId))
      .where(and(isNull(separations.exitInterviewOn), sql`${separations.kind} <> 'death'`))
      .orderBy(asc(separations.lastDayOn))
      .limit(200),
  )
}
