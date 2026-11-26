import { sql } from 'drizzle-orm'
import { schoolSubject, type SchoolExam, type SchoolSubject } from './grading'
import { readTemplate, type Tx } from './report-card-store'
import { classNumberOf, defaultSchoolTemplate, type SchoolTemplate } from './school-policy'

/**
 * What one school report card reads, in one statement, and how the figures are
 * assembled from it (P1-13b, P1-13b.3). Kept apart from the operations so the
 * issue, the reads and the tests share one snapshot and one assembly.
 */

/**
 * A pupil's daily register for the section across the term (decision 1192):
 * days recorded and days physically present. 'unavailable' when the Attendance
 * module is not installed or not enabled for this institution.
 */
export type CardAttendance = { state: 'unavailable' } | { state: 'recorded'; present: number; held: number }

/** What an issue stores (format 1): the resolved template and the report as printed. */
export type IssuePayload = { format: 1; template: SchoolTemplate; templateRevision: number; report: ReportCard & { attendance: CardAttendance } }

export type ReportCard = {
  institution: string
  term: { code: string; name: string }
  classNumber: number
  sectionLabel: string
  name: string
  rollNo: string | null
  templateName: string
  mode: SchoolTemplate['mode']
  subjects: ({ courseCode: string; title: string } & SchoolSubject & { notAssessed?: true })[]
  areas: { key: string; label: string; group: 'scholastic' | 'co_scholastic'; grade: string | null }[]
  remark: string | null
  legend: { grade: string; floor: number }[]
}

/** Everything one report reads, taken in a single statement so it is one snapshot. */
export type Snapshot = {
  cand: { starts_on: string; ends_on: string; section_id: string; section_label: string; class_teacher_id: string | null; program_id: string; program_code: string; term_code: string; term_name: string; pupil_name: string | null; roll_no: string | null; institution_name: string } | null
  template: { revision: number; template: unknown } | null
  entry: { grades: Record<string, string>; remark_key: string | null; published_at: string | null } | null
  attendance: { present: number; held: number } | null
  offerings: { id: string; code: string; title: string; exams: { id: string; name: string; kind: SchoolExam['kind']; max_marks: number; weight_percent: number; published: boolean; obtained: number | null; absent: boolean | null }[] }[]
}

/** `registerTable` is for tests: it stands in for the probe so the statement without the register can be run. */
export async function snapshot(tx: Tx, termId: string, sectionId: string, studentId: string, registerTable?: boolean): Promise<Snapshot> {
  // The register is a soft dependency: with its table absent the statement never names it.
  const hasRegister = registerTable ?? Boolean((await tx.execute(sql`select to_regclass('public.attendance_daily_marks') is not null as present`)).rows[0]?.present)
  const attendance = hasRegister
    ? sql`(select case when exists (select 1 from institution_modules m where m.institution_id = c.institution_id and m.module_id = 'attendance' and m.enabled)
                 then (select jsonb_build_object('present', count(*) filter (where d.present), 'held', count(*))
                         from attendance_daily_marks d
                        where d.institution_id = c.institution_id and d.section_id = c.section_id and d.student_id = c.student_id
                          and d.on_date between c.starts_on and c.ends_on) end
               from cand c) as attendance`
    : sql`null::jsonb as attendance`
  const { rows } = await tx.execute(sql`
    with cand as (
      select s.id as section_id, s.institution_id, t.starts_on, t.ends_on, s.label as section_label, s.class_teacher_id, p.id as program_id, p.code as program_code,
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
      ${attendance},
      (select to_jsonb(cand) - 'term_id' - 'student_id' - 'institution_id' from cand) as cand,
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

export const templateOf = (s: Snapshot): SchoolTemplate | null => {
  if (s.template) return readTemplate(s.template.template)
  const n = s.cand ? classNumberOf(s.cand.program_code) : null
  return n === null ? null : defaultSchoolTemplate(n)
}

/** The report as the snapshot stands, and whether it is complete enough to publish. */
export function assemble(s: Snapshot, t: SchoolTemplate): { report: ReportCard; complete: boolean } {
  const c = s.cand!
  const excluded = new Set(t.excludedOfferingIds)
  const subjects: ReportCard['subjects'] =
    t.mode === 'marks'
      ? s.offerings.map((o) => {
          const subject = { courseCode: o.code, title: o.title }
          if (excluded.has(o.id) && o.exams.length === 0)
            return { ...subject, components: [], total: null, grade: null, notAssessed: true as const }
          return {
            ...subject,
            ...schoolSubject(
              t,
              o.code,
              o.exams.map((e) => ({ examId: e.id, name: e.name, kind: e.kind, maxMarks: Number(e.max_marks), weightPercent: Number(e.weight_percent), published: e.published, obtained: e.obtained === null ? null : Number(e.obtained), absent: e.absent === true })),
            ),
          }
        })
      : []
  const grades = s.entry?.grades ?? {}
  const areas = t.areas.map((a) => ({ key: a.key, label: a.label, group: a.group, grade: a.grades.find((g) => g.key === grades[a.key])?.label ?? null }))
  const complete = t.mode === 'marks' ? subjects.every((x) => x.notAssessed === true || x.total !== null) : areas.filter((a) => a.group === 'scholastic').every((a) => a.grade !== null)
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


/** The captured register as stored with an issue: recorded days, or unavailable. */
export const attendanceOf = (s: Snapshot): CardAttendance =>
  s.attendance ? { state: 'recorded', present: Number(s.attendance.present), held: Number(s.attendance.held) } : { state: 'unavailable' }

/** Everything an issue stores, by value: the resolved template, its revision and the printed report. */
export const issuePayload = (s: Snapshot, t: SchoolTemplate, revision: number): IssuePayload => ({
  format: 1,
  template: t,
  templateRevision: revision,
  report: { ...assemble(s, t).report, attendance: attendanceOf(s) },
})
