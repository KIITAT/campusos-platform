import type { PluginSection } from '@campusos/module-framework'
import { READERS, TEACHERS, TimetableError, checkTerm, listRuns, liveGrid, myTimetable, runDetail, runGrid, workload } from '../api'
import { API, ROOT, choices, context, definePage, form, gridSections, hidden, noTerm, number, officeOf, queryOf, select, table, termFilter, termHref, workloadRows, workloadSections } from './kit'

const draftForm = (termId: string) => form('Draft a timetable', '/runs', [
  hidden('termId', termId), number('seed', 'Seed', true), number('iterations', 'Iterations (up to 300000)', true),
  { name: 'keepTeachers', label: 'Keep existing teachers', kind: 'checkbox', value: 'true' },
  { name: 'keepLive', label: 'Keep live meetings', kind: 'checkbox' },
], { note: 'Runs locally on this server. Review the draft before applying it. Unplaced meetings are reported with a reason.' })

const runTable = () => table('Timetable drafts', 'runs', [
  { key: 'createdAt', label: 'Created', kind: 'when', href: `${ROOT}/run?id={id}` }, { key: 'createdBy', label: 'By' }, { key: 'status', label: 'Status', kind: 'status' },
  { key: 'placedLabel', label: 'Placed / blocks' }, { key: 'unplacedBlocks', label: 'Unplaced', alertWhen: 'unplacedBlocks' }, { key: 'issues', label: 'Issues', alertWhen: 'issues' },
  { key: 'score', label: 'Score' }, { key: 'seconds', label: 'Seconds' },
], { fixedOrder: true })

type GridIndex = Awaited<ReturnType<typeof runGrid>>['index']
function lensLinks(index: GridIndex, path: string, parameters: Record<string, string>, query: Record<string, string>): PluginSection[] {
  const groups = [
    { title: 'Cohorts', key: 'sectionId', rows: index.sections },
    { title: 'Teachers', key: 'teacherId', rows: index.teachers },
    { title: 'Rooms', key: 'roomId', rows: index.rooms },
  ]
  return groups.filter(group => group.rows.length > 0).map(group => ({
    kind: 'links', title: group.title, links: group.rows.map(row => ({
      label: `${row.name} · ${row.meetings} meetings · ${row.hours}h`,
      href: `${ROOT}${path}?${new URLSearchParams({ ...parameters, [group.key]: row.id })}`, active: query[group.key] === row.id,
    })),
  }))
}

function printLinks(path: string, parameters: Record<string, string>, query: Record<string, string>, all: boolean): PluginSection {
  const lensKey = ['sectionId', 'teacherId', 'roomId'].find(key => query[key])
  return { kind: 'links', title: 'Print', links: [
    ...(lensKey ? [{ label: 'This timetable (PDF)', href: `${API}${path}?${new URLSearchParams({ ...parameters, [lensKey]: query[lensKey]! })}` }] : []),
    ...(all ? ['sections', 'teachers', 'rooms'].map(group => ({ label: `All ${group} (PDF)`, href: `${API}${path}?${new URLSearchParams({ ...parameters, all: group })}` })) : []),
  ] }
}

export const timetablePages = [
  definePage({
    path: '/', title: 'Timetable', menu: 'Overview', roles: READERS,
    async load(actor, request) {
      const data = await context(actor, request)
      const [check, runs] = data.termId ? await Promise.all([checkTerm(actor, { termId: data.termId }), listRuns(actor, { termId: data.termId })]) : [null, []]
      return { ...data, check, runs: runs.map(run => ({ ...run, placedLabel: `${run.placed} / ${run.blocks}` })) }
    },
    sections: data => [
      termFilter('/', data),
      { kind: 'shortcuts', title: 'Build the teaching week', items: [
        { label: 'Periods', href: termHref('/week', data.termId), description: 'Days, teaching periods and breaks' },
        ...(data.office ? [
          { label: 'Rooms', href: `${ROOT}/rooms`, description: 'Room kinds, capacity and availability' },
          { label: 'Cohorts and batches', href: `${ROOT}/cohorts`, description: 'Class sizes and shared students' },
          { label: 'Teachers', href: `${ROOT}/teachers`, description: 'Teaching limits and defaults' },
        ] : []),
        { label: 'Eligibility', href: `${ROOT}/eligibility`, description: 'Who may teach which classes' },
        { label: 'Unavailable', href: `${ROOT}/unavailable`, description: 'Times that cannot be booked' },
        { label: 'Classes and needs', href: termHref('/classes', data.termId), description: 'Weekly needs and pinned assignments' },
        { label: 'Drafts', href: termHref('/runs', data.termId), description: 'Review before applying' },
        { label: 'Live timetable', href: termHref('/live', data.termId), description: 'Cohort, teacher and room timetables' },
      ] },
      ...(data.check ? [
        { kind: 'figures' as const, figures: [
          { label: 'Periods per week', value: String(data.check.periodsPerWeek) },
          { label: 'Classes with needs', value: `${data.check.classesWithNeeds} / ${data.check.classes}` },
          { label: 'Teaching asked for', value: String(data.check.teachingAsked) },
          { label: 'Teaching capacity', value: String(data.check.teachingCapacity) },
        ] },
        ...data.check.problems.map(problem => ({ kind: 'note' as const, tone: problem.level === 'stop' ? 'danger' as const : 'warn' as const, text: problem.text })),
        draftForm(data.termId), runTable(),
      ] : [noTerm]),
      { kind: 'note', text: 'Hard constraints are never forced: room capacity, availability, teacher and cohort clashes, and pinned assignments are respected. Preferences and balanced workloads guide the remaining choices.' },
    ],
  }),
  definePage({
    path: '/runs', title: 'Drafts', menu: 'Drafts', roles: READERS,
    async load(actor, request) {
      const data = await context(actor, request)
      const runs = data.termId ? await listRuns(actor, { termId: data.termId }) : []
      return { ...data, runs: runs.map(run => ({ ...run, placedLabel: `${run.placed} / ${run.blocks}` })) }
    },
    sections: data => [termFilter('/runs', data), ...(data.termId ? [runTable(), draftForm(data.termId)] : [noTerm])],
  }),
  definePage({
    path: '/run', title: 'Draft timetable', roles: READERS,
    async load(actor, request) {
      const query = queryOf(request)
      if (!query.id) throw new TimetableError(400, 'run_required', 'Choose a draft from Timetable → Drafts.')
      const [detail, view, load] = await Promise.all([runDetail(actor, { runId: query.id }), runGrid(actor, { runId: query.id, sectionId: query.sectionId, teacherId: query.teacherId, roomId: query.roomId }), workload(actor, { runId: query.id })])
      return { ...detail, ...view, office: officeOf(actor), query, gridRows: view.grid?.rows ?? [], workload: workloadRows(load.rows), unstaffed: load.unstaffed,
        meetingOptions: choices(view.grid?.meetings ?? [], meeting => meeting.entryId, meeting => `${meeting.course} · ${meeting.section} · day ${meeting.dayOfWeek} ${meeting.startsAt} · ${meeting.room}`),
      }
    },
    record: data => ({ title: `Draft timetable, ${data.term.name}`, status: { label: data.run.status, tone: data.run.status === 'applied' ? 'green' : 'gray' }, createdAt: data.run.createdAt.toISOString(), fields: [
      { label: 'Seed', value: data.run.seed }, { label: 'Placed / blocks', value: `${data.run.stats.placed ?? 0} / ${data.run.stats.blocks ?? 0}` },
      { label: 'Seconds', value: Math.round(Number(data.run.stats.ms ?? 0) / 100) / 10 }, { label: 'Cost', value: data.run.cost.total ?? 0 },
    ] }),
    sections: data => [
      { kind: 'links', links: [{ label: 'All drafts', href: termHref('/runs', data.run.termId) }, { label: 'Live timetable', href: termHref('/live', data.run.termId) }] },
      ...data.unplaced.map(row => ({ kind: 'note' as const, tone: 'danger' as const, text: `${row.class} — ${row.count} block(s): ${row.reason}` })),
      ...data.issues.map(row => ({ kind: 'note' as const, tone: 'warn' as const, text: `${row.class}: ${row.message}` })),
      table('Teacher changes on apply', 'teacherChanges', [{ key: 'class', label: 'Class' }, { key: 'from', label: 'From' }, { key: 'to', label: 'To' }], { empty: 'No teacher changes.' }),
      ...lensLinks(data.index, '/run', { id: data.run.id }, data.query), ...gridSections(data.grid),
      ...(data.grid?.meetings.length ? [form('Keep this meeting', '/runs/pin', [select('entryId', 'Meeting', 'meetingOptions'), select('keep', 'Keep', [{ value: 'time', label: 'Time and room' }, { value: 'teacher', label: 'Teacher' }, { value: 'both', label: 'Time, room and teacher' }], false, 'time')], { note: 'Creates a pin for the next run.' })] : []),
      ...workloadSections(data.unstaffed),
      ...(data.run.status === 'draft' ? [
        form('Apply timetable', '/runs/apply', [hidden('runId', data.run.id)], { placement: 'inline', note: 'Makes this draft live and replaces its classes’ slots and teacher assignments. Review every unplaced block and teacher change first.' }),
        form('Discard draft', '/runs/discard', [hidden('runId', data.run.id)], { placement: 'inline' }),
      ] : []),
      printLinks('/runs/pdf', { runId: data.run.id }, data.query, true),
    ],
  }),
  definePage({
    path: '/live', title: 'Live timetable', menu: 'Live timetable', roles: [...READERS, 'faculty'],
    async load(actor, request) {
      const data = await context(actor, request)
      if (!data.termId) return { ...data, grid: null, gridRows: [], index: { sections: [], teachers: [], rooms: [] }, workload: [], unstaffed: 0 }
      const view = await liveGrid(actor, { termId: data.termId, sectionId: data.query.sectionId, teacherId: data.query.teacherId, roomId: data.query.roomId })
      const load = data.faculty ? { rows: [], unstaffed: 0 } : await workload(actor, { termId: data.termId })
      return { ...data, grid: view.grid, gridRows: view.grid?.rows ?? [], index: data.faculty ? { sections: [], teachers: [], rooms: [] } : view.index, workload: workloadRows(load.rows), unstaffed: load.unstaffed }
    },
    sections: data => [
      termFilter('/live', data),
      ...(!data.termId ? [noTerm] : [
        ...(!data.faculty ? lensLinks(data.index, '/live', { termId: data.termId }, data.query) : []), ...gridSections(data.grid),
        ...(!data.faculty ? workloadSections(data.unstaffed) : []),
        printLinks('/live/pdf', { termId: data.termId }, data.faculty ? { teacherId: data.actorId } : data.query, !data.faculty),
      ]),
    ],
  }),
  definePage({
    path: '/my', title: 'My timetable', menu: 'My timetable', roles: TEACHERS,
    async load(actor, request) {
      const data = await context(actor, request)
      if (!data.structure.terms.some(term => term.isCurrent)) return { grid: null, gridRows: [], noCurrentTerm: true }
      const view = await myTimetable(actor)
      return { grid: view.grid, gridRows: view.grid?.rows ?? [], noCurrentTerm: false }
    },
    sections: data => [
      ...(data.noCurrentTerm ? [{ kind: 'note' as const, tone: 'warn' as const, text: 'There is no current term yet. The academic office needs to mark one current.' }] : gridSections(data.grid)),
      { kind: 'links', links: [
        ...(!data.noCurrentTerm ? [{ label: 'Print my timetable (PDF)', href: `${API}/my/pdf` }] : []),
        { label: 'Mark unavailable', href: `${ROOT}/unavailable` }, { label: 'My eligibility', href: `${ROOT}/eligibility` },
      ] },
    ],
  }),
]
