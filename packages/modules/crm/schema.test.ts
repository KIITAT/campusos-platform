import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sql } from 'drizzle-orm'
import { authDb, withTenant } from '@campusos/db'
import { college } from './test-support.test'

const TABLES = ['crm_stages', 'crm_lost_reasons', 'crm_teams', 'crm_team_members', 'crm_leads', 'crm_activities']

async function seed(c: Awaited<ReturnType<typeof college>>) {
  const i = c.id, u = c.admin.id
  const stage = (await authDb.execute(sql`insert into crm_stages (institution_id, name, seq) values (${i}, 'New', 10) returning id`)).rows[0]!.id as string
  await authDb.execute(sql`insert into crm_lost_reasons (institution_id, name) values (${i}, 'Too expensive')`)
  const team = (await authDb.execute(sql`insert into crm_teams (institution_id, name, manager_id) values (${i}, 'North', ${u}) returning id`)).rows[0]!.id as string
  await authDb.execute(sql`insert into crm_team_members (institution_id, team_id, user_id) values (${i}, ${team}, ${c.rep.id})`)
  const lead = (await authDb.execute(sql`insert into crm_leads (institution_id, kind, title, source, owner_id, created_by, stage_id) values (${i}, 'opportunity', 'Acme', 'website', ${u}, ${u}, ${stage}) returning id`)).rows[0]!.id as string
  await authDb.execute(sql`insert into crm_activities (institution_id, lead_id, kind, summary, due_at, assignee_id, created_by) values (${i}, ${lead}, 'call', 'x', now(), ${u}, ${u})`)
  return { lead, stage }
}

test('crm RLS isolates every table', async () => {
  const a = await college(), b = await college()
  const { lead } = await seed(a)
  for (const table of TABLES) {
    const rows = await withTenant(b.id, tx => tx.execute(sql.raw(`select 1 from ${table}`)))
    assert.equal(rows.rows.length, 0, table)
  }
  const own = await withTenant(a.id, tx => tx.execute(sql`select 1 from crm_leads`))
  assert.equal(own.rows.length, 1)
  await assert.rejects(() => withTenant(b.id, tx => tx.execute(sql`insert into crm_activities (institution_id, lead_id, kind, summary, due_at, assignee_id, created_by) values (${b.id}, ${lead}, 'call', 'x', now(), ${b.admin.id}, ${b.admin.id})`)))
  await assert.rejects(() => withTenant(b.id, tx => tx.execute(sql`insert into crm_activities (institution_id, lead_id, kind, summary, due_at, assignee_id, created_by) values (${a.id}, ${lead}, 'call', 'x', now(), ${b.admin.id}, ${b.admin.id})`)))
})

test("a lead's states hold", async () => {
  const c = await college()
  const { stage } = await seed(c)
  const i = c.id, u = c.admin.id
  const bad = (name: string, query: ReturnType<typeof sql>) => assert.rejects(() => authDb.execute(query), (e: unknown) => JSON.stringify(e, Object.getOwnPropertyNames(e)).includes(name), name)
  await bad('crm_lead_stage', sql`insert into crm_leads (institution_id, kind, title, source, owner_id, created_by, stage_id) values (${i}, 'lead', 'x', 'website', ${u}, ${u}, ${stage})`)
  await bad('crm_lead_won', sql`insert into crm_leads (institution_id, kind, status, title, source, owner_id, created_by, won_at) values (${i}, 'lead', 'won', 'x', 'website', ${u}, ${u}, now())`)
  await bad('crm_lead_lost', sql`insert into crm_leads (institution_id, kind, status, title, source, owner_id, created_by) values (${i}, 'lead', 'lost', 'x', 'website', ${u}, ${u})`)
  const party = (await authDb.execute(sql`insert into finance_parties (institution_id, code, name, is_customer) values (${i}, 'P1', 'P', true) returning id`)).rows[0]!.id as string
  await bad('crm_lead_converted', sql`insert into crm_leads (institution_id, kind, title, source, owner_id, created_by, party_id) values (${i}, 'lead', 'x', 'website', ${u}, ${u}, ${party})`)
})
