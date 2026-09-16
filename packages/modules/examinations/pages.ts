import { param, type PluginPage } from '@campusos/module-framework'
import { listOfferings } from '@campusos/module-academic/api'
import {
  DEFAULT_GPA_BANDS,
  listExams,
  listSchemes,
  sheet,
  transcript,
  type Actor,
} from './api'

const MARKERS = ['institution_admin', 'super_admin', 'faculty', 'hod'] as const
const ADMIN = ['institution_admin', 'super_admin'] as const

export const pages: PluginPage[] = [
  {
    path: '/',
    title: 'Examinations',
    menu: 'Exams',
    roles: [...MARKERS],
    async load(actor, req) {
      const a = actor as Actor
      const offerings = await listOfferings(a)
      const offeringId = param(req, 'offeringId') ?? offerings[0]?.id
      const examId = param(req, 'examId')

      const exams = offeringId ? await listExams(a, offeringId) : []
      const marks = examId ? await sheet(a, examId) : null

      return {
        offerings: offerings.map((o) => ({
          label: `${o.courseCode} ${o.sectionLabel}`,
          href: `/m/examinations?offeringId=${o.id}`,
          active: o.id === offeringId,
        })),
        offeringId: offeringId ?? '',
        exams: exams.map((e) => ({
          ...e,
          state: e.publishedAt ? 'published' : 'open',
          open: !e.publishedAt,
        })),
        examOptions: exams.map((e) => ({ value: e.id, label: e.name })),
        unpublished: exams
          .filter((e) => !e.publishedAt)
          .map((e) => ({ value: e.id, label: e.name })),
        published: exams
          .filter((e) => e.publishedAt)
          .map((e) => ({ value: e.id, label: e.name })),
        examId: examId ?? '',
        entries: marks?.entries ?? [],
        examName: marks?.exam.name ?? null,
        locked: marks?.exam.published ?? false,
      }
    },
    sections: (data) => [
      { kind: 'links', title: 'Offering', links: data.offerings as never },
      {
        kind: 'table',
        title: 'Exams',
        rows: 'exams',
        empty: 'Nothing scheduled for this offering.',
        columns: [
          { key: 'name', label: 'Exam', href: '/m/examinations?offeringId={offeringId}&examId={id}' },
          { key: 'kind', label: 'Kind' },
          { key: 'maxMarks', label: 'Out of' },
          { key: 'weightPercent', label: 'Weight' },
          { key: 'state', label: 'Status', alertWhen: 'open' },
        ],
      },
      {
        kind: 'form',
        title: 'Schedule an exam',
        note: 'Total weight across a course cannot exceed 100%.',
        submit: 'Schedule',
        path: '/exams',
        fields: [
          { name: 'offeringId', kind: 'hidden', label: '', value: String(data.offeringId ?? '') },
          { name: 'name', label: 'Name' },
          {
            name: 'kind',
            label: 'Kind',
            kind: 'select',
            options: [
              { value: 'quiz', label: 'quiz' },
              { value: 'assignment', label: 'assignment' },
              { value: 'midterm', label: 'midterm' },
              { value: 'practical', label: 'practical' },
              { value: 'final', label: 'final' },
            ],
          },
          { name: 'maxMarks', label: 'Out of', kind: 'number' },
          { name: 'weightPercent', label: 'Weight %', kind: 'number' },
        ],
      },
      ...(data.examName
        ? [
            {
              kind: 'table' as const,
              title: `Marks — ${String(data.examName)}${data.locked ? ' (published, locked)' : ''}`,
              note: data.locked
                ? 'Published. A mark can only change through an audited revision, and the database is what enforces that.'
                : 'Every enrolled student appears, marked or not, so the sheet is usable as a register.',
              rows: 'entries',
              empty: 'Nobody enrolled.',
              columns: [
                { key: 'studentName', label: 'Student' },
                { key: 'obtained', label: 'Marks' },
                { key: 'absent', label: 'Absent', kind: 'bool' as const },
                { key: 'revision', label: 'Revisions' },
              ],
            },
          ]
        : []),
      {
        kind: 'form',
        title: 'Publish results',
        note:
          'Publishing locks every mark under it. Unpublishing afterwards needs a ' +
          'reason and is audited.',
        submit: 'Publish',
        path: '/exams/publish',
        fields: [
          { name: 'examId', label: 'Exam', kind: 'select', options: 'unpublished' },
        ],
      },
      {
        kind: 'form',
        title: 'Revise a published mark',
        note: 'The only way to change one. Reason mandatory, and the history survives.',
        submit: 'Revise',
        path: '/marks/revise',
        fields: [
          { name: 'examId', label: 'Exam', kind: 'select', options: 'published' },
          { name: 'studentId', label: 'Student' },
          { name: 'obtained', label: 'Marks', kind: 'number', optional: true },
          { name: 'reason', label: 'Reason', hint: 'At least five characters' },
        ],
      },
    ],
  },

  {
    path: '/scales',
    title: 'Grade scales',
    menu: 'Scales',
    roles: [...ADMIN],
    async load(actor) {
      const schemes = await listSchemes(actor as Actor)
      return {
        schemes: schemes.map((s) => ({
          ...s,
          bandCount: s.bands.length,
          summary: s.bands.map((b) => `${b.minPercent}+ ${b.label}`).join(', ') || 'percentage only',
        })),
        hasDefault: schemes.some((s) => s.isDefault),
        defaultBands: DEFAULT_GPA_BANDS.map(
          (b) => `${b.minPercent}:${b.label}:${b.points}:${b.isPass ? 'pass' : 'fail'}`,
        ).join('\n'),
      }
    },
    sections: (data) => [
      {
        kind: 'note',
        text: data.hasDefault
          ? 'Bands are floors: a percentage takes the highest band at or below it, so a scale cannot leave a gap or overlap itself.'
          : `No default scale is set, so transcripts use a built-in ${DEFAULT_GPA_BANDS.length}-band 10-point scale and say so on the document. Define one below to replace it.`,
      },
      {
        kind: 'table',
        rows: 'schemes',
        empty: 'None defined.',
        columns: [
          { key: 'name', label: 'Scale' },
          { key: 'kind', label: 'Kind' },
          { key: 'isDefault', label: 'Default', kind: 'bool' },
          { key: 'summary', label: 'Bands' },
        ],
      },
      {
        kind: 'form',
        title: 'Add a scale',
        note: 'One band per line: floor:label:points:pass|fail. Empty for a percentage scale.',
        submit: 'Create scale',
        path: '/scales',
        fields: [
          { name: 'name', label: 'Name', hint: 'e.g. Undergraduate 10-point' },
          {
            name: 'kind',
            label: 'Kind',
            kind: 'select',
            options: [
              { value: 'gpa', label: 'gpa — bands carry points' },
              { value: 'custom', label: 'custom — bands, your own labels' },
              { value: 'percentage', label: 'percentage — no bands' },
            ],
          },
          {
            name: 'bands',
            label: 'Bands',
            kind: 'textarea',
            rows: 9,
            value: String(data.defaultBands ?? ''),
          },
          { name: 'isDefault', label: 'Use as the default', kind: 'checkbox', optional: true },
        ],
      },
    ],
  },

  {
    path: '/me',
    title: 'My results',
    menu: 'My results',
    roles: ['student'],
    async load(actor) {
      const a = actor as Actor
      const t = await transcript(a, a.id)
      const latest = t.terms.at(-1)
      return {
        provisional: t.provisional,
        cumulative: t.cumulativeGpa,
        scheme: t.schemeName,
        termCode: latest?.termCode ?? null,
        gpa: latest?.gpa ?? null,
        grades: (latest?.grades ?? []).map((g) => ({ ...g, failed: !g.passed })),
        pdf: `/api/v1/modules/examinations/transcript.pdf?studentId=${a.id}`,
      }
    },
    sections: (data) => [
      ...(data.provisional
        ? [
            {
              kind: 'note' as const,
              tone: 'warn' as const,
              text:
                'Provisional. Some enrolled courses have no published results yet, ' +
                'so the averages below cover only what has been published.',
            },
          ]
        : []),
      {
        kind: 'figures',
        title: data.termCode ? `Term ${String(data.termCode)}` : 'Results',
        figures: [
          { label: 'Term GPA', value: data.gpa === null ? '-' : String(data.gpa) },
          {
            label: 'Cumulative',
            value: data.cumulative === null ? '-' : String(data.cumulative),
          },
          { label: 'Scale', value: String(data.scheme ?? '') },
        ],
      },
      {
        kind: 'links',
        links: [{ label: 'Download transcript (PDF)', href: String(data.pdf) }],
      },
      {
        kind: 'table',
        rows: 'grades',
        empty: 'Nothing published yet.',
        columns: [
          { key: 'courseCode', label: 'Course', kind: 'code' },
          { key: 'courseTitle', label: 'Title' },
          { key: 'credits', label: 'Credits' },
          { key: 'percent', label: '%' },
          { key: 'label', label: 'Grade', alertWhen: 'failed' },
        ],
      },
    ],
  },
]
