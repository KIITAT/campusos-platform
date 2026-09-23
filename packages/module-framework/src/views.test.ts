import { test } from 'node:test'
import assert from 'node:assert/strict'
import { axisTicks, listView, statusTone } from './views'

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
