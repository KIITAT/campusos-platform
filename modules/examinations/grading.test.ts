import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_GPA_BANDS,
  bandFor,
  coursePercent,
  gpa,
  gradeCourse,
  round2,
  type ExamResult,
} from './api/grading'

const ex = (over: Partial<ExamResult>): ExamResult => ({
  examId: 'e',
  maxMarks: 100,
  weightPercent: 100,
  obtained: null,
  absent: false,
  ...over,
})

// --- percentage ------------------------------------------------------------

test('a single exam is its own percentage', () => {
  const p = coursePercent([ex({ obtained: 73 })])
  assert.deepEqual(p, { kind: 'complete', percent: 73 })
})

test('marks out of a non-100 maximum are scaled', () => {
  const p = coursePercent([ex({ maxMarks: 25, obtained: 20 })])
  assert.deepEqual(p, { kind: 'complete', percent: 80 })
})

test('components are weighted, not averaged', () => {
  // 30% weight at 50%, 70% weight at 90% -> 15 + 63 = 78
  const p = coursePercent([
    ex({ weightPercent: 30, obtained: 50 }),
    ex({ weightPercent: 70, obtained: 90 }),
  ])
  assert.deepEqual(p, { kind: 'complete', percent: 78 })
})

test('weights that do not sum to 100 still yield a percentage', () => {
  // Two 20% components, both full marks: 100%, not 40%.
  const p = coursePercent([
    ex({ weightPercent: 20, obtained: 100 }),
    ex({ weightPercent: 20, obtained: 100 }),
  ])
  assert.deepEqual(p, { kind: 'complete', percent: 100 })
})

test('an absent student scores zero for that component and it still counts', () => {
  const p = coursePercent([
    ex({ weightPercent: 50, obtained: 100 }),
    ex({ weightPercent: 50, absent: true }),
  ])
  assert.deepEqual(p, { kind: 'complete', percent: 50 })
})

test('a pending mark is excluded and reported, not treated as zero', () => {
  const p = coursePercent([
    ex({ weightPercent: 60, obtained: 80 }),
    ex({ weightPercent: 40, obtained: null }),
  ])
  // 80% of the counted 60, not 48% of 100.
  assert.deepEqual(p, { kind: 'incomplete', percent: 80, missingWeight: 40 })
})

test('all marks pending is incomplete at zero, not a fail', () => {
  const p = coursePercent([ex({ obtained: null })])
  assert.deepEqual(p, { kind: 'incomplete', percent: 0, missingWeight: 100 })
})

test('no exams at all is incomplete', () => {
  assert.deepEqual(coursePercent([]), { kind: 'incomplete', percent: 0, missingWeight: 0 })
})

test('a zero-maximum exam does not divide by zero', () => {
  const p = coursePercent([ex({ maxMarks: 0, obtained: 0 })])
  assert.equal(Number.isFinite(p.percent), true)
  assert.equal(p.percent, 0)
})

test('rounding is half away from zero, to two places', () => {
  assert.equal(round2(39.995), 40)
  assert.equal(round2(39.994), 39.99)
  assert.equal(round2(0.005), 0.01)
})

test('a borderline total rounds the way a student would compute it', () => {
  // 39.995 must not silently become a fail through binary float truncation.
  const p = coursePercent([ex({ maxMarks: 200, obtained: 79.99 })])
  assert.equal(p.percent, 40)
})

// --- bands -----------------------------------------------------------------

test('a band is the highest floor at or below the percentage', () => {
  assert.equal(bandFor(DEFAULT_GPA_BANDS, 100)?.label, 'O')
  assert.equal(bandFor(DEFAULT_GPA_BANDS, 90)?.label, 'O')
  assert.equal(bandFor(DEFAULT_GPA_BANDS, 89.99)?.label, 'A+')
  assert.equal(bandFor(DEFAULT_GPA_BANDS, 40)?.label, 'P')
  assert.equal(bandFor(DEFAULT_GPA_BANDS, 39.99)?.label, 'F')
  assert.equal(bandFor(DEFAULT_GPA_BANDS, 0)?.label, 'F')
})

test('no matching band yields no verdict rather than a generous default', () => {
  const sparse = [{ minPercent: 50, label: 'PASS', points: 1, isPass: true }]
  assert.equal(bandFor(sparse, 49), null)
  const g = gradeCourse(sparse, 4, [ex({ obtained: 49 })])
  assert.equal(g.label, null)
  assert.equal(g.passed, false)
})

test('bands need not be given in order', () => {
  const shuffled = [...DEFAULT_GPA_BANDS].reverse()
  assert.equal(bandFor(shuffled, 85)?.label, 'A+')
})

// --- gpa -------------------------------------------------------------------

test('gpa is credit-weighted, not a flat mean', () => {
  const grades = [
    gradeCourse(DEFAULT_GPA_BANDS, 4, [ex({ obtained: 95 })]), // O, 10 pts, 4 cr
    gradeCourse(DEFAULT_GPA_BANDS, 1, [ex({ obtained: 45 })]), // C, 5 pts, 1 cr
  ]
  // (10*4 + 5*1) / 5 = 9
  assert.deepEqual(gpa(grades), { value: 9, credits: 5 })
})

test('a failed course contributes neither points nor credits', () => {
  const grades = [
    gradeCourse(DEFAULT_GPA_BANDS, 4, [ex({ obtained: 95 })]),
    gradeCourse(DEFAULT_GPA_BANDS, 4, [ex({ obtained: 10 })]), // F
  ]
  assert.deepEqual(gpa(grades), { value: 10, credits: 4 })
})

test('an incomplete course does not drag the average down', () => {
  const grades = [
    gradeCourse(DEFAULT_GPA_BANDS, 4, [ex({ obtained: 95 })]),
    gradeCourse(DEFAULT_GPA_BANDS, 4, [ex({ obtained: null })]),
  ]
  assert.deepEqual(gpa(grades), { value: 10, credits: 4 })
})

test('no gradeable course gives no gpa rather than zero', () => {
  assert.deepEqual(gpa([]), { value: null, credits: 0 })
  const failed = [gradeCourse(DEFAULT_GPA_BANDS, 4, [ex({ obtained: 5 })])]
  assert.deepEqual(gpa(failed), { value: null, credits: 0 })
})

test('the default scale covers every percentage from 0 to 100', () => {
  for (let p = 0; p <= 100; p += 0.5) {
    assert.ok(bandFor(DEFAULT_GPA_BANDS, p), `no band for ${p}`)
  }
})

test('a course graded on the default scale reports everything the transcript needs', () => {
  const g = gradeCourse(DEFAULT_GPA_BANDS, 3, [
    ex({ weightPercent: 40, maxMarks: 50, obtained: 45 }),
    ex({ weightPercent: 60, maxMarks: 100, obtained: 72 }),
  ])
  // 0.9*40 + 0.72*60 = 36 + 43.2 = 79.2
  assert.deepEqual(g, {
    percent: 79.2,
    complete: true,
    label: 'A',
    points: 8,
    passed: true,
    credits: 3,
  })
})
