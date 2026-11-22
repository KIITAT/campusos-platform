import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'
import { withTenant } from '@campusos/db'
import { canAccessStudent, param, type PluginPage, type PluginSection } from '@campusos/module-framework'
import { studentProfiles } from '@campusos/module-academic/schema'
import { listUnassessedOfferings, reportCardRefusal } from './api/report-card-store'
import { reportCardWorkspace } from './api/report-card'
import { offerings, programs, sectionMembers, sections, terms, users } from './api/joins'
import { reportCardEntries } from './schema'
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
      out.push({ kind: 'prose', title: data.pupilName as string, text: work.template ? `${work.template.name}. ${work.published ? 'Published.' : 'Not published.'}` : '' })

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
      if (work.published) out.push({ kind: 'links', title: 'Report card', links: [{ label: 'Download report card', href: href(termId, sectionId, studentId) }] })
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
        const found = await tx
          .select({ termId: reportCardEntries.termId, sectionId: reportCardEntries.sectionId, studentId: reportCardEntries.studentId, term: terms.code, termName: terms.name, startsOn: terms.startsOn, section: sections.label, name: users.name })
          .from(reportCardEntries)
          .innerJoin(terms, eq(terms.id, reportCardEntries.termId))
          .innerJoin(sections, eq(sections.id, reportCardEntries.sectionId))
          .innerJoin(programs, and(eq(programs.id, sections.programId), eq(programs.level, 'school')))
          .innerJoin(users, and(eq(users.id, reportCardEntries.studentId), isNull(users.erasedAt)))
          .where(and(sql`${reportCardEntries.publishedAt} is not null`, sql`${reportCardEntries.studentId} in (${sql.join(allowed.map((i) => sql`${i}`), sql`, `)})`))
        return found
          .sort((x, y) => (x.startsOn < y.startsOn ? 1 : x.startsOn > y.startsOn ? -1 : 0) || x.section.localeCompare(y.section) || (x.name ?? '').localeCompare(y.name ?? '') || (x.studentId < y.studentId ? -1 : 1))
          .map((r) => ({ ...r, term: `${r.term} ${r.termName}`, name: r.name ?? 'Student', link: 'Download report card', href: href(r.termId, r.sectionId, r.studentId) }))
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
