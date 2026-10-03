import { param, type PluginField, type PluginPage, type PluginSection } from '@campusos/module-framework'
import {
  classResults,
  formChoices,
  formView,
  giveView,
  listForms,
  listWindows,
  myClassResults,
  myFeedback,
  termChoices,
  windowView,
  type Actor,
  type Aggregate,
} from './api'

const RUNNERS = ['institution_admin', 'super_admin', 'hod'] as const

const AUDIENCE = { teaching: 'Every class and its teacher', general: 'Once per student' } as const
const KIND = { scale: 'Scale', choice: 'Choice', text: 'Comment' } as const

const ZONES = ['Asia/Kolkata', 'UTC', 'Asia/Dubai', 'Asia/Singapore', 'Asia/Dhaka', 'Asia/Kathmandu', 'Europe/London', 'America/New_York'].map(
  (z) => ({ value: z, label: z }),
)

const ANONYMOUS =
  'Anonymous. That you gave feedback is recorded with your name, so you are not asked again; what you said is kept apart from it, with no name and no time. Your teacher sees averages and comments for the class only after the window closes, and only if enough of the class answered.'

const clip = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** A result's questions as rows, its scale questions as a chart, and its comments. */
function resultSections(r: { responses: number; shown: boolean; questions: Aggregate[] }, scalePoints: number, min: number): PluginSection[] {
  if (!r.shown) {
    return [
      {
        kind: 'note',
        tone: 'warn',
        text: `${r.responses} response${r.responses === 1 ? '' : 's'}; results are shown from ${min}, so that nobody can be picked out.`,
      },
    ]
  }
  const scale = r.questions.filter((q) => q.kind === 'scale')
  const out: PluginSection[] = []
  if (scale.length) {
    out.push({
      kind: 'chart',
      title: 'Average for each statement',
      note: `On the questionnaire's scale of 1 to ${scalePoints}.`,
      type: 'bar',
      rows: 'scaleRows',
      x: 'label',
      series: [{ key: 'mean', label: 'Average' }],
      max: scalePoints,
    })
  }
  out.push({
    kind: 'table',
    title: 'By question',
    rows: 'questionRows',
    pageSize: 60,
    columns: [
      { key: 'label', label: '#' },
      { key: 'section', label: 'Section' },
      { key: 'prompt', label: 'Question' },
      { key: 'meanText', label: 'Average' },
      { key: 'spreadText', label: 'Spread' },
      { key: 'answered', label: 'Answered' },
    ],
  })
  if (r.questions.some((q) => q.kind === 'text' && q.comments.length)) {
    out.push({
      kind: 'table',
      title: 'Comments',
      note: 'As written, in alphabetical order rather than the order they came in.',
      rows: 'commentRows',
      pageSize: 50,
      columns: [
        { key: 'prompt', label: 'Question' },
        { key: 'comment', label: 'Comment' },
      ],
    })
  }
  return out
}

function resultRows(r: { questions: Aggregate[] } | null | undefined) {
  const qs = r?.questions ?? []
  return {
    scaleRows: qs.filter((q) => q.kind === 'scale').map((q) => ({ label: `Q${q.position}`, mean: q.mean ?? 0 })),
    questionRows: qs.map((q) => ({
      label: `Q${q.position}`,
      section: q.section ?? '',
      prompt: clip(q.prompt, 110),
      meanText: q.mean === null ? '' : String(q.mean),
      spreadText: q.spread.map((s) => `${s.label}: ${s.count}`).join(' · '),
      answered: q.answered,
    })),
    commentRows: qs.flatMap((q) => q.comments.map((comment) => ({ prompt: clip(q.prompt, 60), comment }))),
  }
}

/** The answer sheet: a radio row for a point on the scale or a choice, a box for a comment. */
function answerField(q: { id: string; prompt: string; section: string | null; kind: string; options: string[]; required: boolean }, scale: { points: number; low: string; high: string }): PluginField {
  const label = `${q.section ? `${q.section} · ` : ''}${q.prompt}`
  if (q.kind === 'scale') {
    return {
      name: `q_${q.id}`,
      label,
      kind: 'radio',
      optional: !q.required,
      options: Array.from({ length: scale.points }, (_, i) => {
        const n = i + 1
        const words = n === 1 ? ` — ${scale.low}` : n === scale.points ? ` — ${scale.high}` : ''
        return { value: String(n), label: `${n}${words}` }
      }),
    }
  }
  if (q.kind === 'choice') {
    return { name: `q_${q.id}`, label, kind: 'radio', optional: !q.required, options: q.options.map((o) => ({ value: o, label: o })) }
  }
  return { name: `q_${q.id}`, label, kind: 'textarea', rows: 3, optional: true, hint: 'Optional. Please do not name anybody.' }
}

export const pages: PluginPage[] = [
  {
    path: '/',
    title: 'Feedback',
    menu: 'Windows',
    roles: [...RUNNERS],
    async load(actor) {
      const a = actor as Actor
      const [ws, formOptions, termOptions] = await Promise.all([listWindows(a), formChoices(a), termChoices(a)])
      const open = ws.filter((w) => w.phase === 'open')
      return {
        windows: ws.map((w) => ({ ...w, progress: `${w.given} of ${w.owed}` })),
        formOptions,
        termOptions,
        figures: {
          open: open.length,
          given: open.reduce((n, w) => n + w.given, 0),
          owed: open.reduce((n, w) => n + w.owed, 0),
        },
      }
    },
    sections: (data) => {
      const f = data.figures as { open: number; given: number; owed: number }
      return [
        {
          kind: 'figures',
          figures: [
            { label: 'Windows open', value: String(f.open) },
            { label: 'Given in open windows', value: String(f.given) },
            { label: 'Still owed', value: String(Math.max(0, f.owed - f.given)) },
          ],
        },
        {
          kind: 'table',
          title: 'Windows',
          rows: 'windows',
          empty: 'No windows yet. Write and publish a questionnaire, then open it to a term.',
          columns: [
            { key: 'title', label: 'Window', href: '/m/feedback/window?windowId={id}' },
            { key: 'form', label: 'Questionnaire' },
            { key: 'term', label: 'Term' },
            { key: 'phase', label: 'State', kind: 'status' },
            { key: 'opens', label: 'Opens' },
            { key: 'closes', label: 'Closes' },
            { key: 'progress', label: 'Given' },
            { key: 'pct', label: '%' },
          ],
        },
        {
          kind: 'form',
          title: 'Open a questionnaire to a term',
          note: 'Times are read in the zone you choose. A required window counts towards a student having finished their feedback for the term.',
          submit: 'Draft the window',
          path: '/windows',
          fields: [
            { name: 'formId', label: 'Questionnaire', kind: 'select', options: 'formOptions' },
            { name: 'termId', label: 'Term', kind: 'select', options: 'termOptions' },
            { name: 'title', label: 'Title', hint: 'What students see: "End-semester feedback, Autumn 2026"' },
            { name: 'opensAt', label: 'Opens', kind: 'datetime' },
            { name: 'closesAt', label: 'Closes', kind: 'datetime' },
            { name: 'timeZone', label: 'Time zone', kind: 'select', options: ZONES, value: 'Asia/Kolkata' },
            { name: 'minResponses', label: 'Fewest answers before a class sees results', kind: 'number', value: '5' },
            { name: 'required', label: 'Required: counts towards finishing feedback for the term', kind: 'checkbox', value: 'true' },
          ],
        },
      ]
    },
  },

  {
    path: '/forms',
    title: 'Questionnaires',
    menu: 'Questionnaires',
    roles: [...RUNNERS],
    async load(actor) {
      const fs = await listForms(actor as Actor)
      return { forms: fs.map((f) => ({ ...f, audienceText: AUDIENCE[f.audience] })) }
    },
    sections: () => [
      {
        kind: 'note',
        text: 'None are supplied. What a college asks its students -- and in what words -- is its own, and often set by its accreditation body.',
      },
      {
        kind: 'table',
        title: 'Questionnaires',
        rows: 'forms',
        empty: 'None yet.',
        columns: [
          { key: 'name', label: 'Questionnaire', href: '/m/feedback/form?formId={id}' },
          { key: 'audienceText', label: 'Answered' },
          { key: 'docstatus', label: 'State', kind: 'status' },
          { key: 'questions', label: 'Questions' },
          { key: 'windows', label: 'Windows' },
        ],
      },
      {
        kind: 'form',
        title: 'Start a questionnaire',
        submit: 'Start',
        path: '/forms',
        fields: [
          { name: 'name', label: 'Name', hint: 'e.g. Teaching-learning feedback' },
          {
            name: 'audience',
            label: 'Answered',
            kind: 'radio',
            options: [
              { value: 'teaching', label: 'For every class and its teacher' },
              { value: 'general', label: 'Once per student (facilities, curriculum)' },
            ],
            value: 'teaching',
          },
          { name: 'description', label: 'What it is for', kind: 'textarea', rows: 2, optional: true },
          { name: 'scalePoints', label: 'Points on the scale', kind: 'number', value: '5' },
          { name: 'scaleLow', label: 'Lowest point means', value: 'Strongly disagree' },
          { name: 'scaleHigh', label: 'Highest point means', value: 'Strongly agree' },
        ],
      },
    ],
  },

  {
    path: '/form',
    title: 'Questionnaire',
    roles: [...RUNNERS],
    async load(actor, req) {
      const id = param(req, 'formId')
      if (!id) return { v: null }
      const v = await formView(actor as Actor, id)
      return {
        v,
        questions: v.questions.map((q) => ({
          ...q,
          n: q.position,
          kindText: KIND[q.kind],
          optionsText: q.options.join(' · '),
          requiredText: q.required ? 'yes' : 'no',
        })),
        windows: v.windows,
      }
    },
    record: (data) => {
      const v = data.v as Awaited<ReturnType<typeof formView>> | null
      if (typeof v?.form?.id !== 'string') return null
      const f = v.form
      return {
        title: f.name,
        subtitle: AUDIENCE[f.audience],
        fields: [
          { label: 'Scale', value: `1 (${f.scaleLow}) to ${f.scalePoints} (${f.scaleHigh})` },
          { label: 'What it is for', value: f.description },
          { label: 'Retired because', value: f.cancelReason },
        ],
        createdAt: f.createdAt.toISOString(),
        audit: { entity: 'feedback_forms', entityId: f.id },
        docStatus: {
          value: f.docstatus,
          id: f.id,
          idField: 'formId',
          submit: '/forms/publish',
          cancel: '/forms/retire',
          roles: [...RUNNERS],
          labels: { submit: 'Publish', cancel: 'Retire' },
          states: { submitted: 'published', cancelled: 'retired' },
        },
      }
    },
    sections: (data) => {
      const v = data.v as Awaited<ReturnType<typeof formView>> | null
      if (typeof v?.form?.id !== 'string') return [{ kind: 'note', tone: 'warn', text: 'No such questionnaire.' }]
      const draft = v.form.docstatus === 'draft'
      const out: PluginSection[] = [
        {
          kind: 'table',
          title: 'Questions',
          rows: 'questions',
          pageSize: 60,
          empty: 'None yet.',
          bulk: draft
            ? [
                {
                  label: 'Remove',
                  path: '/questions/remove',
                  idKey: 'id',
                  field: 'questionIds',
                  tone: 'danger',
                  fields: [{ name: 'formId', label: '', kind: 'hidden', value: v.form.id }],
                },
              ]
            : undefined,
          columns: [
            { key: 'n', label: '#' },
            { key: 'section', label: 'Section' },
            { key: 'prompt', label: 'Question' },
            { key: 'kindText', label: 'Kind' },
            { key: 'optionsText', label: 'Options' },
            { key: 'requiredText', label: 'Required' },
          ],
        },
      ]
      if (draft) {
        out.push(
          {
            kind: 'form',
            title: 'Add statements on the scale',
            note: 'One per line. Each is answered from 1 to the top of the scale.',
            submit: 'Add',
            path: '/questions/scale',
            fields: [
              { name: 'formId', label: '', kind: 'hidden', value: v.form.id },
              { name: 'section', label: 'Section', optional: true, hint: 'e.g. The teacher' },
              { name: 'prompts', label: 'Statements', kind: 'textarea', rows: 6 },
            ],
          },
          {
            kind: 'form',
            title: 'Add a question',
            submit: 'Add',
            path: '/questions',
            fields: [
              { name: 'formId', label: '', kind: 'hidden', value: v.form.id },
              {
                name: 'kind',
                label: 'Kind',
                kind: 'radio',
                options: [
                  { value: 'scale', label: 'A point on the scale' },
                  { value: 'choice', label: 'One of some options' },
                  { value: 'text', label: 'A comment (always optional)' },
                ],
                value: 'scale',
              },
              { name: 'prompt', label: 'Question', kind: 'textarea', rows: 2 },
              { name: 'section', label: 'Section', optional: true },
              { name: 'options', label: 'Options, for a choice', kind: 'textarea', rows: 4, optional: true, hint: 'One per line' },
              { name: 'required', label: 'Required', kind: 'checkbox', value: 'true' },
            ],
          },
        )
      }
      out.push({
        kind: 'table',
        title: 'Windows',
        rows: 'windows',
        empty: 'Not opened to students yet.',
        columns: [
          { key: 'title', label: 'Window', href: '/m/feedback/window?windowId={id}' },
          { key: 'term', label: 'Term' },
          { key: 'phase', label: 'State', kind: 'status' },
          { key: 'opens', label: 'Opens' },
        ],
      })
      return out
    },
  },

  {
    path: '/window',
    title: 'Window',
    roles: [...RUNNERS],
    async load(actor, req) {
      const id = param(req, 'windowId')
      if (!id) return { v: null }
      const v = await windowView(actor as Actor, id)
      return {
        v,
        classes: v.classes.map((c) => ({ ...c, progress: `${c.given} of ${c.owed}`, windowId: v.window.id })),
        pending: v.pending,
        ...resultRows(v.overall),
      }
    },
    record: (data) => {
      const v = data.v as Awaited<ReturnType<typeof windowView>> | null
      if (typeof v?.window?.id !== 'string') return null
      const w = v.window
      return {
        title: w.title,
        subtitle: `${v.form.name} · ${v.term.code}`,
        status: { label: w.phase },
        fields: [
          { label: 'Opens', value: `${w.opens} (${w.timeZone})` },
          { label: 'Closes', value: `${w.closes} (${w.timeZone})` },
          { label: 'Answered', value: AUDIENCE[v.form.audience] },
          { label: 'Required', value: w.required ? 'yes: counts towards finishing feedback for the term' : 'no' },
          { label: 'Results shown from', value: `${w.minResponses} answers` },
          { label: 'Withdrawn because', value: w.cancelReason },
        ],
        createdAt: w.createdAt.toISOString(),
        audit: { entity: 'feedback_windows', entityId: w.id },
        docStatus: {
          value: w.docstatus,
          id: w.id,
          idField: 'windowId',
          submit: '/windows/publish',
          cancel: '/windows/withdraw',
          roles: [...RUNNERS],
          labels: { submit: 'Publish', cancel: 'Withdraw' },
          states: { submitted: 'published', cancelled: 'withdrawn' },
        },
      }
    },
    sections: (data) => {
      const v = data.v as Awaited<ReturnType<typeof windowView>> | null
      if (typeof v?.window?.id !== 'string') return [{ kind: 'note', tone: 'warn', text: 'No such window.' }]
      const teaching = v.form.audience === 'teaching'
      const closed = v.window.phase === 'closed' || v.window.phase === 'withdrawn'
      const out: PluginSection[] = [
        {
          kind: 'figures',
          figures: [
            { label: teaching ? 'Owed (student × class)' : 'Students', value: String(v.summary.owed) },
            { label: 'Given', value: String(v.summary.given) },
            { label: 'Done', value: v.summary.pct === null ? '—' : `${v.summary.pct}%` },
            { label: 'Students still to give', value: String(v.summary.pending) },
          ],
        },
        {
          kind: 'table',
          title: teaching ? 'By class' : 'Progress',
          note: closed ? 'The average is over every scale answer for the class.' : 'Results appear when the window closes.',
          rows: 'classes',
          pageSize: 50,
          columns: [
            teaching
              ? { key: 'course', label: 'Class', href: '/m/feedback/class?windowId={windowId}&offeringId={offeringId}' }
              : { key: 'course', label: 'Who' },
            { key: 'section', label: 'Section' },
            { key: 'teacher', label: 'Teacher' },
            { key: 'progress', label: 'Given' },
            { key: 'pct', label: '%' },
            { key: 'resultText', label: 'Average' },
          ],
        },
      ]
      if (closed && v.overall) {
        out.push({ kind: 'note', text: `Across every ${teaching ? 'class' : 'student'}: ${v.overall.responses} responses.` })
        out.push(...resultSections(v.overall, v.form.scalePoints, v.window.minResponses))
      }
      out.push({
        kind: 'table',
        title: 'Still to give',
        note: 'Names, to remind -- never what anybody said.',
        rows: 'pending',
        empty: 'Nobody: everyone has given it.',
        columns: [
          { key: 'name', label: 'Student' },
          { key: 'outstanding', label: teaching ? 'Classes outstanding' : 'Outstanding' },
        ],
      })
      return out
    },
  },

  {
    path: '/class',
    title: 'Class feedback',
    roles: [...RUNNERS, 'faculty'],
    async load(actor, req) {
      const w = param(req, 'windowId')
      const o = param(req, 'offeringId')
      if (!w || !o) return { v: null }
      const v = await classResults(actor as Actor, w, o)
      return { v, ...resultRows(v.result) }
    },
    record: (data) => {
      const v = data.v as Awaited<ReturnType<typeof classResults>> | null
      if (typeof v?.class?.id !== 'string') return null
      return {
        title: `${v.class.course} ${v.class.title}`,
        subtitle: `Section ${v.class.section} · ${v.window.title}`,
        status: { label: v.phase },
        fields: [{ label: 'Responses', value: v.result ? String(v.result.responses) : 'after the close' }],
      }
    },
    sections: (data) => {
      const v = data.v as Awaited<ReturnType<typeof classResults>> | null
      if (typeof v?.class?.id !== 'string') return [{ kind: 'note', tone: 'warn', text: 'No such class in that window.' }]
      if (v.open || !v.result) return [{ kind: 'note', text: 'Results appear here once the window closes.' }]
      return resultSections(v.result, v.form.scalePoints, v.window.minResponses)
    },
  },

  {
    path: '/results',
    title: 'Feedback on my classes',
    menu: 'My classes',
    roles: ['faculty'],
    async load(actor) {
      return { rows: await myClassResults(actor as Actor) }
    },
    sections: () => [
      {
        kind: 'note',
        text: 'What your students said, as averages and comments, after each window closes -- and only for a class where enough answered that nobody can be picked out.',
      },
      {
        kind: 'table',
        title: 'Your classes',
        rows: 'rows',
        empty: 'No feedback windows for your classes yet.',
        columns: [
          { key: 'course', label: 'Class', href: '/m/feedback/class?windowId={windowId}&offeringId={offeringId}' },
          { key: 'section', label: 'Section' },
          { key: 'window', label: 'Window' },
          { key: 'phase', label: 'State', kind: 'status' },
          { key: 'responses', label: 'Responses' },
          { key: 'resultText', label: 'Average' },
        ],
      },
    ],
  },

  {
    path: '/me',
    title: 'Give feedback',
    menu: 'Give feedback',
    roles: ['student'],
    async load(actor) {
      const v = await myFeedback(actor as Actor)
      return {
        due: v.due,
        items: v.items.map((i) => ({ ...i, offeringParam: i.offeringId ?? '', go: i.state === 'due' ? 'Give feedback' : '' })),
      }
    },
    sections: (data) => [
      {
        kind: 'figures',
        figures: [{ label: 'Due now', value: String(data.due) }],
      },
      { kind: 'note', text: ANONYMOUS },
      {
        kind: 'table',
        title: 'Your feedback',
        rows: 'items',
        empty: 'Nothing to give feedback on yet.',
        pageSize: 50,
        columns: [
          { key: 'window', label: 'Window' },
          { key: 'course', label: 'Class', href: '/m/feedback/give?windowId={windowId}&offeringId={offeringParam}' },
          { key: 'teacher', label: 'Teacher' },
          { key: 'state', label: 'State', kind: 'status' },
          { key: 'closes', label: 'Closes' },
          { key: 'go', label: '', href: '/m/feedback/give?windowId={windowId}&offeringId={offeringParam}' },
        ],
      },
    ],
  },

  {
    path: '/give',
    title: 'Give feedback',
    roles: ['student'],
    async load(actor, req) {
      const w = param(req, 'windowId')
      if (!w) return { v: null }
      return { v: await giveView(actor as Actor, w, param(req, 'offeringId') || null) }
    },
    record: (data) => {
      const v = data.v as Awaited<ReturnType<typeof giveView>> | null
      if (typeof v?.item?.windowId !== 'string') return null
      return {
        title: v.item.course,
        subtitle: [v.item.window, v.item.teacher].filter(Boolean).join(' · '),
        status: { label: v.item.done ? 'given' : v.item.phase === 'open' ? 'due' : v.item.phase },
        fields: [{ label: 'Closes', value: v.item.closes }],
      }
    },
    sections: (data) => {
      const v = data.v as Awaited<ReturnType<typeof giveView>> | null
      if (typeof v?.item?.windowId !== 'string') return [{ kind: 'note', tone: 'warn', text: 'There is no such feedback for you to give.' }]
      if (v.item.done) return [{ kind: 'note', text: 'Given. Thank you -- it cannot be changed, and it is not linked to your name.' }]
      if (v.item.phase !== 'open') {
        return [{ kind: 'note', text: v.item.phase === 'upcoming' ? `This opens at ${v.item.opens}.` : 'This window has closed.' }]
      }
      const scale = { points: v.form.scalePoints, low: v.form.scaleLow, high: v.form.scaleHigh }
      return [
        { kind: 'note', text: ANONYMOUS },
        {
          kind: 'form',
          title: v.form.name,
          note: v.form.description ?? undefined,
          submit: 'Give feedback',
          path: '/give',
          placement: 'inline',
          fields: [
            { name: 'windowId', label: '', kind: 'hidden', value: v.item.windowId },
            { name: 'offeringId', label: '', kind: 'hidden', value: v.item.offeringId ?? '' },
            ...v.questions.map((q) => answerField(q, scale)),
          ],
        },
      ]
    },
  },
]

