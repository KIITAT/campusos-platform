import { and, asc, eq, isNull, isNotNull, sql } from 'drizzle-orm'
import { audit, users, withTenant } from '@campusos/db'
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
import { links } from '../schema'
import {
  claimLinkSchema,
  decideLinkSchema,
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
