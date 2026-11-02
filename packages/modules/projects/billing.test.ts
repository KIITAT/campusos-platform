import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sql } from 'drizzle-orm'
import { authDb, withTenant } from '@campusos/db'
import { amendInvoice, cancelInvoice, createCostCenter, submitInvoice, trialBalance } from '@campusos/module-finance/api'
import { billProject, createTask, decideTime, listCostRates, logTime, ratePage, reopenTime, setCostRate } from './api'
import { actions, office, project, since, waitingOn, week, type Actor, type Office } from './test-support.test'

const says = (re: RegExp) => (e: unknown) => {
  const cause = (e as { cause?: { constraint?: string } }).cause
  return re.test(String(cause ?? e)) || re.test(cause?.constraint ?? '')
}
const refused = (p: Promise<unknown>, code: string) =>
  assert.rejects(p, (e: unknown) => (e as { code?: string }).code === code, `expected ${code}`)

type Billed = { id: string; invoiceId: string; number: string; amountPaise: number; minutes: number; replayed?: boolean }
const bill = (a: Actor, projectId: string, over: Record<string, unknown> = {}) => billProject(a, { projectId, ...over }) as Promise<Billed>
const keyed = (o: Office, key: string): Actor => ({ ...o.accounts, idempotencyKey: key })
const owner = async <T>(query: ReturnType<typeof sql>) => (await authDb.execute(query)).rows as T[]

test('a week of approved time invoices once through the books (MG-63)', async () => {
  const o = await office()
  const p = await project(o)
  const ids = await week(o, p)
  const b = await bill(o.accounts, p.id)
  assert.equal(b.minutes, 2400)
  assert.equal(b.amountPaise, 6000000)
  assert.ok(b.number)
  const invoices = await owner<{ id: string; docstatus: string; source_ref: string }>(sql`
    select id, docstatus, source_ref from finance_invoices where institution_id = ${o.id} and source_module = 'projects'`)
  assert.equal(invoices.length, 1)
  assert.equal(invoices[0]!.docstatus, 'submitted')
  assert.equal(invoices[0]!.source_ref, `billing:${b.id}`)
  const lines = await owner<{ qty_milli: number; cost_center: string }>(sql`
    select qty_milli::int, cost_center from finance_invoice_lines where invoice_id = ${invoices[0]!.id} order by qty_milli desc`)
  assert.deepEqual(lines.map((l) => [l.qty_milli, l.cost_center]), [[24000, 'PRJ'], [16000, 'PRJ']])
  const marked = await owner<{ n: number }>(sql`select count(*)::int as n from projects_timesheets where billing_id = ${b.id} and id = any(${ids}::uuid[])`)
  assert.equal(marked[0]!.n, 5)
  await refused(billProject(o.accounts, { projectId: p.id }), 'nothing_to_bill')
  assert.equal((await trialBalance(o.admin)).differencePaise, 0)
})

test('unapproved time and time after the through date wait', async () => {
  const o = await office()
  const p = await project(o)
  const t = await createTask(o.manager, { projectId: p.id, title: 'Task A', assigneeId: o.worker.id }) as { id: string }
  const ids: string[] = []
  for (const d of [0, 1, 2, 3, 4]) {
    ids.push(((await logTime(o.worker, { taskId: t.id, workDate: o.last.days[d], minutes: 480, description: 'Work ' + d })) as { id: string }).id)
  }
  await decideTime(o.manager, { ids: ids.slice(0, 4), decision: 'approved' })
  assert.equal((await bill(o.accounts, p.id, { through: o.last.days[1] })).minutes, 960)
  assert.equal((await bill(o.accounts, p.id)).minutes, 960)
  const left = await owner<{ billing_id: string | null }>(sql`select billing_id from projects_timesheets where id = ${ids[4]!}`)
  assert.equal(left[0]!.billing_id, null)
})

test('two billings of one project at the same moment make one invoice', async () => {
  const o = await office()
  const p = await project(o)
  await week(o, p)
  let held!: () => void
  const heldP = new Promise<void>((r) => { held = r })
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const holder = authDb.transaction(async (tx) => {
    await tx.execute(sql`select 1 from projects_projects where id = ${p.id} for update`)
    held()
    await gate
  })
  await heldP
  const a = billProject(o.accounts, { projectId: p.id })
  const b = billProject(o.admin, { projectId: p.id })
  await waitingOn('%projects_projects%', 2)
  release()
  await holder
  const settled = await Promise.allSettled([a, b])
  assert.equal(settled.filter((s) => s.status === 'fulfilled').length, 1)
  const failed = settled.find((s) => s.status === 'rejected') as PromiseRejectedResult
  assert.equal((failed.reason as { code?: string }).code, 'nothing_to_bill')
  const invoices = await owner<{ n: number }>(sql`select count(*)::int as n from finance_invoices where institution_id = ${o.id} and source_module = 'projects'`)
  assert.equal(invoices[0]!.n, 1)
  const distinct = await owner<{ n: number }>(sql`select count(distinct billing_id)::int as n from projects_timesheets where project_id = ${p.id}`)
  assert.equal(distinct[0]!.n, 1)
})

test('one idempotency key bills once and replays the invoice', async () => {
  const o = await office()
  const p = await project(o)
  await week(o, p)
  const first = await billProject(keyed(o, 'bill-key-0001'), { projectId: p.id }) as Billed
  const second = await billProject(keyed(o, 'bill-key-0001'), { projectId: p.id }) as Billed
  assert.equal(second.id, first.id)
  assert.equal(second.replayed, true)
  const invoices = await owner<{ n: number }>(sql`select count(*)::int as n from finance_invoices where institution_id = ${o.id} and source_module = 'projects'`)
  assert.equal(invoices[0]!.n, 1)
  await refused(billProject(keyed(o, 'bill-key-0001'), { projectId: p.id, through: o.last.days[0] }), 'idempotency_key_reused')
})

test('billed time stays billed: the database refuses any change', async () => {
  const o = await office()
  const p = await project(o)
  const ids = await week(o, p)
  await bill(o.accounts, p.id)
  await assert.rejects(() => withTenant(o.id, (tx) => tx.execute(sql`update projects_timesheets set minutes = 60 where id = ${ids[0]!}`)), says(/projects_timesheets_kept/))
  await assert.rejects(() => withTenant(o.id, (tx) => tx.execute(sql`update projects_timesheets set billing_id = null where id = ${ids[0]!}`)), says(/projects_timesheets_kept/))
  await refused(reopenTime(o.manager, { lineId: ids[0]!, reason: 'Hours were wrong' }), 'settled')
})

test('only the office bills, and only a project that bills someone', async () => {
  const o = await office()
  const p = await project(o)
  await refused(billProject(o.manager, { projectId: p.id }), 'forbidden')
  await createCostCenter(o.admin, { code: 'PRJ2', name: 'Second' })
  const q = await project(o, { costCenter: 'PRJ2', billable: false, partyId: undefined, billingRate: undefined })
  await refused(billProject(o.accounts, { projectId: q.id }), 'not_billable')
})

test('a cancelled invoice is amended, not billed again', async () => {
  const o = await office()
  const p = await project(o)
  await week(o, p)
  const b = await bill(o.accounts, p.id)
  await cancelInvoice(o.accounts, { invoiceId: b.invoiceId, reason: 'Wrong customer contact' })
  await refused(billProject(o.accounts, { projectId: p.id }), 'nothing_to_bill')
  const copy = await amendInvoice(o.accounts, { invoiceId: b.invoiceId }) as { id: string }
  const refs = await owner<{ id: string; source_ref: string }>(sql`select id, source_ref from finance_invoices where id in (${b.invoiceId}, ${copy.id})`)
  assert.equal(new Set(refs.map((r) => r.source_ref)).size, 1)
  await submitInvoice(o.accounts, { invoiceId: copy.id })
})

test('cost rates are set by the office, one per person per day', async () => {
  const o = await office()
  const rate = { userId: o.worker.id, effectiveFrom: o.last.first, hourlyCost: '600', homeCostCenter: 'FACULTY' }
  await setCostRate(o.accounts, rate)
  await refused(setCostRate(o.accounts, rate), 'rate_exists')
  await refused(setCostRate(o.accounts, { ...rate, effectiveFrom: o.last.days[1], hourlyCost: '0.50' }), 'bad_amount')
  await refused(setCostRate(o.manager, rate), 'forbidden')
  await refused(listCostRates(o.manager), 'forbidden')
  const one = await listCostRates(o.accounts)
  assert.equal(one.rows.length, 1)
  assert.equal(one.rows[0]!.hourlyCostPaise, 60000)
  assert.equal(one.total, 1)
  assert.equal(one.next, null)
  await setCostRate(o.accounts, { userId: o.manager.id, effectiveFrom: o.last.days[1], hourlyCost: '800' })
  const p1 = await listCostRates(o.accounts, {}, ratePage(new Request('https://x/?n=1'), ''))
  assert.equal(p1.rows.length, 1)
  assert.equal(p1.rows[0]!.userId, o.manager.id)
  assert.ok(p1.next)
  const p2 = await listCostRates(o.accounts, {}, ratePage(new Request(`https://x/?n=1&after=${p1.next}`), ''))
  assert.equal(p2.rows[0]!.userId, o.worker.id)
  assert.equal(p2.next, null)
})

test('billing and cost rates are on the audit trail', async () => {
  const o = await office()
  const p = await project(o)
  await week(o, p)
  const from = await since()
  await setCostRate(o.accounts, { userId: o.worker.id, effectiveFrom: o.last.first, hourlyCost: '600' })
  await bill(o.accounts, p.id)
  const done = await actions(o, from)
  assert.ok(done.includes('billing.created'))
  assert.ok(done.includes('cost_rate.set'))
})
