import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { and, eq, like, sql } from 'drizzle-orm'
import { auditLog, authDb, institutions, users, withTenant } from '@campusos/db'
import { trialBalance, type Actor as Books } from '@campusos/module-finance/api'
import { HrError, createStaff, createTaxRegime, electRegime, generatePayroll, getStatutoryIdentity, listPtSlabs, listStaff, setComponent, setPayrollSettings, setPtSlabs, setStatutoryIdentity, type Actor } from './api'
import { payslips, ptSlabs, staff } from './schema'
import { payPages } from './pages-pay'

/**
 * Statutory pay (P1-06a): the schema, then the run, the posting and the
 * operations, in the order the plan builds them. A fresh institution per
 * test: the journal is append-only.
 */

let n = 0
const SLUG = 'hr-stat-'

interface College { id: string; admin: Actor; clerk: Actor }

async function college(): Promise<College> {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Statutory College', allowedEmailDomains: [`${tag}.test`] })
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

const hire = (c: College, over: Record<string, unknown> = {}) =>
  createStaff(c.admin, { employeeCode: 'E-1', name: 'A Lecturer', designation: 'Lecturer', joinedOn: '2026-01-01', ...over })

const saysDb = (re: RegExp) => (e: unknown) => {
  let text = ''
  for (let x: unknown = e; x instanceof Error; x = (x as { cause?: unknown }).cause) text += x.message + '\n'
  return re.test(text)
}

test('hr_pt_slabs is isolated between institutions', async () => {
  const a = await college()
  const b = await college()
  await withTenant(a.id, (tx) =>
    tx.insert(ptSlabs).values({ institutionId: a.id, state: 'KA', effectiveFrom: '2026-04-01', fromPaise: 0, toPaise: null, amountPaise: 20000 }),
  )
  const seen = await withTenant(b.id, (tx) => tx.select().from(ptSlabs))
  assert.equal(seen.length, 0)
  await assert.rejects(
    () => withTenant(b.id, (tx) => tx.insert(ptSlabs).values({ institutionId: a.id, state: 'KA', effectiveFrom: '2026-05-01', fromPaise: 0, amountPaise: 1 })),
    saysDb(/row-level security|violates/i),
  )
})

test('the database refuses a malformed PAN', async () => {
  const c = await college()
  const s = await hire(c)
  await assert.rejects(
    () => withTenant(c.id, (tx) => tx.update(staff).set({ pan: 'ABCDE1234' }).where(eq(staff.id, s.id))),
    saysDb(/hr_staff_pan/),
  )
})

// --- the run (Step 4)

const turnOn = (c: College, over: Record<string, unknown> = {}) =>
  setPayrollSettings(c.admin, { prorationBasis: 'calendar', statutoryFrom: '2026-03', pfRegistered: true, esiRegistered: true, ...over })

const member = (c: College, staffId: string) => setStatutoryIdentity(c.admin, { staffId, pfMember: true })

const pay = (c: College, staffId: string, code: string, kind: 'earning' | 'deduction', amount: string, wageClass: 'wage' | 'excluded' | 'outside' = 'wage', from = '2026-01-01') =>
  setComponent(c.admin, { staffId, code, label: code, kind, amount, effectiveFrom: from, wageClass })

const slipOf = (c: College, staffId: string, period: string) =>
  withTenant(c.id, async (tx) => (await tx.select().from(payslips).where(and(eq(payslips.staffId, staffId), eq(payslips.period, period))))[0])

test('a statutory month deducts PF first and stores the record', async () => {
  const c = await college()
  const s = await hire(c)
  await turnOn(c)
  await member(c, s.id)
  await pay(c, s.id, 'basic', 'earning', '40000')
  await pay(c, s.id, 'hra', 'earning', '16000', 'excluded')
  const run = await generatePayroll(c.admin, { period: '2026-03' })
  assert.deepEqual(run.failed, [])
  const slip = (await slipOf(c, s.id, '2026-03-01'))!
  const lines = slip.lines as { code: string; appliedPaise: number }[]
  assert.equal(lines.find((l) => l.code === 'pf_employee')!.appliedPaise, 180_000)
  assert.equal((slip.statutory as { employer: { epsPaise: number } }).employer.epsPaise, 125_000)
  assert.equal(slip.employerCostPaise, 195_000)
  assert.equal(slip.netPaise, 5_600_000 - 180_000)
})

test('a manual pf deduction stops that person, not the run', async () => {
  const c = await college()
  const a = await hire(c, { employeeCode: 'A-1', name: 'Clean' })
  const b = await hire(c, { employeeCode: 'B-1', name: 'Manual Pf' })
  await turnOn(c)
  for (const p of [a, b]) {
    await member(c, p.id)
    await pay(c, p.id, 'basic', 'earning', '40000')
  }
  await pay(c, b.id, 'pf', 'deduction', '4800')
  const run = await generatePayroll(c.admin, { period: '2026-03' })
  assert.equal(run.failed.length, 1)
  assert.equal(run.failed[0]!.staffId, b.id)
  assert.equal(run.failed[0]!.message, 'remove the manual pf deduction: statutory pay computes it')
  assert.ok(await slipOf(c, a.id, '2026-03-01'))
  assert.equal(await slipOf(c, b.id, '2026-03-01'), undefined)
})

test('a month before statutory_from is unchanged', async () => {
  const c = await college()
  const b = await hire(c, { employeeCode: 'B-1' })
  await turnOn(c)
  await member(c, b.id)
  await pay(c, b.id, 'basic', 'earning', '40000')
  await pay(c, b.id, 'pf', 'deduction', '4800')
  const run = await generatePayroll(c.admin, { period: '2026-02' })
  assert.deepEqual(run.failed, [])
  const slip = (await slipOf(c, b.id, '2026-02-01'))!
  assert.equal(slip.statutory, null)
  assert.equal(slip.employerCostPaise, 0)
  assert.equal(slip.deductionsPaise, 480_000)
})

test('ESI coverage holds for the period', async () => {
  const c = await college()
  const s = await hire(c)
  await turnOn(c, { statutoryFrom: '2026-10', pfRegistered: false })
  await pay(c, s.id, 'basic', 'earning', '20000', 'wage', '2026-01-01')
  assert.deepEqual((await generatePayroll(c.admin, { period: '2026-10' })).failed, [])
  await pay(c, s.id, 'basic', 'earning', '23000', 'wage', '2026-11-01')
  assert.deepEqual((await generatePayroll(c.admin, { period: '2026-11' })).failed, [])
  const nov = (await slipOf(c, s.id, '2026-11-01'))!
  assert.equal((nov.statutory as { esiCovered: boolean }).esiCovered, true)
  const lines = nov.lines as { code: string; appliedPaise: number }[]
  assert.equal(lines.find((l) => l.code === 'esi_employee')!.appliedPaise, 17_300)
})

// --- posting (Step 5)

test('a statutory payslip posts each head to its own payable', async () => {
  const c = await college()
  const s = await hire(c)
  await turnOn(c, { statutoryFrom: '2026-04' })
  await member(c, s.id)
  await pay(c, s.id, 'basic', 'earning', '40000')
  await pay(c, s.id, 'hra', 'earning', '16000', 'excluded')
  const regime = await createTaxRegime(c.admin, {
    code: 'TEST', name: 'Test regime', yearStartsMonth: 4, standardDeduction: '50000', cessBp: 400, rebateUpTo: '500000',
    slabs: [{ from: '0', to: '300000', rateBp: 0 }, { from: '300000', to: '600000', rateBp: 500 }, { from: '600000', rateBp: 1000 }],
  })
  await electRegime(c.admin, { staffId: s.id, regimeId: regime.id, taxYear: 2026 })
  const run = await generatePayroll(c.admin, { period: '2026-04' })
  assert.deepEqual(run.failed, [])
  const lines = run.payslips[0]!.lines as { code: string; appliedPaise: number }[]
  const tds = lines.find((l) => l.code === 'income_tax')!.appliedPaise
  assert.ok(tds > 0)
  const tb = await trialBalance(c.admin as unknown as Books, {})
  const bal = (code: string) => tb.rows.find((r) => r.code === code)?.balancePaise ?? 0
  assert.equal(bal('2210'), 375_000)
  assert.equal(bal('5110'), 195_000)
  assert.equal(bal('2240'), tds)
  assert.equal(bal('2200'), 0)
  assert.equal(tb.differencePaise, 0)
})

// --- operations (Step 6)

const code = (e: unknown) => (e as HrError).code

test("an accounts clerk cannot read a person's PAN", async () => {
  const c = await college()
  const s = await hire(c)
  await assert.rejects(() => getStatutoryIdentity(c.clerk, s.id), (e) => (e as HrError).status === 403)
})

test('a malformed PAN is refused with the fixed message', async () => {
  const c = await college()
  const s = await hire(c)
  await assert.rejects(
    () => setStatutoryIdentity(c.admin, { staffId: s.id, pan: 'ABCDE1234' }),
    (e) => (e as Error).name === 'ZodError' && /a PAN is five letters, four digits and a letter/.test((e as Error).message),
  )
})

test('setting statutory details audits field names, never values', async () => {
  const c = await college()
  const s = await hire(c)
  const got = await setStatutoryIdentity(c.admin, { staffId: s.id, pan: 'abcde1234f', pfMember: true })
  assert.equal(got.pan, 'ABCDE1234F')
  const rows = await authDb
    .select({ detail: auditLog.detail, reason: auditLog.reason })
    .from(auditLog)
    .where(and(eq(auditLog.institutionId, c.id), eq(auditLog.action, 'hr.statutory_identity_set')))
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0]!.detail, { changed: ['pan', 'pfMember'] })
  assert.ok(!JSON.stringify(rows[0]).includes('ABCDE1234F'))
  assert.equal((await getStatutoryIdentity(c.admin, s.id)).pan, 'ABCDE1234F')
})

test('overlapping PT slabs are refused', async () => {
  const c = await college()
  await assert.rejects(
    () => setPtSlabs(c.admin, { state: 'KA', effectiveFrom: '2026-04', slabs: [{ from: '0', to: '25000', amount: '0' }, { from: '20000', amount: '200' }] }),
    (e) => code(e) === 'slabs_overlap',
  )
  const ok = await setPtSlabs(c.admin, { state: 'KA', effectiveFrom: '2026-04', slabs: [{ from: '0', to: '24999', amount: '0' }, { from: '25000', amount: '200', february: '300' }] })
  assert.equal(ok.length, 2)
  assert.equal((await listPtSlabs(c.admin)).length, 2)
})

test('listStaff never returns a PAN', async () => {
  const c = await college()
  const s = await hire(c)
  await setStatutoryIdentity(c.admin, { staffId: s.id, pan: 'ABCDE1234F' })
  const rows = await listStaff(c.admin)
  assert.ok(rows.length > 0)
  for (const r of rows) assert.ok(!('pan' in r) && !('bankAccount' in r))
})

test('statutory settings are saved together and audited when they change', async () => {
  const c = await college()
  await setPayrollSettings(c.admin, { prorationBasis: 'calendar', statutoryFrom: '2026-03', pfRegistered: true })
  const rows = await authDb
    .select({ detail: auditLog.detail })
    .from(auditLog)
    .where(and(eq(auditLog.institutionId, c.id), eq(auditLog.action, 'hr.statutory_settings_set')))
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0]!.detail, {
    from: { statutoryFrom: null, pfRegistered: false, esiRegistered: false, defaultRegimeId: null },
    to: { statutoryFrom: '2026-03-01', pfRegistered: true, esiRegistered: false, defaultRegimeId: null },
  })
  await setPayrollSettings(c.admin, { prorationBasis: 'days_30', statutoryFrom: '2026-03', pfRegistered: true })
  assert.equal(
    (await authDb.select({ id: auditLog.id }).from(auditLog).where(and(eq(auditLog.institutionId, c.id), eq(auditLog.action, 'hr.statutory_settings_set')))).length,
    1,
  )
})

// --- review findings (P1-06a REVIEW)

const esiOf = (slip: { statutory: unknown } | undefined) => (slip!.statutory as { esiCovered: boolean | null }).esiCovered

test('a person decided out of ESI stays out for the period after a month without ESI (review finding 1)', async () => {
  const c = await college()
  const s = await hire(c)
  await turnOn(c, { statutoryFrom: '2026-10', esiRegistered: false })
  await member(c, s.id)
  await pay(c, s.id, 'basic', 'earning', '23000')
  await generatePayroll(c.admin, { period: '2026-10' })
  assert.equal(esiOf(await slipOf(c, s.id, '2026-10-01')), null)
  await turnOn(c, { statutoryFrom: '2026-10', esiRegistered: true })
  await generatePayroll(c.admin, { period: '2026-11' })
  assert.equal(esiOf(await slipOf(c, s.id, '2026-11-01')), false)
  await pay(c, s.id, 'basic', 'earning', '20000', 'wage', '2026-12-01')
  await generatePayroll(c.admin, { period: '2026-12' })
  const dec = await slipOf(c, s.id, '2026-12-01')
  assert.equal(esiOf(dec), false)
  assert.ok(!(dec!.lines as { code: string }[]).some((l) => l.code === 'esi_employee'))
})

test('an earlier month run after a later one follows the later month’s ESI decision (review finding 2)', async () => {
  const c = await college()
  const s = await hire(c)
  await turnOn(c, { statutoryFrom: '2026-10' })
  await member(c, s.id)
  await pay(c, s.id, 'basic', 'earning', '20000')
  await pay(c, s.id, 'basic', 'earning', '23000', 'wage', '2026-11-01')
  await generatePayroll(c.admin, { period: '2026-11' })
  assert.equal(esiOf(await slipOf(c, s.id, '2026-11-01')), false)
  await generatePayroll(c.admin, { period: '2026-10' })
  assert.equal(esiOf(await slipOf(c, s.id, '2026-10-01')), false)
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

test('a run waits for another month of the same ESI contribution period (review finding 2)', async () => {
  const c = await college()
  const s = await hire(c)
  await turnOn(c, { statutoryFrom: '2026-10' })
  await member(c, s.id)
  await pay(c, s.id, 'basic', 'earning', '20000')
  // Hold the contribution period's lock as another month's run would.
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  let holding!: () => void
  const locked = new Promise<void>((resolve) => (holding = resolve))
  const holder = authDb.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(1213354066, hashtext(${`${c.id}:esi:2026-10-01`}::text))`)
    holding()
    await held
  })
  await locked
  let settled = false
  const run = generatePayroll(c.admin, { period: '2026-11' }).finally(() => (settled = true))
  try {
    await until(async () => settled || (await waiting('%pg_advisory_xact_lock(1213354066%')) >= 1)
    assert.equal(settled, false, 'the run went ahead while another month of its contribution period held the lock')
  } finally {
    release()
    await holder
  }
  assert.deepEqual((await run).failed, [])
})

test('the pay setup form shows the PF and ESI registration it saves (review finding 3)', async () => {
  const c = await college()
  await turnOn(c)
  const page = payPages.find((p) => p.path === '/payroll/setup')!
  const data = await page.load(c.admin, new Request('http://localhost/payroll/setup'))
  const form = page.sections(data).find((x) => x.kind === 'form' && x.title === 'Pay basis and statutory pay') as unknown as { fields: { name: string; value?: string }[] }
  assert.equal(form.fields.find((f) => f.name === 'pfRegistered')!.value, 'true')
  assert.equal(form.fields.find((f) => f.name === 'esiRegistered')!.value, 'true')
})
