import { DAY_NAMES, READERS, listNeeds, listPins, listRooms, listTeachers } from '../api'
import { choices, context, dayOptions, definePage, form, hidden, noTerm, number, removeRows, select, table, termFilter } from './kit'

export const classesPage = definePage({
  path: '/classes', title: 'Classes and needs', menu: 'Classes', roles: READERS,
  async load(actor, request) {
    const data = await context(actor, request)
    const [classes, pins, rooms, teachers] = await Promise.all([
      data.termId ? listNeeds(actor, { termId: data.termId }) : [],
      data.termId ? listPins(actor, { termId: data.termId }) : [],
      data.office ? listRooms(actor) : [], data.office ? listTeachers(actor) : [],
    ])
    return { ...data,
      classes: classes.map(row => ({ ...row, noCandidates: row.candidates === 0 })),
      needs: classes.flatMap(row => row.needs.map(need => ({ ...need, class: `${row.course} · ${row.section}` }))),
      pins: pins.map(pin => ({ ...pin, day: pin.dayOfWeek ? DAY_NAMES[pin.dayOfWeek] : '' })),
      classOptions: choices(classes, row => row.offeringId, row => `${row.course} · ${row.section}`),
      roomOptions: choices(rooms, room => room.id, room => `${room.code} · ${room.kind}`),
      teacherOptions: choices(teachers, teacher => teacher.userId, teacher => teacher.name ?? teacher.email ?? teacher.userId),
    }
  },
  sections: data => [
    termFilter('/classes', data),
    ...(!data.termId ? [noTerm] : [
      table('Classes and weekly needs', 'classes', [
        { key: 'course', label: 'Course' }, { key: 'section', label: 'Cohort' }, { key: 'yearOfStudy', label: 'Year' }, { key: 'size', label: 'Size' },
        { key: 'teacher', label: 'Teacher' }, { key: 'candidates', label: 'Candidates', alertWhen: 'noCandidates' }, { key: 'summary', label: 'Needs' }, { key: 'periodsPerWeek', label: 'Periods / week' },
      ]),
      form('Set need', '/needs', [
        select('offeringId', 'Class', 'classOptions'), { name: 'kind', label: 'Kind', value: 'lecture' }, number('periodsPerWeek', 'Periods per week'), number('blockLength', 'Periods per block', false, 1),
        { name: 'roomKind', label: 'Room kind', value: 'classroom', optional: true }, select('roomId', 'Fixed room', 'roomOptions', true),
      ], { note: 'Periods per week must divide into whole blocks. A lab with six periods in two-period blocks meets three times.' }),
      form('Needs from credits', '/needs/defaults', [hidden('termId', data.termId), number('periodsPerCredit', 'Periods per credit', false, 1), { name: 'kind', label: 'Kind', value: 'lecture' }, { name: 'roomKind', label: 'Room kind', value: 'classroom' }], { note: 'Only classes without a need are given one.' }),
      ...(data.office ? removeRows(data.needs, need => `${need.class} · ${need.kind} need`, '/needs/delete', 'needId', need => need.id) : []),
      table('Pins', 'pins', [{ key: 'course', label: 'Course' }, { key: 'section', label: 'Cohort' }, { key: 'needKind', label: 'Kind' }, { key: 'teacher', label: 'Teacher' }, { key: 'day', label: 'Day' }, { key: 'period', label: 'Period' }, { key: 'room', label: 'Room' }, { key: 'note', label: 'Note' }]),
      form('Pin assignment', '/pins', [select('offeringId', 'Class', 'classOptions'), select('facultyUserId', 'Teacher', 'teacherOptions', true), select('dayOfWeek', 'Day', dayOptions, true), number('period', 'Starting period', true), { name: 'needKind', label: 'Need kind', optional: true, hint: 'For a pinned time, name an existing need such as lecture or lab.' }, select('roomId', 'Room', 'roomOptions', true), { name: 'note', label: 'Note', optional: true }], { note: 'Pin a teacher, a time, or both. A time needs both day and period. A room can only be pinned with a time.' }),
      ...(data.office ? removeRows(data.pins, pin => `${pin.course} · ${pin.section} pin`, '/pins/delete', 'pinId', pin => pin.id) : []),
    ]),
  ],
})
