import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeAnswer, describeKey, parseChoices, scoreAnswer, total, type AnswerKey } from './scoring'
import { instant, wallClock } from './time'

const key = (over: Partial<AnswerKey>): AnswerKey => ({
  kind: 'single',
  choices: [],
  acceptedAnswers: [],
  numericAnswer: null,
  tolerance: 0,
  partialCredit: false,
  ...over,
})

const capital = key({ choices: parseChoices('Lyon\n* Paris\nNice') })
const primes = key({ kind: 'multiple', choices: parseChoices('* 2\n* 3\n4\n* 5') })

test('options are typed one per line, the right ones starred', () => {
  assert.deepEqual(parseChoices('  Lyon \n\n*Paris\n* Nice'), [
    { id: 'a', label: 'Lyon', correct: false },
    { id: 'b', label: 'Paris', correct: true },
    { id: 'c', label: 'Nice', correct: true },
  ])
})

test('single choice: the right option earns the marks, another earns nothing', () => {
  assert.deepEqual(scoreAnswer(capital, 'b', 2), { correct: true, awarded: 2 })
  assert.deepEqual(scoreAnswer(capital, 'a', 2), { correct: false, awarded: 0 })
  // Two options sent to a one-answer question is not a hedge that pays.
  assert.deepEqual(scoreAnswer(capital, ['a', 'b'], 2), { correct: false, awarded: 0 })
})

test('a blank is not wrong, and is never penalised', () => {
  for (const blank of [null, undefined, '', []]) {
    assert.deepEqual(scoreAnswer(capital, blank, 4, 25), { correct: null, awarded: 0 })
  }
})

test('negative marking takes its share for a wrong answer only', () => {
  assert.deepEqual(scoreAnswer(capital, 'a', 4, 25), { correct: false, awarded: -1 })
  assert.deepEqual(scoreAnswer(capital, 'b', 4, 25), { correct: true, awarded: 4 })
})

test('multiple choice is all or nothing unless the question gives partial credit', () => {
  assert.equal(scoreAnswer(primes, ['a', 'b', 'd'], 3).awarded, 3)
  assert.equal(scoreAnswer(primes, ['d', 'b', 'a'], 3).awarded, 3, 'order does not matter')
  assert.deepEqual(scoreAnswer(primes, ['a', 'b'], 3), { correct: false, awarded: 0 })

  const partial = { ...primes, partialCredit: true }
  // Two of three right: two thirds of the marks.
  assert.deepEqual(scoreAnswer(partial, ['a', 'b'], 3), { correct: false, awarded: 2 })
  // A wrong tick takes a right one back.
  assert.deepEqual(scoreAnswer(partial, ['a', 'b', 'c'], 3), { correct: false, awarded: 1 })
  // Ticking everything is not a strategy.
  assert.deepEqual(scoreAnswer(partial, ['a', 'b', 'c', 'd'], 3), { correct: false, awarded: 2 })
  assert.deepEqual(scoreAnswer(partial, ['c'], 3, 50), { correct: false, awarded: -1.5 })
})

test('a form sends ticked boxes as a comma list; that reads the same', () => {
  assert.equal(scoreAnswer(primes, 'a,b,d', 1).awarded, 1)
})

test('short answers ignore case, spacing and Unicode forms, and nothing else', () => {
  const k = key({ kind: 'short', acceptedAnswers: ['Third normal form', '3NF'] })
  assert.equal(scoreAnswer(k, '  third   NORMAL form ', 1).correct, true)
  assert.equal(scoreAnswer(k, '３ＮＦ', 1).correct, true, 'full-width characters fold')
  assert.equal(scoreAnswer(k, 'third normal', 1).correct, false)
  const comma = key({ kind: 'short', acceptedAnswers: ['Delhi, India'] })
  assert.equal(scoreAnswer(comma, 'delhi, india', 1).correct, true, 'a comma is part of a short answer')
})

test('a number is right within its tolerance, and binary fractions do not cheat anybody', () => {
  const g = key({ kind: 'numeric', numericAnswer: '9.81', tolerance: '0.05' })
  assert.equal(scoreAnswer(g, '9.8', 1).correct, true)
  assert.equal(scoreAnswer(g, 9.86, 1).correct, true)
  assert.equal(scoreAnswer(g, '9.87', 1).correct, false)
  assert.equal(scoreAnswer(g, 'nine', 1).correct, false)
  const exact = key({ kind: 'numeric', numericAnswer: '0.3', tolerance: '0' })
  assert.equal(scoreAnswer(exact, 0.1 + 0.2, 1).correct, true)
})

test('an attempt totals its marks and never goes below zero', () => {
  assert.equal(total([2, -1, 0.5]), 1.5)
  assert.equal(total([-1, -1]), 0)
})

test('keys and answers are written out in words, not ids', () => {
  assert.equal(describeKey(primes), '2; 3; 5')
  assert.equal(describeAnswer(primes, ['a', 'c']), '2; 4')
  assert.equal(describeKey(key({ kind: 'numeric', numericAnswer: '9.81', tolerance: '0.05' })), '9.81 ± 0.05')
})

test('a wall-clock time is read in the quiz zone, both ways', () => {
  // 17:00 in Kolkata is 11:30 UTC.
  assert.equal(instant('2026-10-05T17:00', 'Asia/Kolkata').toISOString(), '2026-10-05T11:30:00.000Z')
  assert.equal(wallClock('2026-10-05T11:30:00Z', 'Asia/Kolkata'), '2026-10-05 17:00')
  // An explicit offset wins over the zone.
  assert.equal(instant('2026-10-05T17:00+00:00', 'Asia/Kolkata').toISOString(), '2026-10-05T17:00:00.000Z')
  // Across a daylight-saving change: 09:00 in London is 08:00 UTC in summer, 09:00 in winter.
  assert.equal(instant('2026-07-01T09:00', 'Europe/London').toISOString(), '2026-07-01T08:00:00.000Z')
  assert.equal(instant('2026-12-01T09:00', 'Europe/London').toISOString(), '2026-12-01T09:00:00.000Z')
})
