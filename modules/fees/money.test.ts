import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatPaise,
  ledger,
  overpaidPaise,
  parseRupeesToPaise,
  plainPaise,
} from './api/money'

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

// --- the ledger ------------------------------------------------------------

const lines = [
  { label: 'Tuition', chargedPaise: 4500000, waivedPaise: 0 },
  { label: 'Hostel', chargedPaise: 2500000, waivedPaise: 500000 },
]

test('payable is charged less waived', () => {
  const l = ledger(lines, [])
  assert.equal(l.chargedPaise, 7000000)
  assert.equal(l.waivedPaise, 500000)
  assert.equal(l.payablePaise, 6500000)
  assert.equal(l.outstandingPaise, 6500000)
})

test('an unreconciled payment still reduces what is owed, and is reported apart', () => {
  const l = ledger(lines, [
    { amountPaise: 3000000, reconciledAt: new Date() },
    { amountPaise: 1000000, reconciledAt: null },
  ])
  assert.equal(l.paidPaise, 4000000)
  assert.equal(l.unreconciledPaise, 1000000)
  assert.equal(l.outstandingPaise, 2500000)
})

test('an overpayment is a credit, never negative dues', () => {
  const l = ledger(lines, [{ amountPaise: 7000000, reconciledAt: new Date() }])
  assert.equal(l.outstandingPaise, 0)
  assert.equal(overpaidPaise(l), 500000)
})

test('a fully waived charge leaves nothing owed', () => {
  const l = ledger(
    [{ label: 'Tuition', chargedPaise: 4500000, waivedPaise: 4500000 }],
    [],
  )
  assert.equal(l.payablePaise, 0)
  assert.equal(l.outstandingPaise, 0)
})

test('no charges and no payments is a zero ledger, not a crash', () => {
  const l = ledger([], [])
  assert.deepEqual(
    [l.chargedPaise, l.payablePaise, l.paidPaise, l.outstandingPaise],
    [0, 0, 0, 0],
  )
})

test('a long ledger stays exact -- no accumulated drift', () => {
  // 1000 lines of 8.29 rupees: a float sum of 8.29 drifts, integers do not.
  const many = Array.from({ length: 1000 }, (_, i) => ({
    label: `L${i}`,
    chargedPaise: 829,
    waivedPaise: 0,
  }))
  assert.equal(ledger(many, []).chargedPaise, 829000)
})
