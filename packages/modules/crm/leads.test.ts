import { test } from 'node:test'
import assert from 'node:assert/strict'
import { and, eq, gt } from 'drizzle-orm'
import { sql } from 'drizzle-orm'
import { auditLog, authDb, withTenant } from '@campusos/db'
import { assignLead, createLead, leadDetail, listLeads, markLost, markWon, moveStage, openBoard, pipelinePage, qualifyLead, reopenLead, updateLead } from './api/leads'
import { archiveLostReason, settings } from './api/settings'
import { college, team } from './test-support.test'

const refused = (status: number, code?: string) => (e: unknown) => (e as { status?: number }).status === status && (!code || (e as { code?: string }).code === code)
const page = (qs = '') => pipelinePage(new Request('https://x/api/v1/modules/crm/pipeline' + qs), '')
const lead = (title: string, extra: Record<string, unknown> = {}) => ({ kind: 'lead', title, source: 'website', ...extra })

async function sales() {
  const c = await college()
  await team(c.admin, 'Team One', c.manager.id, [c.rep.id])
  await team(c.admin, 'Team Two', c.admin.id, [c.rep2.id])
  return c
}

test("a salesperson cannot read or change another's lead", async () => {
  const c = await sales()
  const other = await createLead(c.rep2, lead('Theirs'))
  await assert.rejects(() => leadDetail(c.rep, other.id), refused(404, 'not_found'))
  await assert.rejects(() => updateLead(c.rep, { leadId: other.id, title: 'Mine now' }), refused(404))
  await assert.rejects(() => moveStage(c.rep, { leadId: other.id, stageId: crypto.randomUUID() }), refused(404))
  await assert.rejects(() => markWon(c.rep, { leadId: other.id }), refused(404))
  await assert.rejects(() => assignLead(c.rep, { leadId: other.id, ownerId: c.rep.id }), refused(404))
  assert.ok(!(await listLeads(c.rep, page(), {})).rows.some(r => r.id === other.id))
})

test("a manager sees their team's pipeline and no other team's", async () => {
  const c = await sales()
  const l1 = await createLead(c.rep, lead('One')), l2 = await createLead(c.rep2, lead('Two'))
  assert.deepEqual((await listLeads(c.manager, page(), {})).rows.map(r => r.id), [l1.id])
  await assert.rejects(() => leadDetail(c.manager, l2.id), refused(404))
  assert.deepEqual((await listLeads(c.admin, page(), {})).rows.map(r => r.id).sort(), [l1.id, l2.id].sort())
})

test('someone outside every team is refused', async () => {
  const c = await sales()
  for (const who of [c.outsider, c.clerk]) {
    await assert.rejects(() => createLead(who, lead('Not allowed')), refused(403, 'not_in_sales_team'))
    await assert.rejects(() => listLeads(who, page(), {}), refused(403, 'not_in_sales_team'))
  }
})

test('a manager assigns within the team only', async () => {
  const c = await sales()
  const l1 = await createLead(c.rep, lead('One'))
  await assignLead(c.manager, { leadId: l1.id, ownerId: c.manager.id })
  await assert.rejects(() => assignLead(c.manager, { leadId: l1.id, ownerId: c.rep2.id }), refused(403, 'not_your_team'))
  await assert.rejects(() => assignLead(c.admin, { leadId: l1.id, ownerId: c.outsider.id }), refused(400, 'not_a_salesperson'))
})

test('a lead is qualified, staged, won; lost needs a reason; reopen', async () => {
  const c = await sales()
  const l = await createLead(c.rep, lead('Flow'))
  const cfg = await settings(c.admin)
  assert.equal(cfg.stages.length, 4)
  assert.equal(cfg.reasons.length, 3)
  const stage = (name: string) => cfg.stages.find(s => s.name === name)!.id
  await assert.rejects(() => moveStage(c.rep, { leadId: l.id, stageId: stage('Qualified') }), refused(409, 'not_an_opportunity'))
  await qualifyLead(c.rep, { leadId: l.id })
  assert.equal((await leadDetail(c.rep, l.id)).stageName, 'New')
  await moveStage(c.rep, { leadId: l.id, stageId: stage('Proposition') })
  assert.equal((await leadDetail(c.rep, l.id)).stageName, 'Proposition')
  await assert.rejects(() => markLost(c.rep, { leadId: l.id }))
  const archived = cfg.reasons[0]!
  await archiveLostReason(c.admin, { reasonId: archived.id })
  await assert.rejects(() => markLost(c.rep, { leadId: l.id, reasonId: archived.id }), refused(400, 'bad_reason'))
  await markLost(c.rep, { leadId: l.id, reasonId: cfg.reasons[1]!.id })
  assert.equal((await leadDetail(c.rep, l.id)).lead.status, 'lost')
  await assert.rejects(() => updateLead(c.rep, { leadId: l.id, title: 'Changed' }), refused(409, 'not_open'))
  await reopenLead(c.rep, { leadId: l.id })
  assert.equal((await leadDetail(c.rep, l.id)).lead.status, 'open')
  await markWon(c.rep, { leadId: l.id })
  assert.equal((await leadDetail(c.rep, l.id)).lead.status, 'won')
})

test('defaults are seeded once under concurrent first leads', async () => {
  const c = await college()
  await Promise.all([createLead(c.admin, lead('A1')), createLead(c.admin, lead('A2'))])
  const count = await withTenant(c.id, tx => tx.execute(sql`select count(*)::int as n from crm_stages`))
  assert.equal((count.rows[0] as { n: number }).n, 4)
})

test('the list pages, searches and filters', async () => {
  const c = await college()
  for (let i = 0; i < 25; i++) await createLead(c.admin, lead('Lead ' + String(i).padStart(2, '0'), i === 7 ? { company: 'Zebra Industries' } : {}))
  const first = await listLeads(c.admin, page('?n=10'), {})
  assert.equal(first.rows.length, 10)
  assert.equal(first.total, 25)
  assert.ok(first.next)
  const second = await listLeads(c.admin, page('?n=10&after=' + encodeURIComponent(first.next!)), {})
  assert.equal(second.rows.length, 10)
  assert.ok(!second.rows.some(r => first.rows.some(f => f.id === r.id)))
  assert.equal((await listLeads(c.admin, page('?q=Zebra'), {})).rows.length, 1)
  const cfg = await settings(c.admin)
  const one = (await listLeads(c.admin, page('?q=Zebra'), {})).rows[0]!
  await markLost(c.admin, { leadId: one.id, reasonId: cfg.reasons[0]!.id })
  const lost = await listLeads(c.admin, page(), { status: 'lost' })
  assert.deepEqual(lost.rows.map(r => r.id), [one.id])
  assert.ok((await openBoard(c.admin)).length >= 0)
})

test('the audit trail never carries contact data', async () => {
  const c = await sales()
  const mark = new Date(Date.now() - 2000)
  const name = 'Asha Contact-' + crypto.randomUUID(), email = crypto.randomUUID() + '@secret.example'
  await createLead(c.rep, lead('Audit lead', { contactName: name, email, phone: '9999999999' }))
  const rows = await withTenant(c.id, tx => tx.select().from(auditLog).where(and(eq(auditLog.moduleId, 'crm'), gt(auditLog.at, mark))))
  assert.ok(rows.length > 0)
  const text = JSON.stringify(rows)
  assert.ok(!text.includes(name) && !text.includes(email) && !text.includes('9999999999') && !text.includes('Audit lead'))
  assert.ok(authDb)
})
