import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sql } from 'drizzle-orm'
import { authDb, withTenant } from '@campusos/db'
import { createItem, deleteOrder, orderDetail, orderFromQuotation, submitOrder } from '@campusos/module-finance/api'
import { createLead, markWon } from './api/leads'
import { convertOpportunity } from './api/convert'
import { college, team } from './test-support.test'

const refused = (status: number, code?: string) => (e: unknown) => (e as { status?: number }).status === status && (!code || (e as { code?: string }).code === code)
const GSTIN = '27AAPFU0939F1ZV'

async function sales() {
  const c = await college()
  await team(c.admin, 'Team One', c.manager.id, [c.rep.id])
  await team(c.admin, 'Team Two', c.admin.id, [c.rep2.id])
  const item = await createItem(c.clerk, { code: 'SVC', name: 'Service', nature: 'service' }) as { id: string }
  return { ...c, itemId: item.id }
}
/** A won opportunity owned by `rep`. */
async function won(c: Awaited<ReturnType<typeof sales>>, extra: Record<string, unknown> = {}, owner = c.rep) {
  const l = await createLead(owner, { kind: 'opportunity', title: 'Acme deal', source: 'referral', company: 'Acme Pvt Ltd', itemId: c.itemId, expectedValue: '125000.50', ...extra })
  await markWon(owner, { leadId: l.id })
  return l.id
}
const parties = (c: { id: string }, where = sql`true`) => withTenant(c.id, async tx => (await tx.execute(sql`select * from finance_parties where ${where}`)).rows as Record<string, unknown>[])

test('a won opportunity becomes a customer and a draft quotation without retyping', async () => {
  const c = await sales()
  const id = await won(c, { gstin: GSTIN, email: 'buyer@acme.example' })
  const done = await convertOpportunity(c.rep, { leadId: id })
  const [party] = await parties(c, sql`id = ${done.partyId}::uuid`)
  assert.deepEqual([party!.name, party!.is_customer, party!.gstin, party!.state_code, party!.gst_category, party!.email], ['Acme Pvt Ltd', true, GSTIN, '27', 'registered', 'buyer@acme.example'])
  const q = await orderDetail(c.clerk, done.quotationId)
  assert.equal(q.order.kind, 'quotation')
  assert.equal(q.order.docstatus, 'draft')
  assert.equal(q.order.partyId, done.partyId)
  assert.equal(q.lines.length, 1)
  assert.equal(q.lines[0]!.itemId, c.itemId)
  assert.equal(Number(q.lines[0]!.rateFc), 12500050)
  await submitOrder(c.clerk, { orderId: done.quotationId })
  const so = await orderFromQuotation(c.clerk, { quotationId: done.quotationId })
  assert.ok(so.id)
})

test('an existing customer with the GSTIN is never duplicated', async () => {
  const c = await sales()
  const [existing] = (await authDb.execute(sql`insert into finance_parties (institution_id, code, name, is_customer, gstin) values (${c.id}, 'ACME', 'Acme Existing', true, ${GSTIN}) returning id`)).rows as { id: string }[]
  const id = await won(c, { gstin: GSTIN })
  await assert.rejects(() => convertOpportunity(c.rep, { leadId: id }), refused(409, 'party_exists'))
  await assert.rejects(() => convertOpportunity(c.rep, { leadId: id, createNew: true }), refused(409, 'gstin_taken'))
  const done = await convertOpportunity(c.rep, { leadId: id, partyId: existing!.id })
  assert.equal(done.partyId, existing!.id)
  assert.equal((await parties(c, sql`gstin = ${GSTIN}`)).length, 1)
})

test('an e-mail match stops a silent duplicate but allows an explicit one', async () => {
  const c = await sales()
  await authDb.execute(sql`insert into finance_parties (institution_id, code, name, is_customer, email) values (${c.id}, 'BUY', 'Buyer Co', true, 'Sales@Buyer.example')`)
  const id = await won(c, { email: 'sales@buyer.example' })
  await assert.rejects(() => convertOpportunity(c.rep, { leadId: id }), refused(409, 'party_exists'))
  await convertOpportunity(c.rep, { leadId: id, createNew: true })
  assert.equal((await parties(c)).length, 2)
})

test('a supplier-only party is refused as the customer', async () => {
  const c = await sales()
  const [supplier] = (await authDb.execute(sql`insert into finance_parties (institution_id, code, name, is_supplier) values (${c.id}, 'SUP', 'Supplier Only', true) returning id`)).rows as { id: string }[]
  const id = await won(c)
  await assert.rejects(() => convertOpportunity(c.rep, { leadId: id, partyId: supplier!.id }), refused(400, 'not_customer'))
})

test('conversion needs a won opportunity with an item and a value; once only', async () => {
  const c = await sales()
  const open = await createLead(c.rep, { kind: 'opportunity', title: 'Still open', source: 'website', itemId: c.itemId, expectedValue: '100' })
  await assert.rejects(() => convertOpportunity(c.rep, { leadId: open.id }), refused(409, 'not_won'))
  const noItem = await createLead(c.rep, { kind: 'opportunity', title: 'No item', source: 'website' })
  await markWon(c.rep, { leadId: noItem.id })
  await assert.rejects(() => convertOpportunity(c.rep, { leadId: noItem.id }), refused(409, 'needs_item_and_value'))
  const id = await won(c)
  await convertOpportunity(c.rep, { leadId: id })
  await assert.rejects(() => convertOpportunity(c.rep, { leadId: id }), refused(409, 'already_converted'))
})

async function waitingOn(pattern: string, n = 1) {
  const deadline = Date.now() + 10_000
  for (;;) {
    const r = await authDb.execute<{ n: number }>(sql`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and query ilike ${pattern}`)
    if (r.rows[0]!.n >= n) return
    if (Date.now() > deadline) throw new Error(`nobody is waiting on ${pattern}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}
test('two conversions at once convert once', async () => {
  const c = await sales()
  const id = await won(c)
  let release!: () => void
  const held = new Promise<void>(resolve => (release = resolve))
  let holding!: () => void
  const locked = new Promise<void>(resolve => (holding = resolve))
  const holder = authDb.transaction(async tx => { await tx.execute(sql`select 1 from crm_leads where id = ${id} for update`); holding(); await held })
  await locked
  const settled = Promise.allSettled([convertOpportunity(c.rep, { leadId: id, createNew: true }), convertOpportunity(c.rep, { leadId: id, createNew: true })])
  try { await waitingOn('%crm_leads%', 2) } finally { release(); await holder }
  const results = await settled
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  const failed = results.find(r => r.status === 'rejected') as PromiseRejectedResult
  assert.equal((failed.reason as { code?: string }).code, 'already_converted')
  assert.equal((await parties(c, sql`name = 'Acme Pvt Ltd'`)).length, 1)
  const q = await withTenant(c.id, async tx => (await tx.execute(sql`select count(*)::int as n from finance_orders where kind = 'quotation'`)).rows[0] as { n: number })
  assert.equal(q.n, 1)
})

test('conversion follows the visibility rule', async () => {
  const c = await sales()
  const id = await won(c)
  await assert.rejects(() => convertOpportunity(c.rep2, { leadId: id }), refused(404))
  await assert.rejects(() => convertOpportunity(c.outsider, { leadId: id }), refused(403, 'not_in_sales_team'))
})

test('a deleted draft quotation unlinks, the party stays', async () => {
  const c = await sales()
  const id = await won(c)
  const done = await convertOpportunity(c.rep, { leadId: id })
  await deleteOrder(c.clerk, { orderId: done.quotationId })
  const [l] = (await authDb.execute(sql`select party_id, quotation_id from crm_leads where id = ${id}`)).rows as { party_id: string | null; quotation_id: string | null }[]
  assert.equal(l!.quotation_id, null)
  assert.equal(l!.party_id, done.partyId)
})
