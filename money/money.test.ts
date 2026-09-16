import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatPaise, parseRupeesToPaise, plainPaise } from './index'

// --- parsing ---------------------------------------------------------------

test('rupees typed by a person become exact paise', () => {
  const cases: [string, number][] = [
    ['0', 0],
    ['1', 100],
    ['1.5', 150],
    ['1.05', 105],
    ['1234.56', 123456],
    ['45000', 4500000],
    ['1,23,456.78', 12345678],
    ['₹ 2,500.00', 250000],
    ['  99.99  ', 9999],
  ]
  for (const [input, expected] of cases) {
    assert.equal(parseRupeesToPaise(input), expected, input)
  }
})

test('the amounts that break naive float scaling are exact here', () => {
  // 1234.56 * 100 is 123455.99999999999 as a double.
  assert.equal(parseRupeesToPaise('1234.56'), 123456)
  assert.equal(parseRupeesToPaise('8.29'), 829)
  assert.equal(parseRupeesToPaise('0.07'), 7)
  assert.equal(parseRupeesToPaise('16.08'), 1608)
  // and a sweep, because one lucky case proves nothing
  for (let p = 0; p < 2000; p++) {
    const rupees = plainPaise(p)
    assert.equal(parseRupeesToPaise(rupees), p, rupees)
  }
})

test('junk is refused rather than guessed at', () => {
  for (const bad of [
    '', ' ', 'abc', '1.2.3', '1.234', '-5', '1e5', '.5', '5.', 'NaN',
    null, undefined, {}, [], true, 1.5, -1, NaN, Infinity,
  ]) {
    assert.equal(parseRupeesToPaise(bad), null, JSON.stringify(bad))
  }
})

test('an integral rupee number is accepted, a fractional one is not', () => {
  assert.equal(parseRupeesToPaise(500), 50000)
  assert.equal(parseRupeesToPaise(0), 0)
  assert.equal(parseRupeesToPaise(500.5), null)
})

// --- formatting ------------------------------------------------------------

test('formatting groups the Indian way', () => {
  assert.match(formatPaise(12345678), /1,23,456\.78/)
  assert.match(formatPaise(100), /1\.00/)
})

test('the plain form is locale-independent and always two decimals', () => {
  assert.equal(plainPaise(0), '0.00')
  assert.equal(plainPaise(7), '0.07')
  assert.equal(plainPaise(100), '1.00')
  assert.equal(plainPaise(123456), '1234.56')
  assert.equal(plainPaise(-105), '-1.05')
})
