import { and, asc, desc, eq, inArray, isNull, isNotNull, sql } from 'drizzle-orm'
import {
  addressStatus,
  audit,
  institutions,
  invitations,
  issueInvitation,
  stateOf,
  users,
  withTenant,
  withdrawInvitation,
} from '@campusos/db'
import { moduleEnabled, type Role } from '@campusos/module-framework'
import { manifest as academicManifest } from '@campusos/module-academic/manifest'
import { manifest as attendanceManifest } from '@campusos/module-attendance/manifest'
import { manifest as examinationsManifest } from '@campusos/module-examinations/manifest'
import { manifest as feesManifest } from '@campusos/module-fees/manifest'
import { manifest as hostelManifest } from '@campusos/module-hostel/manifest'
import { manifest as libraryManifest } from '@campusos/module-library/manifest'
import { manifest as parentsManifest } from '../manifest'
import { myAttendance } from '@campusos/module-attendance/api'
import { transcript } from '@campusos/module-examinations/api'
import { studentLedger } from '@campusos/module-fees/api'
import { borrowerStatus } from '@campusos/module-library/api'
import { myHostel } from '@campusos/module-hostel/api'
import { listStructure } from '@campusos/module-academic/api'
import { guardianInvites, links } from '../schema'
import {
  claimLinkSchema,
  decideLinkSchema,
  inviteGuardianSchema,
  withdrawGuardianSchema,
  type ChildOverview,
  type LinkRow,
} from './schemas'

const MODULE = 'parents'

export interface Actor {
  id: string
  email?: string | null
  role: Role
  institutionId: string | null
}

export class ParentError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const tenantOf = (actor: Actor): string => {
  if (!actor.institutionId) {
    throw new ParentError(400, 'no_institution', 'no institution for this session')
  }
  return actor.institutionId
}

const isAdmin = (r: Role) => r === 'institution_admin' || r === 'super_admin'

const requireAdmin = (actor: Actor) => {
  const tenant = tenantOf(actor)
  if (!isAdmin(actor.role)) throw new ParentError(403, 'forbidden', 'not permitted')
  return tenant
}

/**
 * The registry this module is allowed to ask about. Not the app's -- a module
 * importing that would be a cycle -- but every manifest it holds a package
 * dependency on, which is exactly the set it can read through.
 */
const KNOWN = [
  parentsManifest,
  academicManifest,
  attendanceManifest,
  examinationsManifest,
  feesManifest,
  hostelManifest,
  libraryManifest,
]

const on = (id: string, institutionId: string) => moduleEnabled(KNOWN, id, institutionId)

// --- links -----------------------------------------------------------------

/**
 * A parent claims a child. Nothing is visible until the institution verifies
 * it: anybody can assert they are somebody's father, and self-service here
 * would be a data-protection incident with a form attached.
 */
export async function claimLink(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  const d = claimLinkSchema.parse(input)

  // An administrator may register a link for a parent; a parent only for self.
  const parentId = isAdmin(actor.role) ? (d.parentId ?? actor.id) : actor.id
  if (!isAdmin(actor.role) && actor.role !== 'parent') {
    throw new ParentError(403, 'forbidden', 'not permitted')
  }

  return withTenant(tenant, async (tx) => {
    const [student] = await tx
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, d.studentId))
    if (!student) throw new ParentError(404, 'no_such_student', 'no such student')
    if (student.role !== 'student') {
      throw new ParentError(400, 'not_a_student', 'that account is not a student')
    }

    const [row] = await tx
      .insert(links)
      .values({
        institutionId: tenant,
        parentId,
        studentId: d.studentId,
        relation: d.relation,
        // An administrator registering the link has, by doing so, verified it.
        verifiedAt: isAdmin(actor.role) ? new Date() : null,
        verifiedBy: isAdmin(actor.role) ? actor.id : null,
      })
      .onConflictDoNothing()
      .returning()
    if (!row) throw new ParentError(409, 'exists', 'that link already exists')
    return row
  })
}

/** The institution decides. Audited either way: it grants sight of a child. */
export async function decideLink(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = decideLinkSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const [row] = await tx.select().from(links).where(eq(links.id, d.linkId))
    if (!row) throw new ParentError(404, 'no_such_link', 'no such link')
    if (row.verifiedAt) throw new ParentError(409, 'already_verified', 'already verified')

    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: d.approve ? 'parents.link_verified' : 'parents.link_refused',
      entity: 'parent_links',
      entityId: row.id,
      reason: d.reason,
      detail: { parentId: row.parentId, studentId: row.studentId, relation: row.relation },
    })

    const [updated] = await tx
      .update(links)
      .set(
        d.approve
          ? { verifiedAt: new Date(), verifiedBy: actor.id, refusedReason: null }
          : { refusedReason: d.reason },
      )
      .where(eq(links.id, d.linkId))
      .returning()
    return updated!
  })
}

/**
 * Withdraw a verified link. Audited, and the reason matters: a parent losing
 * sight of a child is usually a custody or a safeguarding decision.
 */
export async function revokeLink(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = decideLinkSchema.parse({ ...(input as object), approve: false })

  return withTenant(tenant, async (tx) => {
    const [row] = await tx.select().from(links).where(eq(links.id, d.linkId))
    if (!row) throw new ParentError(404, 'no_such_link', 'no such link')

    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: 'parents.link_revoked',
      entity: 'parent_links',
      entityId: row.id,
      reason: d.reason,
      detail: { parentId: row.parentId, studentId: row.studentId },
    })

    await tx.delete(links).where(eq(links.id, d.linkId))
  })
}

const linkColumns = {
  id: links.id,
  parentId: links.parentId,
  studentId: links.studentId,
  relation: links.relation,
  verifiedAt: links.verifiedAt,
  refusedReason: links.refusedReason,
}

export async function listLinks(actor: Actor, pendingOnly = false): Promise<LinkRow[]> {
  const tenant = requireAdmin(actor)

  return withTenant(tenant, async (tx) => {
    const rows = await tx
      .select({
        ...linkColumns,
        parentName: sql<string | null>`(select name from users where id = ${links.parentId})`,
        parentEmail: sql<string | null>`(select email from users where id = ${links.parentId})`,
        studentName: sql<string | null>`(select name from users where id = ${links.studentId})`,
        studentEmail: sql<string | null>`(select email from users where id = ${links.studentId})`,
      })
      .from(links)
      .where(pendingOnly ? isNull(links.verifiedAt) : undefined)
      .orderBy(asc(links.createdAt))
      .limit(500)

    return rows.map((r) => ({
      ...r,
      verifiedAt: r.verifiedAt?.toISOString() ?? null,
    }))
  })
}

/** The students this parent has been verified for. The whole authorisation. */
export async function childrenOf(actor: Actor): Promise<string[]> {
  const tenant = tenantOf(actor)
  return withTenant(tenant, async (tx) => {
    await linkInvited(tx, tenant, actor)
    const rows = await tx
      .select({ studentId: links.studentId })
      .from(links)
      .where(and(eq(links.parentId, actor.id), isNotNull(links.verifiedAt)))
    return rows.map((r) => r.studentId)
  })
}

export async function myChildren(actor: Actor) {
  const tenant = tenantOf(actor)
  return withTenant(tenant, async (tx) => {
    await linkInvited(tx, tenant, actor)
    const rows = await tx
      .select({
        ...linkColumns,
        studentName: sql<string | null>`(select name from users where id = ${links.studentId})`,
        studentEmail: sql<string | null>`(select email from users where id = ${links.studentId})`,
      })
      .from(links)
      .where(eq(links.parentId, actor.id))
      .orderBy(asc(links.createdAt))
    return rows.map((r) => ({ ...r, verifiedAt: r.verifiedAt?.toISOString() ?? null }))
  })
}

// --- guardians by invitation -------------------------------------------------

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]

/**
 * Turn accepted invitations into verified links, the first time the guardian
 * is here to see them.
 *
 * Nobody verifies these a second time: the office did, by naming the address
 * and the child when it issued the invitation, and the guardian did their half
 * by accepting it and then proving the address is theirs at sign-in. The link
 * records who vouched (the issuer) and when (acceptance), so the register reads
 * the same as one the office typed in.
 */
async function linkInvited(tx: Tx, tenant: string, actor: Actor) {
  if (actor.role !== 'parent') return
  const due = await tx
    .select({
      id: guardianInvites.id,
      studentId: guardianInvites.studentId,
      relation: guardianInvites.relation,
      createdBy: invitations.createdBy,
      acceptedAt: invitations.acceptedAt,
    })
    .from(guardianInvites)
    .innerJoin(invitations, eq(invitations.id, guardianInvites.invitationId))
    .where(
      and(
        eq(invitations.userId, actor.id),
        isNotNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
        isNull(guardianInvites.linkedAt),
      ),
    )
  for (const d of due) {
    await tx
      .insert(links)
      .values({
        institutionId: tenant,
        parentId: actor.id,
        studentId: d.studentId,
        relation: d.relation,
        verifiedAt: d.acceptedAt,
        verifiedBy: d.createdBy,
      })
      .onConflictDoNothing()
    await tx
      .update(guardianInvites)
      .set({ linkedAt: new Date() })
      .where(eq(guardianInvites.id, d.id))
  }
}

export interface InviteOutcome {
  invitationId: string | null
  email: string
  expiresAt: string | null
  /** The one time the link exists outside the guardian's hands. Relative to the institution's host. */
  link: string | null
  /** Said to whoever submitted the form. */
  notice: string
}

/**
 * The office invites a guardian for a child.
 *
 * The address must be nobody's yet -- an account belongs to one institution --
 * and must not be one the institution's own domain would admit, because a
 * member of staff who is also a parent already has an account and one role.
 * An address that is already a parent here needs no invitation: the child is
 * linked on the spot.
 *
 * Inviting again for a second child reissues the link and carries the first
 * child over, so a family with two students gets one link, not two that race.
 */
export async function inviteGuardian(actor: Actor, input: unknown): Promise<InviteOutcome> {
  const tenant = requireAdmin(actor)
  const d = inviteGuardianSchema.parse(input)

  const status = await addressStatus(tenant, d.email)
  if (status.kind === 'taken') {
    throw new ParentError(
      409,
      'address_in_use',
      'That address already belongs to an account at another institution, so it cannot be invited here.',
    )
  }
  if (status.kind === 'member' && status.role !== 'parent') {
    throw new ParentError(
      409,
      'member_address',
      'That address is already an account here with another role. Invite the guardian at a personal address.',
    )
  }

  return withTenant(tenant, async (tx): Promise<InviteOutcome> => {
    const [student] = await tx
      .select({ role: users.role, name: users.name })
      .from(users)
      .where(eq(users.id, d.studentId))
    if (!student) throw new ParentError(404, 'no_such_student', 'no such student')
    if (student.role !== 'student') {
      throw new ParentError(400, 'not_a_student', 'that account is not a student')
    }

    const [inst] = await tx
      .select({ domains: institutions.allowedEmailDomains })
      .from(institutions)
      .where(eq(institutions.id, tenant))
    const domain = d.email.split('@')[1] ?? ''
    if (status.kind === 'free' && inst?.domains.includes(domain)) {
      throw new ParentError(
        409,
        'member_address',
        `Addresses at ${domain} sign in as members of the institution. Invite the guardian at a personal address.`,
      )
    }

    if (status.kind === 'member') {
      await tx
        .insert(links)
        .values({
          institutionId: tenant,
          parentId: status.userId,
          studentId: d.studentId,
          relation: d.relation,
          verifiedAt: new Date(),
          verifiedBy: actor.id,
        })
        .onConflictDoNothing()
      await audit(tx, {
        institutionId: tenant,
        actorId: actor.id,
        actorEmail: actor.email ?? null,
        moduleId: MODULE,
        action: 'parents.link_verified',
        entity: 'parent_links',
        entityId: `${status.userId}:${d.studentId}`,
        reason: 'registered for an existing guardian account',
        detail: { parentId: status.userId, studentId: d.studentId, relation: d.relation },
      })
      return {
        invitationId: null,
        email: d.email,
        expiresAt: null,
        link: null,
        notice: `${d.email} already has a guardian account here; ${student.name ?? 'the student'} has been added to it.`,
      }
    }

    const issued = await issueInvitation(tx, {
      institutionId: tenant,
      email: d.email,
      role: 'parent',
      createdBy: actor.id,
      days: d.days,
    })
    const id = issued.invitation.id

    if (issued.superseded.length > 0) {
      await tx
        .update(guardianInvites)
        .set({ invitationId: id })
        .where(
          and(
            inArray(guardianInvites.invitationId, issued.superseded),
            sql`${guardianInvites.studentId} <> ${d.studentId}`,
          ),
        )
    }
    await tx
      .insert(guardianInvites)
      .values({ institutionId: tenant, invitationId: id, studentId: d.studentId, relation: d.relation })
      .onConflictDoNothing()

    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: 'parents.guardian_invited',
      entity: 'invitations',
      entityId: id,
      reason: `guardian (${d.relation}) of a student`,
      detail: { email: d.email, studentId: d.studentId, superseded: issued.superseded },
    })

    const link = `/invite/${issued.token}`
    const until = issued.invitation.expiresAt.toISOString().slice(0, 10)
    return {
      invitationId: id,
      email: d.email,
      expiresAt: issued.invitation.expiresAt.toISOString(),
      link,
      notice:
        `Invitation for ${d.email} created, valid to accept until ${until}. ` +
        'Send the guardian this link. It is shown only now; issuing again replaces it.',
    }
  })
}

/**
 * Withdraw a guardian's invitation, and with it the access it gave.
 *
 * Before acceptance this is housekeeping. After, it is the whole of taking a
 * guardian's access away: the account goes back to pending, its sessions end
 * and the links the invitation made are removed. Audited, with the reason.
 */
export async function withdrawGuardian(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = withdrawGuardianSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const [inv] = await tx.select().from(invitations).where(eq(invitations.id, d.invitationId))
    if (!inv) throw new ParentError(404, 'no_such_invitation', 'no such invitation')
    if (inv.revokedAt) throw new ParentError(409, 'already_withdrawn', 'that invitation was already withdrawn')

    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: 'parents.guardian_withdrawn',
      entity: 'invitations',
      entityId: inv.id,
      reason: d.reason,
      detail: { email: inv.email, userId: inv.userId, accepted: !!inv.acceptedAt },
    })

    if (inv.userId) {
      const students = await tx
        .select({ studentId: guardianInvites.studentId })
        .from(guardianInvites)
        .where(eq(guardianInvites.invitationId, inv.id))
      if (students.length > 0) {
        await tx.delete(links).where(
          and(
            eq(links.parentId, inv.userId),
            inArray(
              links.studentId,
              students.map((s) => s.studentId),
            ),
          ),
        )
      }
    }
    await withdrawInvitation(tx, { invitationId: inv.id, by: actor.id, reason: d.reason })
  })
}

export async function listGuardianInvites(actor: Actor) {
  const tenant = requireAdmin(actor)
  return withTenant(tenant, async (tx) => {
    const rows = await tx
      .select({
        id: invitations.id,
        email: invitations.email,
        expiresAt: invitations.expiresAt,
        acceptedAt: invitations.acceptedAt,
        revokedAt: invitations.revokedAt,
        revokeReason: invitations.revokeReason,
        createdAt: invitations.createdAt,
        signedIn: sql<boolean>`${invitations.userId} is not null`,
        children: sql<string>`coalesce((
          select string_agg(coalesce(u.name, u.email) || ' (' || g.relation || ')', ', ' order by u.name)
          from parent_guardian_invites g join users u on u.id = g.student_id
          where g.invitation_id = invitations.id), '')`,
      })
      .from(invitations)
      .where(eq(invitations.role, 'parent'))
      .orderBy(desc(invitations.createdAt))
      .limit(500)
    return rows.map((r) => ({
      ...r,
      state: stateOf(r),
      expiresAt: r.expiresAt.toISOString(),
      acceptedAt: r.acceptedAt?.toISOString() ?? null,
      revokedAt: r.revokedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    }))
  })
}

/** Students, for the office's pickers. */
export async function studentChoices(actor: Actor) {
  const tenant = requireAdmin(actor)
  return withTenant(tenant, (tx) =>
    tx
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(and(eq(users.role, 'student'), isNull(users.erasedAt)))
      .orderBy(asc(users.name))
      .limit(2000),
  )
}

// --- the lens --------------------------------------------------------------

/**
 * Everything the institution has enabled, about one child, read through the
 * modules that own it.
 *
 * The portal computes nothing itself. A section is absent when its module is
 * off, and absent -- not zero, not an error -- is the honest rendering of "this
 * institution does not use that".
 */
export async function childOverview(
  actor: Actor,
  studentId: string,
): Promise<ChildOverview> {
  const tenant = tenantOf(actor)

  const verified = await childrenOf(actor)
  const allowed = isAdmin(actor.role) || verified.includes(studentId)
  if (!allowed) {
    throw new ParentError(403, 'not_your_child', 'that student is not linked to you')
  }

  // The actor handed to every other module: same identity, plus the one
  // student it has been cleared to read. Nothing wider.
  const viewer = { ...actor, viewerOf: [studentId] }

  const [student] = await withTenant(tenant, (tx) =>
    tx
      .select({ name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, studentId)),
  )
  if (!student) throw new ParentError(404, 'no_such_student', 'no such student')

  const [attendanceOn, examsOn, feesOn, libraryOn, hostelOn] = await Promise.all([
    on('attendance', tenant),
    on('examinations', tenant),
    on('fees', tenant),
    on('library', tenant),
    on('hostel', tenant),
  ])

  const overview: ChildOverview = {
    studentId,
    studentName: student.name,
    studentEmail: student.email,
    sections: [],
    attendance: null,
    results: null,
    fees: null,
    library: null,
    hostel: null,
  }

  if (attendanceOn) {
    const rows = await myAttendance(viewer, studentId)
    overview.attendance = {
      marked: rows.length,
      recent: rows.slice(-10).map((r) => ({
        courseCode: r.courseCode,
        markedAt: r.markedAt.toISOString(),
        method: r.method,
      })),
    }
    overview.sections.push('attendance')
  }

  if (examsOn) {
    const t = await transcript(viewer, studentId)
    // The most recent term only: a parent wants "how is it going", and the
    // whole transcript is a document they can ask the office for.
    const latest = t.terms.at(-1)
    overview.results = {
      provisional: t.provisional,
      gpa: latest?.gpa ?? t.cumulativeGpa,
      grades: (latest?.grades ?? []).map((g) => ({
        courseCode: g.courseCode,
        courseTitle: g.courseTitle,
        percent: g.percent,
        label: g.label,
        passed: g.passed,
      })),
    }
    overview.sections.push('examinations')
  }

  if (feesOn) {
    const structure = await listStructure(viewer)
    const term =
      structure.terms.find((x) => x.isCurrent) ?? structure.terms.at(-1) ?? null
    if (term) {
      const ledger = await studentLedger(viewer, studentId, term.id)
      overview.fees = {
        termCode: ledger.termCode,
        payablePaise: ledger.payablePaise,
        paidPaise: ledger.paidPaise,
        outstandingPaise: ledger.outstandingPaise,
        unreconciledPaise: ledger.unreconciledPaise,
      }
      overview.sections.push('fees')
    }
  }

  if (libraryOn) {
    const status = await borrowerStatus(viewer, studentId)
    overview.library = {
      openCount: status.openCount,
      outstandingFinePaise: status.outstandingFinePaise,
      overdue: status.open.filter((l) => l.daysOverdue > 0).length,
    }
    overview.sections.push('library')
  }

  if (hostelOn) {
    const h = await myHostel(viewer, studentId)
    overview.hostel = {
      allocated: h.allocated,
      blockCode: h.blockCode,
      roomNumber: h.roomNumber,
      recentNights: h.recentNights.slice(0, 10),
    }
    overview.sections.push('hostel')
  }

  return overview
}
