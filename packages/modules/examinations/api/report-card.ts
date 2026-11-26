import * as z from 'zod'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { audit, withTenant } from '@campusos/db'
import { assertCanAccessStudent } from '@campusos/module-framework'
import { reportCardEntries, reportCardVersions } from '../schema'
import { sections, users } from './joins'
import { ExamError, type Actor } from './operations'
import { freezeDefaultWithin, isAdmin, lockReportCard, NOTICES, reportCardRefusal, tenantOf, type Tx } from './report-card-store'
import { assemble, issuePayload, snapshot, templateOf, type CardAttendance, type IssuePayload, type ReportCard, type Snapshot } from './report-card-input'

/**
 * A school pupil's term report (FUNC-03, P1-13b): the entry and publication
 * writes by the class teacher or the office, and the report itself, read live
 * from the published marks. Nothing here is stored but the teacher's grades,
 * remark and publication: the marks are never copied.
 */

export type { CardAttendance, IssuePayload, ReportCard } from './report-card-input'

/** An issued card as served: what was printed, the version and when it was issued. */
export type IssuedReportCard = ReportCard & { attendance: CardAttendance; version: number; issuedAt: string }

/**
 * The issued report of a pupil in a section and term (decision 1195): the
 * highest stored version while the card is published. The caller must be able
 * to read the pupil's academic record (the pupil, a verified guardian, or staff
 * related to the pupil); enforced even where the module is report-only.
 *
 * An issued card needs neither the pupil's current section, an offering, the
 * template nor any mark: it is served from what was stored, and never rebuilt.
 * With no issue stored the refusals are, in order: no such pupil, no template,
 * not published, and a legacy publication with no stored issue (decision 1196).
 */
export async function reportCard(actor: Actor, studentId: string, termId: string, sectionId: string): Promise<IssuedReportCard> {
  const tenant = tenantOf(actor)
  await withTenant(tenant, (tx) => assertCanAccessStudent(tx, { ...actor, authzReportOnly: false }, studentId, 'academic_record'))
  const ids = z.object({ t: z.uuid(), s: z.uuid() }).safeParse({ t: termId, s: sectionId })
  if (!ids.success) throw reportCardRefusal('no_such_school_pupil')
  const d = { termId, sectionId, studentId }
  return withTenant(tenant, async (tx) => {
    const [pupil] = await tx.select({ id: users.id }).from(users).where(and(eq(users.id, studentId), eq(users.role, 'student'), isNull(users.erasedAt)))
    if (!pupil) throw reportCardRefusal('no_such_school_pupil')
    const [entry] = await tx.select({ publishedAt: reportCardEntries.publishedAt }).from(reportCardEntries).where(entryKey(d))
    const [issue] = await tx
      .select({ version: reportCardVersions.version, issuedAt: sql<string>`to_char(${reportCardVersions.issuedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`, payload: reportCardVersions.payload })
      .from(reportCardVersions)
      .where(identityKey(d))
      .orderBy(desc(reportCardVersions.version))
      .limit(1)
    if (issue) {
      if (!entry?.publishedAt) throw reportCardRefusal('report_card_unpublished')
      const p = issue.payload as IssuePayload | null
      if (!p || p.format !== 1 || !p.report || typeof p.report !== 'object') throw new Error('The stored report card cannot be read (integrity error).')
      return { ...p.report, version: issue.version, issuedAt: issue.issuedAt }
    }
    const snap = await snapshot(tx, termId, sectionId, studentId)
    if (!snap.cand) throw reportCardRefusal('no_such_school_pupil')
    if (!templateOf(snap)) throw reportCardRefusal('no_report_card_template')
    if (!snap.entry?.published_at) throw reportCardRefusal('report_card_unpublished')
    throw reportCardRefusal('report_card_legacy_unversioned')
  })
}

// --- writes -------------------------------------------------------------------------

const identity = { termId: z.uuid(), sectionId: z.uuid(), studentId: z.string().trim().min(1).max(100) }
const entrySchema = z.object({ ...identity, area: z.string().trim().max(100), value: z.string().trim().max(100) })

/** A form's checkbox: true, 'true', 'on', '1'; anything else, including absence, is false. */
const checkbox = z.preprocess((v) => (typeof v === 'string' ? ['true', 'on', '1'].includes(v.trim().toLowerCase()) : v), z.boolean())

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

const publicationBase = z.object({ ...identity, published: checkbox, reason: z.string().trim().min(10).max(240) })
const invalidRepublication = () => reportCardRefusal('invalid_report_card_republication')

/** The optional correction controls. An omitted control is not an invalid one. */
function correctionControls(input: unknown): { republish: boolean; expectedVersion: number | undefined } {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const blank = (v: unknown) => v === undefined || v === null || v === ''
  let republish = false
  if (!blank(raw.republish)) {
    const v = typeof raw.republish === 'string' ? raw.republish.trim().toLowerCase() : raw.republish
    if (v === true || v === 'true' || v === 'on' || v === '1') republish = true
    else if (v === false || v === 'false' || v === 'off' || v === '0') republish = false
    else throw invalidRepublication()
  }
  let expectedVersion: number | undefined
  if (!blank(raw.expectedVersion)) {
    const v = raw.expectedVersion
    const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,10}$/.test(v.trim()) ? Number(v.trim()) : NaN
    if (!Number.isInteger(n) || n < 0 || n > 2_147_483_646) throw invalidRepublication()
    expectedVersion = n
  }
  return { republish, expectedVersion }
}

type Identity = { termId: string; sectionId: string; studentId: string }
const identityKey = (d: Identity) =>
  and(eq(reportCardVersions.termId, d.termId), eq(reportCardVersions.sectionId, d.sectionId), eq(reportCardVersions.studentId, d.studentId))
const entryKey = (d: Identity) =>
  and(eq(reportCardEntries.termId, d.termId), eq(reportCardEntries.sectionId, d.sectionId), eq(reportCardEntries.studentId, d.studentId))

async function latestVersion(tx: Tx, d: Identity): Promise<number> {
  const [row] = await tx.select({ v: reportCardVersions.version }).from(reportCardVersions).where(identityKey(d)).orderBy(desc(reportCardVersions.version)).limit(1)
  return row?.v ?? 0
}

const isoOf = (v: unknown) => new Date(v as string).toISOString()

/**
 * The cohort lock, the section and pupil rows shared to the end of the
 * transaction, then the inputs read once under them (decision 1194). A section
 * moved to another programme between the first read and the lock is retried
 * under the lock of its new programme before anything is written.
 */
async function underIssueLock(tx: Tx, actor: Actor, tenant: string, d: Identity, first: Snapshot) {
  let programId = first.cand!.program_id
  for (let attempt = 0; attempt < 3; attempt++) {
    await lockReportCard(tx, tenant, d.termId, programId)
    await tx.execute(sql`select 1 from academic_sections where id = ${d.sectionId}::uuid for share`)
    await tx.execute(sql`select 1 from users where id = ${d.studentId} for share`)
    const snap = await snapshot(tx, d.termId, d.sectionId, d.studentId)
    if (!snap.cand) throw reportCardRefusal('no_such_school_pupil')
    assertMayWrite(actor, snap.cand.class_teacher_id)
    if (snap.cand.program_id === programId) {
      const t = templateOf(snap)
      if (!t) throw reportCardRefusal('no_report_card_template')
      return { snap, t }
    }
    programId = snap.cand.program_id
  }
  throw reportCardRefusal('report_card_stale')
}

/**
 * An office withdrawal of a visible entry whose pupil has left the section (or
 * whose class lost its offerings): nothing can be read for it, but it must be
 * possible to hide it. It only ever hides; it never creates an issue.
 */
async function withdrawStranded(tx: Tx, actor: Actor, tenant: string, d: Identity & { reason: string }, expectedVersion: number | undefined) {
  const [section] = await tx.select({ programId: sections.programId }).from(sections).where(eq(sections.id, d.sectionId))
  if (!section || !isAdmin(actor.role)) throw reportCardRefusal('no_such_school_pupil')
  await lockReportCard(tx, tenant, d.termId, section.programId)
  const [entry] = await tx.select({ publishedAt: reportCardEntries.publishedAt }).from(reportCardEntries).where(entryKey(d))
  if (!entry) throw reportCardRefusal('no_such_school_pupil')
  if (!entry.publishedAt) return { changed: false, notice: NOTICES.unpublished }
  const last = await latestVersion(tx, d)
  if (expectedVersion !== undefined && expectedVersion !== last) throw reportCardRefusal('report_card_version_stale')
  await tx.update(reportCardEntries).set({ publishedAt: null }).where(entryKey(d))
  const legacy = last === 0 ? { legacyPublishedAt: entry.publishedAt.toISOString() } : {}
  await audit(tx, auditEntry(actor, tenant, d, 'report_card.unpublished', d.reason, { termId: d.termId, sectionId: d.sectionId, studentId: d.studentId, published: false, previousVersion: last, version: last, ...legacy }))
  return { changed: true, notice: NOTICES.unpublished }
}

/**
 * Publish, withdraw or correct a pupil's report, with a reason, in one
 * transaction (decisions 1190 to 1198). Publishing, and a reasoned reissue
 * (`republish` with the `expectedVersion` the form showed), each append one
 * immutable issue holding everything printed; a card is never rebuilt from
 * today's marks. Withdrawing hides the card and reopens the ratings.
 */
export async function setReportCardPublication(actor: Actor, input: unknown): Promise<{ changed: boolean; notice: string }> {
  const tenant = tenantOf(actor)
  writerRole(actor)
  const { republish, expectedVersion } = correctionControls(input)
  let d: z.infer<typeof publicationBase>
  if (republish) {
    const parsed = publicationBase.safeParse(input)
    if (!parsed.success || !parsed.data.published || expectedVersion === undefined) throw invalidRepublication()
    d = parsed.data
  } else d = publicationBase.parse(input)

  return withTenant(tenant, async (tx) => {
    const first = await snapshot(tx, d.termId, d.sectionId, d.studentId)
    if (!first.cand) {
      if (!d.published) return withdrawStranded(tx, actor, tenant, d, expectedVersion)
      throw reportCardRefusal('no_such_school_pupil')
    }
    assertMayWrite(actor, first.cand.class_teacher_id)
    const { snap, t } = await underIssueLock(tx, actor, tenant, d, first)
    const last = await latestVersion(tx, d)
    const live = Boolean(snap.entry?.published_at)
    if (expectedVersion !== undefined && expectedVersion !== last) throw reportCardRefusal('report_card_version_stale')
    if (republish && !live) throw reportCardRefusal('report_card_version_stale')
    // A card published before issues existed is reissued as version 1 by the office only (decision 1196).
    if (republish && last === 0 && !isAdmin(actor.role)) throw new ExamError(403, 'forbidden', 'not permitted')
    const notice = republish ? NOTICES.republished : d.published ? NOTICES.published : NOTICES.unpublished
    const detail = { termId: d.termId, sectionId: d.sectionId, studentId: d.studentId }

    if (!d.published) {
      if (!live) return { changed: false, notice }
      const legacy = last === 0 ? { legacyPublishedAt: isoOf(snap.entry!.published_at) } : {}
      await tx.update(reportCardEntries).set({ publishedAt: null }).where(entryKey(d))
      await audit(tx, auditEntry(actor, tenant, d, 'report_card.unpublished', d.reason, { ...detail, published: false, previousVersion: last, version: last, ...legacy }))
      return { changed: true, notice }
    }
    if (live && !republish) return { changed: false, notice }
    if (!assemble(snap, t).complete) throw reportCardRefusal('report_card_incomplete')

    if (!snap.template) await freezeDefaultWithin(tx, actor, d.termId, snap.cand!.program_id, tenant, t)
    const version = last + 1
    const payload = issuePayload(snap, t, snap.template?.revision ?? 1)
    // One database timestamp, in microseconds, for the issue and for the visibility.
    const at = ((await tx.execute(sql`select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at`)).rows as { at: string }[])[0]!.at
    const stamp = sql`${at}::timestamptz`
    await tx
      .insert(reportCardEntries)
      .values({ institutionId: tenant, termId: d.termId, sectionId: d.sectionId, studentId: d.studentId, publishedAt: stamp as never })
      .onConflictDoUpdate({
        target: [reportCardEntries.institutionId, reportCardEntries.termId, reportCardEntries.sectionId, reportCardEntries.studentId],
        set: { publishedAt: stamp as never },
      })
    await tx.insert(reportCardVersions).values({ institutionId: tenant, termId: d.termId, sectionId: d.sectionId, studentId: d.studentId, version, issuedAt: stamp as never, payload: payload as never })
    const legacy = republish && last === 0 ? { legacyPublishedAt: isoOf(snap.entry!.published_at) } : {}
    await audit(tx, auditEntry(actor, tenant, d, republish || last > 0 ? 'report_card.republished' : 'report_card.published', d.reason, { ...detail, published: true, previousVersion: last, version, ...legacy }))
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
    const version = await latestVersion(tx, { termId, sectionId, studentId })
    return {
      programId: snap.cand.program_id,
      template: templateOf(snap),
      revision: snap.template?.revision ?? 0,
      published: Boolean(snap.entry?.published_at),
      version,
      grades: snap.entry?.grades ?? {},
      remarkKey: snap.entry?.remark_key ?? null,
    }
  })
}
