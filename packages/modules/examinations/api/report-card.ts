import * as z from 'zod'
import { sql } from 'drizzle-orm'
import { audit, withTenant } from '@campusos/db'
import { assertCanAccessStudent } from '@campusos/module-framework'
import { reportCardEntries } from '../schema'
import { ExamError, type Actor } from './operations'
import { freezeDefaultWithin, isAdmin, lockReportCard, NOTICES, reportCardRefusal, tenantOf, type Tx } from './report-card-store'
import { assemble, snapshot, templateOf, type ReportCard } from './report-card-input'

/**
 * A school pupil's term report (FUNC-03, P1-13b): the entry and publication
 * writes by the class teacher or the office, and the report itself, read live
 * from the published marks. Nothing here is stored but the teacher's grades,
 * remark and publication: the marks are never copied.
 */

export type { CardAttendance, IssuePayload, ReportCard } from './report-card-input'

/**
 * The published report of a pupil in a section and term. The caller must be
 * able to read the pupil's academic record (the pupil, a verified guardian, or
 * staff related to the pupil); enforced even where the module is report-only.
 * Refusals in order: no such pupil, no template, not published, incomplete.
 */
export async function reportCard(actor: Actor, studentId: string, termId: string, sectionId: string): Promise<ReportCard> {
  const tenant = tenantOf(actor)
  await withTenant(tenant, (tx) => assertCanAccessStudent(tx, { ...actor, authzReportOnly: false }, studentId, 'academic_record'))
  const ids = z.object({ t: z.uuid(), s: z.uuid() }).safeParse({ t: termId, s: sectionId })
  if (!ids.success) throw reportCardRefusal('no_such_school_pupil')
  return withTenant(tenant, async (tx) => {
    const snap = await snapshot(tx, termId, sectionId, studentId)
    if (!snap.cand) throw reportCardRefusal('no_such_school_pupil')
    const t = templateOf(snap)
    if (!t) throw reportCardRefusal('no_report_card_template')
    if (!snap.entry?.published_at) throw reportCardRefusal('report_card_unpublished')
    const { report, complete } = assemble(snap, t)
    if (!complete) throw reportCardRefusal('report_card_incomplete')
    return report
  })
}

// --- writes -------------------------------------------------------------------------

const identity = { termId: z.uuid(), sectionId: z.uuid(), studentId: z.string().trim().min(1).max(100) }
const entrySchema = z.object({ ...identity, area: z.string().trim().max(100), value: z.string().trim().max(100) })

/** A form's checkbox: true, 'true', 'on', '1'; anything else, including absence, is false. */
const checkbox = z.preprocess((v) => (typeof v === 'string' ? ['true', 'on', '1'].includes(v.trim().toLowerCase()) : v), z.boolean())
const publicationSchema = z.object({ ...identity, published: checkbox, reason: z.string().trim().min(10).max(240) })

/**
 * Who may write a pupil's report: the office, or the class teacher of the
 * pupil's section. Refused before anything is read for roles that never may.
 */
function assertMayWrite(actor: Actor, classTeacherId: string | null) {
  if (isAdmin(actor.role)) return
  if ((actor.role === 'faculty' || actor.role === 'hod') && classTeacherId === actor.id) return
  throw new ExamError(403, 'forbidden', 'not permitted')
}
const writerRole = (actor: Actor) => {
  if (!isAdmin(actor.role) && actor.role !== 'faculty' && actor.role !== 'hod') throw new ExamError(403, 'forbidden', 'not permitted')
}

/** Resolve the pupil, take the cohort lock, and read the snapshot under it. */
async function underLock(tx: Tx, actor: Actor, tenant: string, d: { termId: string; sectionId: string; studentId: string }) {
  const first = await snapshot(tx, d.termId, d.sectionId, d.studentId)
  if (!first.cand) throw reportCardRefusal('no_such_school_pupil')
  assertMayWrite(actor, first.cand.class_teacher_id)
  await lockReportCard(tx, tenant, d.termId, first.cand.program_id)
  const snap = await snapshot(tx, d.termId, d.sectionId, d.studentId)
  if (!snap.cand) throw reportCardRefusal('no_such_school_pupil')
  const t = templateOf(snap)
  if (!t) throw reportCardRefusal('no_report_card_template')
  return { snap, t }
}

const auditEntry = (actor: Actor, tenant: string, d: { termId: string; sectionId: string; studentId: string }, action: string, reason: string, detail: Record<string, unknown>) => ({
  institutionId: tenant,
  actorId: actor.id,
  actorEmail: actor.email ?? null,
  moduleId: 'examinations',
  action,
  entity: 'exam_report_card_entries',
  entityId: `${d.termId}:${d.sectionId}:${d.studentId}`,
  reason,
  detail,
})

/** Set one declared area's grade, or the remark, on a pupil's report; `__clear` removes it. */
export async function setReportCardEntry(actor: Actor, input: unknown): Promise<{ changed: boolean; notice: string }> {
  const tenant = tenantOf(actor)
  writerRole(actor)
  const d = entrySchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const { snap, t } = await underLock(tx, actor, tenant, d)
    if (snap.entry?.published_at) throw reportCardRefusal('report_card_published')
    const clear = d.value === '__clear'
    const grades = { ...(snap.entry?.grades ?? {}) }
    let remarkKey = snap.entry?.remark_key ?? null
    let before: string | null
    let after: string | null
    if (d.area === 'remark') {
      if (!clear && !t.remarks.some((r) => r.key === d.value)) throw reportCardRefusal('unknown_report_card_value')
      before = remarkKey
      after = clear ? null : d.value
      remarkKey = after
    } else {
      const area = t.areas.find((a) => a.key === d.area)
      if (!area || (!clear && !area.grades.some((g) => g.key === d.value))) throw reportCardRefusal('unknown_report_card_value')
      before = grades[d.area] ?? null
      after = clear ? null : d.value
      if (after === null) delete grades[d.area]
      else grades[d.area] = after
    }
    if (before === after) return { changed: false, notice: NOTICES.entry }
    if (!snap.template) await freezeDefaultWithin(tx, actor, d.termId, snap.cand!.program_id, tenant, t)
    await tx
      .insert(reportCardEntries)
      .values({ institutionId: tenant, termId: d.termId, sectionId: d.sectionId, studentId: d.studentId, grades, remarkKey })
      .onConflictDoUpdate({ target: [reportCardEntries.institutionId, reportCardEntries.termId, reportCardEntries.sectionId, reportCardEntries.studentId], set: { grades, remarkKey } })
    await audit(tx, auditEntry(actor, tenant, d, 'report_card.entry_saved', 'school report entry saved', { termId: d.termId, sectionId: d.sectionId, studentId: d.studentId, area: d.area, before, after }))
    return { changed: true, notice: NOTICES.entry }
  })
}

/**
 * Publish or withdraw a pupil's report, with a reason. Publishing needs every
 * assessed result, or every scholastic area's rating, to be complete; withdrawing
 * reopens the ratings for editing.
 */
export async function setReportCardPublication(actor: Actor, input: unknown): Promise<{ changed: boolean; notice: string }> {
  const tenant = tenantOf(actor)
  writerRole(actor)
  const d = publicationSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const { snap, t } = await underLock(tx, actor, tenant, d)
    const live = Boolean(snap.entry?.published_at)
    const notice = d.published ? NOTICES.published : NOTICES.unpublished
    if (live === d.published) return { changed: false, notice }
    if (d.published && !assemble(snap, t).complete) throw reportCardRefusal('report_card_incomplete')
    await tx
      .insert(reportCardEntries)
      .values({ institutionId: tenant, termId: d.termId, sectionId: d.sectionId, studentId: d.studentId, publishedAt: sql`now()` })
      .onConflictDoUpdate({
        target: [reportCardEntries.institutionId, reportCardEntries.termId, reportCardEntries.sectionId, reportCardEntries.studentId],
        set: { publishedAt: d.published ? sql`now()` : null },
      })
    await audit(
      tx,
      auditEntry(actor, tenant, d, d.published ? 'report_card.published' : 'report_card.unpublished', d.reason, {
        termId: d.termId,
        sectionId: d.sectionId,
        studentId: d.studentId,
        published: d.published,
      }),
    )
    return { changed: true, notice }
  })
}

/**
 * What the staff screen needs about one pupil's report: the template in force
 * and its revision (0 for the built-in default), the saved ratings and whether
 * it is published. For the office and the section's class teacher only.
 */
export async function reportCardWorkspace(actor: Actor, termId: string, sectionId: string, studentId: string) {
  const tenant = tenantOf(actor)
  writerRole(actor)
  return withTenant(tenant, async (tx) => {
    const snap = await snapshot(tx, termId, sectionId, studentId)
    if (!snap.cand) return null
    assertMayWrite(actor, snap.cand.class_teacher_id)
    return {
      programId: snap.cand.program_id,
      template: templateOf(snap),
      revision: snap.template?.revision ?? 0,
      published: Boolean(snap.entry?.published_at),
      grades: snap.entry?.grades ?? {},
      remarkKey: snap.entry?.remark_key ?? null,
    }
  })
}
