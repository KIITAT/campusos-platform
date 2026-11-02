import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sql } from 'drizzle-orm'
import { authDb, exportSubject } from '@campusos/db'
import { createItem } from '@campusos/module-finance/api'
import { createActivity } from './api/activities'
import { convertOpportunity } from './api/convert'
import { createLead, markWon, updateLead } from './api/leads'
import { eraseLead } from './api/leads'
import { college, team } from './test-support.test'

const refused = (status: number, code?: string) => (e: unknown) => (e as { status?: number }).status === status && (!code || (e as { code?: string }).code === code)
const GSTIN = '27AAPFU0939F1ZV'
async function sales() {
  const c = await college()
  await team(c.admin, 'Team One', c.manager.id, [c.rep.id])
  const item = await createItem(c.clerk, { code: 'SVC', name: 'Service', nature: 'service' }) as { id: string }
  return { ...c, itemId: item.id }
}

test('an administrator erases a contact; the finance customer stays', async () => {
  const c = await sales()
  const l = await createLead(c.rep, { kind: 'opportunity', title: 'Acme deal', source: 'website', company: 'Acme Pvt Ltd', contactName: 'Asha', email: 'asha@acme.example', phone: '9999999999', gstin: GSTIN, notes: 'n', itemId: c.itemId, expectedValue: '100' })
  await createActivity(c.rep, { leadId: l.id, kind: 'call', summary: 'Call Asha about pricing', dueAt: '2030-01-01T10:00' })
  await markWon(c.rep, { leadId: l.id })
  const done = await convertOpportunity(c.rep, { leadId: l.id })
  await eraseLead(c.admin, { leadId: l.id, reason: 'Request ref DPDP-2026-001' })
  const [row] = (await authDb.execute(sql`select title, company, contact_name, email, phone, gstin, notes, erased_at from crm_leads where id = ${l.id}`)).rows as Record<string, unknown>[]
  assert.equal(row!.title, '[erased]')
  assert.deepEqual([row!.company, row!.contact_name, row!.email, row!.phone, row!.gstin, row!.notes], [null, null, null, null, null, null])
  assert.ok(row!.erased_at)
  const acts = (await authDb.execute(sql`select summary from crm_activities where lead_id = ${l.id}`)).rows as { summary: string }[]
  assert.deepEqual(acts.map(a => a.summary), ['[erased]'])
  const [party] = (await authDb.execute(sql`select name, gstin from finance_parties where id = ${done.partyId}`)).rows as Record<string, unknown>[]
  assert.deepEqual([party!.name, party!.gstin], ['Acme Pvt Ltd', GSTIN])
  await assert.rejects(() => updateLead(c.admin, { leadId: l.id, title: 'Changed again' }), refused(409, 'erased'))
  await assert.rejects(() => eraseLead(c.admin, { leadId: l.id, reason: 'Request ref DPDP-2026-001' }), refused(409, 'already_erased'))
})

test('only an administrator erases', async () => {
  const c = await sales()
  const l = await createLead(c.rep, { kind: 'lead', title: 'Some lead', source: 'website' })
  await assert.rejects(() => eraseLead(c.manager, { leadId: l.id, reason: 'Request ref DPDP-2026-002' }), refused(403))
})

test("a staff member's export carries no contact data", async () => {
  const c = await sales()
  await createLead(c.rep, { kind: 'lead', title: 'Exported lead', source: 'website', contactName: 'Secret Contact', email: 'secret@contact.example' })
  const bundle = await exportSubject(c.id, c.rep.id)
  const text = JSON.stringify(bundle)
  assert.ok(Object.keys(bundle.records).some(k => k.startsWith('crm_leads')), Object.keys(bundle.records).join(','))
  assert.ok(!text.includes('Secret Contact') && !text.includes('secret@contact.example') && !text.includes('Exported lead'))
})
