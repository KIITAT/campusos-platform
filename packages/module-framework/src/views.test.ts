import { test } from 'node:test'
import assert from 'node:assert/strict'
import { axisTicks, foldLines, listView, statusTone, ticked } from './views'

const cols = [
  { key: 'name', label: 'Name' },
  { key: 'amount', label: 'Amount', kind: 'money' as const },
  { key: 'on', label: 'On', kind: 'date' as const },
]
const rows = [
  { name: 'Asha', amount: 500, on: '2026-07-01' },
  { name: 'bilal', amount: 1500, on: null },
  { name: 'Chen', amount: 200, on: '2026-06-01' },
]

test('status words get a tone by meaning, and an unknown word is gray', () => {
  assert.equal(statusTone('Paid'), 'green')
  assert.equal(statusTone('cancelled'), 'red')
  assert.equal(statusTone('self review'), 'orange')
  assert.equal(statusTone('submitted'), 'blue')
  assert.equal(statusTone('draft'), 'gray')
  assert.equal(statusTone('quux'), 'gray')
  assert.equal(statusTone(null), 'gray')
})

test('the filter matches any column, case-insensitively', () => {
  assert.deepEqual(listView(rows, cols, { q: 'BIL' }).rows.map((r) => r.name), ['bilal'])
  assert.equal(listView(rows, cols, { q: '1500' }).matched, 1)
  assert.equal(listView(rows, cols, { q: '' }).matched, 3)
})

test('sorting is by value -- numbers as numbers -- and blanks go last either way', () => {
  assert.deepEqual(listView(rows, cols, { sort: 'amount' }).rows.map((r) => r.amount), [200, 500, 1500])
  assert.deepEqual(listView(rows, cols, { sort: 'amount', dir: 'desc' }).rows.map((r) => r.amount), [1500, 500, 200])
  assert.deepEqual(listView(rows, cols, { sort: 'on' }).rows.map((r) => r.name), ['Chen', 'Asha', 'bilal'])
  assert.deepEqual(listView(rows, cols, { sort: 'on', dir: 'desc' }).rows.map((r) => r.name), ['Asha', 'Chen', 'bilal'])
  assert.deepEqual(listView(rows, cols, { sort: 'name' }).rows.map((r) => r.name), ['Asha', 'bilal', 'Chen'])
})

test('an unknown sort key leaves the order alone', () => {
  assert.deepEqual(listView(rows, cols, { sort: 'secret' }).rows, rows)
})

test('the limit cuts after filtering and reports what was left out', () => {
  const many = Array.from({ length: 45 }, (_, i) => ({ name: `n${i}`, amount: i, on: null }))
  const v = listView(many, cols, {}, 20)
  assert.equal(v.rows.length, 20)
  assert.equal(v.matched, 45)
  assert.equal(listView(many, cols, { limit: 100 }).rows.length, 45)
  assert.equal(listView(many, cols, { limit: 100000 }).limit, 500)
})

test('axis ticks are round and cover the largest value', () => {
  assert.deepEqual(axisTicks(0), [0])
  assert.deepEqual(axisTicks(100), [0, 25, 50, 75, 100])
  const t = axisTicks(353_076)
  assert.ok(t.at(-1)! >= 353_076)
  assert.ok(t.length <= 6)
})

test('a lines grid folds back into rows, in order, without the blank ones', () => {
  const body = {
    memo: 'Opening',
    'lines.1.account': '1010',
    'lines.0.account': '1000',
    'lines.0.debit': '500.00',
    'lines.1.credit': '500.00',
    'lines.2.account': '',
    'lines.2.debit': '',
    'lines.3.flag': 'false',
    'lines.12.account': '4000',
  }
  assert.deepEqual(foldLines(body), {
    memo: 'Opening',
    lines: [
      { account: '1000', debit: '500.00' },
      { account: '1010', credit: '500.00' },
      { account: '4000' },
    ],
  })
})

test('keys that only look like a grid pass through', () => {
  assert.deepEqual(foldLines({ 'a.b.c': '1', 'x.1': '2', 'lines.99999.a': '3' }), {
    'a.b.c': '1',
    'x.1': '2',
    'lines.99999.a': '3',
  })
})

test('an unticked checkbox reads as false, not as the truthy string "false"', () => {
  assert.equal(ticked('false'), false)
  assert.equal(ticked('true'), true)
  assert.equal(ticked('on'), true)
  assert.equal(ticked(true), true)
  assert.equal(ticked(undefined), undefined)
})
