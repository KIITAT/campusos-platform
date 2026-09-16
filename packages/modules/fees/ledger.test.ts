import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ledger, overpaidPaise } from './api/ledger'

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
