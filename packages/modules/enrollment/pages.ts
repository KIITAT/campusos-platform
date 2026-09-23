import type { PluginPage } from '@campusos/module-framework'
import { listOfferings, listStructure, type Actor as Academic } from '@campusos/module-academic/api'
import {
  creditLoad,
  listRegistrations,
  listRoster,
  listSeats,
  type Actor,
} from './api'

const STAFF = ['institution_admin', 'super_admin', 'hod'] as const
const EVERYONE = [
  'institution_admin',
  'super_admin',
  'hod',
  'faculty',
  'student',
] as const

const isStaff = (a: Actor) =>
  a.role === 'institution_admin' || a.role === 'super_admin' || a.role === 'hod'

/** The academic core takes the same actor shape; this is the cast, once. */
const asAcademic = (a: Actor): Academic => ({
  id: a.id,
  role: a.role,
  institutionId: a.institutionId,
})

export const pages: PluginPage[] = [
  {
    path: '/',
    title: 'Registration',
    menu: 'Registration',
    roles: [...EVERYONE],
    async load(actor, req) {
      const a = actor as Actor
      const asked = new URL(req.url).searchParams.get('studentId')
      const studentId = isStaff(a) ? (asked ?? a.id) : a.id

      const [structure, offerings, mine] = await Promise.all([
        listStructure(asAcademic(a)),
        listOfferings(asAcademic(a)),
        listRegistrations(a, { studentId }),
      ])

      const current = structure.terms.find((t) => t.isCurrent) ?? null
      const load = current
        ? await creditLoad(a, { studentId, termId: current.id })
        : { credits: 0, courses: 0 }

      const today = new Date().toISOString().slice(0, 10)
      const open =
        current?.registrationOpensOn != null &&
        current.registrationClosesOn != null &&
        today >= current.registrationOpensOn &&
        today <= current.registrationClosesOn

      return {
        studentId,
        termName: current ? `${current.code} - ${current.name}` : null,
        open,
        closesOn: current?.registrationClosesOn ?? null,
        addDropEndsOn: current?.addDropEndsOn ?? null,
        withdrawEndsOn: current?.withdrawEndsOn ?? null,
        credits: String(load.credits),
        courses: String(load.courses),
        registrations: mine.map((r) => ({
          ...r,
          course: `${r.courseCode} - ${r.courseTitle}`,
        })),
        offeringOptions: offerings
          .filter((o) => !current || o.termCode === current.code)
          .map((o) => ({
            value: o.id,
            label: `${o.courseCode} ${o.sectionLabel} - ${o.courseTitle}`,
          })),
      }
    },
    sections: (data) => [
      {
        kind: 'note',
        tone: data.open ? 'info' : 'warn',
        text: data.termName
          ? data.open
            ? `Registration for ${String(data.termName)} is open until ${String(data.closesOn)}. Add and drop freely until ${String(data.addDropEndsOn ?? 'the add/drop deadline')}; after that a drop is a withdrawal and shows on the transcript.`
            : `Registration for ${String(data.termName)} is not open. Staff can still register somebody, and the event records who did.`
          : 'No term is current, so there is nothing to register for. Set one from the academic structure.',
      },
      {
        kind: 'figures',
        figures: [
          { label: 'Credits this term', value: String(data.credits) },
          { label: 'Courses', value: String(data.courses) },
        ],
      },
      {
        kind: 'table',
        title: 'Registrations',
        rows: 'registrations',
        empty: 'Nothing registered.',
        columns: [
          { key: 'termCode', label: 'Term', kind: 'code' },
          { key: 'course', label: 'Course' },
          { key: 'credits', label: 'Credits' },
          { key: 'status', label: 'Status', kind: 'status' },
          { key: 'endedOn', label: 'Ended', kind: 'date' },
        ],
      },
      {
        kind: 'form',
        title: 'Register for a course',
        note: 'The prerequisite chain is checked against your record. If it refuses, the way through is a waiver from the registrar, not a second attempt here.',
        submit: 'Register',
        path: '/register',
        fields: [
          { name: 'studentId', label: 'Student id', value: String(data.studentId), kind: 'hidden' },
          {
            name: 'offeringId',
            label: 'Course',
            kind: 'select',
            options: 'offeringOptions',
          },
        ],
      },
      {
        kind: 'form',
        title: 'Drop a course',
        note: 'Inside add/drop it leaves no mark. After it, and up to the withdrawal deadline, it is a withdrawal.',
        submit: 'Drop',
        path: '/drop',
        fields: [
          { name: 'studentId', label: 'Student id', value: String(data.studentId), kind: 'hidden' },
          {
            name: 'offeringId',
            label: 'Course',
            kind: 'select',
            options: 'offeringOptions',
          },
          { name: 'reason', label: 'Reason', optional: true },
        ],
      },
    ],
  },

  {
    path: '/roster',
    title: 'Roster',
    menu: 'Roster',
    roles: [...STAFF, 'faculty'],
    async load(actor, req) {
      const a = actor as Actor
      const offeringId = new URL(req.url).searchParams.get('offeringId')
      const offerings = await listOfferings(asAcademic(a))
      const chosen = offeringId ?? offerings[0]?.id ?? null
      const roster = chosen ? await listRoster(a, { offeringId: chosen }) : []
      const offering = offerings.find((o) => o.id === chosen) ?? null

      return {
        offeringId: chosen,
        heading: offering
          ? `${offering.courseCode} ${offering.sectionLabel} - ${offering.courseTitle}`
          : 'No offering',
        registered: roster.filter((r) => r.status === 'registered'),
        waiting: roster.filter((r) => r.status === 'waitlisted'),
        gone: roster.filter((r) => r.status === 'dropped' || r.status === 'withdrawn'),
        offeringLinks: offerings.map((o) => ({
          label: `${o.courseCode} ${o.sectionLabel}`,
          href: `/m/enrollment/roster?offeringId=${o.id}`,
          active: o.id === chosen,
        })),
      }
    },
    sections: (data) => [
      { kind: 'links', title: 'Offerings', links: data.offeringLinks as never },
      { kind: 'note', text: String(data.heading) },
      {
        kind: 'table',
        title: 'Registered',
        rows: 'registered',
        empty: 'Nobody yet.',
        columns: [
          { key: 'studentName', label: 'Student' },
          { key: 'credits', label: 'Credits' },
          { key: 'registeredAt', label: 'Since', kind: 'when' },
        ],
      },
      {
        kind: 'table',
        title: 'Waiting',
        note: 'Longest wait first. The place is worked out on the spot, never stored.',
        rows: 'waiting',
        empty: 'Nobody waiting.',
        columns: [
          { key: 'place', label: 'Place' },
          { key: 'studentName', label: 'Student' },
          { key: 'registeredAt', label: 'Joined', kind: 'when' },
        ],
      },
      {
        kind: 'table',
        title: 'Left the course',
        rows: 'gone',
        empty: 'Nobody has left.',
        columns: [
          { key: 'studentName', label: 'Student' },
          { key: 'status', label: 'How', kind: 'status' },
          { key: 'endedOn', label: 'On', kind: 'date' },
        ],
      },
    ],
  },

  {
    path: '/seats',
    title: 'Seats',
    menu: 'Seats',
    roles: [...STAFF],
    async load(actor) {
      const a = actor as Actor
      const [seats, offerings] = await Promise.all([
        listSeats(a),
        listOfferings(asAcademic(a)),
      ])
      return {
        seats,
        offeringOptions: offerings.map((o) => ({
          value: o.id,
          label: `${o.courseCode} ${o.sectionLabel} - ${o.courseTitle}`,
        })),
      }
    },
    sections: () => [
      {
        kind: 'note',
        text: 'An offering with no row here is uncapped. That is deliberate: a seminar nobody capped should not refuse its eleventh student because a default was invented somewhere.',
      },
      {
        kind: 'table',
        title: 'Capped offerings',
        rows: 'seats',
        empty: 'Nothing is capped.',
        columns: [
          { key: 'courseCode', label: 'Course', kind: 'code' },
          { key: 'courseTitle', label: 'Title' },
          { key: 'capacity', label: 'Seats' },
          { key: 'taken', label: 'Taken' },
          { key: 'free', label: 'Free' },
          { key: 'queued', label: 'Waiting' },
        ],
      },
      {
        kind: 'form',
        title: 'Set a limit',
        note: 'Lowering a cap below what is already taken is refused by the same rule that stops a seat being sold twice.',
        submit: 'Set',
        path: '/seats',
        fields: [
          {
            name: 'offeringId',
            label: 'Offering',
            kind: 'select',
            options: 'offeringOptions',
          },
          { name: 'capacity', label: 'Seats', kind: 'number' },
          { name: 'waitlistCapacity', label: 'Waiting list', kind: 'number', optional: true },
        ],
      },
    ],
  },
]
