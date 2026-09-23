import { param, type PluginPage, type PluginSection } from '@campusos/module-framework'
import {
  coverage,
  frameworkView,
  levelChoices,
  listFrameworks,
  listStudents,
  profile,
  skillChoices,
  type Actor,
  type Profile,
} from './api'

const ADMIN = ['institution_admin', 'super_admin'] as const
const STAFF = ['institution_admin', 'super_admin', 'hod', 'faculty'] as const

const SEPARATE =
  'Skills are not grades. A grade is how a course went, once, and is locked; a skill is built across courses and outside them, and its level moves as evidence comes in. Nothing here comes from a mark or goes to a transcript.'

const gapWords = (g: number | null) =>
  g === null ? '' : g === 0 ? 'agree' : g > 0 ? `teacher +${g}` : `self +${-g}`

/** A profile as the rows and chart a page shows. */
function profileData(p: Profile) {
  return {
    student: p.student,
    skills: p.skills.map((s) => ({
      ...s,
      selfText: s.self ? `${s.selfRank}. ${s.self}` : '',
      teacherText: s.teacher ? `${s.teacherRank}. ${s.teacher}` : '',
      gapText: gapWords(s.gap),
      apart: s.gap !== null && Math.abs(s.gap) >= 2,
    })),
    history: p.history,
    chart: p.skills
      .filter((s) => s.selfRank !== null || s.teacherRank !== null)
      .map((s) => ({ code: s.code, self: s.selfRank ?? 0, teacher: s.teacherRank ?? 0 })),
  }
}

function profileSections(data: Record<string, unknown>, mine: boolean): PluginSection[] {
  return [
    {
      kind: 'chart',
      title: mine ? 'How you see yourself, and how your teachers see you' : 'Self and teacher, by skill',
      type: 'bar',
      rows: 'chart',
      x: 'code',
      series: [
        { key: 'self', label: mine ? 'You' : 'Self' },
        { key: 'teacher', label: 'Teacher' },
      ],
      empty: 'No judgements yet.',
    },
    {
      kind: 'table',
      title: 'Skills',
      note: 'The latest judgement from each side. Two levels or more apart is worth a conversation.',
      rows: 'skills',
      empty: 'No skills defined yet.',
      pageSize: 50,
      columns: [
        { key: 'code', label: 'Code', kind: 'code' },
        { key: 'name', label: 'Skill' },
        { key: 'category', label: 'Area' },
        { key: 'selfText', label: mine ? 'You say' : 'Self' },
        { key: 'teacherText', label: 'Teacher says' },
        { key: 'gapText', label: 'Gap', alertWhen: 'apart' },
        { key: 'teacherBy', label: 'By' },
        { key: 'teacherOn', label: 'On', kind: 'date' },
        { key: 'evidence', label: 'Evidence' },
      ],
    },
    {
      kind: 'table',
      title: 'History',
      note: 'Every judgement, as written. Nothing is changed or removed; a new one supersedes the last.',
      rows: 'history',
      empty: 'Nothing recorded yet.',
      pageSize: 50,
      columns: [
        { key: 'assessedOn', label: 'On', kind: 'date' },
        { key: 'code', label: 'Skill', kind: 'code' },
        { key: 'level', label: 'Level' },
        { key: 'source', label: 'From', kind: 'status' },
        { key: 'by', label: 'By' },
        { key: 'evidence', label: 'Evidence' },
      ],
    },
  ]
}

export const pages: PluginPage[] = [
  {
    path: '/',
    title: 'Skills',
    menu: 'Skills',
    roles: [...STAFF],
    async load(actor) {
      const a = actor as Actor
      const [fws, cov] = await Promise.all([listFrameworks(a), coverage(a)])
      return {
        frameworks: fws,
        coverage: cov.map((c) => ({
          ...c,
          gap: c.selfAvg !== null && c.teacherAvg !== null ? Math.round((c.teacherAvg - c.selfAvg) * 100) / 100 : null,
          self: c.selfAvg ?? 0,
          teacher: c.teacherAvg ?? 0,
        })),
        totals: {
          frameworks: fws.length,
          skills: fws.reduce((n, f) => n + f.skills, 0),
          students: Math.max(0, ...fws.map((f) => f.students)),
        },
      }
    },
    sections: (data) => {
      const t = data.totals as { frameworks: number; skills: number; students: number }
      return [
        {
          kind: 'figures',
          figures: [
            { label: 'Frameworks', value: String(t.frameworks) },
            { label: 'Live skills', value: String(t.skills) },
            { label: 'Students judged', value: String(t.students), href: '/m/skills/students' },
          ],
        },
        { kind: 'note', text: SEPARATE },
        {
          kind: 'chart',
          title: 'Average level, self and teacher',
          note: "Each student's latest judgement from each side.",
          type: 'bar',
          rows: 'coverage',
          x: 'code',
          series: [
            { key: 'self', label: 'Self' },
            { key: 'teacher', label: 'Teacher' },
          ],
          empty: 'No judgements yet.',
        },
        {
          kind: 'table',
          title: 'Frameworks',
          rows: 'frameworks',
          empty: 'No framework yet. Define one with its scale: the levels and what each means here.',
          columns: [
            { key: 'name', label: 'Framework', href: '/m/skills/framework?frameworkId={id}' },
            { key: 'levels', label: 'Levels' },
            { key: 'skills', label: 'Skills' },
            { key: 'students', label: 'Students judged' },
          ],
        },
        {
          kind: 'table',
          title: 'By skill',
          rows: 'coverage',
          empty: 'No skills yet.',
          columns: [
            { key: 'code', label: 'Code', kind: 'code' },
            { key: 'name', label: 'Skill' },
            { key: 'judged', label: 'Judged by a teacher' },
            { key: 'selfAvg', label: 'Self, average' },
            { key: 'teacherAvg', label: 'Teacher, average' },
            { key: 'gap', label: 'Gap' },
          ],
        },
        {
          kind: 'form',
          title: 'Define a framework',
          note: 'Write the scale lowest first, one level per line, as "Name: what a student at this level can do". Nothing is supplied: the words are yours.',
          submit: 'Create',
          path: '/frameworks',
          roles: [...ADMIN],
          fields: [
            { name: 'name', label: 'Name', hint: 'e.g. Employability' },
            { name: 'description', label: 'What it is for', kind: 'textarea', rows: 2, optional: true },
            {
              name: 'levels',
              label: 'Levels',
              kind: 'textarea',
              rows: 5,
              hint: 'Beginner: needs guidance on routine tasks',
            },
          ],
        },
      ]
    },
  },

  {
    path: '/framework',
    title: 'Framework',
    roles: [...STAFF],
    async load(actor, req) {
      const id = param(req, 'frameworkId')
      if (!id) return { v: null }
      const v = await frameworkView(actor as Actor, id)
      return {
        v,
        frameworkId: v.framework.id,
        levels: v.levels,
        skills: v.skills.map((s) => ({ ...s, state: s.retiredAt ? 'retired' : 'active' })),
      }
    },
    record: (data) => {
      const v = data.v as Awaited<ReturnType<typeof frameworkView>> | null
      if (typeof v?.framework?.id !== 'string') return null
      return {
        title: v.framework.name,
        subtitle: v.framework.description ?? undefined,
        fields: [
          { label: 'Levels', value: v.levels.length },
          { label: 'Skills', value: v.skills.filter((s) => !s.retiredAt).length },
        ],
        createdAt: v.framework.createdAt.toISOString(),
      }
    },
    sections: (data) => {
      const v = data.v as Awaited<ReturnType<typeof frameworkView>> | null
      if (typeof v?.framework?.id !== 'string') return [{ kind: 'note', tone: 'warn', text: 'No such framework.' }]
      const id = data.frameworkId as string
      return [
        {
          kind: 'table',
          title: 'Scale',
          note: 'Lowest first. A level students have been judged against is never rewritten; a new one goes on top.',
          rows: 'levels',
          columns: [
            { key: 'rank', label: 'Level' },
            { key: 'name', label: 'Name' },
            { key: 'descriptor', label: 'A student here can' },
          ],
        },
        {
          kind: 'table',
          title: 'Skills',
          rows: 'skills',
          empty: 'No skills yet.',
          pageSize: 50,
          columns: [
            { key: 'code', label: 'Code', kind: 'code' },
            { key: 'name', label: 'Skill' },
            { key: 'category', label: 'Area' },
            { key: 'judged', label: 'Judged by a teacher' },
            { key: 'selfJudged', label: 'Self-judged' },
            { key: 'state', label: 'State', kind: 'status' },
          ],
          bulk: [
            {
              label: 'Retire',
              path: '/skills/retire',
              idKey: 'id',
              field: 'skillIds',
              roles: [...ADMIN],
              tone: 'danger',
            },
          ],
        },
        {
          kind: 'form',
          title: 'Add a skill',
          submit: 'Add',
          path: '/skills',
          roles: [...ADMIN],
          fields: [
            { name: 'frameworkId', label: '', kind: 'hidden', value: id },
            { name: 'code', label: 'Code', hint: 'e.g. COMM-WRITTEN' },
            { name: 'name', label: 'Name', hint: 'e.g. Written communication' },
            { name: 'category', label: 'Area', optional: true, hint: 'e.g. Communication' },
            { name: 'description', label: 'Description', kind: 'textarea', rows: 2, optional: true },
          ],
        },
        {
          kind: 'form',
          title: 'Add a level on top',
          submit: 'Add level',
          path: '/levels',
          roles: [...ADMIN],
          placement: 'action',
          fields: [
            { name: 'frameworkId', label: '', kind: 'hidden', value: id },
            { name: 'name', label: 'Name' },
            { name: 'descriptor', label: 'A student here can' },
          ],
        },
      ]
    },
  },

  {
    path: '/students',
    title: 'Students',
    menu: 'Students',
    roles: [...STAFF],
    async load(actor) {
      const rows = await listStudents(actor as Actor)
      return { students: rows.map((s) => ({ ...s, name: s.name ?? s.email })) }
    },
    sections: () => [
      {
        kind: 'table',
        title: 'Students',
        rows: 'students',
        empty: 'No students.',
        pageSize: 50,
        columns: [
          { key: 'name', label: 'Student', href: '/m/skills/student?studentId={id}' },
          { key: 'judgements', label: 'Teacher judgements' },
          { key: 'selfJudgements', label: 'Self' },
          { key: 'lastOn', label: 'Last', kind: 'date' },
        ],
      },
    ],
  },

  {
    path: '/student',
    title: 'Student skills',
    roles: [...STAFF],
    async load(actor, req) {
      const a = actor as Actor
      const id = param(req, 'studentId')
      if (!id) return { p: null }
      const [p, sk, lv] = await Promise.all([profile(a, id), skillChoices(a), levelChoices(a)])
      return {
        p,
        studentId: id,
        ...profileData(p),
        skillOptions: sk.map((s) => ({ value: s.id, label: `${s.code} - ${s.name}` })),
        levelOptions: lv,
      }
    },
    record: (data) => {
      const p = data.p as Profile | null
      if (typeof p?.student?.id !== 'string') return null
      const judged = p.skills.filter((s) => s.teacherRank !== null).length
      return {
        title: p.student.name,
        subtitle: 'Skills profile',
        fields: [
          { label: 'Skills judged by a teacher', value: `${judged} of ${p.skills.length}` },
          { label: 'Judgements on record', value: p.history.length },
        ],
      }
    },
    sections: (data) => {
      const p = data.p as Profile | null
      if (typeof p?.student?.id !== 'string') return [{ kind: 'note', tone: 'warn', text: 'No such student.' }]
      return [
        ...profileSections(data, false),
        {
          kind: 'form',
          title: 'Record a judgement',
          note: 'With the evidence it rests on: a project, a presentation, something you saw. It is kept as written.',
          submit: 'Record',
          path: '/assess',
          placement: 'action',
          fields: [
            { name: 'studentId', label: '', kind: 'hidden', value: data.studentId as string },
            { name: 'skillId', label: 'Skill', kind: 'select', options: 'skillOptions' },
            { name: 'rank', label: 'Level', kind: 'select', options: 'levelOptions' },
            { name: 'evidence', label: 'Evidence', kind: 'textarea', rows: 3 },
            { name: 'assessedOn', label: 'Observed on', kind: 'date', optional: true, hint: 'Empty: today' },
          ],
        },
      ]
    },
  },

  {
    path: '/me',
    title: 'My skills',
    menu: 'My skills',
    roles: ['student'],
    async load(actor) {
      const a = actor as Actor
      const [p, sk, lv] = await Promise.all([profile(a, a.id), skillChoices(a), levelChoices(a)])
      return {
        ...profileData(p),
        skillOptions: sk.map((s) => ({ value: s.id, label: `${s.code} - ${s.name}` })),
        levelOptions: lv,
      }
    },
    sections: (data) => [
      { kind: 'note', text: SEPARATE },
      ...profileSections(data, true),
      {
        kind: 'form',
        title: 'Rate yourself',
        note: 'Your own view, recorded beside your teachers’ -- never over it. Say what it rests on if you can.',
        submit: 'Record',
        path: '/self-assess',
        placement: 'action',
        fields: [
          { name: 'skillId', label: 'Skill', kind: 'select', options: 'skillOptions' },
          { name: 'rank', label: 'Level', kind: 'select', options: 'levelOptions' },
          { name: 'evidence', label: 'Because', kind: 'textarea', rows: 2, optional: true },
        ],
      },
    ],
  },
]

