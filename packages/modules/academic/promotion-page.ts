import { asc, eq, inArray } from 'drizzle-orm'
import { users, withTenant } from '@campusos/db'
import type { PluginPage, PluginSection } from '@campusos/module-framework'
import { programs, sections, studentProfiles, terms } from './schema'
import { readSchoolPromotionRoster, requireWriter, schoolRosterToken, todayIST, type Actor } from './api'

/**
 * School promotion (P1-13c): set each class's next class, preview a section's
 * roster, then promote it, with the detained students ticked. The operation is
 * `promoteSection`; this page only gathers what it needs, and shows the same
 * roster token the operation will demand back.
 */

const REGISTRAR = ['institution_admin', 'super_admin'] as const
const NOTE = {
  finalised: 'This section has already been promoted.',
  size: 'Promotion requires between 1 and 500 students.',
}
const NONE = { value: '', label: 'None' }

export const promotionPage: PluginPage = {
  path: '/promotion',
  title: 'School promotion',
  menu: 'School promotion',
  roles: [...REGISTRAR],
  async load(actor, req) {
    const a = actor as Actor
    const tenant = requireWriter(a)
    const asked = new URL(req.url).searchParams.get('sourceSectionId') ?? ''
    return withTenant(tenant, async (tx) => {
      const classes = await tx.select().from(programs).where(eq(programs.level, 'school')).orderBy(asc(programs.code), asc(programs.id))
      const codeOf = new Map(classes.map((p) => [p.id, p.code]))
      const rows = await tx
        .select({ section: sections })
        .from(sections)
        .innerJoin(programs, eq(programs.id, sections.programId))
        .where(eq(programs.level, 'school'))
        .orderBy(asc(programs.code), asc(sections.admissionYear), asc(sections.label), asc(sections.id))
      const label = (s: (typeof rows)[number]['section']) => `${codeOf.get(s.programId)} ${s.label} (${s.admissionYear})`
      const regular = await tx.select().from(terms).where(eq(terms.kind, 'regular')).orderBy(asc(terms.startsOn), asc(terms.id))

      const data: Record<string, unknown> = {
        classes: classes.map((p) => ({ id: p.id, code: p.code, name: p.name, next: p.nextProgramId ? (codeOf.get(p.nextProgramId) ?? '') : '' })),
        classOptions: classes.map((p) => ({ value: p.id, label: `${p.code} - ${p.name}` })),
        nextOptions: [{ value: '', label: 'No next class' }, ...classes.map((p) => ({ value: p.id, label: `${p.code} - ${p.name}` }))],
        sectionOptions: rows.map(({ section }) => ({ value: section.id, label: label(section) })),
        termOptions: regular.map((t) => ({ value: t.id, label: `${t.code} (${t.startsOn} to ${t.endsOn})` })),
        sourceSectionId: asked,
        state: 'none',
        roster: [],
      }

      const source = rows.find(({ section }) => section.id === asked)?.section
      if (!asked) return data
      if (!source) {
        data.state = 'unknown'
        return data
      }
      data.sourceLabel = label(source)
      if (source.schoolPromotedAt) {
        data.state = 'finalised'
        return data
      }
      const from = classes.find((p) => p.id === source.programId)!
      const today = todayIST()
      const roster = await readSchoolPromotionRoster(tx, source.id, source.programId, today, false)
      if (roster.memberIds.length < 1 || roster.memberIds.length > 500 || roster.participantIds.length < 1) {
        data.state = 'size'
        return data
      }
      const people = await tx
        .select({ id: users.id, name: users.name, rollNo: studentProfiles.rollNo })
        .from(users)
        .leftJoin(studentProfiles, eq(studentProfiles.studentId, users.id))
        .where(inArray(users.id, roster.memberIds))
      const by = new Map(people.map((p) => [p.id, p]))
      const stays = new Set(roster.participantIds)
      const ordered = [...roster.memberIds].sort((x, y) => (by.get(x)?.name ?? '').localeCompare(by.get(y)?.name ?? '') || x.localeCompare(y))
      const next = source.admissionYear + 1
      data.state = 'ready'
      data.rosterToken = schoolRosterToken(roster.memberIds, roster.participantIds)
      data.roster = ordered.map((id) => ({ name: by.get(id)?.name ?? id, rollNo: by.get(id)?.rollNo ?? '', standing: stays.has(id) ? 'On roll' : 'Departed' }))
      data.candidates = ordered.filter((id) => stays.has(id)).map((id) => ({ value: id, label: by.get(id)?.name ?? id }))
      data.promotedOptions = [NONE, ...rows.filter(({ section: s }) => s.programId === from.nextProgramId && s.admissionYear === next && !s.schoolPromotedAt).map(({ section: s }) => ({ value: s.id, label: label(s) }))]
      data.detainedOptions = [NONE, ...rows.filter(({ section: s }) => s.programId === from.id && s.admissionYear === next && !s.schoolPromotedAt).map(({ section: s }) => ({ value: s.id, label: label(s) }))]
      data.noSuccessor = !from.nextProgramId
      return data
    })
  },
  sections: (data): PluginSection[] => {
    const out: PluginSection[] = [
      {
        kind: 'note',
        text:
          'At the end of a session, the old class declaration of every student in a section ends and a new one starts on the first day of the new session: the next class for promoted students, the same class again for detained ones. Previous section membership stays, with its attendance and marks. Promotion runs on or after the first day of the new term, so invoice the new term after promoting; an invoice raised earlier stays at the old class.',
      },
      {
        kind: 'table',
        title: 'Next class',
        rows: 'classes',
        empty: 'No school classes yet.',
        columns: [
          { key: 'code', label: 'Class', kind: 'code' },
          { key: 'name', label: 'Name' },
          { key: 'next', label: 'Next class', kind: 'code' },
        ],
      },
      {
        kind: 'form',
        title: 'Set the next class',
        submit: 'Save next class',
        path: '/programs/next',
        roles: [...REGISTRAR],
        placement: 'inline',
        fields: [
          { name: 'programId', label: 'Class', kind: 'select', options: 'classOptions' },
          { name: 'nextProgramId', label: 'Next class', kind: 'select', options: 'nextOptions', optional: true },
        ],
      },
      {
        kind: 'form',
        title: 'Preview a section',
        submit: 'Preview',
        path: '/promotion',
        method: 'GET',
        fields: [{ name: 'sourceSectionId', label: 'Source section', kind: 'select', options: 'sectionOptions', value: String(data.sourceSectionId ?? '') }],
      },
    ]
    const state = data.state
    if (state === 'unknown') out.push({ kind: 'note', tone: 'danger', text: 'No such section.' })
    if (state === 'finalised') out.push({ kind: 'note', tone: 'warn', text: NOTE.finalised })
    if (state === 'size') out.push({ kind: 'note', tone: 'warn', text: NOTE.size })
    if (state !== 'ready') return out
    out.push({
      kind: 'table',
      title: String(data.sourceLabel),
      rows: 'roster',
      empty: 'Nobody.',
      columns: [
        { key: 'name', label: 'Student' },
        { key: 'rollNo', label: 'Roll number' },
        { key: 'standing', label: 'Standing' },
      ],
    })
    if (data.noSuccessor) out.push({ kind: 'note', tone: 'info', text: 'This class has no next class, so every student must be detained. Other exits are recorded one by one.' })
    out.push({
      kind: 'form',
      title: 'Promote section',
      submit: 'Promote section',
      path: '/sections/promote',
      roles: [...REGISTRAR],
      placement: 'inline',
      fields: [
        { name: 'sourceSectionId', label: 'Source section', kind: 'hidden', value: String(data.sourceSectionId) },
        { name: 'rosterToken', label: 'Roster', kind: 'hidden', value: String(data.rosterToken) },
        { name: 'sourceTermId', label: 'Last term of old session', kind: 'select', options: 'termOptions' },
        { name: 'nextTermId', label: 'First term of new session', kind: 'select', options: 'termOptions' },
        { name: 'promotedSectionId', label: 'Promoted students’ section', kind: 'select', options: 'promotedOptions', optional: true },
        { name: 'detainedSectionId', label: 'Detained students’ section', kind: 'select', options: 'detainedOptions', optional: true },
        { name: 'detainedStudentIds', label: 'Students to detain', kind: 'checkboxes', options: 'candidates', optional: true },
        { name: 'reason', label: 'Reason', kind: 'textarea', rows: 2, hint: '5 to 500 characters, kept on the audit record.' },
      ],
    })
    return out
  },
}
