import type { PluginPage } from '@campusos/module-framework'
import {
  degreeAudit,
  getTimetable,
  listCompletions,
  listCurricula,
  listOfferings,
  listPrerequisites,
  listSections,
  listStructure,
  listStudentPrograms,
  listWaivers,
  type Actor,
} from './api'

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
          {
            name: 'kind',
            label: 'Kind',
            kind: 'select',
            options: [
              { value: 'regular', label: 'regular' },
              { value: 'summer', label: 'summer' },
              { value: 'winter', label: 'winter' },
            ],
          },
          { name: 'startsOn', label: 'From', kind: 'date' },
          { name: 'endsOn', label: 'To', kind: 'date' },
        ],
      },
      {
        kind: 'form',
        title: "Set a term's calendar",
        note:
          'Registration and drop dates, which is what enrollment and any refund ' +
          'are keyed to. A window left empty is closed, not open.',
        submit: 'Set dates',
        path: '/terms/calendar',
        roles: [...REGISTRAR],
        fields: [
          { name: 'termId', label: 'Term', kind: 'select', options: 'termOptions' },
          { name: 'registrationOpensOn', label: 'Registration opens', kind: 'date', optional: true },
          { name: 'registrationClosesOn', label: 'Registration closes', kind: 'date', optional: true },
          { name: 'addDropEndsOn', label: 'Add/drop ends', kind: 'date', optional: true },
          { name: 'withdrawEndsOn', label: 'Withdrawal ends', kind: 'date', optional: true },
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

  {
    path: '/curriculum',
    title: 'Curriculum',
    menu: 'Curriculum',
    roles: [...REGISTRAR, 'hod'],
    async load(actor) {
      const a = actor as Actor
      const registrar = a.role === 'institution_admin' || a.role === 'super_admin'
      const [structure, curricula, chains, waivers] = await Promise.all([
        listStructure(a),
        listCurricula(a),
        listPrerequisites(a),
        registrar ? listWaivers(a) : Promise.resolve([]),
      ])

      return {
        curricula: curricula.map((c) => ({
          ...c,
          programme: `${c.programCode} - ${c.programName}`,
          requirementCount: c.requirements.length,
        })),
        requirements: curricula.flatMap((c) =>
          c.requirements.map((r) => ({
            ...r,
            curriculum: `${c.programCode} ${c.catalogYear}`,
            asks: r.minCredits > 0 ? `${r.minCredits} credits` : `${r.minCourses} courses`,
          })),
        ),
        chains: chains.map((p) => ({
          ...p,
          needs: p.minGradePoints ? `${p.requiresCode} at ${p.minGradePoints}+` : p.requiresCode,
        })),
        waivers: waivers.map((w) => ({
          ...w,
          scope: w.requiresCode ?? 'every prerequisite',
        })),
        programOptions: structure.programs.map((p) => ({
          value: p.id,
          label: `${p.code} - ${p.name}`,
        })),
        courseOptions: structure.courses.map((c) => ({
          value: c.id,
          label: `${c.code} - ${c.title}`,
        })),
        curriculumOptions: curricula.map((c) => ({
          value: c.id,
          label: `${c.programCode} ${c.catalogYear}`,
        })),
      }
    },
    sections: () => [
      {
        kind: 'note',
        text: 'A curriculum belongs to a catalogue year, and a student is held to the one in force when they declared. Editing next year’s rules therefore never moves the goalposts for this year’s students.',
      },
      {
        kind: 'table',
        title: 'Curricula',
        rows: 'curricula',
        empty: 'None yet.',
        columns: [
          { key: 'programme', label: 'Programme' },
          { key: 'catalogYear', label: 'Catalogue' },
          { key: 'totalCredits', label: 'Credits' },
          { key: 'requirementCount', label: 'Requirements' },
          { key: 'isActive', label: 'Active', kind: 'bool' },
        ],
      },
      {
        kind: 'table',
        title: 'Requirements',
        rows: 'requirements',
        empty: 'None yet.',
        columns: [
          { key: 'curriculum', label: 'Curriculum' },
          { key: 'code', label: 'Code', kind: 'code' },
          { key: 'title', label: 'Title' },
          { key: 'kind', label: 'Kind' },
          { key: 'asks', label: 'Asks for' },
        ],
      },
      {
        kind: 'table',
        title: 'Prerequisites',
        note: 'The chain cannot close a loop; the database refuses the edge that would.',
        rows: 'chains',
        empty: 'No course requires another yet.',
        columns: [
          { key: 'courseCode', label: 'Course', kind: 'code' },
          { key: 'kind', label: 'Kind' },
          { key: 'needs', label: 'Needs' },
          { key: 'requiresTitle', label: 'Which is' },
        ],
      },
      {
        kind: 'table',
        title: 'Overrides on file',
        note: 'Who was let in, to what, and why.',
        rows: 'waivers',
        empty: 'None. Every student met the chain as written.',
        columns: [
          { key: 'studentName', label: 'Student' },
          { key: 'courseCode', label: 'For', kind: 'code' },
          { key: 'scope', label: 'Waived' },
          { key: 'reason', label: 'Reason' },
          { key: 'createdAt', label: 'When', kind: 'date' },
        ],
      },
      {
        kind: 'form',
        title: 'Add a curriculum',
        submit: 'Add',
        path: '/curricula',
        roles: [...REGISTRAR],
        fields: [
          { name: 'programId', label: 'Programme', kind: 'select', options: 'programOptions' },
          { name: 'catalogYear', label: 'Catalogue year', kind: 'number' },
          { name: 'totalCredits', label: 'Credits for the award', kind: 'number' },
        ],
      },
      {
        kind: 'form',
        title: 'Add a requirement',
        note: 'An open requirement takes any course that counts, so it needs no course named.',
        submit: 'Add',
        path: '/requirements',
        roles: [...REGISTRAR],
        fields: [
          {
            name: 'curriculumId',
            label: 'Curriculum',
            kind: 'select',
            options: 'curriculumOptions',
          },
          { name: 'code', label: 'Code' },
          { name: 'title', label: 'Title' },
          {
            name: 'kind',
            label: 'Kind',
            kind: 'select',
            options: [
              { value: 'core', label: 'core - all of these' },
              { value: 'elective', label: 'elective - enough of these' },
              { value: 'open', label: 'open - anything that counts' },
            ],
          },
          { name: 'minCredits', label: 'Credits', kind: 'number', optional: true },
          { name: 'minCourses', label: 'Courses', kind: 'number', optional: true },
          {
            name: 'courseIds',
            label: 'Course',
            kind: 'select',
            options: 'courseOptions',
            optional: true,
            hint: 'One at a time; add the requirement again to widen the pool.',
          },
        ],
      },
      {
        kind: 'form',
        title: 'Require one course before another',
        submit: 'Add',
        path: '/prerequisites',
        roles: [...REGISTRAR],
        fields: [
          { name: 'courseId', label: 'Course', kind: 'select', options: 'courseOptions' },
          {
            name: 'requiresCourseId',
            label: 'Requires',
            kind: 'select',
            options: 'courseOptions',
          },
          {
            name: 'kind',
            label: 'Kind',
            kind: 'select',
            options: [
              { value: 'prerequisite', label: 'prerequisite - before' },
              { value: 'corequisite', label: 'corequisite - before or alongside' },
            ],
          },
          {
            name: 'minGradePoints',
            label: 'Minimum grade points',
            kind: 'number',
            optional: true,
            hint: 'Leave empty when a pass is enough.',
          },
        ],
      },
      {
        kind: 'form',
        title: 'Two courses, one course',
        note: 'Cross-listing and transfer equivalence are the same statement, and it reads in both directions.',
        submit: 'Record',
        path: '/equivalences',
        roles: [...REGISTRAR],
        fields: [
          { name: 'courseId', label: 'Course', kind: 'select', options: 'courseOptions' },
          {
            name: 'equivalentCourseId',
            label: 'Is the same as',
            kind: 'select',
            options: 'courseOptions',
          },
          { name: 'note', label: 'Note', optional: true },
        ],
      },
      {
        kind: 'form',
        title: 'Excuse a student from a prerequisite',
        note: 'Leave the prerequisite empty to waive all of them. The reason is on the record.',
        submit: 'Waive',
        path: '/prerequisites/waivers',
        roles: [...REGISTRAR],
        fields: [
          { name: 'studentId', label: 'Student id' },
          { name: 'courseId', label: 'For course', kind: 'select', options: 'courseOptions' },
          {
            name: 'requiresCourseId',
            label: 'Prerequisite',
            kind: 'select',
            options: 'courseOptions',
            optional: true,
          },
          { name: 'reason', label: 'Reason', kind: 'textarea', rows: 2 },
        ],
      },
    ],
  },

  {
    path: '/record',
    title: 'Record',
    menu: 'Record',
    roles: [...EVERYONE],
    async load(actor, req) {
      const a = actor as Actor
      const asked = new URL(req.url).searchParams.get('studentId')
      const registrar = a.role === 'institution_admin' || a.role === 'super_admin'
      const studentId = registrar || a.role === 'hod' || a.role === 'faculty' ? (asked ?? a.id) : a.id

      const [programmes, completions, structure, curricula] = await Promise.all([
        listStudentPrograms(a, { studentId }),
        listCompletions(a, { studentId }),
        registrar ? listStructure(a) : Promise.resolve(null),
        registrar ? listCurricula(a) : Promise.resolve([]),
      ])

      // Null when nothing has been declared, or when the declaration named no
      // catalogue: there is then nothing to audit against, and saying so beats
      // an audit of zero requirements that reads like a finished degree.
      const outstanding = programmes.some((p) => p.status === 'active')
        ? await degreeAudit(a, { studentId }).catch(() => null)
        : null

      const passed = completions.filter((c) => c.passed)
      return {
        studentId,
        mine: studentId === a.id,
        cgpa: outstanding?.cgpa === null || outstanding === null ? '--' : String(outstanding.cgpa),
        creditsRemaining:
          outstanding?.creditsRemaining === null || outstanding === null
            ? '--'
            : String(outstanding.creditsRemaining),
        degreeNote:
          outstanding === null
            ? null
            : outstanding.note
              ? outstanding.note
              : outstanding.complete
                ? `Every requirement of ${outstanding.programCode} is satisfied.`
                : `Reading ${outstanding.programCode} against the ${String(outstanding.catalogYear ?? '')} catalogue.`,
        requirements: (outstanding?.requirements ?? []).map((r) => ({
          ...r,
          asks: r.minCredits > 0 ? `${r.minCredits} credits` : `${r.minCourses} courses`,
          has: r.minCredits > 0 ? String(r.creditsEarned) : String(r.coursesPassed),
          short: r.outstanding.map((o) => o.courseCode).join(', '),
        })),
        overrides: outstanding?.overrides ?? [],
        programmes: programmes.map((p) => ({
          ...p,
          programme: `${p.programCode} - ${p.programName}`,
          lead: p.isPrimary ? 'yes' : '',
        })),
        completions: completions.map((c) => ({
          ...c,
          grade: c.gradeLabel ?? (c.gradePoints ? String(c.gradePoints) : ''),
          where: c.source === 'transfer' ? 'transferred' : 'here',
        })),
        creditsEarned: String(passed.reduce((n, c) => n + c.credits, 0)),
        coursesPassed: String(passed.length),
        transferred: String(passed.filter((c) => c.source === 'transfer').length),
        programOptions: (structure?.programs ?? []).map((p) => ({
          value: p.id,
          label: `${p.code} - ${p.name}`,
        })),
        courseOptions: (structure?.courses ?? []).map((c) => ({
          value: c.id,
          label: `${c.code} - ${c.title}`,
        })),
        termOptions: (structure?.terms ?? []).map((t) => ({
          value: t.id,
          label: `${t.code} - ${t.name}`,
        })),
        curriculumOptions: curricula.map((c) => ({
          value: c.id,
          label: `${c.programCode} ${c.catalogYear}`,
        })),
      }
    },
    sections: (data) => [
      {
        kind: 'note',
        text: data.mine
          ? 'What you are reading for, and what you have passed. Transfer credit sits here too, which is why the prerequisite check finds it.'
          : 'A student can read for more than one degree at once; the one marked as leading is the one a transcript opens with.',
      },
      {
        kind: 'figures',
        figures: [
          { label: 'Credits earned', value: String(data.creditsEarned) },
          { label: 'Still to earn', value: String(data.creditsRemaining) },
          { label: 'Cumulative average', value: String(data.cgpa) },
          { label: 'Courses passed', value: String(data.coursesPassed) },
          { label: 'Transferred in', value: String(data.transferred) },
        ],
      },
      ...(data.degreeNote
        ? [{ kind: 'note' as const, text: String(data.degreeNote) }]
        : []),
      {
        kind: 'table',
        title: 'Degree requirements',
        note: 'Each passed course is spent once: named requirements are filled before pools, and pools before anything that counts.',
        rows: 'requirements',
        empty: 'Nothing to audit against yet.',
        columns: [
          { key: 'code', label: 'Code', kind: 'code' },
          { key: 'title', label: 'Requirement' },
          { key: 'asks', label: 'Asks for' },
          { key: 'has', label: 'Has' },
          { key: 'satisfied', label: 'Met', kind: 'bool' },
          { key: 'short', label: 'Still needed' },
        ],
      },
      {
        kind: 'table',
        title: 'Exceptions on the way here',
        rows: 'overrides',
        empty: 'None. Every course was taken on the chain as written.',
        columns: [
          { key: 'courseCode', label: 'Course', kind: 'code' },
          { key: 'reason', label: 'Reason' },
        ],
      },
      {
        kind: 'table',
        title: 'Programmes',
        rows: 'programmes',
        empty: 'Nothing declared.',
        columns: [
          { key: 'programme', label: 'Programme' },
          { key: 'status', label: 'Status', kind: 'status' },
          { key: 'lead', label: 'Leads' },
          { key: 'declaredOn', label: 'Declared', kind: 'date' },
          { key: 'endedOn', label: 'Ended', kind: 'date' },
        ],
      },
      {
        kind: 'table',
        title: 'Courses completed',
        rows: 'completions',
        empty: 'Nothing on the record yet.',
        columns: [
          { key: 'courseCode', label: 'Course', kind: 'code' },
          { key: 'courseTitle', label: 'Title' },
          { key: 'credits', label: 'Credits' },
          { key: 'grade', label: 'Grade' },
          { key: 'passed', label: 'Passed', kind: 'bool' },
          { key: 'where', label: 'Earned' },
        ],
      },
      {
        kind: 'form',
        title: 'Declare a programme',
        submit: 'Declare',
        path: '/students/programs',
        roles: [...REGISTRAR],
        fields: [
          { name: 'studentId', label: 'Student id', value: String(data.studentId) },
          { name: 'programId', label: 'Programme', kind: 'select', options: 'programOptions' },
          {
            name: 'curriculumId',
            label: 'Catalogue',
            kind: 'select',
            options: 'curriculumOptions',
            optional: true,
          },
          { name: 'isPrimary', label: 'This one leads', kind: 'checkbox', optional: true },
        ],
      },
      {
        kind: 'form',
        title: 'Record a completed course',
        note: 'Leave the term empty for transfer credit, and say where it came from in the note.',
        submit: 'Record',
        path: '/completions',
        roles: [...REGISTRAR],
        fields: [
          { name: 'studentId', label: 'Student id', value: String(data.studentId) },
          { name: 'courseId', label: 'Course', kind: 'select', options: 'courseOptions' },
          {
            name: 'termId',
            label: 'Term',
            kind: 'select',
            options: 'termOptions',
            optional: true,
          },
          {
            name: 'source',
            label: 'Earned',
            kind: 'select',
            options: [
              { value: 'internal', label: 'here' },
              { value: 'transfer', label: 'transferred in' },
            ],
          },
          { name: 'credits', label: 'Credits', kind: 'number', optional: true },
          { name: 'gradePoints', label: 'Grade points', kind: 'number', optional: true },
          { name: 'gradeLabel', label: 'Grade', optional: true },
          { name: 'note', label: 'Note', optional: true },
        ],
      },
    ],
  },
]
