import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { and, eq, like } from 'drizzle-orm'
import { auditLog, authDb, institutions, users, withTenant } from '@campusos/db'
import { HrError, createStaff, createTaxRegime, getPayrollSettings, listTaxRegimes, setPayrollSettings, setPreviousEmployment, setTaxDeclarations, type Actor } from './api'
import { taxDeclarations, taxPreviousEmployment, taxRegimes, taxSurcharges } from './schema'

/**
 * The TDS estimator (P1-06b): the tables, the operations, the run and the
 * page, in the order the plan builds them. A fresh institution per test: the
 * journal is append-only.
 */

let n = 0
const SLUG = 'hr-tds-'

interface College { id: string; admin: Actor; clerk: Actor }

async function college(): Promise<College> {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Tax College', allowedEmailDomains: [`${tag}.test`] })
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

test('the tax tables are isolated between institutions', async () => {
  const a = await college()
  const b = await college()
  const s = await hire(a)
  const [regime] = await withTenant(a.id, (tx) =>
    tx.insert(taxRegimes).values({ institutionId: a.id, code: 'NEW', name: 'New regime' }).returning(),
  )
  await withTenant(a.id, async (tx) => {
    await tx.insert(taxDeclarations).values({ institutionId: a.id, staffId: s.id, taxYear: 2026, head: '80c', declaredPaise: 100 })
    await tx.insert(taxPreviousEmployment).values({ institutionId: a.id, staffId: s.id, taxYear: 2026, incomePaise: 100, tdsPaise: 0 })
    await tx.insert(taxSurcharges).values({ institutionId: a.id, regimeId: regime!.id, abovePaise: 100, rateBp: 1000 })
  })
  const seen = await withTenant(b.id, async (tx) => [
    (await tx.select().from(taxDeclarations)).length,
    (await tx.select().from(taxPreviousEmployment)).length,
    (await tx.select().from(taxSurcharges)).length,
  ])
  assert.deepEqual(seen, [0, 0, 0])
  await assert.rejects(
    () => withTenant(b.id, (tx) => tx.insert(taxDeclarations).values({ institutionId: a.id, staffId: s.id, taxYear: 2027, head: '80c', declaredPaise: 1 })),
    saysDb(/row-level security|violates/i),
  )
  await assert.rejects(
    () => withTenant(b.id, (tx) => tx.insert(taxPreviousEmployment).values({ institutionId: a.id, staffId: s.id, taxYear: 2027, incomePaise: 1, tdsPaise: 0 })),
    saysDb(/row-level security|violates/i),
  )
  await assert.rejects(
    () => withTenant(b.id, (tx) => tx.insert(taxSurcharges).values({ institutionId: a.id, regimeId: regime!.id, abovePaise: 200, rateBp: 1000 })),
    saysDb(/row-level security|violates/i),
  )
})

test('the database refuses a proved amount below zero', async () => {
  const c = await college()
  const s = await hire(c)
  const [row] = await withTenant(c.id, (tx) =>
    tx.insert(taxDeclarations).values({ institutionId: c.id, staffId: s.id, taxYear: 2026, head: '80c', declaredPaise: 100 }).returning(),
  )
  await assert.rejects(
    () => withTenant(c.id, (tx) => tx.update(taxDeclarations).set({ provedPaise: -1 }).where(eq(taxDeclarations.id, row!.id))),
    saysDb(/hr_tax_declarations_amounts/),
  )
})

// --- regimes, settings, declarations and previous employment (Step 3)

const NEW_REGIME = {
  code: 'NEW27', name: 'New regime 2026-27', yearStartsMonth: 4, standardDeduction: '75000', cessBp: 400,
  rebateUpTo: '1200000', rebateMax: '60000', rebateMarginalRelief: true,
  slabs: [
    { from: '0', to: '400000', rateBp: 0 },
    { from: '400000', to: '800000', rateBp: 500 },
    { from: '800000', to: '1200000', rateBp: 1000 },
    { from: '1200000', to: '1600000', rateBp: 1500 },
    { from: '1600000', to: '2000000', rateBp: 2000 },
    { from: '2000000', to: '2400000', rateBp: 2500 },
    { from: '2400000', rateBp: 3000 },
  ],
  surcharges: [
    { above: '5000000', rateBp: 1000 },
    { above: '10000000', rateBp: 1500 },
    { above: '20000000', rateBp: 2500 },
  ],
}
const OLD_REGIME = {
  code: 'OLD27', name: 'Old regime 2026-27', yearStartsMonth: 4, standardDeduction: '50000', cessBp: 400,
  rebateUpTo: '500000', rebateMax: '12500', allowsDeductions: true,
  slabs: [
    { from: '0', to: '250000', rateBp: 0 },
    { from: '250000', to: '500000', rateBp: 500 },
    { from: '500000', to: '1000000', rateBp: 2000 },
    { from: '1000000', rateBp: 3000 },
  ],
  surcharges: [
    { above: '5000000', rateBp: 1000 },
    { above: '10000000', rateBp: 1500 },
    { above: '20000000', rateBp: 2500 },
    { above: '50000000', rateBp: 3700 },
  ],
}

const code = (e: unknown) => (e instanceof HrError ? e.code : undefined)
const status = (e: unknown) => (e instanceof HrError ? e.status : undefined)

test('a regime keeps its rebate cap, marginal relief and surcharges', async () => {
  const c = await college()
  await createTaxRegime(c.admin, NEW_REGIME)
  const [r] = await listTaxRegimes(c.admin)
  assert.equal(r!.rebateMaxPaise, 6_000_000)
  assert.equal(r!.rebateMarginalRelief, true)
  assert.equal(r!.allowsDeductions, false)
  assert.equal((r as unknown as { surcharges: unknown[] }).surcharges.length, 3)
})

test('the default regime is a setting, audited', async () => {
  const c = await college()
  const r = await createTaxRegime(c.admin, NEW_REGIME)
  await setPayrollSettings(c.admin, { prorationBasis: 'calendar', defaultRegimeId: r.id })
  assert.equal((await getPayrollSettings(c.admin)).defaultRegimeId, r.id)
  const rows = await authDb
    .select({ detail: auditLog.detail })
    .from(auditLog)
    .where(and(eq(auditLog.institutionId, c.id), eq(auditLog.action, 'hr.statutory_settings_set')))
  assert.equal(rows.length, 1)
  assert.equal((rows[0]!.detail as { to: { defaultRegimeId: string } }).to.defaultRegimeId, r.id)
  await assert.rejects(
    () => setPayrollSettings(c.admin, { prorationBasis: 'calendar', defaultRegimeId: '00000000-0000-4000-8000-000000000000' }),
    (e) => code(e) === 'not_found',
  )
})

test('declarations replace the year’s rows, once per head, audited without amounts', async () => {
  const c = await college()
  const s = await hire(c)
  await setTaxDeclarations(c.admin, { staffId: s.id, taxYear: 2026, rows: [{ head: '80c', declared: '150000' }, { head: '80d', declared: '25000' }] })
  await setTaxDeclarations(c.admin, { staffId: s.id, taxYear: 2026, rows: [{ head: '80c', declared: '150000' }] })
  const rows = await withTenant(c.id, (tx) => tx.select().from(taxDeclarations))
  assert.equal(rows.length, 1)
  await assert.rejects(
    () => setTaxDeclarations(c.admin, { staffId: s.id, taxYear: 2026, rows: [{ head: '80c', declared: '1' }, { head: '80c', declared: '2' }] }),
    (e) => code(e) === 'duplicate_head',
  )
  const trail = await authDb
    .select({ detail: auditLog.detail, reason: auditLog.reason })
    .from(auditLog)
    .where(and(eq(auditLog.institutionId, c.id), eq(auditLog.action, 'hr.tax_declarations_set')))
  assert.equal(trail.length, 2)
  assert.deepEqual(trail.map((t) => t.detail).find((d) => (d as { heads: string[] }).heads.length === 1), { heads: ['80c'] })
  assert.equal(trail[0]!.reason, 'tax declarations for 2026-27')
  assert.ok(!JSON.stringify(trail).includes('1500'))
})

test('only an administrator records declarations or previous employment', async () => {
  const c = await college()
  const s = await hire(c)
  await assert.rejects(
    () => setTaxDeclarations(c.clerk, { staffId: s.id, taxYear: 2026, rows: [] }),
    (e) => status(e) === 403,
  )
  await assert.rejects(
    () => setPreviousEmployment(c.clerk, { staffId: s.id, taxYear: 2026, income: '1', tds: '0' }),
    (e) => status(e) === 403,
  )
})

test('previous employment is one row per year', async () => {
  const c = await college()
  const s = await hire(c)
  await setPreviousEmployment(c.admin, { staffId: s.id, taxYear: 2026, income: '300000', tds: '15000' })
  await setPreviousEmployment(c.admin, { staffId: s.id, taxYear: 2026, income: '320000', tds: '16000' })
  const rows = await withTenant(c.id, (tx) => tx.select().from(taxPreviousEmployment))
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.incomePaise, 32_000_000)
  assert.equal(rows[0]!.tdsPaise, 1_600_000)
})
