import { param, type PluginField, type PluginPage, type PluginSection } from '@campusos/module-framework'
import {
  attemptView,
  bankChoices,
  courseChoices,
  listQuestions,
  listQuizzes,
  localInput,
  myQuizzes,
  offeringChoices,
  questionView,
  quizView,
  takeView,
  type Actor,
  type AttemptViewData,
  type QuizViewData,
} from './api'

const STAFF = ['institution_admin', 'super_admin', 'hod', 'faculty'] as const

const KIND_OPTIONS = [
  { value: 'single', label: 'Single choice' },
  { value: 'multiple', label: 'Multiple choice' },
  { value: 'true_false', label: 'True or false' },
  { value: 'short', label: 'Short answer' },
  { value: 'numeric', label: 'Number' },
]
const KIND_WORDS = Object.fromEntries(KIND_OPTIONS.map((k) => [k.value, k.label]))

const ZONES = ['Asia/Kolkata', 'UTC', 'Asia/Dubai', 'Asia/Singapore', 'Asia/Dhaka', 'Asia/Kathmandu', 'Europe/London', 'America/New_York'].map(
  (z) => ({ value: z, label: z }),
)

const clip = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** The fields a question is written with, filled from one when revising. */
function questionFields(from?: Awaited<ReturnType<typeof questionView>>): PluginField[] {
  const options = from?.choices?.length && (from.kind === 'single' || from.kind === 'multiple')
    ? from.choices.map((c) => `${c.correct ? '* ' : ''}${c.label}`).join('\n')
    : undefined
  const tf = from?.kind === 'true_false' ? from.choices.find((c) => c.correct)?.id : undefined
  return [
    { name: 'kind', label: 'Kind', kind: 'select', options: KIND_OPTIONS, value: from?.kind ?? 'single' },
    { name: 'points', label: 'Marks', kind: 'number', step: 'any', value: String(from?.points ?? 1) },
    { name: 'prompt', label: 'Question', kind: 'textarea', rows: 3, value: from?.prompt },
    {
      name: 'options',
      label: 'Options (single or multiple choice)',
      kind: 'textarea',
      rows: 5,
      optional: true,
      hint: 'One per line. Start each right option with *',
      value: options,
    },
    {
      name: 'answer',
      label: 'The statement is (true or false)',
      kind: 'select',
      optional: true,
      options: [
        { value: 'true', label: 'True' },
        { value: 'false', label: 'False' },
      ],
      value: tf,
    },
    {
      name: 'accepted',
      label: 'Accepted answers (short answer)',
      kind: 'textarea',
      rows: 3,
      optional: true,
      hint: 'One per line. Case and spacing are ignored.',
      value: from?.acceptedAnswers?.join('\n'),
    },
    { name: 'numericAnswer', label: 'Right number', kind: 'number', step: 'any', optional: true, value: from?.numericAnswer ?? undefined },
    { name: 'tolerance', label: 'Within', kind: 'number', step: 'any', optional: true, hint: 'e.g. 0.01', value: from?.kind === 'numeric' ? String(from.tolerance) : undefined },
    { name: 'topic', label: 'Topic', optional: true, value: from?.topic ?? undefined },
    { name: 'partialCredit', label: 'Partial credit for a partly right multiple-choice answer', kind: 'checkbox', value: from?.partialCredit ? 'true' : 'false' },
    { name: 'explanation', label: 'Explanation, shown with the answer', kind: 'textarea', rows: 2, optional: true, value: from?.explanation ?? undefined },
  ]
}

function quizFields(q?: QuizViewData['quiz']): PluginField[] {
  return [
    { name: 'title', label: 'Title', value: q?.title, hint: 'e.g. Week 3 check: normalisation' },
    { name: 'timeZone', label: 'Time zone', kind: 'select', options: ZONES, value: q?.timeZone ?? 'Asia/Kolkata' },
    { name: 'opensAt', label: 'Opens', kind: 'datetime', value: q ? localInput(q.opensAt, q.timeZone) : undefined },
    { name: 'closesAt', label: 'Closes', kind: 'datetime', value: q ? localInput(q.closesAt, q.timeZone) : undefined },
    { name: 'timeLimitMinutes', label: 'Time limit (minutes)', kind: 'number', optional: true, hint: 'Empty: until it closes', value: q?.timeLimitMinutes ? String(q.timeLimitMinutes) : undefined },
    { name: 'attemptsAllowed', label: 'Attempts', kind: 'number', value: String(q?.attemptsAllowed ?? 1) },
    {
      name: 'keep',
      label: 'Which attempt counts',
      kind: 'select',
      options: [
        { value: 'best', label: 'The best' },
        { value: 'latest', label: 'The latest' },
      ],
      value: q?.keep ?? 'best',
    },
    {
      name: 'reveal',
      label: 'Show answers',
      kind: 'select',
      options: [
        { value: 'after_close', label: 'After the quiz closes' },
        { value: 'after_submit', label: 'As soon as submitted' },
        { value: 'never', label: 'Never; the score only' },
      ],
      value: q?.reveal ?? 'after_close',
    },
    {
      name: 'penaltyPercent',
      label: 'Penalty for a wrong answer (%)',
      kind: 'number',
      step: 'any',
      value: String(q?.penaltyPercent ?? 0),
      hint: 'Negative marking. 0 unless your institution uses it; blanks are never penalised.',
    },
    { name: 'shuffle', label: 'Each attempt gets its own question order', kind: 'checkbox', value: q?.shuffle ? 'true' : 'false' },
    { name: 'instructions', label: 'Instructions', kind: 'textarea', rows: 3, optional: true, value: q?.instructions ?? undefined },
  ]
}

/** One question as a field on the answer sheet, holding what was saved. */
function answerField(q: AttemptViewData['questions'][number]): PluginField {
  const label = `${q.n}. ${q.prompt}  (${q.points} mark${q.points === 1 ? '' : 's'})`
  const saved = q.answer
  const value = saved === null || saved === undefined ? undefined : Array.isArray(saved) ? saved.join(',') : String(saved)
  const options = q.choices.map((c) => ({ value: c.id, label: c.label }))
  const name = `q_${q.itemId}`
  switch (q.kind) {
    case 'single':
    case 'true_false':
      return { name, label, kind: 'radio', options, value, optional: true }
    case 'multiple':
      return { name, label, kind: 'checkboxes', options, value, optional: true, hint: 'Tick every right answer.' }
    case 'numeric':
      return { name, label, kind: 'number', step: 'any', value, optional: true }
    default:
      return { name, label, kind: 'text', value, optional: true }
  }
}

export const pages: PluginPage[] = [
  // --- the teacher -----------------------------------------------------------
  {
    path: '/',
    title: 'Quizzes',
    menu: 'Quizzes',
    roles: [...STAFF],
    async load(actor) {
      const a = actor as Actor
      const [rows, offs] = await Promise.all([listQuizzes(a), offeringChoices(a)])
      const now = Date.now()
      return {
        quizzes: rows.map((q) => ({
          ...q,
          state:
            q.docstatus === 'draft'
              ? 'draft'
              : q.docstatus === 'cancelled'
                ? 'withdrawn'
                : now < q.opensAt.getTime()
                  ? 'upcoming'
                  : now < q.closesAt.getTime()
                    ? 'open'
                    : 'closed',
          klass: `${q.course} ${q.section} (${q.term})`,
          took: `${q.takers} / ${q.classSize}`,
        })),
        offeringOptions: offs.map((o) => ({ value: o.id, label: `${o.course} ${o.title}: ${o.section} ${o.admissionYear}, ${o.term}` })),
        counts: {
          drafts: rows.filter((q) => q.docstatus === 'draft').length,
          open: rows.filter((q) => q.docstatus === 'submitted' && now >= q.opensAt.getTime() && now < q.closesAt.getTime()).length,
          submissions: rows.reduce((n, q) => n + q.takers, 0),
        },
      }
    },
    sections: (data) => {
      const c = data.counts as { drafts: number; open: number; submissions: number }
      return [
        {
          kind: 'figures',
          figures: [
            { label: 'Open now', value: String(c.open) },
            { label: 'Drafts', value: String(c.drafts) },
            { label: 'Students who took one', value: String(c.submissions), hint: 'across every quiz' },
          ],
        },
        {
          kind: 'shortcuts',
          items: [
            { label: 'Question bank', href: '/m/quizzes/bank', description: 'Questions per course, each with the key it is scored against' },
          ],
        },
        {
          kind: 'table',
          title: 'Quizzes',
          rows: 'quizzes',
          empty: 'No quiz set yet. Write questions in the bank, then set a quiz for a class.',
          columns: [
            { key: 'title', label: 'Quiz', href: '/m/quizzes/quiz?quizId={id}' },
            { key: 'klass', label: 'Class' },
            { key: 'state', label: 'State', kind: 'status' },
            { key: 'questions', label: 'Questions' },
            { key: 'took', label: 'Took it' },
            { key: 'opensAt', label: 'Opens', kind: 'when' },
            { key: 'closesAt', label: 'Closes', kind: 'when' },
          ],
        },
        {
          kind: 'form',
          title: 'Set a quiz',
          note: 'Starts as a draft. Times are read in the zone you pick and shown in it.',
          submit: 'Create draft',
          path: '/quizzes',
          fields: [{ name: 'offeringId', label: 'Class', kind: 'select', options: 'offeringOptions' }, ...quizFields()],
        },
      ]
    },
  },

  {
    path: '/bank',
    title: 'Question bank',
    menu: 'Question bank',
    roles: [...STAFF],
    async load(actor, req) {
      const a = actor as Actor
      const courses = await courseChoices(a)
      const courseId = param(req, 'courseId') ?? courses[0]?.id ?? null
      const course = courses.find((c) => c.id === courseId) ?? null
      const qs = course ? await listQuestions(a, course.id) : []
      return {
        courseId: course?.id ?? '',
        course,
        courseLinks: courses.map((c) => ({ label: c.code, href: `/m/quizzes/bank?courseId=${c.id}`, active: c.id === course?.id })),
        questions: qs.map((q) => ({
          ...q,
          short: clip(q.prompt),
          kindLabel: KIND_WORDS[q.kind] ?? q.kind,
          state: q.retired ? 'retired' : 'active',
        })),
        live: qs.filter((q) => !q.retired).length,
        topics: new Set(qs.filter((q) => !q.retired).map((q) => q.topic).filter(Boolean)).size,
      }
    },
    sections: (data) => {
      const course = data.course as { code: string; title: string } | null
      if (!course || typeof course.code !== 'string') {
        return [{ kind: 'note', text: 'No course to write for. A teacher sees the courses they teach; ask the office to assign one.' }]
      }
      return [
        { kind: 'links', title: 'Course', links: data.courseLinks as { label: string; href: string; active: boolean }[] },
        {
          kind: 'figures',
          figures: [
            { label: 'Live questions', value: String(data.live) },
            { label: 'Topics', value: String(data.topics) },
          ],
        },
        {
          kind: 'table',
          title: `${course.code} ${course.title}`,
          note: 'A question is never edited once written: students are scored against its key. Revise it instead; the old one is retired.',
          rows: 'questions',
          empty: 'No questions yet.',
          pageSize: 50,
          columns: [
            { key: 'short', label: 'Question', href: '/m/quizzes/question?questionId={id}' },
            { key: 'kindLabel', label: 'Kind' },
            { key: 'topic', label: 'Topic' },
            { key: 'points', label: 'Marks' },
            { key: 'key', label: 'Answer' },
            { key: 'used', label: 'On quizzes' },
            { key: 'state', label: 'State', kind: 'status' },
          ],
        },
        {
          kind: 'form',
          title: 'Write a question',
          note: 'Fill in the part that matches the kind: options for choice questions, the statement for true or false, accepted answers for a short answer, or the number.',
          submit: 'Add to bank',
          path: '/questions',
          fields: [{ name: 'courseId', label: '', kind: 'hidden', value: data.courseId as string }, ...questionFields()],
        },
      ]
    },
  },

  {
    path: '/question',
    title: 'Question',
    roles: [...STAFF],
    async load(actor, req) {
      const id = param(req, 'questionId')
      const q = id ? await questionView(actor as Actor, id) : null
      return { q, usedOn: q?.usedOn ?? [] }
    },
    record: (data) => {
      const q = data.q as Awaited<ReturnType<typeof questionView>> | null
      if (typeof q?.id !== 'string') return null
      return {
        title: clip(q.prompt, 70),
        subtitle: q.course,
        status: { label: q.retiredAt ? 'retired' : 'active' },
        fields: [
          { label: 'Kind', value: KIND_WORDS[q.kind] ?? q.kind },
          { label: 'Marks', value: q.points },
          { label: 'Topic', value: q.topic },
          { label: 'Answer', value: q.key },
          { label: 'Partial credit', value: q.kind === 'multiple' ? q.partialCredit : null, kind: 'bool' },
          { label: 'Explanation', value: q.explanation },
        ],
        createdAt: q.createdAt.toISOString(),
        createdBy: q.createdByName,
        audit: { entity: 'quiz_questions', entityId: q.id },
      }
    },
    sections: (data) => {
      const q = data.q as Awaited<ReturnType<typeof questionView>> | null
      if (typeof q?.id !== 'string') return [{ kind: 'note', tone: 'warn', text: 'No such question.' }]
      const links = [
        ...(q.revisionOf ? [{ label: 'The version this revises', href: `/m/quizzes/question?questionId=${q.revisionOf}` }] : []),
        ...(q.revisedBy ? [{ label: 'Its revision', href: `/m/quizzes/question?questionId=${q.revisedBy}` }] : []),
        { label: 'Back to the bank', href: `/m/quizzes/bank?courseId=${q.courseId}` },
      ]
      return [
        { kind: 'note', text: q.prompt },
        ...(q.choices.length
          ? [{ kind: 'note' as const, text: q.choices.map((c) => `${c.correct ? '✓' : '·'} ${c.label}`).join('\n') }]
          : []),
        ...(q.retiredAt ? [{ kind: 'note' as const, tone: 'warn' as const, text: 'Retired: not offered for new quizzes. Quizzes that used it keep it.' }] : []),
        { kind: 'links', links },
        {
          kind: 'table',
          title: 'On quizzes',
          rows: 'usedOn',
          empty: 'Not on any quiz yet.',
          columns: [
            { key: 'title', label: 'Quiz', href: '/m/quizzes/quiz?quizId={id}' },
            { key: 'docstatus', label: 'State', kind: 'status' },
          ],
        },
        ...(q.retiredAt
          ? []
          : [
              {
                kind: 'form' as const,
                title: 'Revise',
                note: 'Makes a new question from these fields and retires this one.',
                submit: 'Save as a revision',
                path: '/questions/revise',
                placement: 'action' as const,
                fields: [{ name: 'questionId', label: '', kind: 'hidden' as const, value: q.id }, ...questionFields(q)],
              },
              {
                kind: 'form' as const,
                title: 'Retire',
                note: 'No longer offered for new quizzes.',
                submit: 'Retire',
                path: '/questions/retire',
                placement: 'action' as const,
                fields: [{ name: 'questionId', label: '', kind: 'hidden' as const, value: q.id }],
              },
            ]),
      ]
    },
  },

  {
    path: '/quiz',
    title: 'Quiz',
    roles: [...STAFF],
    async load(actor, req) {
      const a = actor as Actor
      const id = param(req, 'quizId')
      if (!id) return { v: null }
      const v = await quizView(a, id)
      const bank = v.quiz.docstatus === 'draft' ? await bankChoices(a, id) : []
      return {
        v,
        quizId: v.quiz.id,
        items: v.items.map((i) => ({ ...i, short: clip(i.prompt), kindLabel: KIND_WORDS[i.kind] ?? i.kind })),
        results: v.results,
        analysis: v.analysis.map((r) => ({
          ...r,
          short: clip(r.prompt, 60),
          facilityText: r.facility === null ? '' : `${r.facility}%`,
          hard: r.facility !== null && r.facility < 30,
        })),
        bands: v.bands,
        extensions: v.extensions,
        bankOptions: bank.map((q) => ({
          value: q.id,
          label: `${q.topic ? `[${q.topic}] ` : ''}${clip(q.prompt, 80)} (${KIND_WORDS[q.kind]}, ${Number(q.points)})`,
        })),
        rosterOptions: v.roster.map((s) => ({ value: s.id, label: s.name ?? s.email ?? s.id })),
      }
    },
    record: (data) => {
      const v = data.v as QuizViewData | null
      if (typeof v?.quiz?.id !== 'string') return null
      const q = v.quiz
      return {
        title: q.title,
        subtitle: `${q.course}, ${q.className}`,
        status: q.docstatus === 'submitted' ? { label: q.phase } : undefined,
        fields: [
          { label: 'Opens', value: `${q.opens} (${q.timeZone})` },
          { label: 'Closes', value: `${q.closes} (${q.timeZone})` },
          { label: 'Time limit', value: q.timeLimitMinutes ? `${q.timeLimitMinutes} minutes` : 'until it closes' },
          { label: 'Attempts', value: `${q.attemptsAllowed}, the ${q.keep} counts` },
          { label: 'Marks', value: q.maxScore },
          { label: 'Wrong-answer penalty', value: q.penaltyPercent ? `${q.penaltyPercent}%` : 'none' },
          { label: 'Answers shown', value: q.reveal.replace('_', ' ') },
          { label: 'Question order', value: q.shuffle ? 'shuffled per attempt' : 'as set' },
          { label: 'Withdrawn because', value: q.cancelReason },
        ],
        createdAt: q.createdAt.toISOString(),
        audit: { entity: 'quiz_quizzes', entityId: q.id },
        docStatus: {
          value: q.docstatus,
          id: q.id,
          idField: 'quizId',
          submit: '/quizzes/publish',
          cancel: '/quizzes/withdraw',
          amend: q.replacedBy ? undefined : '/quizzes/revise',
          roles: [...STAFF],
          labels: { submit: 'Publish', cancel: 'Withdraw', amend: 'Revise into a new draft' },
          states: { submitted: 'published', cancelled: 'withdrawn' },
        },
      }
    },
    sections: (data) => {
      const v = data.v as QuizViewData | null
      if (typeof v?.quiz?.id !== 'string') return [{ kind: 'note', tone: 'warn', text: 'No such quiz. Pick one from the list.' }]
      const q = v.quiz
      const s = v.summary
      const draft = q.docstatus === 'draft'
      const out: PluginSection[] = [
        {
          kind: 'figures',
          figures: [
            { label: 'Questions', value: String(v.items.length), hint: `${q.maxScore} marks` },
            { label: 'Took it', value: `${s.took} / ${s.classSize}` },
            { label: 'In progress', value: String(s.inProgress) },
            { label: 'Average', value: s.average === null ? '–' : `${s.average}%` },
            { label: 'Median', value: s.median === null ? '–' : `${s.median}%` },
          ],
        },
      ]
      if (draft) {
        out.push({
          kind: 'note',
          text: 'A draft. Put questions on it from the bank, check the window, then publish. Once published it is frozen: the class is owed the quiz they started.',
        })
      }
      if (q.docstatus === 'cancelled') {
        out.push({ kind: 'note', tone: 'danger', text: `Withdrawn: ${q.cancelReason ?? ''}. Attempts made stay on record; no more are taken.` })
      }
      if (q.replacedBy || q.amendedFrom) {
        out.push({
          kind: 'links',
          links: [
            ...(q.amendedFrom ? [{ label: 'The quiz this revises', href: `/m/quizzes/quiz?quizId=${q.amendedFrom}` }] : []),
            ...(q.replacedBy ? [{ label: 'Its revision', href: `/m/quizzes/quiz?quizId=${q.replacedBy}` }] : []),
          ],
        })
      }
      out.push({
        kind: 'table',
        title: 'Questions',
        rows: 'items',
        empty: draft ? 'None yet: add some from the bank.' : 'None.',
        pageSize: 50,
        bulk: draft
          ? [
              {
                label: 'Take off the quiz',
                path: '/quizzes/items/remove',
                idKey: 'id',
                field: 'itemIds',
                tone: 'danger',
                fields: [{ name: 'quizId', label: '', kind: 'hidden', value: q.id }],
              },
            ]
          : undefined,
        columns: [
          { key: 'n', label: '#' },
          { key: 'short', label: 'Question', href: '/m/quizzes/question?questionId={questionId}' },
          { key: 'kindLabel', label: 'Kind' },
          { key: 'points', label: 'Marks' },
          { key: 'key', label: 'Answer' },
        ],
      })
      if (!draft) {
        out.push(
          {
            kind: 'table',
            title: 'Results',
            note: `The ${q.keep} attempt counts. A quiz is practice, not a grade: nothing here reaches a transcript.`,
            rows: 'results',
            empty: 'Nobody in the class.',
            pageSize: 100,
            columns: [
              { key: 'name', label: 'Student', href: '/m/quizzes/result?attemptId={attemptId}' },
              { key: 'state', label: 'State', kind: 'status' },
              { key: 'attempts', label: 'Attempts' },
              { key: 'score', label: 'Score' },
              { key: 'max', label: 'Out of' },
              { key: 'percent', label: '%' },
              { key: 'submittedAt', label: 'Submitted', kind: 'when' },
              { key: 'auto', label: 'By the clock', kind: 'bool' },
            ],
          },
          {
            kind: 'chart',
            title: 'How the class did',
            type: 'bar',
            rows: 'bands',
            x: 'band',
            series: [{ key: 'students', label: 'Students' }],
            empty: 'No attempt submitted yet.',
          },
          {
            kind: 'table',
            title: 'Item analysis',
            note: 'Facility is the share who got a question fully right. Very low facility is worth a look: a hard question, or a wrong key -- which you can put right answer by answer.',
            rows: 'analysis',
            empty: 'No questions.',
            pageSize: 50,
            columns: [
              { key: 'n', label: '#' },
              { key: 'short', label: 'Question' },
              { key: 'topic', label: 'Topic' },
              { key: 'facilityText', label: 'Facility', alertWhen: 'hard' },
              { key: 'right', label: 'Right' },
              { key: 'blank', label: 'Blank' },
              { key: 'average', label: 'Average mark' },
              { key: 'points', label: 'Of' },
            ],
          },
          {
            kind: 'table',
            title: 'Extensions',
            rows: 'extensions',
            empty: 'Nobody has more time.',
            columns: [
              { key: 'name', label: 'Student' },
              { key: 'closes', label: 'Closes for them' },
              { key: 'extraMinutes', label: 'Extra minutes' },
              { key: 'reason', label: 'Reason' },
            ],
          },
        )
      }
      if (draft) {
        out.push(
          {
            kind: 'form',
            title: 'Add questions',
            note: 'Live questions from the course bank, not already on this quiz.',
            submit: 'Add',
            path: '/quizzes/items',
            placement: 'action',
            fields: [
              { name: 'quizId', label: '', kind: 'hidden', value: q.id },
              { name: 'questionIds', label: 'Questions', kind: 'checkboxes', options: 'bankOptions' },
              { name: 'points', label: 'Marks each on this quiz', kind: 'number', step: 'any', optional: true, hint: "Empty: each question's own" },
            ],
          },
          {
            kind: 'form',
            title: 'Change the draft',
            submit: 'Save',
            path: '/quizzes/update',
            placement: 'action',
            fields: [{ name: 'quizId', label: '', kind: 'hidden', value: q.id }, ...quizFields(q)],
          },
        )
      }
      if (q.docstatus === 'submitted') {
        out.push({
          kind: 'form',
          title: 'Give a student more time',
          note: 'For an accommodation or a make-up. A later close, extra minutes on the limit, or both.',
          submit: 'Grant',
          path: '/quizzes/extensions',
          placement: 'action',
          fields: [
            { name: 'quizId', label: '', kind: 'hidden', value: q.id },
            { name: 'studentId', label: 'Student', kind: 'select', options: 'rosterOptions' },
            { name: 'closesAt', label: `Closes for them (${q.timeZone})`, kind: 'datetime', optional: true },
            { name: 'extraMinutes', label: 'Extra minutes', kind: 'number', value: '0' },
            { name: 'reason', label: 'Reason' },
          ],
        })
      }
      return out
    },
  },

  // --- an attempt, for the student who sat it or a teacher of the class -----
  {
    path: '/result',
    title: 'Attempt',
    roles: [...STAFF, 'student'],
    async load(actor, req) {
      const id = param(req, 'attemptId')
      const v = id ? await attemptView(actor as Actor, id) : null
      const staff = (actor as Actor).role !== 'student'
      return {
        v,
        staff,
        rows: (v?.questions ?? []).map((q) => {
          const full = q as typeof q & { correct?: boolean | null; awarded?: number; yourAnswer?: string; key?: string; explanation?: string | null; overridden?: string | null; responseId?: string | null }
          return {
            ...full,
            short: clip(q.prompt, 70),
            verdict: full.correct === true ? 'correct' : full.correct === false ? ((full.awarded ?? 0) > 0 ? 'partial' : 'wrong') : 'blank',
            flagged: !!full.overridden,
          }
        }),
        responseOptions: (v?.questions ?? [])
          .map((q) => q as typeof q & { responseId?: string | null; awarded?: number })
          .filter((q) => q.responseId)
          .map((q) => ({ value: q.responseId!, label: `${q.n}. ${clip(q.prompt, 60)} (now ${q.awarded ?? 0} of ${q.points})` })),
      }
    },
    record: (data) => {
      const v = data.v as AttemptViewData | null
      if (typeof v?.attempt?.id !== 'string') return null
      const a = v.attempt
      return {
        title: `${v.quiz.title}: attempt ${a.number}`,
        subtitle: a.student,
        status: { label: a.submitted ? (a.autoSubmitted ? 'submitted by the clock' : 'submitted') : 'in_progress' },
        fields: [
          { label: 'Score', value: a.score === null ? null : `${a.score} of ${a.max}` },
          { label: 'Percent', value: a.percent === null ? null : `${a.percent}%` },
          { label: 'Started', value: a.started },
          { label: 'Time up at', value: a.deadline },
          { label: 'Submitted', value: a.submitted },
        ],
        createdAt: new Date(a.startedAt).toISOString(),
        audit: { entity: 'quiz_attempts', entityId: a.id },
      }
    },
    sections: (data) => {
      const v = data.v as AttemptViewData | null
      if (typeof v?.attempt?.id !== 'string') return [{ kind: 'note', tone: 'warn', text: 'No such attempt.' }]
      if (!v.attempt.submitted) {
        return [
          { kind: 'note', text: `In progress. Time is up at ${v.attempt.deadline}.` },
          ...(data.staff ? [] : [{ kind: 'links' as const, links: [{ label: 'Carry on with it', href: `/m/quizzes/take?quizId=${v.quiz.id}` }] }]),
        ]
      }
      const out: PluginSection[] = []
      if (!v.revealed) {
        out.push({
          kind: 'note',
          text:
            v.quiz.reveal === 'never'
              ? 'This quiz shows the score only.'
              : `Answers are shown once the quiz closes, at ${v.quiz.closes}.`,
        })
        return out
      }
      out.push({
        kind: 'table',
        title: 'Answers',
        rows: 'rows',
        pageSize: 100,
        columns: [
          { key: 'n', label: '#' },
          { key: 'short', label: 'Question' },
          { key: 'yourAnswer', label: 'Answer given' },
          { key: 'key', label: 'Right answer' },
          { key: 'verdict', label: '', kind: 'status' },
          { key: 'awarded', label: 'Mark' },
          { key: 'points', label: 'Of' },
          { key: 'explanation', label: 'Why' },
          { key: 'overridden', label: 'Mark changed because', alertWhen: 'flagged' },
        ],
      })
      if (data.staff) {
        out.push({
          kind: 'form',
          title: "Change a mark",
          note: "When the key did not foresee a right answer -- a spelling, an equivalent form. The answer itself never changes; the change is audited and the total follows.",
          submit: 'Change the mark',
          path: '/responses/override',
          placement: 'action',
          roles: [...STAFF],
          fields: [
            { name: 'responseId', label: 'Answer', kind: 'select', options: 'responseOptions' },
            { name: 'awarded', label: 'Mark', kind: 'number', step: 'any' },
            { name: 'reason', label: 'Reason' },
          ],
        })
      }
      return out
    },
  },

  // --- the student -----------------------------------------------------------
  {
    path: '/me',
    title: 'My quizzes',
    menu: 'My quizzes',
    roles: ['student'],
    async load(actor) {
      const rows = await myQuizzes(actor as Actor)
      return {
        quizzes: rows.map((q) => ({
          ...q,
          scoreText: q.score === null ? '' : `${q.score} / ${q.max}`,
          go: q.state === 'open' || q.state === 'retake' || q.state === 'in_progress' ? 'Take it' : '',
        })),
        open: rows.filter((q) => q.state === 'open' || q.state === 'in_progress' || q.state === 'retake').length,
        done: rows.filter((q) => q.score !== null).length,
      }
    },
    sections: (data) => [
      {
        kind: 'figures',
        figures: [
          { label: 'To do', value: String(data.open), tone: (data.open as number) > 0 ? 'due' : undefined },
          { label: 'Done', value: String(data.done) },
        ],
      },
      {
        kind: 'table',
        title: 'Quizzes',
        note: 'Quizzes are for practice and feedback. They are not part of your grades.',
        rows: 'quizzes',
        empty: 'No quiz for your classes yet.',
        columns: [
          { key: 'title', label: 'Quiz', href: '/m/quizzes/take?quizId={id}' },
          { key: 'course', label: 'Course' },
          { key: 'state', label: 'State', kind: 'status' },
          { key: 'closes', label: 'Closes' },
          { key: 'timeLimit', label: 'Time limit' },
          { key: 'attempts', label: 'Attempts' },
          { key: 'scoreText', label: 'Score', href: '/m/quizzes/result?attemptId={resultId}' },
          { key: 'go', label: '', href: '/m/quizzes/take?quizId={id}' },
        ],
      },
    ],
  },

  {
    path: '/take',
    title: 'Quiz',
    roles: ['student'],
    async load(actor, req) {
      const id = param(req, 'quizId')
      if (!id) return { t: null }
      const t = await takeView(actor as Actor, id)
      return { t }
    },
    record: (data) => {
      const t = data.t as Awaited<ReturnType<typeof takeView>> | null
      const e = t?.entry
      if (typeof e?.id !== 'string') return null
      return {
        title: e.title,
        subtitle: e.course,
        status: { label: e.state },
        fields: [
          { label: 'Closes', value: e.closes },
          { label: 'Time limit', value: e.timeLimit },
          { label: 'Attempts', value: e.attempts },
          { label: 'Wrong answers lose', value: t!.penaltyPercent ? `${t!.penaltyPercent}% of the question's marks` : 'nothing' },
          { label: 'Your score', value: e.score === null ? null : `${e.score} of ${e.max}` },
        ],
      }
    },
    sections: (data) => {
      const t = data.t as Awaited<ReturnType<typeof takeView>> | null
      const e = t?.entry
      if (typeof e?.id !== 'string') return [{ kind: 'note', tone: 'warn', text: 'No such quiz for your classes.' }]
      const out: PluginSection[] = []
      if (t!.instructions) out.push({ kind: 'note', text: t!.instructions })
      const a = t!.attempt
      if (a && !a.attempt.submitted) {
        out.push(
          {
            kind: 'note',
            tone: 'warn',
            text: `Attempt ${a.attempt.number}. Time is up at ${a.attempt.deadline}; whatever is saved by then is scored. Save as you go.`,
          },
          {
            kind: 'form',
            title: 'Your answers',
            submit: 'Save answers',
            path: '/attempts/answers',
            placement: 'inline',
            fields: [
              { name: 'attemptId', label: '', kind: 'hidden', value: a.attempt.id },
              ...a.questions.map(answerField),
              { name: 'finish', label: 'I have finished: submit this attempt to be scored', kind: 'checkbox', value: 'false' },
            ],
          },
        )
        return out
      }
      if (e.state === 'open' || e.state === 'retake') {
        out.push({
          kind: 'form',
          title: e.state === 'retake' ? 'Try again' : 'Start',
          note:
            e.timeLimit === 'none'
              ? `You have until ${e.closes} once you start.`
              : `You have ${e.timeLimit} from starting, or until ${e.closes} if that comes first.`,
          submit: 'Start the attempt',
          path: '/attempts/start',
          placement: 'inline',
          fields: [{ name: 'quizId', label: '', kind: 'hidden', value: e.id }],
        })
      } else {
        const words: Record<string, string> = {
          upcoming: `It opens at ${e.opens}.`,
          done: 'Done. No attempts left.',
          missed: 'It closed before you took it.',
          withdrawn: 'Your teacher withdrew this quiz.',
        }
        out.push({ kind: 'note', text: words[e.state] ?? '' })
      }
      if (e.resultId) out.push({ kind: 'links', links: [{ label: 'See your result', href: `/m/quizzes/result?attemptId=${e.resultId}` }] })
      return out
    },
  },
]
