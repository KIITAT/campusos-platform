import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, like } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import { printedText } from '@campusos/module-framework/pdf'
import { plainPaise } from '@campusos/money'
import {
  HrError, createStaff, createTaxRegime, electRegime, generatePayroll, quarterMonths, remit, setComponent,
  setPayrollSettings, setStatutoryIdentity, taxStatementDocument, tdsQuarterFile, voidRemittance, type Actor,
} from './api'
import type { TaxRecord } from './api/tds'
import { payslips } from './schema'

/** The annual tax statement and the 24Q working statement (P1-06c step 7). */

let n = 0
const SLUG = 'hr-returns-'

interface College { id: string; admin: Actor; clerk: Actor; faculty: Actor; other: Actor; staffId: string; otherId: string }

async function college(pan: string | null = 'ABCDE1234F'): Promise<College> {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Returns College', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: i!.id, role: 'institution_admin', name: 'Adm' },
      { email: `clerk@${tag}.test`, institutionId: i!.id, role: 'accounts_staff', name: 'Clerk' },
      { email: `fac@${tag}.test`, institutionId: i!.id, role: 'faculty', name: 'Fac' },
      { email: `oth@${tag}.test`, institutionId: i!.id, role: 'faculty', name: 'Oth' },
    ])
    .returning({ id: users.id })
  const mk = (k: number, role: Actor['role']): Actor => ({ id: people[k]!.id, email: null, role, institutionId: i!.id })
  const c: College = { id: i!.id, admin: mk(0, 'institution_admin'), clerk: mk(1, 'accounts_staff'), faculty: mk(2, 'faculty'), other: mk(3, 'faculty'), staffId: '', otherId: '' }
  // The tax record on a payslip is kept when statutory pay is on (P1-06b).
  await setPayrollSettings(c.admin, { prorationBasis: 'calendar', statutoryFrom: '2026-03', pfRegistered: false, esiRegistered: false })
  const regime = await createTaxRegime(c.admin, {
    code: 'TEST', name: 'Test regime', yearStartsMonth: 4, standardDeduction: '50000', cessBp: 400, rebateUpTo: '500000',
    slabs: [{ from: '0', to: '300000', rateBp: 0 }, { from: '300000', to: '600000', rateBp: 500 }, { from: '600000', rateBp: 1000 }],
  })
  const s = await createStaff(c.admin, { employeeCode: 'A-1', name: 'Ravi Kumar', designation: 'Lecturer', joinedOn: '2025-01-01', userId: c.faculty.id })
  const o = await createStaff(c.admin, { employeeCode: 'B-1', name: 'Sita Rao', designation: 'Lecturer', joinedOn: '2025-01-01', userId: c.other.id })
  c.staffId = s.id
  c.otherId = o.id
  if (pan) await setStatutoryIdentity(c.admin, { staffId: s.id, pan })
  await setComponent(c.admin, { staffId: s.id, code: 'basic', label: 'Basic', kind: 'earning', amount: '56000', effectiveFrom: '2025-01-01' })
  await setComponent(c.admin, { staffId: o.id, code: 'basic', label: 'Basic', kind: 'earning', amount: '30000', effectiveFrom: '2025-01-01' })
  for (const year of [2025, 2026]) await electRegime(c.admin, { staffId: s.id, regimeId: regime.id, taxYear: year })
  return c
}

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

const run = async (c: College, ...periods: string[]) => {
  for (const p of periods) assert.deepEqual((await generatePayroll(c.admin, { period: p })).failed, [])
}
const slips = (c: College) => withTenant(c.id, (tx) => tx.select().from(payslips).where(eq(payslips.staffId, c.staffId)))
const tdsOf = (s: Awaited<ReturnType<typeof slips>>[number]) => (s.lines as { code: string; appliedPaise: number }[]).find((l) => l.code === 'income_tax')?.appliedPaise ?? 0
const tdsByMonth = async (c: College) => Object.fromEntries((await slips(c)).map((s) => [s.period.slice(0, 7), tdsOf(s)]))
const rows = (csv: string) => csv.split('\n').map((l) => l.split(','))
const text = async (bytes: Uint8Array) => (await printedText(bytes)).join('|')
const challan = { head: 'tds', bsrCode: '0510308', challanSerial: '00123', paidOn: '2026-05-07', paidFrom: 'bank' }

test('a quarter lists deductees, challans and the difference', async () => {
  const c = await college()
  await run(c, '2026-04', '2026-05', '2026-06')
  const tds = await tdsByMonth(c)
  assert.ok(tds['2026-04']! > 0 && tds['2026-05']! > 0 && tds['2026-06']! > 0)
  const first = await tdsQuarterFile(c.admin, 2026, 1)
  assert.equal(first.name, 'tds-24q-2026-Q1.csv')
  assert.equal(first.content.split('\n')[0], 'Record,PAN,Name,Month,Gross,Tax deducted,BSR code,Challan serial,Deposited on,Amount deposited')
  const people = rows(first.content).filter((r) => r[0] === 'DEDUCTEE')
  assert.equal(people.length, 3)
  assert.equal(people[0]![1], 'ABCDE1234F')
  assert.equal(people[0]![3], '2026-04')
  const deducted = tds['2026-04']! + tds['2026-05']! + tds['2026-06']!
  const total = rows(first.content).find((r) => r[0] === 'TOTAL' && r[1] === 'Deducted')!
  assert.equal(total[5], plainPaise(deducted))

  await remit(c.admin, { ...challan, period: '2026-04', amount: plainPaise(tds['2026-04']!), challanRef: 'T-1' })
  const second = rows((await tdsQuarterFile(c.admin, 2026, 1)).content)
  assert.equal(second.filter((r) => r[0] === 'CHALLAN').length, 1)
  assert.equal(second.find((r) => r[0] === 'TOTAL' && r[1] === 'Deposited')![9], plainPaise(tds['2026-04']!))
  assert.equal(second.find((r) => r[0] === 'TOTAL' && r[1] === 'Difference')![5], plainPaise(tds['2026-05']! + tds['2026-06']!))
})

test('a person without a PAN is listed as PANNOTAVBL', async () => {
  const c = await college(null)
  await run(c, '2026-04')
  const people = rows((await tdsQuarterFile(c.admin, 2026, 1)).content).filter((r) => r[0] === 'DEDUCTEE')
  assert.equal(people[0]![1], 'PANNOTAVBL')
})

test('quarters follow the Indian financial year', () => {
  assert.deepEqual(quarterMonths(2026, 1), ['2026-04-01', '2026-05-01', '2026-06-01'])
  assert.deepEqual(quarterMonths(2026, 4), ['2027-01-01', '2027-02-01', '2027-03-01'])
})

test('a voided remittance is not a deposit', async () => {
  const c = await college()
  await run(c, '2026-04')
  const tds = await tdsByMonth(c)
  const r = await remit(c.admin, { ...challan, period: '2026-04', amount: plainPaise(tds['2026-04']!), challanRef: 'T-1' })
  await voidRemittance(c.admin, { remittanceId: r.id, reason: 'entered against the wrong month' })
  const out = rows((await tdsQuarterFile(c.admin, 2026, 1)).content)
  assert.equal(out.filter((x) => x[0] === 'CHALLAN').length, 0)
  assert.equal(out.find((x) => x[0] === 'TOTAL' && x[1] === 'Deposited')![9], '0.00')
})

test('the annual statement names the form, the PAN, the regime and the tax', async () => {
  const c = await college()
  await run(c, '2026-04', '2026-05')
  const all = await slips(c)
  const last = all.sort((a, b) => a.period.localeCompare(b.period)).at(-1)!
  const record = last.tax as TaxRecord
  const sum = all.reduce((t, s) => t + tdsOf(s), 0)
  const d = await taxStatementDocument(c.admin, c.staffId, 2026)
  assert.equal(d.name, 'tax-statement-A-1-2026.pdf')
  const t = await text(d.bytes)
  for (const s of ['Form 130', 'ABCDE1234F', 'TEST', plainPaise(record.annualTaxPaise), plainPaise(sum)]) assert.ok(t.includes(s), `${s} in ${t}`)
  assert.ok(t.includes('Part A (the TRACES certificate of tax deposited) is issued from TRACES and is not produced by CampusOS.'))
})

test('an earlier tax year is a Form 16 Part B', async () => {
  const c = await college()
  await run(c, '2026-03')
  const t = await text((await taxStatementDocument(c.admin, c.staffId, 2025)).bytes)
  assert.ok(t.includes('Form 16 (Part B)'), t)
})

test('who may fetch the statements', async () => {
  const c = await college()
  await run(c, '2026-04')
  assert.ok((await taxStatementDocument(c.faculty, c.staffId, 2026)).bytes.length > 0)
  await assert.rejects(() => taxStatementDocument(c.other, c.staffId, 2026), (e) => e instanceof HrError && e.status === 404 && e.code === 'no_such_staff')
  assert.ok((await taxStatementDocument(c.clerk, c.staffId, 2026)).bytes.length > 0)
  await assert.rejects(() => taxStatementDocument(c.admin, c.staffId, 2024), (e) => e instanceof HrError && e.status === 404 && e.code === 'no_such_statement')
  await assert.rejects(() => tdsQuarterFile(c.clerk, 2026, 1), (e) => e instanceof HrError && e.status === 403 && e.code === 'forbidden')
})

test('a quarter outside 1 to 4 is refused', async () => {
  const c = await college()
  await assert.rejects(() => tdsQuarterFile(c.admin, 2026, 5), (e) => e instanceof HrError && e.status === 400 && e.code === 'bad_period')
})
