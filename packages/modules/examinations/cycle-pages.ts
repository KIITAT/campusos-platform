import { param, type PluginPage, type PluginSection } from '@campusos/module-framework'
import { listStructure, type Actor as AcademicActor } from '@campusos/module-academic/api'
import {
  backlogList,
  enrolmentList,
  examCycleSettings,
  examStats,
  listWindows,
  myExamCycle,
  papersFor,
  studentPerformance,
  type Actor,
} from './api'
import { localInput, wallClock } from './api/time'

const STAFF = ['institution_admin', 'super_admin', 'hod', 'faculty'] as const
const CELL = ['institution_admin', 'super_admin'] as const
const ZONE = 'Asia/Kolkata'

const ZONES = ['Asia/Kolkata', 'UTC', 'Asia/Dubai', 'Asia/Singapore', 'Asia/Dhaka', 'Asia/Kathmandu', 'Europe/London', 'America/New_York'].map(
  (z) => ({ value: z, label: z }),
)

type Cycle = NonNullable<Awaited<ReturnType<typeof myExamCycle>>>

const SITTING = { internal: 'internal assessment', university: 'university exam', both: 'both' } as const

const PHASE_WORDS = { none: 'not set', upcoming: 'upcoming', open: 'open', closed: 'closed' } as const

export const cyclePages: PluginPage[] = [
  {
    path: '/booking',
    title: 'Exam booking',
    menu: 'Exam booking',
    roles: ['student'],
    async load(actor, req) {
      const c = await myExamCycle(actor as Actor, param(req, 'termId'))
      if (!c) return { c: null }
      return {
        c,
        papers: c.papers,
        classes: c.classes,
        backlogs: c.backlogs,
        bookings: c.bookings.map((b) => ({ ...b, bookedOn: wallClock(b.bookedAt, ZONE), sitting: SITTING[b.bookingType] })),
        reports: c.reports.map((r) => ({ ...r, state: r.held ? 'held' : 'ready', link: r.held ? '' : 'Download' })),
        owed: c.feedback?.owed ?? [],
        backlogOptions: c.backlogs.filter((b) => !b.booked).map((b) => ({ value: b.courseId, label: `${b.code} ${b.title} (failed ${b.failedIn ?? ''})` })),
        cancellable: c.bookings.filter((b) => b.state === 'booked').map((b) => ({ value: b.id, label: `${b.code} ${b.title}` })),
      }
    },
    sections: (data) => {
      const c = data.c as Cycle | null
      if (typeof c?.term?.id !== 'string') return [{ kind: 'note', tone: 'warn', text: 'No current term is set yet.' }]
      const out: PluginSection[] = []
      const p = c.profile

      // Step 1. Feedback, where the institution takes it.
      if (c.feedback) {
        out.push(
          c.feedback.complete
            ? { kind: 'note', text: `Step 1. Feedback for ${c.term.code}: done. Thank you.` }
            : {
                kind: 'note',
                tone: 'warn',
                text: `Step 1. Feedback for ${c.term.code}: ${c.feedback.owed.length} still to give. Your grade report may wait for it.`,
              },
        )
        if (!c.feedback.complete) out.push({ kind: 'links', links: [{ label: 'Give feedback', href: '/m/feedback/me' }] })
      }

      // Step 2. Enrolment, with the details the student confirms.
      const w = c.enrolWindow
      out.push({
        kind: 'figures',
        figures: [
          { label: 'Enrolment window', value: w ? PHASE_WORDS[w.phase] : 'not set', hint: w ? `${w.opens} to ${w.closes}` : undefined },
          { label: 'Papers this term', value: String(c.classes.length) },
          { label: 'Enrolled', value: c.enrolment ? 'yes' : 'no' },
        ],
      })
      if (c.enrolment) {
        out.push({
          kind: 'table',
          title: `Step 2. Enrolled for ${c.term.code}`,
          note: `On ${wallClock(c.enrolment.enrolledAt, w?.timeZone ?? ZONE)}, with these papers.`,
          rows: 'papers',
          columns: [
            { key: 'code', label: 'Paper', kind: 'code' },
            { key: 'title', label: 'Title' },
          ],
        })
        out.push({
          kind: 'links',
          title: 'Step 3. Admit card',
          links: [{ label: `Download the admit card for ${c.term.code}`, href: `/api/v1/modules/examinations/admit-card.pdf?termId=${c.term.id}` }],
        })
      } else {
        out.push({
          kind: 'note',
          text:
            `Step 2. Check your details before you enrol. Name: ${p.name}. Roll number: ${p.rollNo ?? 'not recorded'}. ` +
            `Registration number: ${p.registrationNo ?? 'not recorded'}. Programme: ${c.programme ?? 'not recorded'}. ` +
            `Phone: ${p.phone ?? 'not recorded'}. Address: ${p.address ?? 'not recorded'}. ` +
            'If anything is wrong, contact the office before enrolling: it is printed on your admit card.',
        })
        if (w?.phase === 'open') {
          out.push({
            kind: 'form',
            title: `Enrol for ${c.term.code}`,
            note: `You will be enrolled for all ${c.classes.length} of your papers this term.`,
            submit: 'Enrol',
            path: '/enrol',
            placement: 'inline',
            fields: [
              { name: 'termId', label: '', kind: 'hidden', value: c.term.id },
              { name: 'confirm', label: 'I have checked my name, numbers, phone and address, and they are correct', kind: 'checkbox', value: 'false' },
            ],
          })
        } else {
          out.push({
            kind: 'note',
            tone: 'warn',
            text: w ? (w.phase === 'upcoming' ? `Enrolment opens ${w.opens}.` : 'The enrolment window is closed. Contact the examination cell.') : 'Enrolment has not been opened for this term.',
          })
        }
      }

      // Backlogs.
      const b = c.backlogWindow
      out.push({
        kind: 'table',
        title: 'Backlog papers',
        note: b
          ? `Booking ${PHASE_WORDS[b.phase]} (${b.opens} to ${b.closes}). Per paper: internal assessment ${b.internalFee}, university exam ${b.examFee}.`
          : 'Backlog booking has not been opened for this term.',
        rows: 'backlogs',
        empty: 'No backlogs on your record.',
        columns: [
          { key: 'code', label: 'Paper', kind: 'code' },
          { key: 'title', label: 'Title' },
          { key: 'failedIn', label: 'Failed in' },
          { key: 'booked', label: 'Booked', kind: 'bool' },
        ],
      })
      if (b?.phase === 'open' && (data.backlogOptions as unknown[]).length) {
        out.push({
          kind: 'form',
          title: 'Book a backlog paper',
          submit: 'Book',
          path: '/backlogs',
          fields: [
            { name: 'termId', label: '', kind: 'hidden', value: c.term.id },
            { name: 'courseId', label: 'Paper', kind: 'select', options: 'backlogOptions' },
            {
              name: 'bookingType',
              label: 'Sit',
              kind: 'radio',
              value: 'university',
              options: [
                { value: 'internal', label: 'Internal assessment' },
                { value: 'university', label: 'University exam' },
                { value: 'both', label: 'Both' },
              ],
            },
          ],
        })
      }
      if (c.bookings.length) {
        out.push({
          kind: 'table',
          title: 'Booked',
          rows: 'bookings',
          columns: [
            { key: 'code', label: 'Paper', kind: 'code' },
            { key: 'title', label: 'Title' },
            { key: 'sitting', label: 'Sitting' },
            { key: 'fee', label: 'Fee' },
            { key: 'bookedOn', label: 'Booked' },
            { key: 'state', label: 'State', kind: 'status' },
          ],
        })
        if (b?.phase === 'open' && (data.cancellable as unknown[]).length) {
          out.push({
            kind: 'form',
            title: 'Cancel a booking',
            submit: 'Cancel it',
            path: '/backlogs/cancel',
            fields: [
              { name: 'bookingId', label: 'Booking', kind: 'select', options: 'cancellable' },
              { name: 'reason', label: 'Why', kind: 'textarea', rows: 2 },
            ],
          })
        }
      }

      // Grade reports.
      out.push({
        kind: 'table',
        title: 'Semester grade reports',
        note: 'From the official record. A report is held while required feedback for its term is outstanding.',
        rows: 'reports',
        empty: 'No finalised results yet.',
        columns: [
          { key: 'term', label: 'Term' },
          { key: 'state', label: 'State', kind: 'status' },
          { key: 'link', label: '', href: '/api/v1/modules/examinations/grade-report.pdf?termId={termId}' },
        ],
      })
      return out
    },
  },

  {
    path: '/cycle',
    title: 'Examination cycle',
    menu: 'Cycle',
    roles: ['institution_admin', 'super_admin', 'hod'],
    async load(actor, req) {
      const a = actor as Actor
      const [windows, settings, structure] = await Promise.all([
        listWindows(a),
        examCycleSettings(a),
        listStructure(a as unknown as AcademicActor),
      ])
      const term =
        structure.terms.find((t) => t.id === param(req, 'termId')) ?? structure.terms.find((t) => t.isCurrent) ?? structure.terms.at(-1) ?? null
      const [enrolled, backlogs] = term ? await Promise.all([enrolmentList(a, term.id), backlogList(a, term.id)]) : [[], []]
      return {
        term,
        windows,
        settings,
        enrolled,
        backlogs,
        terms: structure.terms.map((t) => ({ label: t.code, href: `/m/examinations/cycle?termId=${t.id}`, active: t.id === term?.id })),
        termOptions: structure.terms.map((t) => ({ value: t.id, label: `${t.code} - ${t.name}${t.isCurrent ? ' (current)' : ''}` })),
        enrolledOptions: enrolled.filter((e) => e.enrolmentId).map((e) => ({ value: e.enrolmentId!, label: e.name })),
        counts: {
          enrolled: enrolled.filter((e) => e.enrolmentId).length,
          waiting: enrolled.filter((e) => !e.enrolmentId).length,
          backlogs: backlogs.filter((b) => b.state === 'booked').length,
        },
        now: localInput(new Date(), ZONE),
      }
    },
    sections: (data) => {
      const s = data.settings as { paperReleaseMinutes: number; gradeReportNeedsFeedback: boolean }
      const n = data.counts as { enrolled: number; waiting: number; backlogs: number }
      const term = data.term as { code: string } | null
      return [
        { kind: 'links', title: 'Term', links: data.terms as never },
        {
          kind: 'figures',
          figures: [
            { label: `Enrolled for ${term?.code ?? ''}`, value: String(n.enrolled) },
            { label: 'With classes, not enrolled', value: String(n.waiting) },
            { label: 'Backlog papers booked', value: String(n.backlogs) },
          ],
        },
        {
          kind: 'table',
          title: 'Windows',
          rows: 'windows',
          empty: 'None set. Open an enrolment window for the term below.',
          columns: [
            { key: 'term', label: 'Term', kind: 'code' },
            { key: 'kind', label: 'For' },
            { key: 'phase', label: 'State', kind: 'status' },
            { key: 'opens', label: 'Opens' },
            { key: 'closes', label: 'Closes' },
            { key: 'internalFee', label: 'Internal fee' },
            { key: 'examFee', label: 'Exam fee' },
          ],
        },
        {
          kind: 'form',
          title: 'Open or move a window',
          note: 'One enrolment and one backlog window per term; setting it again moves it. Fees apply to backlog papers, per paper, and are charged through Fees where it is on.',
          submit: 'Set the window',
          path: '/windows',
          fields: [
            { name: 'termId', label: 'Term', kind: 'select', options: 'termOptions' },
            {
              name: 'kind',
              label: 'For',
              kind: 'radio',
              value: 'enrolment',
              options: [
                { value: 'enrolment', label: 'Examination enrolment' },
                { value: 'backlog', label: 'Backlog booking' },
              ],
            },
            { name: 'opensAt', label: 'Opens', kind: 'datetime', value: String(data.now) },
            { name: 'closesAt', label: 'Closes', kind: 'datetime' },
            { name: 'timeZone', label: 'Time zone', kind: 'select', options: ZONES, value: ZONE },
            { name: 'internalFee', label: 'Backlog: internal assessment fee per paper', kind: 'money', optional: true },
            { name: 'examFee', label: 'Backlog: university exam fee per paper', kind: 'money', optional: true },
            { name: 'instructions', label: 'Instructions printed on the admit card', kind: 'textarea', rows: 3, optional: true },
          ],
        },
        {
          kind: 'table',
          title: 'Enrolment',
          rows: 'enrolled',
          empty: 'Nobody has classes this term.',
          pageSize: 50,
          columns: [
            { key: 'name', label: 'Student', href: '/m/examinations/performance?studentId={studentId}' },
            { key: 'rollNo', label: 'Roll', kind: 'code' },
            { key: 'state', label: 'State', kind: 'status' },
            { key: 'papers', label: 'Papers' },
            { key: 'classes', label: 'Classes' },
            { key: 'enrolledAt', label: 'Enrolled', kind: 'date' },
          ],
        },
        {
          kind: 'form',
          title: 'Cancel an enrolment',
          note: 'The student may enrol again while the window is open.',
          submit: 'Cancel it',
          path: '/enrolments/cancel',
          roles: [...CELL],
          fields: [
            { name: 'enrolmentId', label: 'Student', kind: 'select', options: 'enrolledOptions' },
            { name: 'reason', label: 'Why', kind: 'textarea', rows: 2 },
          ],
        },
        {
          kind: 'table',
          title: 'Backlog bookings',
          rows: 'backlogs',
          empty: 'None this term.',
          columns: [
            { key: 'student', label: 'Student' },
            { key: 'course', label: 'Paper' },
            { key: 'typeText', label: 'Sitting' },
            { key: 'fee', label: 'Fee' },
            { key: 'state', label: 'State', kind: 'status' },
            { key: 'cancelReason', label: 'Cancelled because' },
          ],
        },
        {
          kind: 'form',
          title: 'Rules for the cycle',
          note: `Question papers open to the examination cell ${s.paperReleaseMinutes} minutes before each exam. Grade reports ${s.gradeReportNeedsFeedback ? 'wait' : 'do not wait'} for a student's required feedback.`,
          submit: 'Save',
          path: '/cycle/settings',
          roles: [...CELL],
          fields: [
            { name: 'paperReleaseMinutes', label: 'Minutes before an exam its paper opens', kind: 'number', value: String(s.paperReleaseMinutes) },
            {
              name: 'gradeReportNeedsFeedback',
              label: 'A student’s grade report waits for their required feedback',
              kind: 'checkbox',
              value: String(s.gradeReportNeedsFeedback),
            },
          ],
        },
      ]
    },
  },

  {
    path: '/paper',
    title: 'Question paper',
    roles: [...STAFF],
    async load(actor, req) {
      const id = param(req, 'examId')
      if (!id) return { v: null }
      const v = await papersFor(actor as Actor, id)
      return {
        v,
        papers: v.papers.map((p) => ({
          ...p,
          uploaded: wallClock(p.uploadedAt, ZONE),
          fingerprint: `${p.sha256.slice(0, 16)}…`,
          kb: `${Math.round(p.sizeBytes / 1024)} KB`,
          download: v.released && p.state !== 'superseded' ? 'Download' : '',
        })),
        role: (actor as Actor).role,
      }
    },
    record: (data) => {
      const v = data.v as Awaited<ReturnType<typeof papersFor>> | null
      if (typeof v?.exam?.id !== 'string') return null
      return {
        title: `${v.exam.course}: ${v.exam.name}`,
        subtitle: 'Question paper',
        status: { label: v.released ? 'released' : 'sealed' },
        fields: [
          { label: 'Exam', value: v.exam.scheduledAt ? wallClock(v.exam.scheduledAt, ZONE) : 'not scheduled' },
          { label: 'Opens to the examination cell', value: v.releaseAt ? wallClock(v.releaseAt, ZONE) : '—' },
        ],
      }
    },
    sections: (data) => {
      const v = data.v as Awaited<ReturnType<typeof papersFor>> | null
      if (typeof v?.exam?.id !== 'string') return [{ kind: 'note', tone: 'warn', text: 'No such exam.' }]
      const out: PluginSection[] = [
        {
          kind: 'note',
          text:
            `Sealed: nobody can download a paper until ${v.releaseMinutes} minutes before the exam, and then only the examination cell, every time on the record. ` +
            'Keep the fingerprint of what you upload; it is the proof that the paper opened is the paper you set.',
        },
        {
          kind: 'table',
          title: 'Uploaded',
          rows: 'papers',
          empty: 'Nothing uploaded yet.',
          columns: [
            { key: 'version', label: 'Version' },
            { key: 'fileName', label: 'File' },
            { key: 'kb', label: 'Size' },
            { key: 'fingerprint', label: 'SHA-256', kind: 'code' },
            { key: 'uploader', label: 'By' },
            { key: 'uploaded', label: 'When' },
            { key: 'state', label: 'State', kind: 'status' },
            { key: 'download', label: '', href: '/api/v1/modules/examinations/paper.pdf?paperId={id}' },
          ],
        },
      ]
      if (!v.released && v.exam.scheduledAt) {
        out.push({
          kind: 'form',
          title: 'Upload the paper',
          note: 'A PDF, up to 8 MB. Uploading again replaces it until the seal closes.',
          submit: 'Upload and seal',
          path: '/papers',
          fields: [
            { name: 'examId', label: '', kind: 'hidden', value: v.exam.id },
            { name: 'paper', label: 'Question paper (PDF)', kind: 'file', accept: 'application/pdf' },
          ],
        })
      }
      if (!v.exam.scheduledAt) out.push({ kind: 'note', tone: 'warn', text: 'Schedule the exam first: a paper is sealed against its date.' })
      return out
    },
  },

  {
    path: '/stats',
    title: 'Exam statistics',
    roles: [...STAFF],
    async load(actor, req) {
      const id = param(req, 'examId')
      if (!id) return { v: null }
      const v = await examStats(actor as Actor, id)
      // Whole students up the side: the top of the scale is the fullest band.
      return { v, bands: v.bands, bandTop: Math.max(1, ...v.bands.map((b) => b.students)) }
    },
    record: (data) => {
      const v = data.v as Awaited<ReturnType<typeof examStats>> | null
      if (typeof v?.exam?.id !== 'string') return null
      return {
        title: `${v.exam.course}: ${v.exam.name}`,
        subtitle: v.exam.published ? 'Published' : 'Not yet published',
        status: { label: v.exam.published ? 'published' : 'draft' },
      }
    },
    sections: (data) => {
      const v = data.v as Awaited<ReturnType<typeof examStats>> | null
      if (typeof v?.exam?.id !== 'string') return [{ kind: 'note', tone: 'warn', text: 'No such exam.' }]
      const pct = (x: number | null) => (x === null ? '—' : `${x}%`)
      return [
        {
          kind: 'figures',
          figures: [
            { label: 'Sat', value: String(v.sat), hint: `${v.absent} absent` },
            { label: 'Average', value: pct(v.mean) },
            { label: 'Median', value: pct(v.median) },
            { label: 'Highest', value: pct(v.highest) },
            { label: 'Lowest', value: pct(v.lowest) },
            { label: 'Passed', value: pct(v.passRate), hint: `at ${v.passFloor}% or more` },
          ],
        },
        {
          kind: 'chart',
          title: 'Spread of marks',
          note: 'Students in each ten-percent band.',
          type: 'bar',
          rows: 'bands',
          x: 'band',
          series: [{ key: 'students', label: 'Students' }],
          max: 'bandTop',
        },
      ]
    },
  },

  {
    path: '/performance',
    title: 'Performance',
    menu: 'My performance',
    roles: [...STAFF, 'student'],
    async load(actor, req) {
      const a = actor as Actor
      const id = a.role === 'student' ? a.id : (param(req, 'studentId') ?? a.id)
      const rows = await studentPerformance(a, id)
      return {
        rows: rows.map((r) => ({ ...r, behind: r.versus !== null && r.versus < -10 })),
        chart: rows.filter((r) => r.percent !== null).map((r) => ({ label: `${r.course} ${r.exam}`, you: r.percent, class: r.classMean ?? 0 })),
      }
    },
    sections: () => [
      {
        kind: 'chart',
        title: 'Against the class',
        type: 'bar',
        rows: 'chart',
        x: 'label',
        series: [
          { key: 'you', label: 'Student' },
          { key: 'class', label: 'Class average' },
        ],
        max: 100,
        empty: 'No published exams yet.',
      },
      {
        kind: 'table',
        title: 'Every published exam',
        rows: 'rows',
        empty: 'No published exams yet.',
        pageSize: 50,
        columns: [
          { key: 'term', label: 'Term', kind: 'code' },
          { key: 'course', label: 'Course', kind: 'code' },
          { key: 'exam', label: 'Exam' },
          { key: 'percent', label: '%' },
          { key: 'classMean', label: 'Class %' },
          { key: 'versus', label: 'Difference', alertWhen: 'behind' },
          { key: 'absent', label: 'Absent', kind: 'bool' },
        ],
      },
    ],
  },
]
