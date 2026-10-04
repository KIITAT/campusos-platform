import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pagesFor, type PluginForm } from '@campusos/module-framework'
import { pages } from './pages'
import { manifest } from './manifest'
import { specs } from './routes'

const fixtures = {
  office: true, actorId: 'teacher-1', termId: 'term-1', termOptions: [],
  query: {}, periods: [], own: false, rooms: [], cohorts: [], teachers: [],
  eligibility: [], unavailable: [], classes: [], needs: [], pins: [], runs: [],
  settings: { maxPerDay: 6, maxPerWeek: 24, maxConsecutive: 3, yearStartsMonth: 7, timeLimitSeconds: 20 },
  check: { periodsPerWeek: 30, classesWithNeeds: 2, classes: 3, teachingAsked: 8, teachingCapacity: 24, problems: [] },
  run: { id: 'run-1', termId: 'term-1', status: 'draft', seed: 42, stats: { placed: 3, blocks: 4, ms: 1200 }, cost: { total: 7 }, createdAt: new Date('2026-10-05T09:00:00Z') },
  term: { id: 'term-1', name: 'Autumn' }, unplaced: [], issues: [], teacherChanges: [],
  index: { sections: [{ id: 'section-1', name: 'CS & Design', meetings: 1, hours: 1 }], teachers: [], rooms: [] },
  grid: { title: 'CS & Design', subtitle: 'Autumn', days: [{ day: 1, label: 'Mon' }, { day: 7, label: 'Sun' }], rows: [{ period: '1', time: '09:00–10:00', d1: 'CS201 · Dr Rao · R101', d7: '' }], meetings: [{ entryId: 'meeting-1', course: 'CS201', section: 'A', dayOfWeek: 1, startsAt: '09:00', endsAt: '10:00', teacher: 'Dr Rao', room: 'R101' }] },
  workload: [], unstaffed: 0,
}

const page = (path: string) => {
  const found = pages.find(candidate => candidate.path === path)
  assert.ok(found, `missing page ${path}`)
  return found
}

test('all twelve timetable screens are reachable through role-appropriate navigation', () => {
  assert.deepEqual(pages.map(candidate => candidate.path).sort(), ['/', '/week', '/rooms', '/cohorts', '/teachers', '/eligibility', '/unavailable', '/classes', '/runs', '/run', '/live', '/my'].sort())
  assert.equal(pagesFor(pages, 'student').length, 0)
  assert.deepEqual(pagesFor(pages, 'faculty').map(candidate => candidate.path).sort(), ['/eligibility', '/live', '/my', '/unavailable'])
  assert.ok(manifest.navEntries.some(entry => entry.href === '/m/timetable/my' && entry.roles.includes('faculty')))
  assert.ok(manifest.navEntries.some(entry => entry.href === '/m/timetable' && entry.roles.includes('institution_admin')))
})

test('every declared mutation posts to an existing timetable route and preserves office roles', () => {
  const forms = pages.flatMap(candidate => candidate.sections(fixtures)).filter((section): section is PluginForm => section.kind === 'form' && section.method !== 'GET')
  assert.ok(forms.length >= 17)
  for (const form of forms) {
    assert.ok(specs.some(route => route.path === form.path && route.method === (form.method ?? 'POST')), form.path)
    if (!form.path.startsWith('/unavailable')) assert.deepEqual(form.roles?.slice().sort(), ['institution_admin', 'super_admin'])
  }
  for (const path of ['/periods/generate', '/periods', '/rooms', '/sections', '/teachers', '/settings', '/eligibility', '/eligibility/import', '/unavailable', '/needs', '/needs/defaults', '/pins', '/runs', '/runs/apply', '/runs/discard', '/runs/pin']) {
    assert.ok(forms.some(form => form.path === path), `missing form ${path}`)
  }
})

test('draft actions disappear after apply and grid columns follow actual teaching days', () => {
  const draft = page('/run').sections(fixtures)
  const applied = page('/run').sections({ ...fixtures, run: { ...fixtures.run, status: 'applied' } })
  assert.ok(draft.some(section => section.kind === 'form' && section.path === '/runs/apply'))
  assert.ok(!applied.some(section => section.kind === 'form' && ['/runs/apply', '/runs/discard'].includes(section.path)))
  const grid = draft.find(section => section.kind === 'table' && section.rows === 'gridRows')
  assert.ok(grid?.kind === 'table')
  assert.equal(grid.fixedOrder, true)
  assert.deepEqual(grid.columns.map(column => column.key), ['period', 'time', 'd1', 'd7'])
  const print = draft.filter(section => section.kind === 'links').flatMap(section => section.links)
  assert.ok(print.some(link => link.href === '/api/v1/modules/timetable/runs/pdf?runId=run-1&all=sections'))
})

test('faculty screens do not offer other teachers, global workload, or eligibility mutations', () => {
  const own = { ...fixtures, office: false, faculty: true }
  assert.ok(!page('/eligibility').sections(own).some(section => section.kind === 'form' && section.method !== 'GET'))
  const unavailable = page('/unavailable').sections(own).find(section => section.kind === 'form' && section.path === '/unavailable')
  assert.ok(unavailable?.kind === 'form')
  assert.ok(!unavailable.fields.some(field => ['userId', 'roomId', 'sectionId'].includes(field.name)))
  const live = page('/live').sections(own)
  assert.ok(!live.some(section => section.kind === 'table' && section.rows === 'workload'))
  assert.ok(!live.some(section => section.kind === 'links' && section.links.some(link => link.href.includes('all='))))
})

test('missing terms and unselected grids have clear empty states without unusable run actions', () => {
  const sections = page('/').sections({ ...fixtures, termId: '', check: null })
  assert.ok(sections.some(section => section.kind === 'note' && /term/i.test(section.text)))
  assert.ok(!sections.some(section => section.kind === 'form' && section.path === '/runs'))
  assert.ok(page('/live').sections({ ...fixtures, grid: null }).some(section => section.kind === 'note' && /choose/i.test(section.text)))
})

test('row removals carry scalar identifiers and never use array-only bulk payloads', () => {
  const populated = { ...fixtures,
    periods: [{ id: 'period-1', day: 'Monday', index: 1, startsAt: '09:00' }],
    eligibility: [{ id: 'eligibility-1', teacher: 'Dr Rao', course: 'CS201' }],
    unavailable: [{ id: 'unavailable-1', userId: 'teacher-1', who: 'Dr Rao', day: 'Monday', periodLabel: 'Whole day' }],
    needs: [{ id: 'need-1', class: 'CS201 A', kind: 'lecture' }], pins: [{ id: 'pin-1', course: 'CS201', section: 'A' }],
  }
  const removals = pages.flatMap(candidate => candidate.sections(populated)).filter((section): section is PluginForm => section.kind === 'form' && section.path.endsWith('/delete'))
  const identifiers = Object.fromEntries(removals.map(form => [form.path, form.fields.map(field => [field.name, field.value])]))
  assert.deepEqual(identifiers, {
    '/periods/delete': [['periodId', 'period-1']], '/eligibility/delete': [['id', 'eligibility-1']], '/unavailable/delete': [['id', 'unavailable-1']],
    '/needs/delete': [['needId', 'need-1']], '/pins/delete': [['pinId', 'pin-1']],
  })
})
