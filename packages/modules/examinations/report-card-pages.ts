import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'
import { withTenant } from '@campusos/db'
import { canAccessStudent, param, type PluginPage, type PluginSection } from '@campusos/module-framework'
import { studentProfiles } from '@campusos/module-academic/schema'
import { listUnassessedOfferings, reportCardRefusal } from './api/report-card-store'
import { reportCardWorkspace } from './api/report-card'
import { offerings, programs, sectionMembers, sections, terms, users } from './api/joins'
import type { Actor } from './api'

/**
 * The school report card screens (P1-13b). Staff: the office, or the class
 * teacher of a section, choose a class and term, then a pupil, and rate, publish
 * and download. Pupils and guardians: the published reports of themselves or
 * their verified children. Every identity read from the query string is checked
 * again against what this person may open before anything is shown.
 */

const OFFICE = ['institution_admin', 'super_admin'] as const
const PDF = '/api/v1/modules/examinations/report-card.pdf'
const href = (termId: string, sectionId: string, studentId: string) =>
  `${PDF}?termId=${encodeURIComponent(termId)}&sectionId=${encodeURIComponent(sectionId)}&studentId=${encodeURIComponent(studentId)}`
const isOffice = (role: string) => (OFFICE as readonly string[]).includes(role)

const CLEAR = { value: '__clear', label: 'Clear' }

export const reportCardPages: PluginPage[] = [
  {
    path: '/report-cards',
    title: 'School report cards',
    menu: 'School report cards',
    roles: ['institution_admin', 'super_admin', 'hod', 'faculty'],
    async load(actor, req) {
      const a = actor as Actor
      const office = isOffice(a.role)
      const tenant = a.institutionId!
      const wantTerm = param(req, 'termId') ?? ''
      const wantSection = param(req, 'sectionId') ?? ''
      const wantStudent = param(req, 'studentId') ?? ''
      const base = await withTenant(tenant, async (tx) => {
        const termRows = await tx.select({ id: terms.id, code: terms.code, name: terms.name }).from(terms).orderBy(desc(terms.startsOn), asc(terms.id))
        const sectionRows = await tx
          .select({ id: sections.id, label: sections.label, program: programs.code, programId: programs.id })
          .from(sections)
          .innerJoin(programs, eq(programs.id, sections.programId))
          .where(office ? eq(programs.level, 'school') : and(eq(programs.level, 'school'), eq(sections.classTeacherId, a.id)))
          .orderBy(asc(programs.code), asc(sections.label), asc(sections.id))
        // A roster only for a chosen term and a section this person may open, with a class in that term.
        const term = termRows.find((t) => t.id === wantTerm)
        const section = sectionRows.find((s) => s.id === wantSection)
        let roster: { id: string; name: string | null; roll: string | null }[] = []
        if (term && section) {
          const [offered] = await tx.select({ one: sql<number>`1` }).from(offerings).where(and(eq(offerings.sectionId, section.id), eq(offerings.termId, term.id))).limit(1)
          if (offered) {
            roster = await tx
              .select({ id: users.id, name: users.name, roll: studentProfiles.rollNo })
              .from(sectionMembers)
              .innerJoin(users, and(eq(users.id, sectionMembers.userId), eq(users.role, 'student'), isNull(users.erasedAt)))
              .leftJoin(studentProfiles, eq(studentProfiles.studentId, users.id))
              .where(eq(sectionMembers.sectionId, section.id))
            // Roll numbers first (blank last), then name, then id.
            roster.sort((x, y) => Number(x.roll === null) - Number(y.roll === null) || (x.roll ?? '').localeCompare(y.roll ?? '') || (x.name ?? '').localeCompare(y.name ?? '') || (x.id < y.id ? -1 : 1))
          }
        }
        const unassessedOfferings = office && term && section && roster.some((p) => p.id === wantStudent)
          ? await listUnassessedOfferings(tx, term.id, section.programId)
          : []
        return { termRows, sectionRows, term, section, roster, unassessedOfferings }
      })
      const pupil = base.roster.find((p) => p.id === wantStudent)
      const work = base.term && base.section && pupil ? await reportCardWorkspace(a, base.term.id, base.section.id, pupil.id) : null
      return {
        office,
        termOptions: base.termRows.map((t) => ({ value: t.id, label: `${t.code} ${t.name}` })),
        sectionOptions: base.sectionRows.map((s) => ({ value: s.id, label: `${s.program} ${s.label}` })),
        termId: base.term?.id ?? '',
        sectionId: base.section?.id ?? '',
        studentOptions: base.roster.map((p) => ({ value: p.id, label: `${p.roll ? `${p.roll}  ` : ''}${p.name ?? 'Student'}` })),
        studentId: work ? pupil!.id : '',
        pupilName: pupil?.name ?? '',
        work,
        unassessedOfferings: base.unassessedOfferings.map((o) => ({ id: o.id, section: o.section, course: `${o.courseCode} ${o.title}` })),
        rosterEmpty: Boolean(base.term && base.section && !base.roster.length),
      }
    },
    sections(data) {
      const out: PluginSection[] = [
        {
          kind: 'form',
          title: 'Choose class and term',
          method: 'GET',
          path: '/report-cards',
          submit: 'Show pupils',
          fields: [
            { name: 'termId', label: 'Term', kind: 'select', options: 'termOptions', value: data.termId as string },
            { name: 'sectionId', label: 'Section', kind: 'select', options: 'sectionOptions', value: data.sectionId as string },
          ],
        },
      ]
      const termId = data.termId as string
      const sectionId = data.sectionId as string
      if (termId && sectionId) {
        if (data.rosterEmpty) out.push({ kind: 'note', text: 'No pupils in this class and term.' })
        else
          out.push({
            kind: 'form',
            title: 'Choose pupil',
            method: 'GET',
            path: '/report-cards',
            submit: 'Open report card',
            fields: [
              { name: 'termId', label: '', kind: 'hidden', value: termId },
              { name: 'sectionId', label: '', kind: 'hidden', value: sectionId },
              { name: 'studentId', label: 'Pupil', kind: 'select', options: 'studentOptions', value: data.studentId as string },
            ],
          })
      }
      const work = data.work as Awaited<ReturnType<typeof reportCardWorkspace>>
      const studentId = data.studentId as string
      if (!work || !studentId) return out
      const ids = [
        { name: 'termId', label: '', kind: 'hidden' as const, value: termId },
        { name: 'sectionId', label: '', kind: 'hidden' as const, value: sectionId },
        { name: 'studentId', label: '', kind: 'hidden' as const, value: studentId },
      ]
      out.push({ kind: 'prose', title: data.pupilName as string, text: work.template ? `${work.template.name}. ${work.published ? (work.version > 0 ? `Published, issue version ${work.version}.` : 'Published, with no stored issue.') : 'Not published.'}` : '' })

      if (data.office) {
        out.push({
          kind: 'form',
          title: 'Edit term template',
          note: `Revision ${work.revision}${work.revision === 0 ? ' (the built-in default until saved)' : ''}. The template is fixed once any pupil’s report in this class and term has been started.`,
          path: '/report-card/template',
          placement: 'inline',
          submit: 'Save template',
          fields: [
            { name: 'termId', label: '', kind: 'hidden', value: termId },
            { name: 'programId', label: '', kind: 'hidden', value: work.programId },
            { name: 'expectedRevision', label: '', kind: 'hidden', value: String(work.revision) },
            { name: 'template', label: 'Template JSON', kind: 'textarea', rows: 14, value: work.template ? JSON.stringify(work.template, null, 2) : '' },
          ],
        })

        if (work.template?.mode === 'marks' && (data.unassessedOfferings as unknown[]).length) {
          out.push(
            { kind: 'note', text: 'Add offering IDs to excludedOfferingIds to print Not assessed.' },
            {
              kind: 'table',
              title: 'Offerings with no exams',
              rows: 'unassessedOfferings',
              columns: [
                { key: 'section', label: 'Section' },
                { key: 'course', label: 'Course' },
                { key: 'id', label: 'Offering ID' },
              ],
            },
          )
        }
      }

      if (!work.template) {
        out.push({ kind: 'note', tone: 'warn', text: reportCardRefusal('no_report_card_template').message })
        return out
      }
      if (!work.published) {
        for (const area of work.template.areas)
          out.push({
            kind: 'form',
            title: area.label,
            path: '/report-card/entry',
            placement: 'inline',
            submit: 'Save grade',
            fields: [
              ...ids,
              { name: 'area', label: '', kind: 'hidden', value: area.key },
              { name: 'value', label: 'Grade', kind: 'select', options: [CLEAR, ...area.grades.map((g) => ({ value: g.key, label: g.label }))], value: work.grades[area.key] ?? '__clear' },
            ],
          })
        if (work.template.remarks.length)
          out.push({
            kind: 'form',
            title: 'Class teacher’s remark',
            path: '/report-card/entry',
            placement: 'inline',
            submit: 'Save remark',
            fields: [
              ...ids,
              { name: 'area', label: '', kind: 'hidden', value: 'remark' },
              { name: 'value', label: 'Class teacher’s remark', kind: 'select', options: [CLEAR, ...work.template.remarks.map((r) => ({ value: r.key, label: r.label }))], value: work.remarkKey ?? '__clear' },
            ],
          })
      }
      out.push({
        kind: 'form',
        title: 'Publication',
        note: 'Publishing needs every assessed result, or every scholastic rating, to be complete. A published report cannot be edited until it is withdrawn.',
        path: '/report-card/publication',
        placement: 'inline',
        submit: 'Save publication',
        fields: [
          ...ids,
          { name: 'published', label: 'Publish', kind: 'checkbox', value: String(work.published) },
          { name: 'reason', label: 'Reason', kind: 'textarea', rows: 2, hint: '10 to 240 characters. Leave out medical and personal details.' },
        ],
      })
      if (work.published && work.version > 0) {
        out.push(
          {
            kind: 'form',
            title: 'Republish report card',
            note: `Issues a corrected version after version ${work.version}. The family sees the new version at the same link; earlier versions stay on record.`,
            path: '/report-card/publication',
            placement: 'inline',
            submit: 'Republish report card',
            fields: [
              ...ids,
              { name: 'published', label: '', kind: 'hidden', value: 'true' },
              { name: 'republish', label: '', kind: 'hidden', value: 'true' },
              { name: 'expectedVersion', label: '', kind: 'hidden', value: String(work.version) },
              { name: 'reason', label: 'Reason', kind: 'textarea', rows: 2, hint: '10 to 240 characters. Leave out medical and personal details.' },
            ],
          },
          { kind: 'links', title: `Report card, issue version ${work.version}`, links: [{ label: 'Download report card', href: href(termId, sectionId, studentId) }] },
        )
      } else if (work.published) {
        out.push({ kind: 'note', tone: 'warn', text: reportCardRefusal('report_card_legacy_unversioned').message })
        if (data.office)
          out.push({
            kind: 'form',
            title: 'Issue legacy report card',
            note: 'Reviews the figures against the school’s own copy and issues them as version 1 today. The original publication date is kept in the audit trail.',
            path: '/report-card/publication',
            placement: 'inline',
            submit: 'Issue legacy report card',
            fields: [
              ...ids,
              { name: 'published', label: '', kind: 'hidden', value: 'true' },
              { name: 'republish', label: '', kind: 'hidden', value: 'true' },
              { name: 'expectedVersion', label: '', kind: 'hidden', value: '0' },
              { name: 'reason', label: 'Reason', kind: 'textarea', rows: 2, hint: '10 to 240 characters.' },
            ],
          })
      }
      return out
    },
  },

  {
    path: '/my-report-cards',
    title: 'School report cards',
    menu: 'School report cards',
    roles: ['student', 'parent'],
    async load(actor) {
      const a = actor as Actor & { viewerOf?: string[] }
      const wanted = a.role === 'student' ? [a.id] : (a.viewerOf ?? [])
      const rows = await withTenant(a.institutionId!, async (tx) => {
        // The same academic_record check every other reader of a pupil's results uses.
        const allowed: string[] = []
        for (const id of wanted) if (await canAccessStudent(tx, { ...a, authzReportOnly: false }, id, 'academic_record')) allowed.push(id)
        if (!allowed.length) return []
        // The latest issue of each visible card, with the labels it was printed with: a later
        // change to an offering, a mark or the roster must never remove the link.
        const found = (
          await tx.execute(sql`
            select distinct on (v.term_id, v.section_id, v.student_id)
                   v.term_id as "termId", v.section_id as "sectionId", v.student_id as "studentId",
                   v.payload->'report' as report, t.starts_on as "startsOn"
              from exam_report_card_versions v
              join exam_report_card_entries e on e.institution_id = v.institution_id and e.term_id = v.term_id
                   and e.section_id = v.section_id and e.student_id = v.student_id and e.published_at is not null
              join users u on u.id = v.student_id and u.erased_at is null
              join academic_terms t on t.id = v.term_id
             where v.payload is not null and v.student_id in (${sql.join(allowed.map((i) => sql`${i}`), sql`, `)})
             order by v.term_id, v.section_id, v.student_id, v.version desc`)
        ).rows as unknown as { termId: string; sectionId: string; studentId: string; report: { term: { code: string; name: string }; sectionLabel: string; name: string }; startsOn: string }[]
        return found
          .map((r) => ({ ...r, term: `${r.report.term.code} ${r.report.term.name}`, section: r.report.sectionLabel, name: r.report.name || 'Student' }))
          .sort((x, y) => (x.startsOn < y.startsOn ? 1 : x.startsOn > y.startsOn ? -1 : 0) || x.section.localeCompare(y.section) || x.name.localeCompare(y.name) || (x.studentId < y.studentId ? -1 : 1))
          .map((r) => ({ termId: r.termId, sectionId: r.sectionId, studentId: r.studentId, term: r.term, section: r.section, name: r.name, link: 'Download report card', href: href(r.termId, r.sectionId, r.studentId) }))
      })
      return { rows }
    },
    sections: () => [
      {
        kind: 'table',
        title: 'Published school report cards',
        rows: 'rows',
        empty: 'No published school report cards.',
        columns: [
          { key: 'term', label: 'Term' },
          { key: 'section', label: 'Section' },
          { key: 'name', label: 'Pupil' },
          { key: 'link', label: '', href: `${PDF}?termId={termId}&sectionId={sectionId}&studentId={studentId}` },
        ],
      },
    ],
  },
]
