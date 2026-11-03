import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sql } from 'drizzle-orm'
import { authDb } from '@campusos/db'
import { closePeriod, saveInvoice, submitInvoice, trialBalance } from '@campusos/module-finance/api'
import { billProject, costProject, decideTime, profitability, reopenTime, reverseCosting, setCostRate, createTask, logTime } from './api'
import { actions, office, project, since, waitingOn, week, type Actor, type Office } from './test-support.test'

const refused = (p: Promise<unknown>, code: string) =>
  assert.rejects(p, (e: unknown) => (e as { code?: string }).code === code, `expected ${code}`)

type Costed = { id: string; entryId: string; amountPaise: number; minutes: number; replayed?: boolean }
const cost = (a: Actor, projectId: string, period: string) => costProject(a, { projectId, period }) as Promise<Costed>
const owner = async <T>(query: ReturnType<typeof sql>) => (await authDb.execute(query)).rows as T[]
const rate = (o: Office) => setCostRate(o.accounts, { userId: o.worker.id, effectiveFrom: o.last.first, hourlyCost: '600', homeCostCenter: 'FACULTY' })
const entriesOf = (o: Office) => owner<{ n: number }>(sql`
  select count(*)::int as n from finance_journal_entries where institution_id = ${o.id} and source_module = 'projects' and source_ref like 'costing:%'`)

test("a month's approved time posts its cost to the project's cost centre (MG-63)", async () => {
  const o = await office()
  const p = await project(o)
  await rate(o)
  const ids = await week(o, p)
  const c = await cost(o.accounts, p.id, o.last.period)
  assert.equal(c.amountPaise, 2400000)
  assert.equal(c.minutes, 2400)
  const entry = await owner<{ id: string; posting_date: string }>(sql`
    select id, posting_date::text from finance_journal_entries where institution_id = ${o.id} and source_ref = ${'costing:' + c.id}`)
  assert.equal(entry.length, 1)
  assert.equal(entry[0]!.posting_date, o.last.end)
  const lines = await owner<{ code: string; debit_paise: number; credit_paise: number; cost_center: string }>(sql`
    select a.code, l.debit_paise::int, l.credit_paise::int, l.cost_center from finance_journal_lines l
      join finance_accounts a on a.id = l.account_id where l.entry_id = ${entry[0]!.id} order by l.debit_paise desc`)
  assert.deepEqual(lines.map((l) => [l.code, l.debit_paise, l.credit_paise, l.cost_center]), [['5100', 2400000, 0, 'PRJ'], ['5100', 0, 2400000, 'FACULTY']])
  const paid = await owner<{ n: number }>(sql`select count(*)::int as n from projects_timesheets
    where costing_id = ${c.id} and cost_paise = 480000 and id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`)
  assert.equal(paid[0]!.n, 5)
  assert.equal((await trialBalance(o.admin)).differencePaise, 0)
})

test('time without a cost rate stops the costing and names the person', async () => {
  const o = await office()
  const p = await project(o)
  const t = await createTask(o.manager, { projectId: p.id, title: 'Plan' }) as { id: string }
  const l = await logTime(o.manager, { taskId: t.id, workDate: o.last.days[0], minutes: 60, description: 'Planning' }) as { id: string }
  await decideTime(o.admin, { ids: [l.id], decision: 'approved' })
  await assert.rejects(cost(o.accounts, p.id, o.last.period), (e: unknown) => {
    const err = e as { code?: string; detail?: { userIds?: string[] } }
    return err.code === 'no_cost_rate' && !!err.detail?.userIds?.includes(o.manager.id)
  })
  assert.equal((await entriesOf(o))[0]!.n, 0)
})

test('an unfinished month cannot be costed, and a closed period refuses the costing', async () => {
  const o = await office()
  const p = await project(o)
  await rate(o)
  await week(o, p)
  await refused(costProject(o.accounts, { projectId: p.id, period: o.today.slice(0, 7) }), 'month_not_over')
  await closePeriod(o.admin, { year: o.last.year, month: o.last.month, override: true, overrideReason: 'Closed for the projects costing test' })
  await refused(costProject(o.accounts, { projectId: p.id, period: o.last.period }), 'period_closed')
  const marked = await owner<{ n: number }>(sql`select count(*)::int as n from projects_timesheets where project_id = ${p.id} and costing_id is not null`)
  assert.equal(marked[0]!.n, 0)
})

test('two costings of one project and month at the same moment post once', async () => {
  const o = await office()
  const p = await project(o)
  await rate(o)
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
  const a = costProject(o.accounts, { projectId: p.id, period: o.last.period })
  const b = costProject(o.admin, { projectId: p.id, period: o.last.period })
  await waitingOn('%projects_projects%', 2)
  release()
  await holder
  const settled = await Promise.allSettled([a, b])
  assert.equal(settled.filter((s) => s.status === 'fulfilled').length, 1)
  const failed = settled.find((s) => s.status === 'rejected') as PromiseRejectedResult
  assert.equal((failed.reason as { code?: string }).code, 'nothing_to_cost')
  assert.equal((await entriesOf(o))[0]!.n, 1)
})

test('a reversed costing frees its time to be corrected and costed again', async () => {
  const o = await office()
  const p = await project(o)
  await rate(o)
  const ids = await week(o, p)
  const c = await cost(o.accounts, p.id, o.last.period)
  await reverseCosting(o.accounts, { costingId: c.id, reason: 'Wrong cost rate' })
  const reversal = await owner<{ n: number }>(sql`select count(*)::int as n from finance_journal_entries where reversal_of = ${c.entryId}`)
  assert.equal(reversal[0]!.n, 1)
  const freed = await owner<{ n: number }>(sql`select count(*)::int as n from projects_timesheets where project_id = ${p.id} and costing_id is null and cost_paise is null`)
  assert.equal(freed[0]!.n, 5)
  await refused(reverseCosting(o.accounts, { costingId: c.id, reason: 'Wrong cost rate' }), 'already_reversed')
  await reopenTime(o.manager, { lineId: ids[0]!, reason: 'Hours were wrong' })
  await decideTime(o.manager, { ids: [ids[0]!], decision: 'approved' })
  const again = await cost(o.accounts, p.id, o.last.period)
  assert.notEqual(again.id, c.id)
  assert.equal(again.amountPaise, 2400000)
})

test('a costing replays on its idempotency key', async () => {
  const o = await office()
  const p = await project(o)
  await rate(o)
  await week(o, p)
  const keyed: Actor = { ...o.accounts, idempotencyKey: 'cost-key-0001' }
  const first = await cost(keyed, p.id, o.last.period)
  const second = await cost(keyed, p.id, o.last.period)
  assert.equal(second.id, first.id)
  assert.equal(second.replayed, true)
  assert.equal((await entriesOf(o))[0]!.n, 1)
})

test('project profitability ties to the ledger (MG-62)', async () => {
  const o = await office()
  const p = await project(o)
  await rate(o)
  await week(o, p)
  await billProject(o.accounts, { projectId: p.id })
  await cost(o.accounts, p.id, o.last.period)
  const query = { from: o.last.first, to: o.today }
  const row = async () => (await profitability(o.accounts, query)).rows.find((r) => r.id === p.id)!
  const books = () => owner<{ income: string; expense: string }>(sql`
    select coalesce(sum(l.credit_paise - l.debit_paise) filter (where a.type = 'income'), 0)::text as income,
           coalesce(sum(l.debit_paise - l.credit_paise) filter (where a.type = 'expense'), 0)::text as expense
      from finance_journal_lines l join finance_journal_entries e on e.id = l.entry_id join finance_accounts a on a.id = l.account_id
     where l.institution_id = ${o.id} and l.cost_center = 'PRJ' and e.posting_date between ${o.last.first}::date and ${o.today}::date`)
  let r = await row()
  assert.equal(r.minutes, 2400)
  assert.equal(r.billedPaise, 6000000)
  assert.equal(r.incomePaise, 6000000)
  assert.equal(r.costedPaise, 2400000)
  assert.equal(r.expensePaise, 2400000)
  assert.equal(r.marginPaise, 3600000)
  assert.equal(r.unexplainedIncomePaise, 0)
  assert.equal(r.unexplainedExpensePaise, 0)
  let b = (await books())[0]!
  assert.deepEqual([Number(b.income), Number(b.expense)], [r.incomePaise, r.expensePaise])
  const bill = await saveInvoice(o.accounts, {
    kind: 'purchase', partyId: o.supplier, postingDate: o.today,
    lines: [{ description: 'Survey equipment hire', qty: '1', rate: '1000', costCenter: 'PRJ' }],
  }) as { id: string }
  await submitInvoice(o.admin, { invoiceId: bill.id })
  r = await row()
  assert.equal(r.expensePaise, 2500000)
  assert.equal(r.unexplainedExpensePaise, 100000)
  b = (await books())[0]!
  assert.deepEqual([Number(b.income), Number(b.expense)], [r.incomePaise, r.expensePaise])
})

test('only the office costs, reverses or reads profitability', async () => {
  const o = await office()
  const p = await project(o)
  await refused(costProject(o.manager, { projectId: p.id, period: o.last.period }), 'forbidden')
  await refused(reverseCosting(o.manager, { costingId: p.id, reason: 'Not allowed' }), 'forbidden')
  await refused(profitability(o.manager, {}), 'forbidden')
})

test('costing and its reversal are on the audit trail', async () => {
  const o = await office()
  const p = await project(o)
  await rate(o)
  await week(o, p)
  const from = await since()
  const c = await cost(o.accounts, p.id, o.last.period)
  await reverseCosting(o.accounts, { costingId: c.id, reason: 'Wrong cost rate' })
  const done = await actions(o, from)
  assert.ok(done.includes('costing.created'))
  assert.ok(done.includes('costing.reversed'))
})
