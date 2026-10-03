import { param, type PluginPage, type PluginSection } from '@campusos/module-framework'
import {
  assignmentList,
  listLeaveTypes,
  localInput,
  menteeView,
  myMentees,
  myMentoring,
  pendingLeave,
  sectionChoices,
  staffChoices,
  type Actor,
} from './api'

const RUNNERS = ['institution_admin', 'super_admin', 'hod'] as const
const STAFF = [...RUNNERS, 'faculty'] as const
const ZONE = 'Asia/Kolkata'

const NOTE_KINDS = [
  { value: 'meeting', label: 'Meeting' },
  { value: 'call', label: 'Call' },
  { value: 'progress', label: 'Progress' },
  { value: 'concern', label: 'Concern' },
]

const today = () => new Date().toISOString().slice(0, 10)

/** A leave application's rows, as both the mentor and the student read them. */
const LEAVE_COLUMNS = [
  { key: 'type', label: 'Kind' },
  { key: 'startsOn', label: 'From' },
  { key: 'endsOn', label: 'To' },
  { key: 'days', label: 'Days' },
  { key: 'placeOfVisit', label: 'Going to' },
  { key: 'purpose', label: 'Why' },
  { key: 'leaving', label: 'Leaves' },
  { key: 'arriving', label: 'Back' },
  { key: 'status', label: 'State', kind: 'status' as const },
  { key: 'decisionNote', label: 'Note' },
  { key: 'documentLink', label: '', href: '/api/v1/modules/mentoring/leave/document.pdf?applicationId={id}' },
]

const THREAD_COLUMNS = [
  { key: 'sent', label: 'When' },
  { key: 'sender', label: 'From' },
  { key: 'body', label: 'Message' },
  { key: 'readText', label: 'Read' },
]

export const pages: PluginPage[] = [
  {
    path: '/',
    title: 'Mentors',
    menu: 'Mentors',
    roles: [...RUNNERS],
    async load(actor) {
      const a = actor as Actor
      const [rows, staff, sections, types] = await Promise.all([assignmentList(a), staffChoices(a), sectionChoices(a), listLeaveTypes(a)])
      return {
        rows,
        staff,
        sections,
        types: types.map((t) => ({ ...t, state: t.retiredAt ? 'retired' : 'active', doc: t.needsDocument ? 'yes' : 'no', max: t.maxDays ?? '' })),
        liveTypes: types.filter((t) => !t.retiredAt).map((t) => ({ value: t.id, label: t.name })),
        counts: { all: rows.length, assigned: rows.filter((r) => r.mentor).length },
      }
    },
    sections: (data) => {
      const c = data.counts as { all: number; assigned: number }
      return [
        {
          kind: 'figures',
          figures: [
            { label: 'Students', value: String(c.all) },
            { label: 'With a mentor', value: String(c.assigned) },
            { label: 'Without', value: String(c.all - c.assigned), tone: c.all - c.assigned ? 'due' : 'clear' },
          ],
        },
        {
          kind: 'table',
          title: 'Students and their mentors',
          rows: 'rows',
          pageSize: 50,
          bulk: [
            {
              label: 'Give these a mentor',
              path: '/assign',
              idKey: 'studentId',
              field: 'studentIds',
              fields: [
                { name: 'mentorId', label: 'Mentor', kind: 'select', options: 'staff' },
                { name: 'coMentorId', label: 'Co-mentor', kind: 'select', options: 'staff', optional: true },
              ],
            },
            {
              label: 'End mentoring',
              path: '/assignments/end',
              idKey: 'studentId',
              field: 'studentIds',
              tone: 'danger',
              fields: [{ name: 'reason', label: 'Why', kind: 'text' }],
            },
          ],
          columns: [
            { key: 'student', label: 'Student', href: '/m/mentoring/mentee?studentId={studentId}' },
            { key: 'rollNo', label: 'Roll', kind: 'code' },
            { key: 'section', label: 'Section' },
            { key: 'mentor', label: 'Mentor' },
            { key: 'coMentor', label: 'Co-mentor' },
            { key: 'since', label: 'Since' },
            { key: 'state', label: 'State', kind: 'status' },
          ],
        },
        {
          kind: 'form',
          title: 'Give a section a mentor',
          note: 'Every student in the section. One who already had a mentor has it ended today; the history is kept.',
          submit: 'Assign',
          path: '/assign',
          fields: [
            { name: 'sectionId', label: 'Section', kind: 'select', options: 'sections' },
            { name: 'mentorId', label: 'Mentor', kind: 'select', options: 'staff' },
            { name: 'coMentorId', label: 'Co-mentor', kind: 'select', options: 'staff', optional: true },
            { name: 'reason', label: 'Note', optional: true },
          ],
        },
        {
          kind: 'table',
          title: 'Kinds of leave',
          rows: 'types',
          empty: 'None yet: students cannot ask for leave until there is a kind to ask for.',
          columns: [
            { key: 'name', label: 'Kind' },
            { key: 'doc', label: 'Needs a document' },
            { key: 'max', label: 'Most days' },
            { key: 'state', label: 'State', kind: 'status' },
          ],
        },
        {
          kind: 'form',
          title: 'Add a kind of leave',
          submit: 'Add',
          path: '/leave-types',
          fields: [
            { name: 'name', label: 'Name', hint: 'e.g. Home visit, Medical, Academic event' },
            { name: 'maxDays', label: 'Most days at a time', kind: 'number', optional: true },
            { name: 'needsDocument', label: 'Needs a supporting document (a PDF)', kind: 'checkbox', value: 'false' },
          ],
        },
        {
          kind: 'form',
          title: 'Stop offering a kind of leave',
          submit: 'Retire',
          path: '/leave-types/retire',
          fields: [{ name: 'leaveTypeId', label: 'Kind', kind: 'select', options: 'liveTypes' }],
        },
      ]
    },
  },

  {
    path: '/mentees',
    title: 'My mentees',
    menu: 'My mentees',
    roles: ['faculty', 'hod'],
    async load(actor) {
      const rows = await myMentees(actor as Actor)
      return {
        rows: rows.map((r) => ({ ...r, attendanceText: r.attendance === null ? '' : `${r.attendance}%` })),
        counts: {
          all: rows.length,
          low: rows.filter((r) => r.low).length,
          leave: rows.reduce((n, r) => n + r.leaveWaiting, 0),
          unread: rows.reduce((n, r) => n + r.unread, 0),
        },
      }
    },
    sections: (data) => {
      const c = data.counts as { all: number; low: number; leave: number; unread: number }
      return [
        {
          kind: 'figures',
          figures: [
            { label: 'Mentees', value: String(c.all) },
            { label: 'Attendance under 75%', value: String(c.low), tone: c.low ? 'due' : 'clear' },
            { label: 'Leave to decide', value: String(c.leave), tone: c.leave ? 'due' : 'clear', href: '/m/mentoring/leave' },
            { label: 'Unread messages', value: String(c.unread), tone: c.unread ? 'due' : 'clear' },
          ],
        },
        {
          kind: 'table',
          title: 'Mentees',
          rows: 'rows',
          empty: 'No mentees yet. The office assigns them.',
          pageSize: 60,
          columns: [
            { key: 'student', label: 'Student', href: '/m/mentoring/mentee?studentId={studentId}' },
            { key: 'rollNo', label: 'Roll', kind: 'code' },
            { key: 'as', label: 'You are' },
            { key: 'attendanceText', label: 'Attendance', alertWhen: 'low' },
            { key: 'leaveWaiting', label: 'Leave waiting' },
            { key: 'unread', label: 'Unread' },
            { key: 'lastNote', label: 'Last note' },
          ],
        },
      ]
    },
  },

  {
    path: '/mentee',
    title: 'Mentee',
    roles: [...STAFF],
    async load(actor, req) {
      const id = param(req, 'studentId')
      if (!id) return { v: null }
      const v = await menteeView(actor as Actor, id)
      return {
        v,
        attendance: (v.attendance ?? []).map((l) => ({ ...l, pct: l.percent === null ? '' : `${l.percent}%`, low: l.percent !== null && l.percent < 75 })),
        results: v.results?.terms ?? [],
        leave: v.leave,
        pendingLeave: v.leave.filter((l) => l.status === 'pending').map((l) => ({ value: l.id, label: `${l.type}, ${l.startsOn} to ${l.endsOn}: ${l.placeOfVisit}` })),
        notes: v.notes,
        thread: v.thread.map((m) => ({ ...m, readText: m.read ? 'read' : '' })),
        history: v.history.map((h) => ({ ...h, to: h.to ?? 'now' })),
      }
    },
    record: (data) => {
      const v = data.v as Awaited<ReturnType<typeof menteeView>> | null
      if (typeof v?.profile?.studentId !== 'string') return null
      const p = v.profile
      return {
        title: p.name,
        subtitle: v.programme ?? undefined,
        fields: [
          { label: 'Roll number', value: p.rollNo },
          { label: 'Registration number', value: p.registrationNo },
          { label: 'Phone', value: p.phone },
          { label: 'Email', value: p.email },
          { label: 'Address', value: p.address },
          { label: 'Emergency contact', value: p.emergencyContact },
          { label: 'Mentor', value: v.mentor },
          { label: 'Co-mentor', value: v.coMentor },
          { label: 'Lives in', value: v.housing ? `${v.housing.blockName} (${v.housing.block}), room ${v.housing.room}` : v.modules.hostel ? 'not in the hostel' : null },
          { label: 'Attendance', value: v.attendanceOverall === null ? null : `${v.attendanceOverall}% overall` },
          { label: 'Cumulative average', value: v.results?.cgpa ?? null },
          { label: `Fees, ${v.fees?.term ?? ''}`, value: v.fees ? `${v.fees.outstanding} outstanding of ${v.fees.payable}` : null },
        ],
      }
    },
    sections: (data) => {
      const v = data.v as Awaited<ReturnType<typeof menteeView>> | null
      if (typeof v?.profile?.studentId !== 'string') return [{ kind: 'note', tone: 'warn', text: 'No such mentee.' }]
      const out: PluginSection[] = []
      if (v.modules.attendance) {
        out.push({
          kind: 'table',
          title: 'Attendance by class',
          rows: 'attendance',
          empty: 'No classes yet.',
          columns: [
            { key: 'term', label: 'Term', kind: 'code' },
            { key: 'courseCode', label: 'Class', kind: 'code' },
            { key: 'courseTitle', label: 'Title' },
            { key: 'teacher', label: 'Teacher' },
            { key: 'held', label: 'Held' },
            { key: 'present', label: 'Present' },
            { key: 'absent', label: 'Absent' },
            { key: 'pct', label: '%', alertWhen: 'low' },
          ],
        })
      }
      if (v.modules.examinations) {
        out.push({
          kind: 'table',
          title: 'Results by term',
          note: 'From the official record.',
          rows: 'results',
          empty: 'Nothing finalised yet.',
          columns: [
            { key: 'term', label: 'Term', kind: 'code' },
            { key: 'courses', label: 'Courses' },
            { key: 'failed', label: 'Not passed' },
            { key: 'credits', label: 'Credits' },
            { key: 'gpa', label: 'Average' },
          ],
        })
      }
      out.push({ kind: 'table', title: 'Leave', rows: 'leave', empty: 'No leave asked for.', columns: LEAVE_COLUMNS })
      if ((data.pendingLeave as unknown[]).length) {
        out.push({
          kind: 'form',
          title: 'Decide a leave',
          submit: 'Decide',
          path: '/leave/decide',
          fields: [
            { name: 'applicationId', label: 'Application', kind: 'select', options: 'pendingLeave' },
            {
              name: 'decision',
              label: 'Decision',
              kind: 'radio',
              value: 'approve',
              options: [
                { value: 'approve', label: 'Approve' },
                { value: 'reject', label: 'Refuse' },
              ],
            },
            { name: 'note', label: 'Note', optional: true, hint: 'Needed when refusing: the student reads it.' },
          ],
        })
      }
      out.push(
        {
          kind: 'table',
          title: 'Conversation',
          rows: 'thread',
          empty: 'Nothing said yet.',
          pageSize: 50,
          columns: THREAD_COLUMNS,
        },
        {
          kind: 'form',
          title: 'Write to the student',
          submit: 'Send',
          path: '/messages',
          placement: 'inline',
          fields: [
            { name: 'studentId', label: '', kind: 'hidden', value: v.profile.studentId },
            { name: 'body', label: 'Message', kind: 'textarea', rows: 3 },
          ],
        },
        {
          kind: 'table',
          title: 'Notes',
          note: 'Private to the mentors and the office, unless shared.',
          rows: 'notes',
          empty: 'No notes yet.',
          columns: [
            { key: 'metOn', label: 'On' },
            { key: 'kind', label: 'Kind' },
            { key: 'body', label: 'Note' },
            { key: 'author', label: 'By' },
            { key: 'sharedText', label: 'Seen by' },
          ],
        },
        {
          kind: 'form',
          title: 'Write a note',
          submit: 'Save the note',
          path: '/notes',
          fields: [
            { name: 'studentId', label: '', kind: 'hidden', value: v.profile.studentId },
            { name: 'metOn', label: 'On', kind: 'date', value: today() },
            { name: 'kind', label: 'Kind', kind: 'radio', options: NOTE_KINDS, value: 'meeting' },
            { name: 'body', label: 'Note', kind: 'textarea', rows: 4 },
            { name: 'shared', label: 'Share with the student', kind: 'checkbox', value: 'false' },
          ],
        },
        {
          kind: 'table',
          title: 'Mentors over time',
          rows: 'history',
          columns: [
            { key: 'mentor', label: 'Mentor' },
            { key: 'from', label: 'From' },
            { key: 'to', label: 'To' },
            { key: 'reason', label: 'Note' },
          ],
        },
      )
      return out
    },
  },

  {
    path: '/leave',
    title: 'Leave requests',
    menu: 'Leave requests',
    roles: [...STAFF],
    async load(actor) {
      const rows = await pendingLeave(actor as Actor)
      return { rows, options: rows.map((l) => ({ value: l.id, label: `${l.student}: ${l.type}, ${l.startsOn} to ${l.endsOn}` })) }
    },
    sections: (data) => {
      const out: PluginSection[] = [
        {
          kind: 'table',
          title: 'Waiting on you',
          rows: 'rows',
          empty: 'Nothing waiting.',
          pageSize: 50,
          columns: [{ key: 'student', label: 'Student', href: '/m/mentoring/mentee?studentId={studentId}' }, ...LEAVE_COLUMNS.filter((c) => c.key !== 'status' && c.key !== 'decisionNote'), { key: 'contactPhone', label: 'Phone' }],
        },
      ]
      if ((data.rows as unknown[]).length) {
        out.push({
          kind: 'form',
          title: 'Decide',
          note: 'Approved leave reaches the hostel roll call, where the student lives in the hostel.',
          submit: 'Decide',
          path: '/leave/decide',
          fields: [
            { name: 'applicationId', label: 'Application', kind: 'select', options: 'options' },
            {
              name: 'decision',
              label: 'Decision',
              kind: 'radio',
              value: 'approve',
              options: [
                { value: 'approve', label: 'Approve' },
                { value: 'reject', label: 'Refuse' },
              ],
            },
            { name: 'note', label: 'Note', optional: true, hint: 'Needed when refusing: the student reads it.' },
          ],
        })
      }
      return out
    },
  },

  {
    path: '/me',
    title: 'My mentor and leave',
    menu: 'Mentor and leave',
    roles: ['student'],
    async load(actor) {
      const v = await myMentoring(actor as Actor)
      const now = new Date()
      return {
        v,
        thread: v.thread.map((m) => ({ ...m, readText: m.from === 'student' && m.read ? 'read' : '' })),
        notes: v.notes,
        leave: v.leave,
        types: v.leaveTypes.map((t) => ({
          value: t.id,
          label: `${t.name}${t.maxDays ? `, up to ${t.maxDays} days` : ''}${t.needsDocument ? ' (needs a document)' : ''}`,
        })),
        cancellable: v.leave
          .filter((l) => l.status === 'pending' || (l.status === 'approved' && new Date(l.leavingAt) > now))
          .map((l) => ({ value: l.id, label: `${l.type}, ${l.startsOn} to ${l.endsOn}` })),
        nowLocal: localInput(now, ZONE),
      }
    },
    sections: (data) => {
      const v = data.v as Awaited<ReturnType<typeof myMentoring>>
      const out: PluginSection[] = [
        {
          kind: 'figures',
          figures: [
            { label: 'Mentor', value: v.mentor?.name ?? 'not yet assigned', hint: v.mentor?.email ?? undefined },
            { label: 'Co-mentor', value: v.coMentor?.name ?? '—', hint: v.coMentor?.email ?? undefined },
            ...(v.housing ? [{ label: 'Hostel', value: `${v.housing.block}, room ${v.housing.room}` }] : []),
          ],
        },
        { kind: 'table', title: 'Conversation with your mentors', rows: 'thread', empty: 'Nothing said yet.', pageSize: 50, columns: THREAD_COLUMNS },
      ]
      if (v.mentor) {
        out.push({
          kind: 'form',
          title: 'Write to your mentor',
          submit: 'Send',
          path: '/messages',
          placement: 'inline',
          fields: [{ name: 'body', label: 'Message', kind: 'textarea', rows: 3 }],
        })
      }
      out.push(
        { kind: 'table', title: 'Your leave', rows: 'leave', empty: 'You have not asked for leave.', columns: LEAVE_COLUMNS },
        {
          kind: 'form',
          title: 'Ask for leave',
          note: v.mentor ? 'Your mentor decides. Times are India time.' : 'You have no mentor yet, so the office decides. Times are India time.',
          submit: 'Ask',
          path: '/leave',
          fields: [
            { name: 'leaveTypeId', label: 'Kind of leave', kind: 'select', options: 'types' },
            { name: 'startsOn', label: 'From', kind: 'date' },
            { name: 'endsOn', label: 'To', kind: 'date' },
            { name: 'purpose', label: 'Purpose', kind: 'textarea', rows: 2 },
            { name: 'placeOfVisit', label: 'Place of visit' },
            { name: 'leavingAt', label: 'Leaving', kind: 'datetime', value: String(data.nowLocal) },
            { name: 'arrivingAt', label: 'Back', kind: 'datetime' },
            { name: 'contactPhone', label: 'Phone during leave' },
            { name: 'document', label: 'Supporting document (PDF)', kind: 'file', accept: 'application/pdf', optional: true },
          ],
        },
      )
      if ((data.cancellable as unknown[]).length) {
        out.push({
          kind: 'form',
          title: 'Cancel leave',
          note: 'Before you go. Once you have left, tell your mentor instead.',
          submit: 'Cancel it',
          path: '/leave/cancel',
          fields: [
            { name: 'applicationId', label: 'Leave', kind: 'select', options: 'cancellable' },
            { name: 'reason', label: 'Why', optional: true },
          ],
        })
      }
      out.push({
        kind: 'table',
        title: 'Notes your mentor shared',
        rows: 'notes',
        empty: 'None shared.',
        columns: [
          { key: 'metOn', label: 'On' },
          { key: 'kind', label: 'Kind' },
          { key: 'body', label: 'Note' },
          { key: 'author', label: 'By' },
        ],
      })
      return out
    },
  },
]
