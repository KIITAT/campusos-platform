import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, like, sql } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import { trialBalance, type Actor as Books } from '@campusos/module-finance/api'
import { plainPaise } from '@campusos/money'
import {
  HrError, createStaff, createTaxRegime, electRegime, generatePayroll, listDues, listRemittances, remit, setComponent,
  setPayrollSettings, setPtSlabs, setStatutoryIdentity, voidRemittance, type Actor, type PayslipStatutory,
} from './api'
import { payslips } from './schema'
import { pages } from './pages'

/** Remittance of PF, ESI, PT and TDS against their payables (P1-06c step 5). */

let n = 0
const SLUG = 'hr-remit-'

interface College { id: string; admin: Actor; clerk: Actor }

async function college(): Promise<College> {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Remit College', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: i!.id, role: 'institution_admin', name: 'Adm' },
      { email: `clerk@${tag}.test`, institutionId: i!.id, role: 'accounts_staff', name: 'Clerk' },
    ])
    .returning({ id: users.id })
  return {
    id: i!.id,
    admin: { id: people[0]!.id, email: `adm@${tag}.test`, role: 'institution_admin', institutionId: i!.id },
    clerk: { id: people[1]!.id, email: `clerk@${tag}.test`, role: 'accounts_staff', institutionId: i!.id },
  }
}

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

const code = (e: unknown) => (e as HrError).code
const rejectsWith = (p: Promise<unknown>, c: string) => assert.rejects(p, (e) => e instanceof HrError && e.code === c)
const rupees = (paise: number) => plainPaise(paise)

/**
 * April 2026, statutory pay on. A: 40,000 basic plus 16,000 HRA (above the PF
 * ceiling, taxed). B: 12,000 basic (ESI covered). Both work in MH.
 */
async function month(who: ('A' | 'B')[] = ['A', 'B'], tds = true) {
  const c = await college()
  await setPayrollSettings(c.admin, { prorationBasis: 'calendar', statutoryFrom: '2026-03', pfRegistered: true, esiRegistered: true })
  await setPtSlabs(c.admin, { state: 'MH', effectiveFrom: '2026-03', slabs: [{ from: '0', amount: '200' }] })
  const regime = await createTaxRegime(c.admin, {
    code: 'TEST', name: 'Test regime', yearStartsMonth: 4, standardDeduction: '50000', cessBp: 400, rebateUpTo: '500000',
    slabs: [{ from: '0', to: '300000', rateBp: 0 }, { from: '300000', to: '600000', rateBp: 500 }, { from: '600000', rateBp: 1000 }],
  })
  for (const w of who) {
    const s = await createStaff(c.admin, { employeeCode: `${w}-1`, name: `Person ${w}`, designation: 'Lecturer', joinedOn: '2026-01-01' })
    await setStatutoryIdentity(c.admin, { staffId: s.id, pfMember: true, uan: `10020030040${w === 'A' ? 1 : 2}`, workState: 'MH' })
    const basic = w === 'A' ? '40000' : '12000'
    await setComponent(c.admin, { staffId: s.id, code: 'basic', label: 'Basic', kind: 'earning', amount: basic, effectiveFrom: '2026-01-01', wageClass: 'wage' })
    if (w === 'A') {
      await setComponent(c.admin, { staffId: s.id, code: 'hra', label: 'HRA', kind: 'earning', amount: '16000', effectiveFrom: '2026-01-01', wageClass: 'excluded' })
      if (tds) await electRegime(c.admin, { staffId: s.id, regimeId: regime.id, taxYear: 2026 })
    }
  }
  const run = await generatePayroll(c.admin, { period: '2026-04' })
  assert.deepEqual(run.failed, [])
  return c
}

const slips = (c: College) => withTenant(c.id, (tx) => tx.select().from(payslips).where(eq(payslips.institutionId, c.id)))
const balances = async (c: College) => {
  const tb = await trialBalance(c.admin as unknown as Books, {})
  return { bal: (acct: string) => tb.rows.find((r) => r.code === acct)?.balancePaise ?? 0, diff: tb.differencePaise }
}
const dueOf = async (c: College, head: string, state: string | null = null) =>
  (await listDues(c.admin, '2026-04')).find((d) => d.head === head && d.state === state)!

const base = { period: '2026-04', paidOn: '2026-05-10', paidFrom: 'bank' }
const TDS = { head: 'tds', bsrCode: '0510308', challanSerial: '00123' }

test('what is due equals what the payslips credited to each payable', async () => {
  const c = await month()
  const rows = await slips(c)
  const lines = (code: string) => rows.reduce((t, r) => t + ((r.lines as { code: string; appliedPaise: number }[]).find((l) => l.code === code)?.appliedPaise ?? 0), 0)
  const emp = (r: (typeof rows)[number]) => (r.statutory as PayslipStatutory).employer
  const admin = rows.reduce((t, r) => t + emp(r).pfAdminPaise, 0)
  const pfEmployer = rows.reduce((t, r) => t + emp(r).epsPaise + emp(r).epfPaise + emp(r).edliPaise + emp(r).pfAdminPaise, 0)
  const topUp = Math.max(0, 50_000 - admin)
  const pf = await dueOf(c, 'pf')
  assert.equal(pf.adminTopUpPaise, topUp)
  assert.equal(pf.duePaise, lines('pf_employee') + pfEmployer + topUp)
  const esi = await dueOf(c, 'esi')
  assert.equal(esi.duePaise, lines('esi_employee') + rows.reduce((t, r) => t + emp(r).esiPaise, 0))
  const pt = await dueOf(c, 'pt', 'MH')
  assert.equal(pt.duePaise, lines('professional_tax'))
  const tds = await dueOf(c, 'tds')
  assert.equal(tds.duePaise, lines('income_tax'))
  assert.ok(tds.duePaise > 0)
  const { bal, diff } = await balances(c)
  assert.equal(bal('2210'), pf.duePaise - pf.adminTopUpPaise)
  assert.equal(bal('2220'), esi.duePaise)
  assert.equal(bal('2230'), pt.duePaise)
  assert.equal(bal('2240'), tds.duePaise)
  assert.equal(diff, 0)
})

test('the EPF administration charge has a floor, posted once at the first remittance (NEW-50)', async () => {
  const c = await month(['A'], false)
  const [slip] = await slips(c)
  assert.equal((slip!.statutory as PayslipStatutory).employer.pfAdminPaise, 7_500)
  const before = await balances(c)
  const pf = await dueOf(c, 'pf')
  assert.equal(pf.adminTopUpPaise, 42_500)
  await remit(c.admin, { ...base, head: 'pf', amount: rupees(100_000), challanRef: 'PF-1' })
  const first = await balances(c)
  assert.equal(first.bal('5110') - before.bal('5110'), 42_500)
  assert.equal(first.bal('2210') - before.bal('2210'), 42_500 - 100_000)
  assert.equal((await dueOf(c, 'pf')).duePaise, pf.duePaise)
  await remit(c.admin, { ...base, head: 'pf', amount: rupees(50_000), challanRef: 'PF-2' })
  const second = await balances(c)
  assert.equal(second.bal('5110'), first.bal('5110'), 'no second top-up')
  assert.equal(second.bal('2210') - first.bal('2210'), -50_000)
  assert.equal(second.diff, 0)
})

test('remitting the whole TDS balance clears the payable and the bank pays it', async () => {
  const c = await month()
  const due = await dueOf(c, 'tds')
  const r = await remit(c.admin, { ...base, ...TDS, amount: rupees(due.duePaise), challanRef: 'T-1' })
  assert.equal(r.amountPaise, due.duePaise)
  const { bal, diff } = await balances(c)
  assert.equal(bal('2240'), 0)
  assert.equal(bal('1010'), -due.duePaise)
  assert.equal(diff, 0)
  const after = await dueOf(c, 'tds').catch(() => undefined)
  assert.ok(!after || after.balancePaise === 0)
})

test('each refusal has its own code', async () => {
  const c = await month()
  const esi = await dueOf(c, 'esi')
  const pt = await dueOf(c, 'pt', 'MH')
  await rejectsWith(remit(c.admin, { ...base, head: 'esi', amount: rupees(esi.balancePaise + 1), challanRef: 'E-0' }), 'over_remitted')
  await rejectsWith(remit(c.admin, { ...base, head: 'esi', amount: rupees(esi.balancePaise), paidOn: '2099-01-01', challanRef: 'E-0' }), 'future_date')
  await remit(c.admin, { ...base, head: 'esi', amount: rupees(100), challanRef: 'E-1' })
  await rejectsWith(remit(c.admin, { ...base, head: 'esi', amount: rupees(100), challanRef: 'E-1' }), 'duplicate_challan')
  await rejectsWith(remit(c.admin, { ...base, head: 'pt', amount: rupees(pt.balancePaise), challanRef: 'P-1' }), 'state_rule')
  await rejectsWith(remit(c.admin, { ...base, head: 'esi', state: 'MH', amount: rupees(100), challanRef: 'E-2' }), 'state_rule')
  await rejectsWith(remit(c.admin, { ...base, head: 'tds', amount: rupees(100), challanRef: 'T-0' }), 'challan_required')
  await remit(c.admin, { ...base, head: 'esi', amount: rupees(esi.balancePaise - 100), challanRef: 'E-3' })
  await rejectsWith(remit(c.admin, { ...base, head: 'esi', amount: rupees(1), challanRef: 'E-4' }), 'nothing_due')
})

test('a voided remittance restores the payable and its challan can be entered again', async () => {
  const c = await month()
  const due = await dueOf(c, 'tds')
  const r = await remit(c.admin, { ...base, ...TDS, amount: rupees(due.duePaise), challanRef: 'T-1' })
  await voidRemittance(c.admin, { remittanceId: r.id, reason: 'entered against the wrong month' })
  const { bal, diff } = await balances(c)
  assert.equal(bal('2240'), due.duePaise)
  assert.equal(bal('1010'), 0)
  assert.equal(diff, 0)
  await rejectsWith(voidRemittance(c.admin, { remittanceId: r.id, reason: 'voiding it again' }), 'already_void')
  await remit(c.admin, { ...base, ...TDS, amount: rupees(due.duePaise), challanRef: 'T-1' })
  assert.equal((await listRemittances(c.admin, '2026-04')).length, 2)
})

async function waiting(pattern: string): Promise<number> {
  const r = await authDb.execute<{ n: number }>(
    sql`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and query ilike ${pattern}`,
  )
  return r.rows[0]!.n
}

async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 10_000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

const settle = <T>(p: Promise<T>) =>
  p.then(() => ({ ok: true as const, error: null as unknown }), (error: unknown) => ({ ok: false as const, error }))

test('two parallel remittances of the whole balance: one wins, the payable never goes negative', async () => {
  const c = await month()
  const esi = await dueOf(c, 'esi')
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  let holding!: () => void
  const locked = new Promise<void>((resolve) => (holding = resolve))
  const holder = authDb.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(1213354066, hashtext(${`${c.id}:2026-04-01`}::text))`)
    holding()
    await held
  })
  await locked
  const one = settle(remit(c.admin, { ...base, head: 'esi', amount: rupees(esi.balancePaise), challanRef: 'RACE-1' }))
  const two = settle(remit(c.admin, { ...base, head: 'esi', amount: rupees(esi.balancePaise), challanRef: 'RACE-2' }))
  try {
    await until(async () => (await waiting('%pg_advisory_xact_lock(1213354066%')) >= 2)
  } finally {
    release()
    await holder
  }
  const results = await Promise.all([one, two])
  assert.equal(results.filter((r) => r.ok).length, 1)
  const failed = results.find((r) => !r.ok)!
  assert.equal(code(failed.error), 'nothing_due')
  assert.equal((await balances(c)).bal('2220'), 0)
})

test('only the administrators remit, void or list dues', async () => {
  const c = await month()
  await assert.rejects(() => remit(c.clerk, { ...base, head: 'esi', amount: rupees(100), challanRef: 'E-1' }), (e) => (e as HrError).status === 403)
  await assert.rejects(() => voidRemittance(c.clerk, { remittanceId: crypto.randomUUID(), reason: 'not allowed' }), (e) => (e as HrError).status === 403)
  await assert.rejects(() => listDues(c.clerk, '2026-04'), (e) => (e as HrError).status === 403)
})

test('the Payroll page links each payslip PDF and the statutory files', async () => {
  const c = await month(['A'], false)
  const page = pages.find((p) => p.path === '/payroll')!
  const data = await page.load(c.admin, new Request('http://localhost/payroll?period=2026-04'))
  const sections = page.sections(data) as unknown as { kind: string; title?: string; rows?: string; columns?: { key: string; href?: string }[] }[]
  const slipTable = sections.find((s) => s.kind === 'table' && s.rows === 'payslips')!
  assert.ok(slipTable.columns!.some((col) => col.href?.includes('payslip.pdf?payslipId={id}')))
  const files = sections.find((s) => s.title === 'Files for this month')!
  assert.ok(files.columns!.some((col) => col.href?.includes('/payroll/{file}?period={period}')))
})
