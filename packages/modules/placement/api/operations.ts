import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { users, withTenant } from '@campusos/db'
import { courseCompletions, programs, studentPrograms } from '@campusos/module-academic/schema'
import { applications, companies, drives, offers, officers, results, rounds } from '../schema'
import { ADMIN, DomainError, log, person, tenant, type Actor, type Tx } from './core'
import * as schemas from './schemas'

async function officer(tx: Tx, actor: Actor) {
  const current = await person(tx, actor.id)
  if (ADMIN.includes(current.role)) return
  if (!['faculty', 'hod'].includes(current.role)) throw new DomainError(403, 'forbidden', 'A placement officer is required.')
  const [appointment] = await tx.select().from(officers).where(and(eq(officers.userId, actor.id), eq(officers.active, true)))
  if (!appointment) throw new DomainError(403, 'forbidden', 'An appointed placement officer is required.')
}

async function driveFor(tx: Tx, driveId: string) {
  const [drive] = await tx.select().from(drives).where(eq(drives.id, driveId)).for('update')
  if (!drive) throw new DomainError(404, 'no_such_drive', 'No matching drive in this institution.')
  return drive
}

async function applicationFor(tx: Tx, applicationId: string) {
  const [application] = await tx.select().from(applications).where(eq(applications.id, applicationId)).for('update')
  if (!application) throw new DomainError(404, 'no_such_application', 'No matching application in this institution.')
  return application
}

function writer<T>(actor: Actor, run: (tx: Tx, institutionId: string) => Promise<T>) {
  const institutionId = tenant(actor, [...ADMIN, 'faculty', 'hod'])
  return withTenant(institutionId, async (tx) => {
    await officer(tx, actor)
    return run(tx, institutionId)
  })
}

export async function setOfficer(actor: Actor, input: unknown) {
  const institutionId = tenant(actor, ADMIN)
  const data = schemas.officerSchema.parse(input)
  return withTenant(institutionId, async (tx) => {
    if (data.active) {
      const member = await person(tx, data.userId)
      if (![...ADMIN, 'faculty', 'hod'].includes(member.role)) throw new DomainError(400, 'not_staff', 'Appoint institutional teaching staff or administrators.')
      await tx.insert(officers).values({ institutionId, ...data }).onConflictDoUpdate({ target: [officers.institutionId, officers.userId], set: { active: true } })
    } else {
      const [appointment] = await tx.update(officers).set({ active: false }).where(eq(officers.userId, data.userId)).returning()
      if (!appointment) throw new DomainError(404, 'no_such_officer', 'No matching officer in this institution.')
    }
    await log(tx, actor, 'officer.changed', data.userId, data.active ? 'Appointed placement officer' : 'Revoked placement officer')
    return { notice: 'Placement officer updated.' }
  })
}

export async function createCompany(actor: Actor, input: unknown) {
  return writer(actor, async (tx, institutionId) => {
    const data = schemas.companySchema.parse(input)
    const [company] = await tx.insert(companies).values({ institutionId, ...data }).onConflictDoNothing().returning()
    if (!company) throw new DomainError(409, 'duplicate_company', 'That company already exists.')
    await log(tx, actor, 'company.created', company.id, `Added ${company.name}`)
    return { ...company, notice: 'Company added.' }
  })
}

export async function createDrive(actor: Actor, input: unknown) {
  return writer(actor, async (tx, institutionId) => {
    const data = schemas.driveSchema.parse(input)
    if (new Date(data.closesAt).getTime() <= Date.now()) throw new DomainError(400, 'past_deadline', 'The application deadline must be in the future.')
    const [company] = await tx.select().from(companies).where(eq(companies.id, data.companyId))
    if (!company) throw new DomainError(404, 'no_such_company', 'No matching company in this institution.')
    if (data.programId) {
      const [program] = await tx.select().from(programs).where(eq(programs.id, data.programId))
      if (!program) throw new DomainError(404, 'no_such_program', 'No matching programme in this institution.')
    }
    const [drive] = await tx.insert(drives).values({ institutionId, ...data, minCgpa: String(data.minCgpa), closesAt: new Date(data.closesAt) }).returning()
    await log(tx, actor, 'drive.created', drive!.id, `Drafted ${data.title}`)
    return { ...drive!, notice: 'Drive drafted. Open it when ready for applications.' }
  })
}

export async function changeDrive(actor: Actor, input: unknown) {
  return writer(actor, async (tx) => {
    const data = schemas.driveStateSchema.parse(input)
    const drive = await driveFor(tx, data.driveId)
    if (drive.status === data.status) return { notice: 'Drive already has that status.' }
    if ((data.status === 'open' && drive.status !== 'draft') || (data.status === 'closed' && drive.status !== 'open')) {
      throw new DomainError(409, 'invalid_transition', 'A draft opens once, then closes permanently.')
    }
    if (data.status === 'open' && drive.closesAt.getTime() <= Date.now()) throw new DomainError(409, 'past_deadline', 'The application deadline has passed.')
    await tx.update(drives).set({ status: data.status }).where(eq(drives.id, drive.id))
    await log(tx, actor, `drive.${data.status}`, drive.id, `Drive ${data.status}`)
    return { notice: `Drive ${data.status}.` }
  })
}

async function eligibility(tx: Tx, studentId: string, drive: typeof drives.$inferSelect) {
  const declarations = await tx.select().from(studentPrograms).where(and(eq(studentPrograms.studentId, studentId), inArray(studentPrograms.status, ['active', 'completed'])))
  if (!declarations.some((declaration) => !drive.programId || declaration.programId === drive.programId)) {
    throw new DomainError(409, 'wrong_program', 'An active or completed eligible programme is required.')
  }
  const record = await tx.select().from(courseCompletions).where(eq(courseCompletions.studentId, studentId))
  const passes = new Set(record.filter((completion) => completion.passed).map((completion) => completion.courseId))
  const backlogs = new Set(record.filter((completion) => !completion.passed && !passes.has(completion.courseId)).map((completion) => completion.courseId)).size
  const graded = record.filter((completion) => completion.passed && completion.gradePoints !== null)
  const credits = graded.reduce((total, completion) => total + completion.credits, 0)
  const cgpa = credits ? Math.round(graded.reduce((total, completion) => total + Number(completion.gradePoints) * completion.credits, 0) / credits * 100) / 100 : null
  if (Number(drive.minCgpa) > 0 && (cgpa === null || cgpa < Number(drive.minCgpa))) throw new DomainError(409, 'grades_below_threshold', 'Published academic grades do not meet this drive threshold.')
  if (backlogs > drive.maxBacklogs) throw new DomainError(409, 'backlogs_above_threshold', 'Uncleared academic backlogs exceed this drive threshold.')
  return { cgpa, backlogs, checkedAt: new Date().toISOString() }
}

export async function apply(actor: Actor, input: unknown) {
  const institutionId = tenant(actor, ['student'])
  const data = schemas.applicationSchema.parse(input)
  return withTenant(institutionId, async (tx) => {
    const drive = await driveFor(tx, data.driveId)
    await person(tx, actor.id, 'student')
    const [existing] = await tx.select().from(applications).where(and(eq(applications.driveId, drive.id), eq(applications.studentId, actor.id)))
    if (existing) return existing
    if (drive.status !== 'open' || drive.closesAt.getTime() <= Date.now()) throw new DomainError(409, 'drive_not_open', 'This drive is not open for applications.')
    const checked = await eligibility(tx, actor.id, drive)
    const [application] = await tx.insert(applications).values({ institutionId, driveId: drive.id, studentId: actor.id, eligibility: checked }).returning()
    await log(tx, actor, 'application.created', application!.id, `Applied to ${drive.title}`)
    return application!
  })
}

export async function withdraw(actor: Actor, input: unknown) {
  const institutionId = tenant(actor, ['student'])
  const data = schemas.applicationIdSchema.parse(input)
  return withTenant(institutionId, async (tx) => {
    const application = await applicationFor(tx, data.applicationId)
    if (application.studentId !== actor.id) throw new DomainError(404, 'no_such_application', 'No matching application.')
    if (application.status === 'withdrawn') return { notice: 'Application already withdrawn.' }
    if (!['applied', 'shortlisted'].includes(application.status)) throw new DomainError(409, 'invalid_transition', 'Only an active application can be withdrawn.')
    await tx.update(applications).set({ status: 'withdrawn' }).where(eq(applications.id, application.id))
    await log(tx, actor, 'application.withdrawn', application.id, 'Student withdrew application')
    return { notice: 'Application withdrawn.' }
  })
}

export async function createRound(actor: Actor, input: unknown) {
  return writer(actor, async (tx, institutionId) => {
    const data = schemas.roundSchema.parse(input)
    const drive = await driveFor(tx, data.driveId)
    const issued = await tx.select({ id: offers.id }).from(offers).innerJoin(applications, eq(applications.id, offers.applicationId)).where(eq(applications.driveId, drive.id)).limit(1)
    if (issued.length) throw new DomainError(409, 'offers_issued', 'Selection rounds cannot change after an offer is issued.')
    const existing = await tx.select().from(rounds).where(eq(rounds.driveId, drive.id))
    const [round] = await tx.insert(rounds).values({ institutionId, ...data, position: existing.length + 1 }).returning()
    await log(tx, actor, 'round.created', round!.id, `Added ${data.name}`)
    return round!
  })
}

export async function recordResult(actor: Actor, input: unknown) {
  return writer(actor, async (tx, institutionId) => {
    const data = schemas.resultSchema.parse(input)
    const [round] = await tx.select().from(rounds).where(eq(rounds.id, data.roundId))
    if (!round) throw new DomainError(404, 'no_such_round', 'No matching selection round.')
    await driveFor(tx, round.driveId)
    const application = await applicationFor(tx, data.applicationId)
    if (application.driveId !== round.driveId) throw new DomainError(409, 'wrong_round', 'This round belongs to another drive.')
    const existing = await tx.select().from(results).where(eq(results.applicationId, application.id))
    const duplicate = existing.find((result) => result.roundId === round.id)
    if (duplicate) {
      if (duplicate.outcome === data.outcome && duplicate.note === data.note) return duplicate
      throw new DomainError(409, 'result_final', 'A recorded selection result cannot be overwritten.')
    }
    if (!['applied', 'shortlisted'].includes(application.status)) throw new DomainError(409, 'application_not_active', 'The application is no longer active.')
    const earlier = await tx.select().from(rounds).where(and(eq(rounds.driveId, round.driveId), sql`${rounds.position} < ${round.position}`))
    if (earlier.some((previous) => !existing.some((result) => result.roundId === previous.id && result.outcome === 'passed'))) throw new DomainError(409, 'previous_round', 'Pass every earlier round before recording this one.')
    const [result] = await tx.insert(results).values({ institutionId, ...data }).returning()
    await tx.update(applications).set({ status: data.outcome === 'passed' ? 'shortlisted' : 'rejected' }).where(eq(applications.id, application.id))
    await log(tx, actor, 'round.result', application.id, data.note)
    return result!
  })
}

export async function issueOffer(actor: Actor, input: unknown) {
  return writer(actor, async (tx, institutionId) => {
    const data = schemas.offerSchema.parse(input)
    const [snapshot] = await tx.select().from(applications).where(eq(applications.id, data.applicationId))
    if (!snapshot) throw new DomainError(404, 'no_such_application', 'No matching application.')
    const drive = await driveFor(tx, snapshot.driveId)
    const application = await applicationFor(tx, snapshot.id)
    const [existing] = await tx.select().from(offers).where(eq(offers.applicationId, application.id))
    if (existing) {
      if (Number(existing.annualPaise) === data.annualPaise) return existing
      throw new DomainError(409, 'offer_final', 'An issued offer cannot be silently changed.')
    }
    if (!['applied', 'shortlisted'].includes(application.status)) throw new DomainError(409, 'application_not_active', 'An active application is required.')
    const selectionRounds = await tx.select().from(rounds).where(eq(rounds.driveId, drive.id))
    const passed = await tx.select().from(results).where(and(eq(results.applicationId, application.id), eq(results.outcome, 'passed')))
    if (!selectionRounds.length || selectionRounds.some((round) => !passed.some((result) => result.roundId === round.id))) throw new DomainError(409, 'rounds_incomplete', 'Pass all configured selection rounds before issuing an offer.')
    await eligibility(tx, application.studentId, drive)
    const [offer] = await tx.insert(offers).values({ institutionId, applicationId: application.id, studentId: application.studentId, annualPaise: String(data.annualPaise) }).returning()
    await tx.update(applications).set({ status: 'offered' }).where(eq(applications.id, application.id))
    await log(tx, actor, 'offer.issued', application.id, 'All selection rounds passed; offer issued')
    return offer!
  })
}

export async function respondOffer(actor: Actor, input: unknown) {
  const institutionId = tenant(actor, ['student'])
  const data = schemas.responseSchema.parse(input)
  return withTenant(institutionId, async (tx) => {
    await person(tx, actor.id, 'student')
    const [offer] = await tx.select().from(offers).where(and(eq(offers.id, data.offerId), eq(offers.studentId, actor.id))).for('update')
    if (!offer) throw new DomainError(404, 'no_such_offer', 'No matching offer.')
    if (offer.status === data.decision) return { notice: `Offer already ${data.decision}.` }
    if (offer.status !== 'pending') throw new DomainError(409, 'offer_final', 'Only a pending offer can be answered.')
    if (data.decision === 'accepted') {
      const [accepted] = await tx.select().from(offers).where(and(eq(offers.studentId, actor.id), eq(offers.status, 'accepted')))
      if (accepted) throw new DomainError(409, 'already_placed', 'You have already accepted a placement offer.')
    }
    await tx.update(offers).set({ status: data.decision }).where(eq(offers.id, offer.id))
    await tx.update(applications).set({ status: data.decision }).where(eq(applications.id, offer.applicationId))
    await log(tx, actor, `offer.${data.decision}`, offer.applicationId, `Student ${data.decision} offer`)
    return { notice: `Offer ${data.decision}.` }
  })
}

export async function workspace(actor: Actor) {
  const institutionId = tenant(actor)
  return withTenant(institutionId, async (tx) => {
    const staff = actor.role !== 'student'
    if (staff) await officer(tx, actor)
    const applicationRows = await tx.select().from(applications).where(staff ? undefined : eq(applications.studentId, actor.id)).orderBy(asc(applications.createdAt)).limit(1000)
    const companyRows = await tx.select().from(companies).orderBy(asc(companies.name)).limit(1000)
    const driveRows = await tx.select().from(drives).where(staff ? undefined : sql`${drives.status} = 'open' or ${drives.id} in (select drive_id from placement_applications where student_id=${actor.id})`).orderBy(asc(drives.closesAt)).limit(1000)
    const visibleDriveIds = driveRows.map((drive) => drive.id)
    const visibleApplicationIds = applicationRows.map((application) => application.id)
    return {
      staff, admin: ADMIN.includes(actor.role), companies: companyRows,
      drives: driveRows.map((drive) => ({ ...drive, company: companyRows.find((company) => company.id === drive.companyId)?.name ?? '', closesAt: drive.closesAt.toISOString() })),
      applications: applicationRows,
      rounds: visibleDriveIds.length ? await tx.select().from(rounds).where(inArray(rounds.driveId, visibleDriveIds)).orderBy(asc(rounds.position)) : [],
      results: visibleApplicationIds.length ? await tx.select().from(results).where(inArray(results.applicationId, visibleApplicationIds)) : [],
      offers: await tx.select().from(offers).where(staff ? undefined : eq(offers.studentId, actor.id)).limit(1000),
      programs: staff ? await tx.select({ value: programs.id, label: programs.name }).from(programs).orderBy(asc(programs.name)) : [],
      people: staff ? await tx.select({ value: users.id, label: users.name }).from(users).where(and(inArray(users.role, ['faculty', 'hod']), isNull(users.erasedAt))).limit(1000) : [],
      officers: staff ? await tx.select().from(officers) : [],
    }
  })
}

export async function statistics(actor: Actor) {
  return writer(actor, async (tx) => {
    const [summary] = await tx.select({
      applications: sql<number>`count(*)::int`,
      accepted: sql<number>`count(*) filter (where status = 'accepted')::int`,
      offered: sql<number>`count(*) filter (where status in ('offered','accepted','declined'))::int`,
      rejected: sql<number>`count(*) filter (where status = 'rejected')::int`,
    }).from(applications)
    return summary!
  })
}
