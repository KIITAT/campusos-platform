import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { and, asc, eq, like, sql } from 'drizzle-orm'
import { auditLog, authDb, institutions, users, withTenant } from '@campusos/db'
import { isPosted, purposeBalance } from '@campusos/module-finance/api'
import type { AccountPurpose } from '@campusos/module-finance/api'
import {
  HrError,
  createGratuityRule,
  createStaff,
  endEmployment,
  gratuityAmount,
  listGratuityValuations,
  payGratuity,
  setComponent,
  valueGratuity,
  type Actor,
} from './api'
import { payPages } from './pages-pay'
import { gratuityValuationLines, gratuityValuations, staff } from './schema'

/**
 * The gratuity provision (P1-06d, ACC-29): the valuation tables, valuing, the
 * payout drawn from the provision and the page, in the order the plan builds
 * them. A fresh institution per test: the journal is append-only.
 */

let n = 0
const SLUG = 'hr-grat-'

interface College { id: string; admin: Actor; clerk: Actor }

async function college(): Promise<College> {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Gratuity College', allowedEmailDomains: [`${tag}.test`] })
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
  createStaff(c.admin, { employeeCode: 'E-1', name: 'A Lecturer', designation: 'Lecturer', joinedOn: '2020-01-01', ...over })

const saysDb = (re: RegExp) => (e: unknown) => {
  let text = ''
  for (let x: unknown = e; x instanceof Error; x = (x as { cause?: unknown }).cause) text += x.message + '\n'
  return re.test(text)
}

const valuation = (c: College, over: Record<string, unknown> = {}) => ({
  institutionId: c.id,
  asOf: '2026-09-30',
  method: 'actuarial' as const,
  obligationPaise: 100,
  provisionBeforePaise: 0,
  adjustmentPaise: 100,
  reference: 'AV-1',
  ...over,
})

test('the valuation tables are isolated between institutions', async () => {
  const a = await college()
  const b = await college()
  const s = await hire(a)
  const [v] = await withTenant(a.id, (tx) => tx.insert(gratuityValuations).values(valuation(a)).returning({ id: gratuityValuations.id }))
  const line = (valuationId: string) => ({ institutionId: a.id, valuationId, staffId: s.id, serviceYears: 1, monthlyWagePaise: 100, amountPaise: 6 })
  await withTenant(a.id, (tx) => tx.insert(gratuityValuationLines).values(line(v!.id)))
  assert.equal((await withTenant(b.id, (tx) => tx.select().from(gratuityValuations))).length, 0)
  assert.equal((await withTenant(b.id, (tx) => tx.select().from(gratuityValuationLines))).length, 0)
  await assert.rejects(() => withTenant(b.id, (tx) => tx.insert(gratuityValuations).values(valuation(a))), saysDb(/row-level security|violates/i))
  await assert.rejects(() => withTenant(b.id, (tx) => tx.insert(gratuityValuationLines).values(line(v!.id))), saysDb(/row-level security|violates/i))
})

test('a valuation and its lines cannot be changed or deleted', async () => {
  const c = await college()
  const s = await hire(c)
  const [v] = await withTenant(c.id, (tx) => tx.insert(gratuityValuations).values(valuation(c)).returning({ id: gratuityValuations.id }))
  await withTenant(c.id, (tx) =>
    tx.insert(gratuityValuationLines).values({ institutionId: c.id, valuationId: v!.id, staffId: s.id, serviceYears: 1, monthlyWagePaise: 100, amountPaise: 6 }),
  )
  await assert.rejects(
    () => withTenant(c.id, (tx) => tx.update(gratuityValuations).set({ reference: 'X' }).where(eq(gratuityValuations.id, v!.id))),
    saysDb(/a gratuity valuation cannot be changed/),
  )
  await assert.rejects(
    () => withTenant(c.id, (tx) => tx.delete(gratuityValuationLines).where(eq(gratuityValuationLines.valuationId, v!.id))),
    saysDb(/a gratuity valuation cannot be changed/),
  )
  await authDb.delete(institutions).where(eq(institutions.id, c.id))
  assert.equal((await authDb.select().from(institutions).where(eq(institutions.id, c.id))).length, 0)
})

test('the database refuses a valuation that is not at a month end, or whose sums disagree', async () => {
  const c = await college()
  const put = (over: Record<string, unknown>) => withTenant(c.id, (tx) => tx.insert(gratuityValuations).values(valuation(c, over)))
  await assert.rejects(() => put({ asOf: '2026-09-29' }), saysDb(/hr_gratuity_valuations_month_end/))
  await assert.rejects(() => put({ adjustmentPaise: 99 }), saysDb(/hr_gratuity_valuations_sum/))
  await assert.rejects(() => put({ method: 'accrued', ruleId: null, reference: null }), saysDb(/hr_gratuity_valuations_basis/))
})

test('hr_about carries a person’s valuation lines', async () => {
  const c = await college()
  const s = await hire(c, { userId: c.admin.id })
  const [v] = await withTenant(c.id, (tx) => tx.insert(gratuityValuations).values(valuation(c)).returning({ id: gratuityValuations.id }))
  await withTenant(c.id, (tx) =>
    tx.insert(gratuityValuationLines).values({ institutionId: c.id, valuationId: v!.id, staffId: s.id, serviceYears: 1, monthlyWagePaise: 100, amountPaise: 6 }),
  )
  const sources = await withTenant(c.id, async (tx) =>
    (await tx.execute<{ source: string }>(sql`select source from dpdp_subject.hr_about where subject_id = ${c.admin.id}`)).rows.map((r) => r.source),
  )
  assert.ok(sources.includes('hr_gratuity_valuation_lines'), sources.join(','))
})

const pay = (c: College, staffId: string, codeName: string, amount: string, from = '2016-01-01') =>
  setComponent(c.admin, { staffId, code: codeName, label: codeName, kind: 'earning', amount, effectiveFrom: from })

const rule = (c: College) =>
  createGratuityRule(c.admin, {
    code: 'PGA', name: 'Payment of Gratuity Act', minServiceYears: 5, daysPerYear: 15, divisorDays: 26, wageCodes: ['basic', 'da'], roundUpMonths: 6, max: '2000000',
  })

const code = (e: unknown) => (e instanceof HrError ? e.code : undefined)

const bal = (c: College, purpose: AccountPurpose, on: string) => withTenant(c.id, (tx) => purposeBalance(tx, purpose, on))

/** Seven people around 30 September 2026: three counted, four not (see each comment). */
async function people(c: College) {
  const r = await rule(c)
  const make = async (employeeCode: string, joinedOn: string, basic: string, leftOn?: string, da?: string) => {
    const s = await hire(c, { employeeCode, joinedOn })
    await pay(c, s.id, 'basic', basic)
    if (da) await pay(c, s.id, 'da', da)
    if (leftOn) await endEmployment(c.admin, { staffId: s.id, leftOn, reason: 'resigned to move cities' })
    return s
  }
  const A = await make('A-1', '2020-01-15', '40000')
  const B = await make('B-1', '2024-06-01', '30000', undefined, '5000')
  const C = await make('C-1', '2018-04-01', '50000', '2026-08-31')
  await make('D-1', '2010-04-01', '50000', '2025-06-30') // left more than a year before: no line
  const E = await make('E-1', '2015-04-01', '20000', '2026-07-31') // paid before any valuation: no line
  const F = await make('F-1', '2026-10-01', '10000') // joins after the first valuation date
  await make('G-1', '2023-04-01', '20000', '2026-09-15') // left below the minimum service: no line
  await payGratuity(c.admin, { staffId: E.id, ruleId: r.id, paidOn: '2026-08-05' })
  return { r, A, B, C, E, F }
}

const codeMap = (c: College) =>
  withTenant(c.id, async (tx) => new Map((await tx.select({ id: staff.id, code: staff.employeeCode }).from(staff)).map((x) => [x.id, x.code])))

test('an accrued valuation counts the employed, vested or not, and unpaid recent leavers', async () => {
  const c = await college()
  const { r } = await people(c)
  const v = await valueGratuity(c.admin, { asOf: '2026-09-30', method: 'accrued', ruleId: r.id })
  assert.equal(v.obligationPaise, 43_269_231)
  assert.equal(v.provisionBeforePaise, 0)
  assert.equal(v.adjustmentPaise, 43_269_231)
  const codeOf = await codeMap(c)
  const got = v.lines
    .map((l) => [codeOf.get(l.staffId), l.serviceYears, l.monthlyWagePaise, l.amountPaise, l.leftOn])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
  assert.deepEqual(got, [
    ['A-1', 7, 4_000_000, 16_153_846, null],
    ['B-1', 2, 3_500_000, 4_038_462, null],
    ['C-1', 8, 5_000_000, 23_076_923, '2026-08-31'],
  ])
  assert.equal(await bal(c, 'gratuity_provision', '2026-09-30'), 43_269_231)
  const eAmount = gratuityAmount(2_000_000, 11, { minServiceYears: 5, daysPerYear: 15, divisorDays: 26, roundUpMonths: 6, maxPaise: 200_000_000 })
  assert.equal(eAmount, 12_692_308)
  assert.equal(await bal(c, 'employer_cost', '2026-09-30'), 43_269_231 + eAmount)
  const rows = await authDb
    .select({ detail: auditLog.detail, reason: auditLog.reason })
    .from(auditLog)
    .where(and(eq(auditLog.institutionId, c.id), eq(auditLog.action, 'hr.gratuity_valued')))
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.reason, 'gratuity provision as at 2026-09-30')
  assert.deepEqual(rows[0]!.detail, { method: 'accrued', obligationPaise: 43_269_231, adjustmentPaise: 43_269_231, people: 3 })
})

test('a payout after a valuation draws on the provision, and the next valuation trues it up', async () => {
  const c = await college()
  const { r, C } = await people(c)
  await valueGratuity(c.admin, { asOf: '2026-09-30', method: 'accrued', ruleId: r.id })
  const costBefore = await bal(c, 'employer_cost', '2026-09-30')
  await payGratuity(c.admin, { staffId: C.id, ruleId: r.id, paidOn: '2026-10-10' })
  assert.equal(await bal(c, 'gratuity_provision', '2026-10-31'), 43_269_231 - 23_076_923)
  assert.equal(await bal(c, 'employer_cost', '2026-10-31'), costBefore)
  const v = await valueGratuity(c.admin, { asOf: '2026-10-31', method: 'accrued', ruleId: r.id })
  assert.deepEqual(
    v.lines.map((l) => [l.serviceYears, l.monthlyWagePaise, l.amountPaise]).sort((a, b) => b[2]! - a[2]!),
    [[7, 4_000_000, 16_153_846], [2, 3_500_000, 4_038_462], [0, 1_000_000, 0]],
  )
  assert.equal(v.obligationPaise, 20_192_308)
  assert.equal(v.provisionBeforePaise, 20_192_308)
  assert.equal(v.adjustmentPaise, 0)
  assert.equal(await withTenant(c.id, (tx) => isPosted(tx, 'hr', `gratuity-valuation:${v.id}`)), null)
})

test('an actuarial figure replaces the computed one, down as well as up', async () => {
  const c = await college()
  const { r } = await people(c)
  await valueGratuity(c.admin, { asOf: '2026-09-30', method: 'accrued', ruleId: r.id })
  const v = await valueGratuity(c.admin, { asOf: '2026-09-30', method: 'actuarial', obligation: '400000', reference: 'AV/2026-27/H1' })
  assert.equal(v.provisionBeforePaise, 43_269_231)
  assert.equal(v.adjustmentPaise, 40_000_000 - 43_269_231)
  assert.equal(v.lines.length, 0)
  assert.equal(v.ruleId, null)
  assert.equal(await bal(c, 'gratuity_provision', '2026-09-30'), 40_000_000)
})

test('a valuation dated before the last one is refused', async () => {
  const c = await college()
  const { r } = await people(c)
  await valueGratuity(c.admin, { asOf: '2026-09-30', method: 'accrued', ruleId: r.id })
  await assert.rejects(
    () => valueGratuity(c.admin, { asOf: '2026-08-31', method: 'accrued', ruleId: r.id }),
    (e: unknown) =>
      code(e) === 'valuation_order' && (e as Error).message === 'the provision was last valued as at 2026-09-30; value it as at that date or later',
  )
})

test('the input names its method’s figures', async () => {
  const c = await college()
  const r = await rule(c)
  await assert.rejects(
    () => valueGratuity(c.admin, { asOf: '2026-09-29', method: 'accrued', ruleId: r.id }),
    (e: unknown) => e instanceof Error && e.message.includes('value the provision as at the last day of a month'),
  )
  await assert.rejects(() => valueGratuity(c.admin, { asOf: '2026-09-30', method: 'accrued' }), (e: unknown) => code(e) === 'rule_required')
  await assert.rejects(
    () => valueGratuity(c.admin, { asOf: '2026-09-30', method: 'actuarial', obligation: '100000' }),
    (e: unknown) => code(e) === 'actuarial_figure',
  )
  await assert.rejects(
    () => valueGratuity(c.admin, { asOf: '2026-09-30', method: 'accrued', ruleId: '00000000-0000-4000-8000-000000000000' }),
    (e: unknown) => code(e) === 'no_such_rule',
  )
})

test('only an administrator values; the office reads', async () => {
  const c = await college()
  const { r } = await people(c)
  await assert.rejects(
    () => valueGratuity(c.clerk, { asOf: '2026-09-30', method: 'accrued', ruleId: r.id }),
    (e: unknown) => e instanceof HrError && e.status === 403,
  )
  await valueGratuity(c.admin, { asOf: '2026-09-30', method: 'accrued', ruleId: r.id })
  const list = await listGratuityValuations(c.clerk)
  assert.equal(list.length, 1)
  assert.deepEqual(list[0]!.lines.map((l) => [l.employeeCode, l.name]).sort(), [['A-1', 'A Lecturer'], ['B-1', 'A Lecturer'], ['C-1', 'A Lecturer']])
})

test('a payout before any valuation is still a cost', async () => {
  const c = await college()
  await people(c)
  assert.equal(await bal(c, 'gratuity_provision', '2026-12-31'), 0)
  assert.equal(await bal(c, 'employer_cost', '2026-12-31'), 12_692_308)
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
  p.then(() => ({ ok: true as const, error: null }), (error: unknown) => ({ ok: false as const, error }))

test('two valuations at once take turns', async () => {
  const c = await college()
  const { r } = await people(c)
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  let holding!: () => void
  const locked = new Promise<void>((resolve) => (holding = resolve))
  const holder = authDb.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(1213354066, hashtext(${`${c.id}:gratuity`}::text))`)
    holding()
    await held
  })
  await locked
  const x = settle(valueGratuity(c.admin, { asOf: '2026-09-30', method: 'accrued', ruleId: r.id }))
  const y = settle(valueGratuity(c.admin, { asOf: '2026-09-30', method: 'accrued', ruleId: r.id }))
  await until(async () => (await waiting('%pg_advisory_xact_lock%')) >= 2)
  release()
  await holder
  assert.equal((await x).ok, true)
  assert.equal((await y).ok, true)
  const rows = await withTenant(c.id, (tx) =>
    tx.select({ a: gratuityValuations.adjustmentPaise }).from(gratuityValuations).orderBy(asc(gratuityValuations.adjustmentPaise)),
  )
  // Which of the two took the lock first is not fixed: one posts it all, the other nothing.
  assert.deepEqual(rows.map((row) => row.a), [0, 43_269_231])
  assert.equal(await bal(c, 'gratuity_provision', '2026-09-30'), 43_269_231)
})

test('the pay setup page shows the provision and offers the form', async () => {
  const c = await college()
  const { r } = await people(c)
  await valueGratuity(c.admin, { asOf: '2026-09-30', method: 'accrued', ruleId: r.id })
  const page = payPages.find((p) => p.path === '/payroll/setup')!
  const data = (await page.load(c.admin, new Request('http://localhost/payroll/setup'))) as { valuations: { asOf: string; method: string; people: number }[] }
  assert.equal(data.valuations.length, 1)
  assert.equal(data.valuations[0]!.asOf, '2026-09-30')
  assert.equal(data.valuations[0]!.method, 'accrued')
  assert.equal(data.valuations[0]!.people, 3)
  const sections = page.sections(data as never) as unknown as { kind: string; title?: string; path?: string }[]
  assert.ok(sections.some((s) => s.kind === 'table' && s.title === 'Gratuity provision'))
  const form = sections.find((s) => s.kind === 'form' && s.title === 'Value the gratuity provision')
  assert.equal(form?.path, '/pay/gratuity/valuations')
})
