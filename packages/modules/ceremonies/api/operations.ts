import { randomBytes } from 'node:crypto'
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import {
  amendDocument,
  audit,
  cancelDocument,
  institutions,
  submitDocument,
  users,
  withTenant,
} from '@campusos/db'
import type { Role } from '@campusos/module-framework'
import { degreeAudit, type DegreeAudit } from '@campusos/module-academic/api'
import { programs, studentPrograms } from '@campusos/module-academic/schema'
import { candidates, ceremonies, certificates, holds, type Candidate } from '../schema'
import { certificatePdf } from './certificate-pdf'
import {
  ceremonyRefSchema,
  ceremonyStatusSchema,
  checkInSchema,
  clearHoldSchema,
  createCeremonySchema,
  issueSchema,
  placeHoldSchema,
  reissueSchema,
  respondSchema,
  revokeSchema,
  verifySchema,
} from './schemas'

const MODULE = 'ceremonies'

export interface Actor {
  id: string
  email?: string | null
  role: Role
  institutionId: string | null
}

export class CeremonyError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]

const tenantOf = (actor: Actor) => {
  if (!actor.institutionId) throw new CeremonyError(400, 'no_institution', 'no institution for this session')
  return actor.institutionId
}
const isOffice = (r: Role) => r === 'institution_admin' || r === 'super_admin'
const isMarshal = (r: Role) => isOffice(r) || r === 'hod' || r === 'faculty'
const requireOffice = (actor: Actor) => {
  const t = tenantOf(actor)
  if (!isOffice(actor.role)) throw new CeremonyError(403, 'forbidden', 'not permitted')
  return t
}
const requireReader = (actor: Actor) => {
  const t = tenantOf(actor)
  if (!isOffice(actor.role) && actor.role !== 'hod') throw new CeremonyError(403, 'forbidden', 'not permitted')
  return t
}
const today = () => new Date().toISOString().slice(0, 10)
const who = (actor: Actor, tenant: string) => ({
  institutionId: tenant,
  actorId: actor.id,
  actorEmail: actor.email ?? null,
  moduleId: MODULE,
})

async function ceremonyIn(tx: Tx, ceremonyId: string) {
  const [c] = await tx.select().from(ceremonies).where(eq(ceremonies.id, ceremonyId))
  if (!c) throw new CeremonyError(404, 'no_such_ceremony', 'no such ceremony')
  return c
}

// --- ceremonies --------------------------------------------------------------

export async function createCeremony(actor: Actor, input: unknown) {
  const tenant = requireOffice(actor)
  const d = createCeremonySchema.parse(input)
  return withTenant(tenant, async (tx) => {
    if (d.programIds.length) {
      const found = await tx.select({ id: programs.id }).from(programs).where(inArray(programs.id, d.programIds))
      if (found.length !== new Set(d.programIds).size) {
        throw new CeremonyError(404, 'no_such_program', 'one of those programmes does not exist here')
      }
    }
    if (d.rsvpClosesOn && d.rsvpClosesOn > d.heldOn) {
      throw new CeremonyError(400, 'rsvp_after_ceremony', 'replies must close on or before the day')
    }
    const [row] = await tx
      .insert(ceremonies)
      .values({ institutionId: tenant, ...d, createdBy: actor.id })
      .returning()
    return row!
  })
}

const ORDER = ['planning', 'open', 'held', 'closed'] as const

export async function setCeremonyStatus(actor: Actor, input: unknown) {
  const tenant = requireOffice(actor)
  const d = ceremonyStatusSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const c = await ceremonyIn(tx, d.ceremonyId)
    if (ORDER.indexOf(d.status) <= ORDER.indexOf(c.status)) {
      throw new CeremonyError(409, 'ceremony_status_forward', `a ceremony moves forward only; it is already ${c.status}`)
    }
    const [row] = await tx
      .update(ceremonies)
      .set({ status: d.status })
      .where(eq(ceremonies.id, c.id))
      .returning()
    return row!
  })
}

export async function listCeremonies(actor: Actor) {
  const tenant = requireReader(actor)
  return withTenant(tenant, (tx) =>
    tx
      .select({
        id: ceremonies.id,
        name: ceremonies.name,
        heldOn: ceremonies.heldOn,
        venue: ceremonies.venue,
        status: ceremonies.status,
        candidates: sql<number>`(select count(*)::int from ceremony_candidates c where c.ceremony_id = ${ceremonies.id})`,
        eligible: sql<number>`(select count(*)::int from ceremony_candidates c where c.ceremony_id = ${ceremonies.id} and c.eligible)`,
        issued: sql<number>`(select count(*)::int from ceremony_certificates x where x.ceremony_id = ${ceremonies.id} and x.docstatus = 'submitted')`,
      })
      .from(ceremonies)
      .orderBy(desc(ceremonies.heldOn)),
  )
}

// --- eligibility -------------------------------------------------------------

const shortOf = (a: DegreeAudit): string => {
  if (a.note) return a.note
  const open = a.requirements.filter((r) => !r.satisfied).map((r) => r.code)
  const credits = a.creditsRemaining ? `${a.creditsRemaining} credits short` : ''
  return [credits, open.length ? `requirements open: ${open.join(', ')}` : ''].filter(Boolean).join('; ') || 'not complete'
}

const snapshot = (a: DegreeAudit) => ({
  complete: a.complete,
  creditsEarned: a.creditsEarned,
  totalCredits: a.totalCredits,
  cgpa: a.cgpa,
  requirements: a.requirements.map((r) => ({ code: r.code, satisfied: r.satisfied })),
  overrides: a.overrides.length,
  catalogYear: a.catalogYear,
})

/**
 * Run the degree audit for everybody reading a programme graduating at this
 * ceremony, and record what it found.
 *
 * Nobody is added by hand and nobody is marked eligible by hand: the list is
 * whoever holds a live or completed declaration in those programmes, and
 * eligible means the audit says complete. Running it again refreshes every
 * figure -- a grade corrected last week is reflected, both ways.
 */
export async function runEligibility(actor: Actor, input: unknown) {
  const tenant = requireOffice(actor)
  const d = ceremonyRefSchema.parse(input)

  const pool = await withTenant(tenant, async (tx) => {
    const c = await ceremonyIn(tx, d.ceremonyId)
    if (c.status === 'closed') throw new CeremonyError(409, 'ceremony_closed', 'that ceremony is closed')
    return tx
      .select({
        studentProgramId: studentPrograms.id,
        studentId: studentPrograms.studentId,
        programCode: programs.code,
        programName: programs.name,
      })
      .from(studentPrograms)
      .innerJoin(programs, eq(programs.id, studentPrograms.programId))
      .where(
        and(
          inArray(studentPrograms.status, ['active', 'completed']),
          c.programIds.length ? inArray(studentPrograms.programId, c.programIds) : undefined,
        ),
      )
  })

  let eligible = 0
  const now = new Date()
  for (const p of pool) {
    // The academic module's own audit, as this office would read it there.
    const a = await degreeAudit(actor, { studentId: p.studentId, studentProgramId: p.studentProgramId })
    if (a.complete) eligible++
    await withTenant(tenant, (tx) =>
      tx
        .insert(candidates)
        .values({
          institutionId: tenant,
          ceremonyId: d.ceremonyId,
          studentId: p.studentId,
          studentProgramId: p.studentProgramId,
          programCode: p.programCode,
          programName: p.programName,
          creditsEarned: a.creditsEarned,
          creditsRequired: a.totalCredits,
          cgpa: a.cgpa === null ? null : a.cgpa.toFixed(2),
          eligible: a.complete,
          shortOf: a.complete ? null : shortOf(a),
          auditedAt: now,
        })
        .onConflictDoUpdate({
          target: [candidates.ceremonyId, candidates.studentId],
          set: {
            studentProgramId: p.studentProgramId,
            programCode: p.programCode,
            programName: p.programName,
            creditsEarned: a.creditsEarned,
            creditsRequired: a.totalCredits,
            cgpa: a.cgpa === null ? null : a.cgpa.toFixed(2),
            eligible: a.complete,
            shortOf: a.complete ? null : shortOf(a),
            auditedAt: now,
          },
        }),
    )
  }
  return {
    audited: pool.length,
    eligible,
    notice: `Audited ${pool.length} student${pool.length === 1 ? '' : 's'}: ${eligible} cleared to graduate, ${pool.length - eligible} not yet.`,
  }
}

export async function listCandidates(actor: Actor, ceremonyId: string) {
  const tenant = requireReader(actor)
  return withTenant(tenant, async (tx) => {
    const rows = await tx
      .select({
        id: candidates.id,
        studentId: candidates.studentId,
        name: users.name,
        email: users.email,
        programCode: candidates.programCode,
        programName: candidates.programName,
        creditsEarned: candidates.creditsEarned,
        creditsRequired: candidates.creditsRequired,
        cgpa: candidates.cgpa,
        eligible: candidates.eligible,
        shortOf: candidates.shortOf,
        auditedAt: candidates.auditedAt,
        attendance: candidates.attendance,
        guests: candidates.guests,
        checkedInAt: candidates.checkedInAt,
        holds: sql<number>`(select count(*)::int from ceremony_holds h where h.candidate_id = ${candidates.id} and h.cleared_at is null)`,
        certificateId: sql<string | null>`(select x.id from ceremony_certificates x where x.candidate_id = ${candidates.id} and x.docstatus <> 'cancelled' limit 1)`,
        serial: sql<string | null>`(select x.serial from ceremony_certificates x where x.candidate_id = ${candidates.id} and x.docstatus <> 'cancelled' limit 1)`,
      })
      .from(candidates)
      .innerJoin(users, eq(users.id, candidates.studentId))
      .where(eq(candidates.ceremonyId, ceremonyId))
      .orderBy(asc(candidates.programCode), asc(users.name))
    return rows.map((r) => ({
      ...r,
      stage: r.certificateId
        ? 'issued'
        : !r.eligible
          ? 'not_eligible'
          : r.holds > 0
            ? 'held'
            : 'cleared',
    }))
  })
}

// --- holds -------------------------------------------------------------------

export async function placeHold(actor: Actor, input: unknown) {
  const tenant = requireOffice(actor)
  const d = placeHoldSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [c] = await tx.select().from(candidates).where(eq(candidates.id, d.candidateId))
    if (!c) throw new CeremonyError(404, 'no_such_candidate', 'no such candidate')
    const [h] = await tx
      .insert(holds)
      .values({ institutionId: tenant, candidateId: c.id, reason: d.reason, placedBy: actor.id })
      .returning()
    await audit(tx, {
      ...who(actor, tenant),
      action: 'ceremonies.hold_placed',
      entity: 'ceremony_candidates',
      entityId: c.id,
      reason: d.reason,
    })
    return h!
  })
}

export async function clearHold(actor: Actor, input: unknown) {
  const tenant = requireOffice(actor)
  const d = clearHoldSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [h] = await tx.select().from(holds).where(eq(holds.id, d.holdId))
    if (!h) throw new CeremonyError(404, 'no_such_hold', 'no such hold')
    if (h.clearedAt) throw new CeremonyError(409, 'already_cleared', 'that hold is already cleared')
    await audit(tx, {
      ...who(actor, tenant),
      action: 'ceremonies.hold_cleared',
      entity: 'ceremony_candidates',
      entityId: h.candidateId,
      reason: d.reason,
    })
    const [row] = await tx
      .update(holds)
      .set({ clearedAt: new Date(), clearedBy: actor.id, clearReason: d.reason })
      .where(eq(holds.id, h.id))
      .returning()
    return row!
  })
}

export async function listHolds(actor: Actor, ceremonyId: string) {
  const tenant = requireReader(actor)
  return withTenant(tenant, (tx) =>
    tx
      .select({
        id: holds.id,
        candidateId: holds.candidateId,
        name: users.name,
        reason: holds.reason,
        placedAt: holds.placedAt,
        clearedAt: holds.clearedAt,
        clearReason: holds.clearReason,
      })
      .from(holds)
      .innerJoin(candidates, eq(candidates.id, holds.candidateId))
      .innerJoin(users, eq(users.id, candidates.studentId))
      .where(eq(candidates.ceremonyId, ceremonyId))
      .orderBy(desc(holds.placedAt)),
  )
}

// --- the graduand -----------------------------------------------------------

/** A student's reply: coming, or conferred in absentia, and how many guests. */
export async function respond(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  if (actor.role !== 'student') throw new CeremonyError(403, 'forbidden', 'only the graduand replies')
  const d = respondSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const c = await ceremonyIn(tx, d.ceremonyId)
    const [me] = await tx
      .select()
      .from(candidates)
      .where(and(eq(candidates.ceremonyId, c.id), eq(candidates.studentId, actor.id)))
    if (!me) throw new CeremonyError(404, 'not_a_candidate', 'you are not on the list for that ceremony')
    if (!me.eligible) {
      throw new CeremonyError(409, 'not_eligible', `the degree audit has not cleared you yet: ${me.shortOf ?? ''}`.trim())
    }
    if (c.status !== 'open') throw new CeremonyError(409, 'replies_closed', 'replies are not open for that ceremony')
    if (c.rsvpClosesOn && today() > c.rsvpClosesOn) {
      throw new CeremonyError(409, 'replies_closed', `replies closed on ${c.rsvpClosesOn}`)
    }
    const guests = d.attendance === 'in_absentia' ? 0 : d.guests
    if (guests > c.guestLimit) {
      throw new CeremonyError(409, 'too_many_guests', `each graduand may bring ${c.guestLimit}`)
    }
    const [row] = await tx
      .update(candidates)
      .set({ attendance: d.attendance, guests, respondedAt: new Date() })
      .where(eq(candidates.id, me.id))
      .returning()
    return row!
  })
}

export async function myGraduation(actor: Actor) {
  const tenant = tenantOf(actor)
  return withTenant(tenant, async (tx) => {
    const rows = await tx
      .select({
        candidateId: candidates.id,
        ceremonyId: ceremonies.id,
        ceremony: ceremonies.name,
        heldOn: ceremonies.heldOn,
        venue: ceremonies.venue,
        status: ceremonies.status,
        rsvpClosesOn: ceremonies.rsvpClosesOn,
        guestLimit: ceremonies.guestLimit,
        programName: candidates.programName,
        creditsEarned: candidates.creditsEarned,
        creditsRequired: candidates.creditsRequired,
        cgpa: candidates.cgpa,
        eligible: candidates.eligible,
        shortOf: candidates.shortOf,
        attendance: candidates.attendance,
        guests: candidates.guests,
        checkedInAt: candidates.checkedInAt,
        holds: sql<number>`(select count(*)::int from ceremony_holds h where h.candidate_id = ${candidates.id} and h.cleared_at is null)`,
      })
      .from(candidates)
      .innerJoin(ceremonies, eq(ceremonies.id, candidates.ceremonyId))
      .where(eq(candidates.studentId, actor.id))
      .orderBy(desc(ceremonies.heldOn))
    const certs = await tx
      .select({
        id: certificates.id,
        serial: certificates.serial,
        programName: certificates.programName,
        conferredOn: certificates.conferredOn,
        docstatus: certificates.docstatus,
        cancelReason: certificates.cancelReason,
      })
      .from(certificates)
      .where(eq(certificates.studentId, actor.id))
      .orderBy(desc(certificates.createdAt))
    return { ceremonies: rows, certificates: certs }
  })
}

// --- the day -----------------------------------------------------------------

export async function checkIn(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  if (!isMarshal(actor.role)) throw new CeremonyError(403, 'forbidden', 'not permitted')
  const d = checkInSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [c] = await tx.select().from(candidates).where(eq(candidates.id, d.candidateId))
    if (!c) throw new CeremonyError(404, 'no_such_candidate', 'no such candidate')
    const e = await ceremonyIn(tx, c.ceremonyId)
    if (e.status !== 'open' && e.status !== 'held') {
      throw new CeremonyError(409, 'not_the_day', 'check-in is for a ceremony that is open or being held')
    }
    if (!c.eligible) throw new CeremonyError(409, 'not_eligible', 'the degree audit has not cleared this student')
    if (c.checkedInAt) throw new CeremonyError(409, 'already_checked_in', 'already checked in')
    const [row] = await tx
      .update(candidates)
      .set({ checkedInAt: new Date(), checkedInBy: actor.id })
      .where(eq(candidates.id, c.id))
      .returning()
    return row!
  })
}

// --- certificates ------------------------------------------------------------

const code = () => randomBytes(9).toString('base64url')

async function nextSerial(tx: Tx, tenant: string, year: string) {
  // One number at a time per institution, so two clerks issuing at once do
  // not both take the next serial.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${tenant} || ':ceremony-serial'))`)
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(certificates)
    .where(sql`${certificates.serial} like ${`CERT-${year}-%`}`)
  return `CERT-${year}-${String((row?.n ?? 0) + 1).padStart(4, '0')}`
}

/**
 * Issue certificates to eligible candidates.
 *
 * Each is audited again, now, and the certificate carries that audit: the
 * eligibility on the list may be a week old, and a certificate is the one
 * place where "was cleared at the time" has to be literally true. Anybody the
 * fresh audit does not clear, or who has a hold open, is skipped and said so.
 */
export async function issueCertificates(actor: Actor, input: unknown) {
  const tenant = requireOffice(actor)
  const d = issueSchema.parse(input)

  const { ceremony, list } = await withTenant(tenant, async (tx) => {
    const ceremony = await ceremonyIn(tx, d.ceremonyId)
    if (ceremony.status === 'planning') {
      throw new CeremonyError(409, 'ceremony_certificate_planning', 'open the ceremony before issuing certificates')
    }
    const list = await tx
      .select({ c: candidates, name: users.name })
      .from(candidates)
      .innerJoin(users, eq(users.id, candidates.studentId))
      .where(
        and(
          eq(candidates.ceremonyId, ceremony.id),
          d.candidateIds?.length ? inArray(candidates.id, d.candidateIds) : undefined,
        ),
      )
    return { ceremony, list }
  })

  const issued: string[] = []
  const skipped: { name: string; reason: string }[] = []
  for (const { c, name } of list) {
    const label = name ?? c.studentId
    const a = await degreeAudit(actor, { studentId: c.studentId, studentProgramId: c.studentProgramId })
    const out = await withTenant(tenant, async (tx) => {
      const [live] = await tx
        .select({ id: certificates.id })
        .from(certificates)
        .where(and(eq(certificates.candidateId, c.id), sql`${certificates.docstatus} <> 'cancelled'`))
      if (live) return 'already holds a certificate'
      // The fresh audit is also written back, so the list never disagrees with
      // what the certificate says.
      await tx
        .update(candidates)
        .set({
          eligible: a.complete,
          shortOf: a.complete ? null : shortOf(a),
          creditsEarned: a.creditsEarned,
          cgpa: a.cgpa === null ? null : a.cgpa.toFixed(2),
          auditedAt: new Date(),
        })
        .where(eq(candidates.id, c.id))
      if (!a.complete) return `not cleared by the degree audit (${shortOf(a)})`
      const [open] = await tx
        .select({ reason: holds.reason })
        .from(holds)
        .where(and(eq(holds.candidateId, c.id), isNull(holds.clearedAt)))
      if (open) return `on hold: ${open.reason}`

      const [cert] = await tx
        .insert(certificates)
        .values({
          institutionId: tenant,
          candidateId: c.id,
          ceremonyId: ceremony.id,
          studentId: c.studentId,
          serial: await nextSerial(tx, tenant, ceremony.heldOn.slice(0, 4)),
          verificationCode: code(),
          studentName: label,
          programCode: c.programCode,
          programName: c.programName,
          cgpa: a.cgpa === null ? null : a.cgpa.toFixed(2),
          creditsEarned: a.creditsEarned,
          conferredOn: ceremony.heldOn,
          audit: snapshot(a),
          createdBy: actor.id,
          docstatus: 'submitted',
          submittedAt: new Date(),
          submittedBy: actor.id,
        })
        .returning()
      await audit(tx, {
        ...who(actor, tenant),
        action: 'ceremonies.certificate_issued',
        entity: 'ceremony_certificates',
        entityId: cert!.id,
        reason: `issued ${cert!.serial} on a complete degree audit`,
      })
      return null
    })
    if (out === null) issued.push(label)
    else skipped.push({ name: label, reason: out })
  }

  return {
    issued: issued.length,
    skipped,
    notice:
      `${issued.length} certificate${issued.length === 1 ? '' : 's'} issued.` +
      (skipped.length ? ` Skipped: ${skipped.map((s) => `${s.name} (${s.reason})`).join('; ')}.` : ''),
  }
}

async function certificateIn(tx: Tx, id: string) {
  const [c] = await tx.select().from(certificates).where(eq(certificates.id, id))
  if (!c) throw new CeremonyError(404, 'no_such_certificate', 'no such certificate')
  return c
}

/** Revoke: cancel, with the reason. The serial stays on record as revoked. */
export async function revokeCertificate(actor: Actor, input: unknown) {
  const tenant = requireOffice(actor)
  const d = revokeSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    await certificateIn(tx, d.certificateId)
    return cancelDocument(tx, certificates, d.certificateId, { ...who(actor, tenant), reason: d.reason })
  })
}

/**
 * Reissue a revoked certificate -- a misspelt name corrected, say. A new
 * serial and verification code, the old one named as what it replaces, and
 * the audit taken again: a reissue is not a way round a student who no longer
 * clears.
 */
export async function reissueCertificate(actor: Actor, input: unknown) {
  const tenant = requireOffice(actor)
  const d = reissueSchema.parse(input)
  const old = await withTenant(tenant, (tx) => certificateIn(tx, d.certificateId))
  if (old.docstatus !== 'cancelled') {
    throw new CeremonyError(409, 'not_revoked', 'only a revoked certificate is reissued')
  }
  const [cand] = await withTenant(tenant, (tx) =>
    tx.select().from(candidates).where(eq(candidates.id, old.candidateId)),
  )
  const a = await degreeAudit(actor, { studentId: old.studentId, studentProgramId: cand!.studentProgramId })
  if (!a.complete) {
    throw new CeremonyError(409, 'ceremony_certificate_audit', `the degree audit no longer clears this student (${shortOf(a)})`)
  }
  return withTenant(tenant, async (tx) => {
    const [student] = await tx.select({ name: users.name }).from(users).where(eq(users.id, old.studentId))
    const draft = await amendDocument(tx, certificates, old.id, who(actor, tenant), {
      serial: await nextSerial(tx, tenant, old.conferredOn.slice(0, 4)),
      verification_code: code(),
      student_name: student?.name ?? old.studentName,
      cgpa: a.cgpa === null ? null : a.cgpa.toFixed(2),
      credits_earned: a.creditsEarned,
      audit: JSON.stringify(snapshot(a)),
      created_by: actor.id,
    })
    return submitDocument(tx, certificates, String(draft.id), who(actor, tenant))
  })
}

export async function listCertificates(actor: Actor, ceremonyId?: string) {
  const tenant = requireReader(actor)
  return withTenant(tenant, (tx) =>
    tx
      .select({
        id: certificates.id,
        serial: certificates.serial,
        studentName: certificates.studentName,
        programCode: certificates.programCode,
        cgpa: certificates.cgpa,
        conferredOn: certificates.conferredOn,
        docstatus: certificates.docstatus,
        cancelReason: certificates.cancelReason,
        amendedFrom: certificates.amendedFrom,
      })
      .from(certificates)
      .where(ceremonyId ? eq(certificates.ceremonyId, ceremonyId) : undefined)
      .orderBy(asc(certificates.serial)),
  )
}

/** One certificate: the office sees any, a student only their own. */
export async function certificateView(actor: Actor, certificateId: string) {
  const tenant = tenantOf(actor)
  return withTenant(tenant, async (tx) => {
    const c = await certificateIn(tx, certificateId)
    if (!isOffice(actor.role) && actor.role !== 'hod' && c.studentId !== actor.id) {
      throw new CeremonyError(403, 'forbidden', 'not permitted')
    }
    const [replacedBy] = await tx
      .select({ id: certificates.id, serial: certificates.serial })
      .from(certificates)
      .where(eq(certificates.amendedFrom, c.id))
    const [replaces] = c.amendedFrom
      ? await tx
          .select({ id: certificates.id, serial: certificates.serial })
          .from(certificates)
          .where(eq(certificates.id, c.amendedFrom))
      : []
    const [ceremony] = await tx.select().from(ceremonies).where(eq(ceremonies.id, c.ceremonyId))
    return { ...c, ceremony: ceremony?.name ?? '', replacedBy: replacedBy ?? null, replaces: replaces ?? null }
  })
}

/**
 * Check a certificate by the code printed on it: whether it stands, and what
 * it says. Staff only for now -- a public checking page needs the host to
 * serve something without a sign-in, which is a separate decision.
 */
export async function verifyCertificate(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  if (!isMarshal(actor.role)) throw new CeremonyError(403, 'forbidden', 'not permitted')
  const d = verifySchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [c] = await tx.select().from(certificates).where(eq(certificates.verificationCode, d.code))
    if (!c) return { valid: false as const, reason: 'no certificate here carries that code' }
    if (c.docstatus !== 'submitted') {
      return { valid: false as const, reason: `certificate ${c.serial} was revoked: ${c.cancelReason ?? ''}`.trim() }
    }
    return {
      valid: true as const,
      serial: c.serial,
      studentName: c.studentName,
      programName: c.programName,
      conferredOn: c.conferredOn,
    }
  })
}

export type CandidateRow = Awaited<ReturnType<typeof listCandidates>>[number]
export type { Candidate }

/**
 * The printable certificate. A revoked one is not printed: a copy of it would
 * be a document that looks valid and is not.
 */
export async function certificateDocument(actor: Actor, certificateId: string) {
  const c = await certificateView(actor, certificateId)
  if (c.docstatus !== 'submitted') {
    throw new CeremonyError(409, 'not_standing', 'only a certificate that stands is printed')
  }
  const tenant = tenantOf(actor)
  const [inst] = await withTenant(tenant, (tx) =>
    tx.select({ name: institutions.name }).from(institutions).where(eq(institutions.id, tenant)),
  )
  const bytes = await certificatePdf(c, inst?.name ?? '')
  return { bytes, serial: c.serial }
}

/**
 * What a marshal at the door needs: cleared graduands at any ceremony open or
 * being held, whether they said they are coming, and whether they are in.
 * Nothing about why somebody is not cleared -- that is the office's business.
 */
export async function checkinBoard(actor: Actor) {
  const tenant = tenantOf(actor)
  if (!isMarshal(actor.role)) throw new CeremonyError(403, 'forbidden', 'not permitted')
  return withTenant(tenant, (tx) =>
    tx
      .select({
        id: candidates.id,
        ceremony: ceremonies.name,
        name: users.name,
        programCode: candidates.programCode,
        attendance: candidates.attendance,
        guests: candidates.guests,
        checkedInAt: candidates.checkedInAt,
      })
      .from(candidates)
      .innerJoin(ceremonies, eq(ceremonies.id, candidates.ceremonyId))
      .innerJoin(users, eq(users.id, candidates.studentId))
      .where(and(eq(candidates.eligible, true), inArray(ceremonies.status, ['open', 'held'])))
      .orderBy(asc(ceremonies.heldOn), asc(users.name)),
  )
}

/** Programmes, for the office's pickers. */
export async function programChoices(actor: Actor) {
  const tenant = requireOffice(actor)
  return withTenant(tenant, (tx) =>
    tx.select({ id: programs.id, code: programs.code, name: programs.name }).from(programs).orderBy(asc(programs.code)),
  )
}
