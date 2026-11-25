import { param, type PluginPage } from '@campusos/module-framework'
import {
  listOfferings,
  listStructure,
  type Actor as AcademicActor,
} from '@campusos/module-academic/api'
import {
  DEFAULT_GPA_BANDS,
  listExams,
  listMarkReviews,
  listProgramSchemes,
  reviewableMarks,
  listSchemes,
  sheet,
  transcript,
  type Actor,
} from './api'
import { wallClock } from './api/time'
import { cyclePages } from './cycle-pages'
import { reportCardPages } from './report-card-pages'

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
      const [offerings, structure] = await Promise.all([listOfferings(a), listStructure(a as unknown as AcademicActor)])
      const offeringId = param(req, 'offeringId') ?? offerings[0]?.id
      const examId = param(req, 'examId')

      const exams = offeringId ? await listExams(a, offeringId) : []
      const marks = examId ? await sheet(a, examId) : null
      const reviews = examId ? await listMarkReviews(a, { examId, after: param(req, 'after') || undefined }) : null

      return {
        offerings: offerings.map((o) => ({
          label: `${o.courseCode} ${o.sectionLabel}`,
          href: `/m/examinations?offeringId=${o.id}`,
          active: o.id === offeringId,
        })),
        offeringId: offeringId ?? '',
        roomOptions: structure.rooms.map((r) => ({ value: r.id, label: r.code })),
        exams: exams.map((e) => ({
          ...e,
          when: e.scheduledAt ? wallClock(e.scheduledAt, 'Asia/Kolkata') : '',
          paper: 'Paper',
          stats: e.publishedAt ? 'Statistics' : '',
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
        locked: marks ? marks.exam.published || marks.exam.everPublished : false,
        reviews: (reviews?.rows ?? []).map((r) => ({
          requestId: r.requestId,
          kind: r.kind,
          status: r.status,
          markId: r.markId,
          studentId: r.staff?.studentId ?? '',
          baseRevision: r.staff?.baseRevision ?? '',
          proposal: r.staff
            ? r.staff.proposedAbsent
              ? 'absent'
              : r.staff.proposedScore === null
                ? ''
                : String(r.staff.proposedScore)
            : '',
          createdAt: r.createdAt.slice(0, 10),
        })),
        olderReviews: reviews?.next
          ? [{ label: 'Older reviews', href: `/m/examinations?offeringId=${offeringId ?? ''}&examId=${examId}&after=${reviews.next}` }]
          : [],
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
          { key: 'when', label: 'When' },
          { key: 'state', label: 'Status', kind: 'status', alertWhen: 'open' },
          { key: 'paper', label: '', href: '/m/examinations/paper?examId={id}' },
          { key: 'stats', label: '', href: '/m/examinations/stats?examId={id}' },
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
          { name: 'scheduledAt', label: 'When', kind: 'datetime', optional: true, hint: 'India time. Printed on the admit card for a final.' },
          { name: 'roomId', label: 'Room', kind: 'select', options: 'roomOptions', optional: true },
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
                { key: 'needsRecompute', label: 'Needs re-finalisation', kind: 'bool' as const },
              ],
            },
            {
              kind: 'table' as const,
              title: 'Mark reviews',
              note:
                'A published mark moves only when one person proposes and a different administrator ' +
                'approves. A student’s request waits here for a proposal.',
              rows: 'reviews',
              empty: 'No reviews for this exam.',
              columns: [
                { key: 'status', label: 'Status', kind: 'status' as const },
                { key: 'kind', label: 'Kind' },
                { key: 'studentId', label: 'Student' },
                { key: 'markId', label: 'Mark', kind: 'code' as const },
                { key: 'baseRevision', label: 'Revision seen' },
                { key: 'proposal', label: 'Proposed' },
                { key: 'requestId', label: 'Review', kind: 'code' as const },
                { key: 'createdAt', label: 'Opened' },
              ],
            },
            { kind: 'links' as const, links: data.olderReviews as never },
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
        title: 'Finalise this course',
        note:
          'Turns the published marks into the academic record: the prerequisite ' +
          'check, the degree audit and the official transcript all read it from ' +
          'there afterwards. Safe to run again after a revision -- the record is ' +
          'corrected with the reason attached, never rewritten quietly.',
        submit: 'Finalise',
        path: '/finalise',
        roles: [...ADMIN],
        fields: [
          { name: 'offeringId', label: 'Offering', value: String(data.offeringId ?? '') },
          {
            name: 'reason',
            label: 'Reason',
            optional: true,
            hint: 'Only needed when this corrects a result already on the record.',
          },
        ],
      },
      {
        kind: 'form',
        title: 'Propose revision',
        note:
          'Proposes a different score, or an absence, for a published mark. Nothing changes until a ' +
          'different administrator approves it below. Give the review id to answer a student’s request.',
        submit: 'Propose',
        path: '/marks/revise',
        fields: [
          { name: 'examId', label: 'Exam', kind: 'select', options: 'published' },
          { name: 'studentId', label: 'Student' },
          { name: 'obtained', label: 'Marks', kind: 'number', optional: true, step: 'any' },
          { name: 'absent', label: 'Absent', kind: 'checkbox', optional: true },
          { name: 'expectedRevision', label: 'Revision seen', kind: 'number', value: '0', hint: 'The revisions column of the sheet' },
          { name: 'requestId', label: 'Review id', optional: true, hint: 'From the reviews table, when answering a student' },
          { name: 'reason', label: 'Reason', hint: '10 to 500 characters' },
        ],
      },
      {
        kind: 'form',
        title: 'Decide revision',
        note: 'Approve a proposal, or close a review. You cannot decide a proposal you made. After approving, finalise the course again.',
        submit: 'Decide',
        path: '/marks/decide',
        roles: [...ADMIN],
        fields: [
          { name: 'requestId', label: 'Review id' },
          {
            name: 'decision',
            label: 'Decision',
            kind: 'select',
            options: [
              { value: 'approve', label: 'approve the proposal' },
              { value: 'reject', label: 'reject and close' },
            ],
          },
          { name: 'reason', label: 'Reason', hint: '10 to 500 characters' },
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
      const [schemes, programScales, structure] = await Promise.all([
        listSchemes(actor as Actor),
        listProgramSchemes(actor as Actor),
        listStructure(actor as unknown as AcademicActor),
      ])
      return {
        programScales,
        programOptions: structure.programs.map((p) => ({
          value: p.id,
          label: `${p.code} - ${p.name}`,
        })),
        schemeOptions: schemes.map((s) => ({ value: s.id, label: s.name })),
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
        kind: 'table',
        title: 'Programmes on their own scale',
        note: 'Everything else grades on the institution default.',
        rows: 'programScales',
        empty: 'None. Every programme uses the default.',
        columns: [
          { key: 'programCode', label: 'Programme', kind: 'code' },
          { key: 'programName', label: 'Name' },
          { key: 'schemeName', label: 'Scale' },
        ],
      },
      {
        kind: 'form',
        title: 'Give a programme its own scale',
        note:
          'A ten-point scale for the degrees and a percentage with divisions for ' +
          'an affiliated diploma is one institution, not two.',
        submit: 'Set',
        path: '/scales/programs',
        fields: [
          { name: 'programId', label: 'Programme', kind: 'select', options: 'programOptions' },
          { name: 'schemeId', label: 'Scale', kind: 'select', options: 'schemeOptions' },
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
    async load(actor, req) {
      const a = actor as Actor
      const t = await transcript(a, a.id)
      const latest = t.terms.at(-1)
      const [asked, reviews] = await Promise.all([
        reviewableMarks(a, param(req, 'markAfter') || undefined),
        listMarkReviews(a, { after: param(req, 'after') || undefined }),
      ])
      return {
        markOptions: asked.rows.map((m) => ({ value: m.markId, label: m.label })),
        moreMarks: asked.next ? [{ label: 'More marks', href: `/m/examinations/me?markAfter=${asked.next}` }] : [],
        myReviews: reviews.rows.map((r) => ({ ...r, opened: r.createdAt.slice(0, 10), decided: r.decidedAt?.slice(0, 10) ?? '' })),
        olderReviews: reviews.next ? [{ label: 'Older requests', href: `/m/examinations/me?after=${reviews.next}` }] : [],
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
      {
        kind: 'form',
        title: 'Request a mark review',
        note: 'Ask for a recheck or a re-evaluation of a published mark. There is no charge. Staff look at it and an administrator decides.',
        submit: 'Request review',
        path: '/marks/recheck',
        fields: [
          { name: 'markId', label: 'Mark', kind: 'select', options: 'markOptions' },
          {
            name: 'kind',
            label: 'Kind',
            kind: 'select',
            options: [
              { value: 'recheck', label: 'recheck: the marks were added up wrongly' },
              { value: 're_evaluation', label: 're-evaluation: the answers were marked wrongly' },
            ],
          },
          { name: 'reason', label: 'Reason', kind: 'textarea', rows: 3, hint: '10 to 500 characters' },
        ],
      },
      { kind: 'links', links: data.moreMarks as never },
      {
        kind: 'table',
        title: 'Your mark reviews',
        rows: 'myReviews',
        empty: 'You have not asked for any review.',
        columns: [
          { key: 'status', label: 'Status', kind: 'status' },
          { key: 'kind', label: 'Kind' },
          { key: 'opened', label: 'Opened' },
          { key: 'decided', label: 'Decided' },
        ],
      },
      { kind: 'links', links: data.olderReviews as never },
    ],
  },
  ...cyclePages,
  ...reportCardPages,
]
