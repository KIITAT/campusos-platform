import type { PluginPage } from '@campusos/module-framework'
import { getTimetable, listOfferings, listSections, listStructure, type Actor } from './api'

const REGISTRAR = ['institution_admin', 'super_admin'] as const
const EVERYONE = [
  'institution_admin',
  'super_admin',
  'hod',
  'faculty',
  'student',
] as const

const DAYS = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export const pages: PluginPage[] = [
  {
    path: '/',
    title: 'Timetable',
    menu: 'Timetable',
    roles: [...EVERYONE],
    async load(actor) {
      const t = await getTimetable(actor as Actor)
      return {
        termCode: t.termCode,
        entries: t.entries.map((e) => ({
          ...e,
          day: DAYS[e.dayOfWeek],
          at: `${e.startsAt.slice(0, 5)}-${e.endsAt.slice(0, 5)}`,
        })),
      }
    },
    sections: (data) => [
      {
        kind: 'note',
        text: data.termCode
          ? `Term ${data.termCode}. A student sees every cohort they belong to, electives included; a lecturer sees what they teach.`
          : 'No term is current, so there is nothing to show. Set one from Structure.',
      },
      {
        kind: 'table',
        rows: 'entries',
        empty: 'Nothing timetabled.',
        columns: [
          { key: 'day', label: 'Day' },
          { key: 'at', label: 'Time' },
          { key: 'courseCode', label: 'Course', kind: 'code' },
          { key: 'courseTitle', label: 'Title' },
          { key: 'roomCode', label: 'Room', kind: 'code' },
          { key: 'facultyName', label: 'Lecturer' },
        ],
      },
    ],
  },

  {
    path: '/structure',
    title: 'Structure',
    menu: 'Structure',
    roles: [...REGISTRAR, 'hod'],
    async load(actor) {
      const s = await listStructure(actor as Actor)
      return {
        departments: s.departments,
        programs: s.programs,
        courses: s.courses,
        rooms: s.rooms,
        terms: s.terms,
        departmentOptions: s.departments.map((d) => ({
          value: d.id,
          label: `${d.code} - ${d.name}`,
        })),
        termOptions: s.terms.map((t) => ({ value: t.id, label: `${t.code} - ${t.name}` })),
      }
    },
    sections: () => [
      {
        kind: 'table',
        title: 'Departments',
        rows: 'departments',
        empty: 'None yet.',
        columns: [
          { key: 'code', label: 'Code', kind: 'code' },
          { key: 'name', label: 'Name' },
        ],
      },
      {
        kind: 'table',
        title: 'Programmes',
        rows: 'programs',
        empty: 'None yet.',
        columns: [
          { key: 'code', label: 'Code', kind: 'code' },
          { key: 'name', label: 'Name' },
          { key: 'level', label: 'Level' },
          { key: 'durationTerms', label: 'Terms' },
        ],
      },
      {
        kind: 'table',
        title: 'Courses',
        rows: 'courses',
        empty: 'None yet.',
        columns: [
          { key: 'code', label: 'Code', kind: 'code' },
          { key: 'title', label: 'Title' },
          { key: 'credits', label: 'Credits' },
        ],
      },
      {
        kind: 'table',
        title: 'Terms',
        rows: 'terms',
        empty: 'None yet.',
        columns: [
          { key: 'code', label: 'Code', kind: 'code' },
          { key: 'name', label: 'Name' },
          { key: 'startsOn', label: 'From', kind: 'date' },
          { key: 'endsOn', label: 'To', kind: 'date' },
          { key: 'isCurrent', label: 'Current', kind: 'bool' },
        ],
      },
      {
        kind: 'table',
        title: 'Rooms',
        rows: 'rooms',
        empty: 'None yet.',
        columns: [
          { key: 'code', label: 'Code', kind: 'code' },
          { key: 'building', label: 'Building' },
          { key: 'capacity', label: 'Capacity' },
        ],
      },
      {
        kind: 'form',
        title: 'Add a department',
        submit: 'Add',
        path: '/departments',
        roles: [...REGISTRAR],
        fields: [
          { name: 'code', label: 'Code' },
          { name: 'name', label: 'Name' },
        ],
      },
      {
        kind: 'form',
        title: 'Add a programme',
        submit: 'Add',
        path: '/programs',
        roles: [...REGISTRAR],
        fields: [
          { name: 'departmentId', label: 'Department', kind: 'select', options: 'departmentOptions' },
          { name: 'code', label: 'Code' },
          { name: 'name', label: 'Name' },
          {
            name: 'level',
            label: 'Level',
            kind: 'select',
            options: [
              { value: 'undergraduate', label: 'undergraduate' },
              { value: 'postgraduate', label: 'postgraduate' },
              { value: 'doctoral', label: 'doctoral' },
              { value: 'diploma', label: 'diploma' },
            ],
          },
          { name: 'durationTerms', label: 'Terms', kind: 'number' },
        ],
      },
      {
        kind: 'form',
        title: 'Add a course',
        submit: 'Add',
        path: '/courses',
        roles: [...REGISTRAR],
        fields: [
          { name: 'departmentId', label: 'Department', kind: 'select', options: 'departmentOptions' },
          { name: 'code', label: 'Code' },
          { name: 'title', label: 'Title' },
          { name: 'credits', label: 'Credits', kind: 'number' },
        ],
      },
      {
        kind: 'form',
        title: 'Add a term',
        submit: 'Add',
        path: '/terms',
        roles: [...REGISTRAR],
        fields: [
          { name: 'code', label: 'Code' },
          { name: 'name', label: 'Name' },
          { name: 'startsOn', label: 'From', kind: 'date' },
          { name: 'endsOn', label: 'To', kind: 'date' },
        ],
      },
      {
        kind: 'form',
        title: 'Set the current term',
        note: 'At most one is current, and the database is what enforces that.',
        submit: 'Set current',
        path: '/terms/current',
        roles: [...REGISTRAR],
        fields: [{ name: 'termId', label: 'Term', kind: 'select', options: 'termOptions' }],
      },
      {
        kind: 'form',
        title: 'Add a room',
        submit: 'Add',
        path: '/rooms',
        roles: [...REGISTRAR],
        fields: [
          { name: 'code', label: 'Code' },
          { name: 'building', label: 'Building', optional: true },
          { name: 'capacity', label: 'Capacity', kind: 'number', optional: true },
        ],
      },
    ],
  },

  {
    path: '/cohorts',
    title: 'Cohorts',
    menu: 'Cohorts',
    roles: [...REGISTRAR, 'hod'],
    async load(actor) {
      const a = actor as Actor
      const [sections, offerings, structure] = await Promise.all([
        listSections(a),
        listOfferings(a),
        listStructure(a),
      ])
      return {
        sections,
        offerings,
        sectionOptions: sections.map((s) => ({
          value: s.id,
          label: `${s.programCode} ${s.label} (${s.admissionYear})`,
        })),
        programOptions: structure.programs.map((p) => ({
          value: p.id,
          label: `${p.code} - ${p.name}`,
        })),
        courseOptions: structure.courses.map((c) => ({
          value: c.id,
          label: `${c.code} - ${c.title}`,
        })),
        termOptions: structure.terms.map((t) => ({ value: t.id, label: t.code })),
        roomOptions: structure.rooms.map((r) => ({ value: r.id, label: r.code })),
      }
    },
    sections: () => [
      {
        kind: 'note',
        text:
          'A section is a cohort — a programme, an admission year and a label — ' +
          'not a course offering. Membership is many-to-many, because electives ' +
          'put a student in more than one.',
      },
      {
        kind: 'table',
        title: 'Cohorts',
        rows: 'sections',
        empty: 'None yet.',
        columns: [
          { key: 'programCode', label: 'Programme', kind: 'code' },
          { key: 'label', label: 'Section' },
          { key: 'admissionYear', label: 'Year' },
          { key: 'members', label: 'Students' },
        ],
      },
      {
        kind: 'table',
        title: 'Offerings',
        rows: 'offerings',
        empty: 'None yet.',
        columns: [
          { key: 'courseCode', label: 'Course', kind: 'code' },
          { key: 'sectionLabel', label: 'Section' },
          { key: 'termCode', label: 'Term', kind: 'code' },
          { key: 'facultyName', label: 'Lecturer' },
        ],
      },
      {
        kind: 'form',
        title: 'Add a cohort',
        submit: 'Add',
        path: '/sections',
        roles: [...REGISTRAR],
        fields: [
          { name: 'programId', label: 'Programme', kind: 'select', options: 'programOptions' },
          { name: 'label', label: 'Label', hint: 'e.g. a, b' },
          { name: 'admissionYear', label: 'Admission year', kind: 'number' },
        ],
      },
      {
        kind: 'form',
        title: 'Enrol a student',
        submit: 'Enrol',
        path: '/sections/members',
        roles: [...REGISTRAR],
        fields: [
          { name: 'sectionId', label: 'Cohort', kind: 'select', options: 'sectionOptions' },
          { name: 'userId', label: 'Student' },
        ],
      },
      {
        kind: 'form',
        title: 'Offer a course',
        note: 'An offering is what attendance, exams and marks all attach to.',
        submit: 'Offer',
        path: '/offerings',
        roles: [...REGISTRAR],
        fields: [
          { name: 'termId', label: 'Term', kind: 'select', options: 'termOptions' },
          { name: 'courseId', label: 'Course', kind: 'select', options: 'courseOptions' },
          { name: 'sectionId', label: 'Cohort', kind: 'select', options: 'sectionOptions' },
          { name: 'facultyUserId', label: 'Lecturer' },
        ],
      },
      {
        kind: 'form',
        title: 'Timetable a slot',
        note:
          'A room cannot host two overlapping slots and a lecturer cannot be in ' +
          'two places at once. Postgres refuses both, not this form.',
        submit: 'Add slot',
        path: '/slots',
        roles: [...REGISTRAR],
        fields: [
          { name: 'offeringId', label: 'Offering' },
          { name: 'roomId', label: 'Room', kind: 'select', options: 'roomOptions' },
          {
            name: 'dayOfWeek',
            label: 'Day',
            kind: 'select',
            options: DAYS.slice(1).map((d, i) => ({ value: String(i + 1), label: d })),
          },
          { name: 'startsAt', label: 'From', hint: 'HH:MM' },
          { name: 'endsAt', label: 'To', hint: 'HH:MM' },
        ],
      },
    ],
  },
]
