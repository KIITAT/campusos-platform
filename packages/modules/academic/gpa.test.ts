// Expected values are UNVERIFIED: worked by hand from the rule in plans/P0-09.md D1–D4, pending the owner's academic office.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  gradePointAverage,
  rulesOn,
  LEGACY_GPA_RULES,
  CORRECTED_GPA_RULES,
  round2,
  type Attempt,
  type GpaPolicyVersion,
} from './api/gpa'

const a = (courseId: string, termStartsOn: string | null, credits: number, points: number | null, passed = points !== null && points > 0): Attempt => ({
  courseId,
  termStartsOn,
  credits,
  points,
  passed,
})

const LEGACY: GpaPolicyVersion[] = [{ effectiveFrom: '0001-01-01', ...LEGACY_GPA_RULES }]
const CORRECTED: GpaPolicyVersion[] = []
const best: GpaPolicyVersion[] = [{ effectiveFrom: '0001-01-01', failedCredits: 'zero', repeats: 'best' }]
const zeroAll: GpaPolicyVersion[] = [{ effectiveFrom: '0001-01-01', failedCredits: 'zero', repeats: 'all' }]
const V: GpaPolicyVersion[] = [
  { effectiveFrom: '0001-01-01', ...LEGACY_GPA_RULES },
  { effectiveFrom: '2026-07-01', ...CORRECTED_GPA_RULES },
]

test('a failed course counts its credits at zero points (FUNC-03, UNVERIFIED)', () => {
  const rows = [a('x', '2026-01-05', 4, 10), a('y', '2026-01-05', 3, 8), a('z', '2026-01-05', 3, 0, false)]
  assert.deepEqual(gradePointAverage(rows, CORRECTED), { value: 6.4, credits: 10 })
  assert.deepEqual(gradePointAverage(rows, LEGACY), { value: 9.14, credits: 7 })
})

test('a retake to improve counts the latest, the best, or both (FUNC-03, UNVERIFIED)', () => {
  const rows = [a('x', '2026-01-05', 4, 6), a('x', '2026-08-01', 4, 8), a('y', '2026-01-05', 4, 9)]
  assert.deepEqual(gradePointAverage(rows, CORRECTED), { value: 8.5, credits: 8 })
  assert.deepEqual(gradePointAverage(rows, best), { value: 8.5, credits: 8 })
  assert.deepEqual(gradePointAverage(rows, LEGACY), { value: 7.67, credits: 12 })
})

test('a worse retake: latest takes it, best does not (FUNC-03, UNVERIFIED)', () => {
  const rows = [a('x', '2026-01-05', 4, 8), a('x', '2026-08-01', 4, 5), a('y', '2026-01-05', 4, 9)]
  assert.deepEqual(gradePointAverage(rows, CORRECTED), { value: 7, credits: 8 })
  assert.deepEqual(gradePointAverage(rows, best), { value: 8.5, credits: 8 })
  assert.deepEqual(gradePointAverage(rows, LEGACY), { value: 7.33, credits: 12 })
})

test('failed twice then passed (FUNC-03, UNVERIFIED)', () => {
  const rows = [
    a('x', '2026-01-05', 3, 0, false),
    a('x', '2026-08-01', 3, 0, false),
    a('x', '2027-01-04', 3, 4),
    a('y', '2026-01-05', 3, 7),
  ]
  assert.deepEqual(gradePointAverage(rows, CORRECTED), { value: 5.5, credits: 6 })
  assert.deepEqual(gradePointAverage(rows, zeroAll), { value: 2.75, credits: 12 })
  assert.deepEqual(gradePointAverage(rows, LEGACY), { value: 5.5, credits: 6 })
})

test('an ungraded attempt counts towards nothing (FUNC-03, UNVERIFIED)', () => {
  const rows = [a('pf', '2026-01-05', 2, null, true), a('w', '2026-01-05', 4, null, false), a('y', '2026-01-05', 4, 8)]
  assert.deepEqual(gradePointAverage(rows, CORRECTED), { value: 8, credits: 4 })
})

test('no graded attempt is no average; only failures is zero (FUNC-03, UNVERIFIED)', () => {
  assert.deepEqual(gradePointAverage([], CORRECTED), { value: null, credits: 0 })
  const rows = [a('x', '2026-01-05', 4, 0, false)]
  assert.deepEqual(gradePointAverage(rows, CORRECTED), { value: 0, credits: 4 })
  assert.deepEqual(gradePointAverage(rows, LEGACY), { value: null, credits: 0 })
})

test('transfer credit counts as the earliest attempt (FUNC-03, UNVERIFIED)', () => {
  assert.deepEqual(gradePointAverage([a('t', null, 3, 7, true), a('y', '2026-01-05', 3, 9)], CORRECTED), { value: 8, credits: 6 })
  assert.deepEqual(gradePointAverage([a('x', null, 4, 5, true), a('x', '2026-01-05', 4, 9)], CORRECTED), { value: 9, credits: 4 })
})

test('a new rule applies from its date, never before it (FUNC-03, UNVERIFIED)', () => {
  const t1 = [a('x', '2026-01-05', 4, 0, false), a('y', '2026-01-05', 4, 8)]
  const t2 = [a('z', '2026-08-01', 4, 0, false), a('w', '2026-08-01', 4, 9)]
  assert.deepEqual(gradePointAverage(t1, V), { value: 8, credits: 4 })
  assert.deepEqual(gradePointAverage(t2, V), { value: 4.5, credits: 8 })
  assert.deepEqual(gradePointAverage([...t1, ...t2], V), { value: 5.67, credits: 12 })
})

test('a course retaken across the change follows the rule of its latest attempt (FUNC-03, UNVERIFIED)', () => {
  assert.deepEqual(gradePointAverage([a('x', '2026-01-05', 4, 0, false), a('x', '2026-08-01', 4, 6)], V), { value: 6, credits: 4 })
})

test('the rule on a day (FUNC-03, UNVERIFIED)', () => {
  assert.deepEqual(rulesOn(V, '2026-06-30'), LEGACY_GPA_RULES)
  assert.deepEqual(rulesOn(V, '2026-07-01'), CORRECTED_GPA_RULES)
  assert.deepEqual(rulesOn(V, null), LEGACY_GPA_RULES)
  assert.deepEqual(rulesOn([], '2026-01-01'), CORRECTED_GPA_RULES)
})

test('round2 rounds half away from zero on decimal values (FUNC-03, UNVERIFIED)', () => {
  assert.equal(round2(39.995), 40)
  assert.equal(round2(7.125), 7.13)
  assert.equal(round2(-1.005), -1.01)
})
