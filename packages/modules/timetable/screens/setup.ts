import type { PluginSection } from '@campusos/module-framework'
import { DAY_NAMES, OFFICE, READERS, TEACHERS, getSettings, listEligibility, listPeriods, listRooms, listSections, listTeachers, listUnavailable } from '../api'
import { choices, context, dayOptions, definePage, form, number, officeOf, queryOf, removeRows, select, table, termFilter } from './kit'

const limitFields = () => [number('maxPerDay', 'Maximum periods per day', true), number('maxPerWeek', 'Maximum periods per week', true), number('maxConsecutive', 'Maximum consecutive periods', true)]
const eligibilityColumns = [
  { key: 'teacher', label: 'Teacher' }, { key: 'course', label: 'Course' }, { key: 'department', label: 'Department' },
  { key: 'program', label: 'Programme' }, { key: 'yearOfStudy', label: 'Year' }, { key: 'preference', label: 'Preference' },
]

export const setupPages = [
  definePage({
    path: '/week', title: 'Periods', menu: 'Periods', roles: READERS,
    async load(actor, request) {
      const data = await context(actor, request)
      const periodTerm = data.query.week === 'standing' ? '' : data.termId
      const result = await listPeriods(actor, { termId: periodTerm })
      return { ...data, ...result, termId: periodTerm, periods: result.periods.map(period => ({ ...period, day: DAY_NAMES[period.dayOfWeek] })) }
    },
    sections: data => [
      termFilter('/week', data),
      { kind: 'links', links: [{ label: 'Standing week', href: '/m/timetable/week?week=standing', active: !data.termId }] },
      { kind: 'note', text: data.own ? 'This term has its own teaching week.' : 'Showing the standing week. To change the standing week for all terms, open Standing week; otherwise new periods belong to the selected term.' },
      table('Teaching periods', 'periods', [{ key: 'day', label: 'Day' }, { key: 'index', label: 'Period' }, { key: 'startsAt', label: 'Starts' }, { key: 'endsAt', label: 'Ends' }, { key: 'label', label: 'Label' }], { fixedOrder: true, pageSize: 100 }),
      form('Lay out days', '/periods/generate', [
        select('termId', 'Term (blank means standing week)', 'termOptions', true, data.termId),
        { name: 'days', label: 'Teaching days', kind: 'checkboxes', options: dayOptions, value: '1,2,3,4,5' },
        { name: 'startsAt', label: 'First start', value: '09:00', hint: 'HH:MM' }, number('minutes', 'Minutes per period', false, 60), number('count', 'Periods per day', false, 6),
        { name: 'breaks', label: 'Breaks', optional: true, hint: '2:10, 4:40 means ten minutes after period 2 and forty after period 4.' },
      ], { note: 'Replaces the periods on the selected days only.' }),
      form('Add period', '/periods', [select('termId', 'Term (blank means standing week)', 'termOptions', true, data.termId), select('dayOfWeek', 'Day', dayOptions), number('index', 'Period number'), { name: 'startsAt', label: 'Starts', hint: 'HH:MM' }, { name: 'endsAt', label: 'Ends', hint: 'HH:MM' }, { name: 'label', label: 'Label', optional: true }]),
      ...(data.office ? removeRows(data.periods, period => `${period.day} period ${period.index} (${period.startsAt})`, '/periods/delete', 'periodId', period => period.id) : []),
    ],
  }),
  definePage({
    path: '/rooms', title: 'Rooms', menu: 'Rooms', roles: OFFICE,
    async load(actor) {
      const rooms = await listRooms(actor)
      return { rooms, roomOptions: choices(rooms, room => room.id, room => `${room.code} · ${room.capacity ?? 'unlimited'} seats`) }
    },
    sections: () => [
      table('Rooms', 'rooms', [{ key: 'code', label: 'Room' }, { key: 'building', label: 'Building' }, { key: 'capacity', label: 'Seats' }, { key: 'kind', label: 'Kind' }, { key: 'available', label: 'Available', kind: 'bool' }]),
      form('Set room availability', '/rooms', [select('roomId', 'Room', 'roomOptions'), { name: 'kind', label: 'Kind', value: 'classroom', hint: 'Use the same kind as a class need: classroom, lab, hall or lab:chemistry.' }, { name: 'available', label: 'Available for timetabling', kind: 'checkbox', value: 'true' }]),
    ],
  }),
  definePage({
    path: '/cohorts', title: 'Cohorts and batches', menu: 'Cohorts', roles: OFFICE,
    async load(actor) {
      const cohorts = await listSections(actor)
      return { cohorts, cohortOptions: choices(cohorts, cohort => cohort.id, cohort => cohort.name) }
    },
    sections: () => [
      { kind: 'note', text: "A1 part of A means A's lectures never overlap A1's labs; A1 and A2 may run side by side." },
      table('Cohorts and batches', 'cohorts', [{ key: 'name', label: 'Cohort' }, { key: 'members', label: 'Members' }, { key: 'expectedSize', label: 'Expected' }, { key: 'size', label: 'Size used' }, { key: 'parent', label: 'Part of' }]),
      form('Set cohort plan', '/sections', [select('sectionId', 'Cohort', 'cohortOptions'), number('expectedSize', 'Expected size', true), select('parentSectionId', 'Part of cohort', 'cohortOptions', true)], { note: 'Leaving the size blank uses membership. Leaving the parent blank removes the batch relationship.' }),
    ],
  }),
  definePage({
    path: '/teachers', title: 'Teachers', menu: 'Teachers', roles: OFFICE,
    async load(actor) {
      const [teachers, settings, eligibility] = await Promise.all([listTeachers(actor), getSettings(actor), listEligibility(actor)])
      return { settings, eligibility, teacherOptions: choices(teachers, teacher => teacher.userId, teacher => teacher.name ?? teacher.email ?? teacher.userId), teachers: teachers.map(teacher => ({ ...teacher,
        dayLimit: `${teacher.effective.maxPerDay}${teacher.maxPerDay === null ? ' (default)' : ' (own)'}`,
        weekLimit: `${teacher.effective.maxPerWeek}${teacher.maxPerWeek === null ? ' (default)' : ' (own)'}`,
        consecutiveLimit: `${teacher.effective.maxConsecutive}${teacher.maxConsecutive === null ? ' (default)' : ' (own)'}`,
      })) }
    },
    sections: data => [
      table('Teachers', 'teachers', [{ key: 'name', label: 'Teacher' }, { key: 'role', label: 'Role' }, { key: 'dayLimit', label: 'Per day' }, { key: 'weekLimit', label: 'Per week' }, { key: 'consecutiveLimit', label: 'In a row' }, { key: 'eligibility', label: 'Eligibility rules' }]),
      table('Eligibility', 'eligibility', eligibilityColumns),
      form('Set teacher limits', '/teachers', [select('userId', 'Teacher', 'teacherOptions'), ...limitFields(), { name: 'note', label: 'Note', optional: true }], { note: 'Blank limits restore institution defaults. A weekly limit of zero takes the teacher out of new assignments.' }),
      form('Save defaults', '/settings', [
        number('maxPerDay', 'Periods per day', false, data.settings.maxPerDay), number('maxPerWeek', 'Periods per week', false, data.settings.maxPerWeek),
        number('maxConsecutive', 'Consecutive periods', false, data.settings.maxConsecutive), number('yearStartsMonth', 'Academic year starts in month (1–12)', false, data.settings.yearStartsMonth),
        number('timeLimitSeconds', 'Solver time limit in seconds (1–600)', false, data.settings.timeLimitSeconds),
      ]),
    ],
  }),
  definePage({
    path: '/eligibility', title: 'Who may teach what', menu: 'Eligibility', roles: [...READERS, 'faculty'],
    async load(actor, request) {
      const data = await context(actor, request)
      const eligibility = await listEligibility(actor, { userId: data.query.userId, courseId: data.query.courseId })
      const teachers = data.office ? await listTeachers(actor) : []
      return { ...data, eligibility, teacherOptions: choices(teachers, teacher => teacher.userId, teacher => teacher.name ?? teacher.email ?? teacher.userId),
        courseOptions: choices(data.structure.courses, course => course.id, course => `${course.code} · ${course.title}`),
        departmentOptions: choices(data.structure.departments, department => department.id, department => `${department.code} · ${department.name}`),
        programOptions: choices(data.structure.programs, program => program.id, program => `${program.code} · ${program.name}`),
      }
    },
    sections: data => [
      form('Filter eligibility', '/eligibility', [...(data.office ? [select('userId', 'Teacher', 'teacherOptions', true, data.query.userId)] : []), select('courseId', 'Course', 'courseOptions', true, data.query.courseId)], { method: 'GET', roles: undefined, submit: 'Filter' }),
      table('Who may teach what', 'eligibility', eligibilityColumns),
      ...(data.office ? [
        form('Add eligibility', '/eligibility', [select('userId', 'Teacher', 'teacherOptions'), select('courseId', 'Course', 'courseOptions', true), select('departmentId', 'Department', 'departmentOptions', true), select('programId', 'Programme', 'programOptions', true), number('yearOfStudy', 'Year of study (1–10)', true), { name: 'preference', label: 'Preference (5 is strongest)', kind: 'radio', value: '3', options: [1, 2, 3, 4, 5].map(value => ({ value: String(value), label: String(value) })) }], { note: 'Choose at least one course, department, programme or year. Conditions on the same rule apply together.' }),
        form('Import CSV', '/eligibility/import', [{ name: 'file', label: 'Eligibility CSV', kind: 'file', accept: '.csv' }], { note: 'Columns: email, course code, department code, programme code, year, preference. Header optional. Any invalid row prevents the whole import.' }),
        ...removeRows(data.eligibility, row => `${row.teacher ?? 'teacher'} · ${row.course ?? row.department ?? row.program ?? `year ${row.yearOfStudy}`}`, '/eligibility/delete', 'id', row => row.id),
      ] : []),
    ],
  }),
  definePage({
    path: '/unavailable', title: 'Unavailable', menu: 'Unavailable', roles: [...READERS, 'faculty'],
    async load(actor, request) {
      const office = officeOf(actor)
      const query = queryOf(request)
      const [unavailable, teachers, rooms, cohorts] = await Promise.all([
        listUnavailable(actor, { userId: office ? query.userId : actor.id }),
        office ? listTeachers(actor) : [], office ? listRooms(actor) : [], office ? listSections(actor) : [],
      ])
      return { office, actorId: actor.id, query, unavailable: unavailable.map(row => ({ ...row, who: row.teacher ?? row.room ?? row.section, day: DAY_NAMES[row.dayOfWeek], periodLabel: row.period ?? 'Whole day' })),
        teacherOptions: choices(teachers, teacher => teacher.userId, teacher => teacher.name ?? teacher.email ?? teacher.userId), roomOptions: choices(rooms, room => room.id, room => room.code), cohortOptions: choices(cohorts, cohort => cohort.id, cohort => cohort.name),
      }
    },
    sections: data => [
      ...(data.office ? [form('Filter teacher', '/unavailable', [select('userId', 'Teacher', 'teacherOptions', true, data.query.userId)], { method: 'GET', roles: undefined, submit: 'Filter' })] : []),
      table('Unavailable', 'unavailable', [{ key: 'who', label: 'Who or where' }, { key: 'day', label: 'Day' }, { key: 'periodLabel', label: 'Period' }, { key: 'reason', label: 'Reason' }]),
      form('Mark unavailable', '/unavailable', [
        ...(data.office ? [select('userId', 'Teacher', 'teacherOptions', true), select('roomId', 'Room', 'roomOptions', true), select('sectionId', 'Cohort', 'cohortOptions', true)] : []),
        select('dayOfWeek', 'Day', dayOptions), number('period', 'Period (blank means whole day)', true), { name: 'reason', label: 'Reason', optional: true },
      ], { roles: [...OFFICE, ...TEACHERS], note: data.office ? 'Choose exactly one teacher, room or cohort.' : 'This marks your own teaching availability.' }),
      ...removeRows(data.unavailable.filter(row => data.office || row.userId === data.actorId), row => `${row.who ?? 'my time'} · ${row.day} · ${row.periodLabel}`, '/unavailable/delete', 'id', row => row.id, [...OFFICE, ...TEACHERS]),
    ] as PluginSection[],
  }),
]
