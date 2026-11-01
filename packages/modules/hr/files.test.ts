import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HrError, bankAdviceFile, csvCell, ecrFile, ecrName, esiFile, type EcrRow, type EsiRow } from './api'

/** The statutory file builders (P1-06c): pure text from rows, no database. */

test('csvCell neutralises formulas and quotes separators', () => {
  assert.equal(csvCell('=SUM(A1)'), "'=SUM(A1)")
  assert.equal(csvCell('A, B'), '"A, B"')
  assert.equal(csvCell('say "hi"'), '"say ""hi"""')
  assert.equal(csvCell('plain'), 'plain')
})

test("ecrName keeps A-Z and single spaces", () => {
  assert.equal(ecrName("Anita  D'Souza-Rao 2nd"), 'ANITA DSOUZARAO ND')
})

const ecrRow = (over: Partial<EcrRow> = {}): EcrRow => ({
  employeeCode: 'E1', name: 'Ravi Kumar', uan: '100200300400', grossPaise: 4_000_050,
  epfWagesPaise: 1_500_000, epsWagesPaise: 1_500_000, edliWagesPaise: 1_500_000,
  epfPaise: 180_000, epsPaise: 125_000, diffPaise: 55_000, ncpDays: 2, ...over,
})

test('ecrFile golden line, joined by one newline, no trailing newline', () => {
  const line = '100200300400#~#RAVI KUMAR#~#40001#~#15000#~#15000#~#15000#~#1800#~#1250#~#550#~#2#~#0'
  assert.equal(ecrFile([ecrRow()]), line)
  assert.equal(ecrFile([ecrRow(), ecrRow({ employeeCode: 'E2' })]), `${line}\n${line}`)
})

test('ecrFile refuses the whole file when a UAN is missing', () => {
  assert.throws(
    () => ecrFile([ecrRow(), ecrRow({ employeeCode: 'E2', uan: null }), ecrRow({ employeeCode: 'E9', uan: null })]),
    (e) => e instanceof HrError && e.status === 409 && e.code === 'incomplete_details' && e.message === 'UAN missing for: E2, E9',
  )
})

const esiRow = (over: Partial<EsiRow> = {}): EsiRow => ({
  employeeCode: 'E1', name: 'Sita', esiNumber: '1234567890', days: 26, wagesPaise: 1_800_000,
  leftOn: null, monthEnd: '2026-04-30', ...over,
})
const HEADER = 'IP Number,IP Name,No of Days for which wages paid/payable during the month,Total Monthly Wages,Reason Code for Zero workings days(numeric only; provide 0 for all other reasons),Last Working Day'

test('esiFile golden rows and reason codes', () => {
  assert.equal(esiFile([esiRow()]), `${HEADER}\n1234567890,Sita,26,18000,0,`)
  assert.equal(esiFile([esiRow({ days: 0, leftOn: '2026-04-10' })]).split('\n')[1], '1234567890,Sita,0,18000,2,10/04/2026')
  assert.equal(esiFile([esiRow({ days: 0 })]).split('\n')[1], '1234567890,Sita,0,18000,1,')
})

test('bankAdviceFile golden row and formula safety', () => {
  const row = { employeeCode: 'E1', name: 'Ravi Kumar', account: '123456789012', ifsc: 'HDFC0001234', netPaise: 3_500_050 }
  const head = 'Employee code,Beneficiary name,Account number,IFSC,Amount,Narration'
  assert.equal(bankAdviceFile([row], '2026-04'), `${head}\nE1,Ravi Kumar,123456789012,HDFC0001234,35000.50,Salary 2026-04`)
  assert.equal(bankAdviceFile([{ ...row, name: '=cmd' }], '2026-04').split('\n')[1], "E1,'=cmd,123456789012,HDFC0001234,35000.50,Salary 2026-04")
  assert.throws(() => bankAdviceFile([{ ...row, ifsc: null }], '2026-04'), (e) => e instanceof HrError && e.message === 'Bank account or IFSC missing for: E1')
})
