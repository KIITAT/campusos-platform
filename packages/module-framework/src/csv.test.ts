import { test } from 'node:test'
import assert from 'node:assert/strict'
import { csvCell } from './csv'
import { listRows } from './views'

test('a cell a spreadsheet would run is made text, numbers stay numbers (SEC-08)', () => {
  assert.equal(csvCell('=1+1'), "'=1+1")
  assert.equal(csvCell('+91 98'), "'+91 98")
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)")
  assert.equal(csvCell('-x'), "'-x")
  assert.equal(csvCell('\tx'), "'\tx")
  assert.equal(csvCell('=HYPERLINK("http://e.example","a,b")'), '"\'=HYPERLINK(""http://e.example"",""a,b"")"')
  assert.equal(csvCell('-1250.50'), '-1250.50')
  assert.equal(csvCell('+5'), '+5')
  assert.equal(csvCell('42'), '42')
  assert.equal(csvCell('Rao, Priya'), '"Rao, Priya"')
  assert.equal(csvCell('a\rb'), '"a\rb"')
  assert.equal(csvCell(''), '')
})

test('listRows filters and sorts like the list view, without a cut (UX-07)', () => {
  const rows = Array.from({ length: 600 }, (_, i) => ({ name: 'n' + String(i).padStart(3, '0'), fee: i }))
  const columns = [
    { key: 'name', label: 'Name' },
    { key: 'fee', label: 'Fee', kind: 'money' as const },
  ]
  assert.equal(listRows(rows, columns, {}).length, 600)
  assert.equal(listRows(rows, columns, { sort: 'fee', dir: 'desc' })[0]!.fee, 599)
  assert.equal(listRows(rows, columns, { q: 'n59' }).length, 10)
})
