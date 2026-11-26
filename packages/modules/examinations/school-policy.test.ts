import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as policy from './api/school-policy'
import * as grading from './api/grading'

/**
 * School grading (FUNC-03, P1-13b): the stage defaults, the template rules and
 * the marks arithmetic, with no database. Class numbers are the stages named
 * in the plan; XI and XII have no default.
 */

type Row = { examId: string; maxMarks: number; weightPercent: number; obtained: number | null; absent: boolean; kind: 'quiz' | 'assignment' | 'midterm' | 'practical' | 'final'; name: string; published: boolean }
let n = 0
const row = (kind: Row['kind'], name: string, obtained: number | null, maxMarks: number, weightPercent: number, over: Partial<Row> = {}): Row => ({
  examId: `e${++n}`,
  maxMarks,
  weightPercent,
  obtained,
  absent: false,
  kind,
  name,
  published: true,
  ...over,
})

/** One component of weight 100 on the final exam, with the standard bands. */
const single = (): policy.SchoolTemplate => ({
  version: 1,
  classNumber: 8,
  name: 'One paper',
  mode: 'marks',
  components: [{ key: 'paper', label: 'Paper', weight: 100, selectors: [{ kind: 'final' }] }],
  subjectOverrides: [],
  bands: [
    { floor: 91, grade: 'A1' },
    { floor: 81, grade: 'A2' },
    { floor: 33, grade: 'D' },
    { floor: 0, grade: 'E' },
  ],
  areas: [],
  remarks: [],
})

const mark = (t: policy.SchoolTemplate, obtained: number) => grading.schoolSubject(t, 'MA', [row('final', 'Final', obtained, 100, 100)])

test('the stage defaults exist for classes I to X and not beyond', () => {
  for (const c of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    const t = policy.defaultSchoolTemplate(c)
    assert.ok(t, `class ${c}`)
    assert.equal(t.classNumber, c)
    assert.ok(policy.schoolTemplateSchema.safeParse(t).success, `class ${c} default is valid`)
  }
  for (const c of [0, 11, 12, 2.5]) assert.equal(policy.defaultSchoolTemplate(c), null)
  assert.deepEqual([1, 2].map((c) => policy.defaultSchoolTemplate(c)!.name), ['Foundational progress', 'Foundational progress'])
  for (const c of [3, 5]) assert.equal(policy.defaultSchoolTemplate(c)!.name, 'Preparatory progress')
  for (const c of [1, 2, 3, 5]) {
    const t = policy.defaultSchoolTemplate(c)!
    assert.equal(t.mode, 'observations')
    assert.deepEqual([t.components.length, t.bands.length], [0, 0])
    assert.ok(t.areas.some((a) => a.group === 'scholastic') && t.areas.some((a) => a.group === 'co_scholastic'))
    assert.deepEqual(t.remarks.map((r) => r.key), ['steady', 'practice'])
  }
  for (const c of [6, 8]) {
    const t = policy.defaultSchoolTemplate(c)!
    assert.equal(t.name, 'Middle school term report')
    assert.deepEqual(t.components.map((x) => x.weight), [10, 5, 5, 80])
    assert.deepEqual(t.areas.map((a) => a.grades.length), [3, 3, 3, 3])
  }
  for (const c of [9, 10]) {
    const t = policy.defaultSchoolTemplate(c)!
    assert.equal(t.name, 'Secondary school term report')
    assert.deepEqual(t.components.map((x) => x.weight), [5, 5, 5, 5, 80])
  }
  assert.deepEqual(policy.defaultSchoolTemplate(9)!.areas.map((a) => a.label), ['Art Education', 'Physical Education and Well-being', 'Discipline'])
  assert.deepEqual(policy.defaultSchoolTemplate(10)!.areas.map((a) => a.label), ['Work Education', 'Art Education', 'Health and Physical Education', 'Discipline'])
  assert.deepEqual(policy.defaultSchoolTemplate(8)!.bands.map((b) => b.floor), [91, 81, 71, 61, 51, 41, 33, 0])
})

test('the class comes from the programme code, any case', () => {
  assert.equal(policy.classNumberOf('CLASS-6'), 6)
  assert.equal(policy.classNumberOf(' class-10 '), 10)
  for (const bad of ['CLASS-11', 'CLASS-0', 'CLASS-06', 'GRADE-6', 'BTECH']) assert.equal(policy.classNumberOf(bad), null)
})

test('a template is refused for every rule it can break, with the path', () => {
  const ok = policy.defaultSchoolTemplate(8)!
  const clone = () => structuredClone(ok) as policy.SchoolTemplate
  const bad = (label: string, edit: (t: policy.SchoolTemplate) => unknown) => {
    const t = clone()
    const input = edit(t) ?? t
    assert.equal(policy.schoolTemplateSchema.safeParse(input).success, false, label)
  }
  assert.ok(policy.schoolTemplateSchema.safeParse(ok).success)
  bad('unknown key', (t) => ({ ...t, extra: 1 }))
  bad('wrong version', (t) => ({ ...t, version: 2 }))
  bad('class 11', (t) => ({ ...t, classNumber: 11 }))
  bad('name too long', (t) => ({ ...t, name: 'x'.repeat(71) }))
  bad('weights do not sum to 100', (t) => void (t.components[0]!.weight = 11))
  bad('duplicate component keys', (t) => void (t.components[1]!.key = t.components[0]!.key))
  bad('bad key pattern', (t) => void (t.components[0]!.key = 'Periodic'))
  bad('same selector in two components', (t) => void t.components[1]!.selectors.push({ kind: 'quiz', name: ' periodic test ' }))
  bad('no zero floor', (t) => void (t.bands = t.bands.filter((b) => b.floor !== 0)))
  bad('duplicate floors', (t) => void (t.bands[1]!.floor = t.bands[0]!.floor))
  bad('reserved area key', (t) => void (t.areas[0]!.key = 'remark'))
  bad('duplicate area keys', (t) => void (t.areas[1]!.key = t.areas[0]!.key))
  bad('duplicate remark keys', (t) => void t.remarks.push({ key: 'steady', label: 'Again.' }))
  bad('seven components', (t) => void (t.components = Array.from({ length: 7 }, (_, i) => ({ key: `c${i}`, label: 'C', weight: 1, selectors: [{ kind: 'quiz' as const, name: `q${i}` }] }))))
  bad('a scholastic area in a marks template', (t) => void t.areas.push({ key: 'x', label: 'X', group: 'scholastic', grades: [{ key: 'a', label: 'A' }] }))
  bad('duplicate normalised subject codes', (t) => {
    const c = structuredClone(t.components)
    t.subjectOverrides = [
      { courseCode: 'PE1', components: c },
      { courseCode: ' pe1 ', components: c },
    ]
  })
  bad('an override that does not sum to 100', (t) => void (t.subjectOverrides = [{ courseCode: 'PE1', components: [{ key: 'a', label: 'A', weight: 20, selectors: [{ kind: 'final' }] }] }]))
  const obs = policy.defaultSchoolTemplate(2)!
  assert.equal(policy.schoolTemplateSchema.safeParse({ ...obs, bands: [{ floor: 0, grade: 'E' }] }).success, false, 'observations carry no bands')
  assert.equal(policy.schoolTemplateSchema.safeParse({ ...obs, areas: obs.areas.filter((a) => a.group !== 'scholastic') }).success, false, 'observations need a scholastic area')

  const r = policy.schoolTemplateSchema.safeParse({ ...ok, components: ok.components.map((c, i) => (i === 0 ? { ...c, weight: 11 } : c)) })
  assert.equal(r.success, false)
  assert.deepEqual(r.error!.issues[0]!.path, ['components'], 'the Zod path names the set')
  assert.ok(policy.schoolTemplateSchema.safeParse({ ...ok, subjectOverrides: [{ courseCode: 'PE1', components: [{ key: 'terminal', label: 'Terminal', weight: 20, selectors: [{ kind: 'final' }] }, { key: 'practical', label: 'Practical', weight: 80, selectors: [{ kind: 'practical' }] }] }] }).success)
})

test('marks templates normalize and sort optional offering exclusions', () => {
  const template = policy.defaultSchoolTemplate(6)!
  const ids = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']
  assert.deepEqual(policy.schoolTemplateSchema.parse({ ...template, excludedOfferingIds: [` ${ids[1]!.toUpperCase()} `, ids[0]] }), { ...template, excludedOfferingIds: ids })
  assert.deepEqual(policy.schoolTemplateSchema.parse({ ...template, excludedOfferingIds: [] }), template)
  assert.equal(policy.canonicalTemplate({ ...template, excludedOfferingIds: [] } as policy.SchoolTemplate), policy.canonicalTemplate(template))
  assert.equal(
    policy.canonicalTemplate({ ...template, excludedOfferingIds: [...ids].reverse() } as policy.SchoolTemplate),
    policy.canonicalTemplate({ ...template, excludedOfferingIds: ids } as policy.SchoolTemplate),
  )
})

test('offering exclusions reject malformed UUIDs, normalized duplicates, excess IDs and observation exclusions', () => {
  const template = policy.defaultSchoolTemplate(6)!
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  for (const excludedOfferingIds of [[id, ` ${id.toUpperCase()} `], ['abc'], Array.from({ length: 101 }, () => crypto.randomUUID())]) {
    assert.equal(policy.schoolTemplateSchema.safeParse({ ...template, excludedOfferingIds }).success, false)
  }
  const observations = policy.defaultSchoolTemplate(2)!
  assert.equal(policy.schoolTemplateSchema.safeParse({ ...observations, excludedOfferingIds: [id] }).success, false)
  assert.deepEqual(policy.schoolTemplateSchema.parse({ ...observations, excludedOfferingIds: [] }), observations)
})

test('the band edges: 32.99 is E, 33.00 is D, 90.99 is A2, 91.00 is A1', () => {
  const t = single()
  for (const [score, grade] of [[32.99, 'E'], [33, 'D'], [90.99, 'A2'], [91, 'A1'], [0, 'E'], [100, 'A1']] as const) {
    const r = mark(t, score)
    assert.equal(r.total, score)
    assert.equal(r.grade, grade, String(score))
  }
})

test('the marks round half up once, after exact arithmetic', () => {
  const t = single()
  // 1/3 of 100 is 33.333..., which rounds to 33.33 and then bands as D.
  assert.equal(grading.schoolSubject(t, 'MA', [row('final', 'Final', 1, 3, 100)]).total, 33.33)
  // 0.01 of 200 is 0.005%: a half in the third decimal rounds up, not to even.
  assert.equal(grading.schoolSubject(t, 'MA', [row('final', 'Final', 0.01, 200, 100)]).total, 0.01)
})

test('inside a component the exams weigh by their own weight', () => {
  const t = single()
  const r = grading.schoolSubject(t, 'MA', [row('final', 'A', 1, 2, 1), row('final', 'B', 1, 1, 3)])
  // (1 * 1/2 + 3 * 1/1) / 4 = 0.875 of the component's weight of 100.
  assert.equal(r.components[0]!.value, 87.5)
  assert.equal(r.total, 87.5)
  assert.equal(r.grade, 'A2')
})

test('an absent pupil scores zero, a missing mark is pending', () => {
  const t = policy.defaultSchoolTemplate(8)!
  const full = (over: Partial<Record<string, Partial<Row>>> = {}) => [
    row('quiz', 'Periodic Test', 8, 10, 10, over.pt),
    row('assignment', 'Notebook', 5, 5, 5, over.nb),
    row('assignment', 'Subject Enrichment', 4, 5, 5, over.se),
    row('final', 'Term Examination', 70, 80, 80, over.fin),
  ]
  const done = grading.schoolSubject(t, 'MA', full())
  assert.deepEqual([done.total, done.grade], [87, 'A2'])
  assert.deepEqual(done.components.map((c) => c.value), [8, 5, 4, 70])
  assert.deepEqual(done.components.map((c) => c.max), [10, 5, 5, 80])

  const absent = grading.schoolSubject(t, 'MA', full({ fin: { obtained: null, absent: true } }))
  assert.equal(absent.components[3]!.absent, true)
  assert.equal(absent.components[3]!.value, 0)
  assert.deepEqual([absent.total, absent.grade], [17, 'E'])
  assert.equal(done.components[3]!.absent, false)

  const pending = grading.schoolSubject(t, 'MA', full({ fin: { obtained: null } }))
  assert.equal(pending.components[3]!.value, null)
  assert.deepEqual([pending.total, pending.grade], [null, null])

  const unpublished = grading.schoolSubject(t, 'MA', full({ nb: { published: false } }))
  assert.deepEqual([unpublished.components[1]!.value, unpublished.total, unpublished.grade], [null, null, null])

  // A component with no exam at all.
  const missing = grading.schoolSubject(t, 'MA', full().slice(0, 3))
  assert.deepEqual([missing.components[3]!.value, missing.total], [null, null])

  // An exam the template does not name is unmapped: no total.
  const stray = grading.schoolSubject(t, 'MA', [...full(), row('practical', 'Viva', 3, 5, 1)])
  assert.deepEqual([stray.total, stray.grade], [null, null])
})

test('names match trimmed and case-insensitive, and a named selector beats the kind fallback', () => {
  const t = policy.defaultSchoolTemplate(8)!
  const r = grading.schoolSubject(t, 'MA', [
    row('quiz', '  periodic TEST ', 10, 10, 10),
    row('assignment', 'notebook', 5, 5, 5),
    row('assignment', 'SUBJECT ENRICHMENT', 5, 5, 5),
    row('midterm', 'Anything', 80, 80, 80),
  ])
  assert.deepEqual([r.total, r.grade], [100, 'A1'])
  // A quiz with another name has no component to count in.
  const other = grading.schoolSubject(t, 'MA', [row('quiz', 'Weekly quiz', 10, 10, 10), row('assignment', 'Notebook', 5, 5, 5), row('assignment', 'Subject Enrichment', 5, 5, 5), row('final', 'F', 80, 80, 80)])
  assert.equal(other.total, null)
})

test('a subject override replaces the template components for that course code only', () => {
  const t = policy.defaultSchoolTemplate(9)!
  t.subjectOverrides = [
    {
      courseCode: 'PE',
      components: [
        { key: 'terminal', label: 'Terminal', weight: 20, selectors: [{ kind: 'final' }] },
        { key: 'practical', label: 'Practical', weight: 80, selectors: [{ kind: 'practical' }] },
      ],
    },
  ]
  assert.ok(policy.schoolTemplateSchema.safeParse(t).success)
  const rows = [row('final', 'Terminal', 15, 20, 20), row('practical', 'Practical', 60, 80, 80)]
  const pe = grading.schoolSubject(t, ' pe ', rows)
  assert.deepEqual(pe.components.map((c) => [c.key, c.value]), [['terminal', 15], ['practical', 60]])
  assert.equal(pe.total, 75)
  assert.equal(grading.schoolSubject(t, 'MA', rows).total, null, 'another subject uses the standard set')
})

test('the school policy grades without points, and the college rule is unchanged', () => {
  assert.equal(grading.gradingPolicyFor('school').id, 'school-marks')
  for (const k of ['percentage', 'gpa', 'custom'] as const) assert.equal(grading.gradingPolicyFor(k).id, 'university-grade-points')
  assert.deepEqual(grading.gradingPolicyFor('school').average([], []), { value: null, credits: 0 })
  const g = grading.gradingPolicyFor('school').gradeCourse([{ minPercent: 0, label: 'E', points: null, isPass: true }], 0, [{ examId: 'x', maxMarks: 10, weightPercent: 100, obtained: 5, absent: false }])
  assert.deepEqual([g.points, g.credits], [null, 0])
})
