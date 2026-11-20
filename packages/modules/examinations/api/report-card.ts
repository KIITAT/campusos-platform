import * as z from 'zod'
import { sql } from 'drizzle-orm'
import { audit, withTenant } from '@campusos/db'
import { assertCanAccessStudent } from '@campusos/module-framework'
import { reportCardEntries } from '../schema'
import { schoolSubject, type SchoolExam, type SchoolSubject } from './grading'
import { ExamError, type Actor } from './operations'
import { isAdmin, lockReportCard, NOTICES, readTemplate, reportCardRefusal, tenantOf, type Tx } from './report-card-store'
import { classNumberOf, defaultSchoolTemplate, type SchoolTemplate } from './school-policy'

/**
 * A school pupil's term report (FUNC-03, P1-13b): the entry and publication
 * writes by the class teacher or the office, and the report itself, read live
 * from the published marks. Nothing here is stored but the teacher's grades,
 * remark and publication: the marks are never copied.
 */

export type ReportCard = {
  institution: string
  term: { code: string; name: string }
  classNumber: number
  sectionLabel: string
  name: string
  rollNo: string | null
  templateName: string
  mode: SchoolTemplate['mode']
  subjects: ({ courseCode: string; title: string } & SchoolSubject)[]
  areas: { key: string; label: string; group: 'scholastic' | 'co_scholastic'; grade: string | null }[]
  remark: string | null
  legend: { grade: string; floor: number }[]
}

/** Everything one report reads, taken in a single statement so it is one snapshot. */
type Snapshot = {
  cand: { section_id: string; section_label: string; class_teacher_id: string | null; program_id: string; program_code: string; term_code: string; term_name: string; pupil_name: string | null; roll_no: string | null; institution_name: string } | null
  template: { revision: number; template: unknown } | null
  entry: { grades: Record<string, string>; remark_key: string | null; published_at: string | null } | null
  offerings: { id: string; code: string; title: string; exams: { id: string; name: string; kind: SchoolExam['kind']; max_marks: number; weight_percent: number; published: boolean; obtained: number | null; absent: boolean | null }[] }[]
}

async function snapshot(tx: Tx, termId: string, sectionId: string, studentId: string): Promise<Snapshot> {
  const { rows } = await tx.execute(sql`
    with cand as (
      select s.id as section_id, s.label as section_label, s.class_teacher_id, p.id as program_id, p.code as program_code,
             t.id as term_id, t.code as term_code, t.name as term_name, u.id as student_id, u.name as pupil_name,
             sp.roll_no, i.name as institution_name
        from academic_sections s
        join academic_programs p on p.id = s.program_id and p.level = 'school'
        join academic_terms t on t.id = ${termId}::uuid
        join academic_section_members m on m.section_id = s.id and m.user_id = ${studentId}
        join users u on u.id = m.user_id and u.role = 'student' and u.erased_at is null
        join institutions i on i.id = s.institution_id
        left join academic_student_profiles sp on sp.student_id = u.id
       where s.id = ${sectionId}::uuid
         and exists (select 1 from academic_offerings o where o.section_id = s.id and o.term_id = t.id)
    )
    select
      (select to_jsonb(cand) - 'term_id' - 'student_id' from cand) as cand,
      (select jsonb_build_object('revision', r.revision, 'template', r.template)
         from exam_report_card_templates r where r.term_id = ${termId}::uuid and r.program_id = (select program_id from cand)) as template,
      (select jsonb_build_object('grades', e.grades, 'remark_key', e.remark_key, 'published_at', e.published_at)
         from exam_report_card_entries e
        where e.term_id = ${termId}::uuid and e.section_id = ${sectionId}::uuid and e.student_id = ${studentId}) as entry,
      coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', o.id, 'code', c.code, 'title', c.title,
                 'exams', coalesce((
                   select jsonb_agg(jsonb_build_object(
                            'id', x.id, 'name', x.name, 'kind', x.kind, 'max_marks', x.max_marks, 'weight_percent', x.weight_percent,
                            'published', x.published_at is not null, 'obtained', k.obtained, 'absent', k.absent) order by x.created_at, x.id)
                     from exams x left join exam_marks k on k.exam_id = x.id and k.student_id = ${studentId}
                    where x.offering_id = o.id), '[]'::jsonb)
               ) order by c.code, o.id)
          from academic_offerings o join academic_courses c on c.id = o.course_id
         where o.section_id = ${sectionId}::uuid and o.term_id = ${termId}::uuid and exists (select 1 from cand)), '[]'::jsonb) as offerings`)
  return rows[0] as unknown as Snapshot
}

const templateOf = (s: Snapshot): SchoolTemplate | null => {
  if (s.template) return readTemplate(s.template.template)
  const n = s.cand ? classNumberOf(s.cand.program_code) : null
  return n === null ? null : defaultSchoolTemplate(n)
}

/** The report as the snapshot stands, and whether it is complete enough to publish. */
function assemble(s: Snapshot, t: SchoolTemplate): { report: ReportCard; complete: boolean } {
  const c = s.cand!
  const subjects =
    t.mode === 'marks'
      ? s.offerings.map((o) => ({
          courseCode: o.code,
          title: o.title,
          ...schoolSubject(
            t,
            o.code,
            o.exams.map((e) => ({ examId: e.id, name: e.name, kind: e.kind, maxMarks: Number(e.max_marks), weightPercent: Number(e.weight_percent), published: e.published, obtained: e.obtained === null ? null : Number(e.obtained), absent: e.absent === true })),
          ),
        }))
      : []
  const grades = s.entry?.grades ?? {}
  const areas = t.areas.map((a) => ({ key: a.key, label: a.label, group: a.group, grade: a.grades.find((g) => g.key === grades[a.key])?.label ?? null }))
  const complete = t.mode === 'marks' ? subjects.every((x) => x.total !== null) : areas.filter((a) => a.group === 'scholastic').every((a) => a.grade !== null)
  return {
    complete,
    report: {
      institution: c.institution_name,
      term: { code: c.term_code, name: c.term_name },
      classNumber: t.classNumber,
      sectionLabel: c.section_label,
      name: c.pupil_name?.trim() || 'Student',
      rollNo: c.roll_no,
      templateName: t.name,
      mode: t.mode,
      subjects,
      areas,
      remark: t.remarks.find((r) => r.key === s.entry?.remark_key)?.label ?? null,
      legend: [...t.bands].sort((a, b) => b.floor - a.floor).map((b) => ({ grade: b.grade, floor: b.floor })),
    },
  }
}

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
 * subject's result, or every scholastic area's rating, to be complete; withdrawing
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
