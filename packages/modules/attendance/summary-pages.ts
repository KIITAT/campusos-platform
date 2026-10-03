import { param, type PluginPage, type PluginSection } from '@campusos/module-framework'
import { listStructure } from '@campusos/module-academic/api'
import { attendanceRules, attendanceSummary, classAbsentees, classChoices, excusableStudents, listExcuses, type Actor } from './api'

const STAFF = ['institution_admin', 'super_admin', 'hod', 'faculty'] as const
const KINDS = [
  { value: 'medical', label: 'Medical' },
  { value: 'on_duty', label: 'On college duty' },
  { value: 'leave', label: 'Approved leave' },
  { value: 'other', label: 'Other' },
]

const pct = (p: number | null) => (p === null ? '' : `${p}%`)

/** The student's own page, as KIIT's "Student Attendance Details" lays it out. */
export const myAttendancePage: PluginPage = {
  path: '/me',
  title: 'My attendance',
  menu: 'My attendance',
  roles: ['student'],
  async load(actor, req) {
    const a = actor as Actor
    const structure = await listStructure(a as never)
    const term =
      structure.terms.find((t) => t.id === param(req, 'termId')) ?? structure.terms.find((t) => t.isCurrent) ?? structure.terms.at(-1) ?? null
    const [lines, rules] = await Promise.all([attendanceSummary(a, a.id, term?.id ?? null), attendanceRules(a)])
    const held = lines.reduce((n, l) => n + l.held, 0)
    const counted = lines.reduce((n, l) => n + l.present + (rules.excusedCounts ? l.excused : 0), 0)
    return {
      rules,
      term: term?.code ?? '',
      terms: structure.terms.map((t) => ({ label: t.code, href: `/m/attendance/me?termId=${t.id}`, active: t.id === term?.id })),
      rows: lines.map((l) => ({
        ...l,
        pctText: pct(l.percent),
        neededText: l.needed ? `${l.needed} in a row` : '',
      })),
      overall: held ? Math.round((counted / held) * 1000) / 10 : null,
      short: lines.filter((l) => l.short),
    }
  },
  sections: (data) => {
    const rules = data.rules as { minimumPercent: number; excusedCounts: boolean } | undefined
    const short = (data.short as { courseCode: string; needed: number }[] | undefined) ?? []
    const out: PluginSection[] = [
      { kind: 'links', title: 'Term', links: (data.terms as never) ?? [] },
      {
        kind: 'figures',
        figures: [
          { label: 'Overall', value: data.overall === null || data.overall === undefined ? '—' : `${data.overall}%` },
          { label: 'Minimum', value: `${rules?.minimumPercent ?? 75}%` },
          { label: 'Classes short', value: String(short.length), tone: short.length ? 'due' : 'clear' },
        ],
      },
    ]
    if (short.length) {
      out.push({
        kind: 'note',
        tone: 'warn',
        text: `Below ${rules?.minimumPercent ?? 75}% in ${short.map((s) => `${s.courseCode} (attend the next ${s.needed} to recover)`).join(', ')}. Talk to your mentor if something is in the way.`,
      })
    }
    out.push({
      kind: 'table',
      title: `Attendance, ${String(data.term ?? '')}`,
      note: rules?.excusedCounts
        ? 'Excused absences -- illness, college duty, approved leave -- count towards the percentage.'
        : 'Excused absences are shown, but only classes attended count towards the percentage.',
      rows: 'rows',
      empty: 'No classes this term.',
      columns: [
        { key: 'teacher', label: 'Faculty' },
        { key: 'courseCode', label: 'Subject', kind: 'code' },
        { key: 'courseTitle', label: 'Title' },
        { key: 'present', label: 'Present' },
        { key: 'absent', label: 'Absent' },
        { key: 'excused', label: 'Excused' },
        { key: 'held', label: 'Total' },
        { key: 'pctText', label: '%', alertWhen: 'short' },
        { key: 'neededText', label: 'To recover' },
      ],
    })
    return out
  },
}

export const summaryPages: PluginPage[] = [
  {
    path: '/absentees',
    title: 'Absentees',
    menu: 'Absentees',
    roles: [...STAFF],
    async load(actor, req) {
      const a = actor as Actor
      const classes = await classChoices(a)
      const id = param(req, 'offeringId') ?? classes[0]?.value
      if (!id) return { classes: [], v: null }
      const v = await classAbsentees(a, id)
      return {
        v,
        classes: classes.map((c) => ({ label: c.label, href: `/m/attendance/absentees?offeringId=${c.value}`, active: c.value === id })),
        rows: v.students.map((s) => ({ ...s, pctText: pct(s.percent), neededText: s.needed ? `${s.needed}` : '' })),
        missing: (v.lastSession?.missing ?? []).map((name) => ({ name })),
      }
    },
    sections: (data) => {
      const v = data.v as Awaited<ReturnType<typeof classAbsentees>> | null
      if (typeof v?.class?.id !== 'string') return [{ kind: 'note', text: 'No classes this term.' }]
      return [
        { kind: 'links', title: 'Class', links: data.classes as never },
        {
          kind: 'figures',
          figures: [
            { label: 'Students', value: String(v.students.length) },
            { label: `Below ${v.rules.minimumPercent}%`, value: String(v.short), tone: v.short ? 'due' : 'clear' },
            { label: 'Missed the last class', value: String(v.lastSession?.missing.length ?? 0) },
          ],
        },
        {
          kind: 'table',
          title: `${v.class.course}, section ${v.class.section}`,
          note: 'Those short of the minimum first.',
          rows: 'rows',
          pageSize: 80,
          columns: [
            { key: 'name', label: 'Student' },
            { key: 'rollNo', label: 'Roll', kind: 'code' },
            { key: 'present', label: 'Present' },
            { key: 'absent', label: 'Absent' },
            { key: 'excused', label: 'Excused' },
            { key: 'held', label: 'Held' },
            { key: 'pctText', label: '%', alertWhen: 'short' },
            { key: 'neededText', label: 'Needs' },
          ],
        },
        {
          kind: 'table',
          title: 'Missed the last class',
          rows: 'missing',
          empty: v.lastSession ? 'Nobody: everyone was there.' : 'No class held yet.',
          columns: [{ key: 'name', label: 'Student' }],
        },
      ]
    },
  },

  {
    path: '/excuses',
    title: 'Excused absence',
    menu: 'Excuses',
    roles: [...STAFF],
    async load(actor) {
      const a = actor as Actor
      const [rows, rules, classes, students] = await Promise.all([listExcuses(a), attendanceRules(a), classChoices(a), excusableStudents(a)])
      const runs = a.role !== 'faculty'
      return {
        rows: rows.map((r) => ({
          ...r,
          days: r.fromOn === r.toOn ? r.fromOn : `${r.fromOn} to ${r.toOn}`,
          kindText: KINDS.find((k) => k.value === r.kind)?.label ?? r.kind,
          why: r.revokeReason ? `${r.reason} (revoked: ${r.revokeReason})` : r.reason,
        })),
        rules,
        runs,
        classes,
        students,
        revocable: rows
          .filter((r) => r.state === 'excused' && !r.sourceModule)
          .map((r) => ({ value: r.id, label: `${r.student}: ${r.course}, ${r.fromOn === r.toOn ? r.fromOn : `${r.fromOn} to ${r.toOn}`}` })),
      }
    },
    sections: (data) => {
      const rules = data.rules as { minimumPercent: number; excusedCounts: boolean; timeZone: string }
      const out: PluginSection[] = [
        {
          kind: 'table',
          title: 'Excuses',
          note: 'A class missed inside an excuse counts as excused. Approved leave is excused by Mentoring, and withdrawn there.',
          rows: 'rows',
          empty: 'None.',
          pageSize: 50,
          columns: [
            { key: 'student', label: 'Student' },
            { key: 'course', label: 'Class' },
            { key: 'days', label: 'Days' },
            { key: 'kindText', label: 'Kind' },
            { key: 'why', label: 'Why' },
            { key: 'by', label: 'By' },
            { key: 'state', label: 'State', kind: 'status' },
          ],
        },
        {
          kind: 'form',
          title: 'Excuse absence',
          note: data.runs ? 'For one class, or every class the student has when no class is chosen.' : 'For one of your classes.',
          submit: 'Excuse',
          path: '/excuses',
          fields: [
            { name: 'studentId', label: 'Student', kind: 'select', options: 'students' },
            { name: 'offeringId', label: 'Class', kind: 'select', options: 'classes', optional: Boolean(data.runs) },
            { name: 'fromOn', label: 'From', kind: 'date' },
            { name: 'toOn', label: 'To', kind: 'date' },
            { name: 'kind', label: 'Kind', kind: 'radio', options: KINDS, value: 'medical' },
            { name: 'reason', label: 'Why' },
          ],
        },
        {
          kind: 'form',
          title: 'Revoke an excuse',
          submit: 'Revoke',
          path: '/excuses/revoke',
          fields: [
            { name: 'excuseId', label: 'Excuse', kind: 'select', options: 'revocable' },
            { name: 'reason', label: 'Why' },
          ],
        },
      ]
      if (data.runs) {
        out.push({
          kind: 'form',
          title: 'Attendance rules',
          note: `Now: ${rules.minimumPercent}% minimum; excused absence ${rules.excusedCounts ? 'counts' : 'does not count'}; dates read in ${rules.timeZone}. The minimum and what counts are the university's regulation.`,
          submit: 'Save the rules',
          path: '/rules',
          roles: ['institution_admin', 'super_admin'],
          fields: [
            { name: 'minimumPercent', label: 'Minimum attendance (%)', kind: 'number', value: String(rules.minimumPercent) },
            { name: 'excusedCounts', label: 'Excused absence counts towards it', kind: 'checkbox', value: String(rules.excusedCounts) },
            { name: 'timeZone', label: 'Time zone', value: rules.timeZone },
          ],
        })
      }
      return out
    },
  },
]
