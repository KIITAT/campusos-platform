import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sql } from 'drizzle-orm'
import { authDb, withTenant } from '@campusos/db'
import { completeActivity, createActivity, reminderText, sendDueReminders } from './api/activities'
import { createLead } from './api/leads'
import { jobs } from './jobs'
import { college, team } from './test-support.test'

const refused = (status: number, code?: string) => (e: unknown) => (e as { status?: number }).status === status && (!code || (e as { code?: string }).code === code)
/** India wall-clock `minutes` from now, as the datetime form field writes it. */
const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000 + 5.5 * 3_600_000).toISOString().slice(0, 16)
const lead = (title: string) => ({ kind: 'lead', title, source: 'website' })
async function sales() {
  const c = await college()
  await team(c.admin, 'Team One', c.manager.id, [c.rep.id])
  await team(c.admin, 'Team Two', c.admin.id, [c.rep2.id])
  return c
}
const notes = (c: { id: string }, userId: string) => withTenant(c.id, async tx => (await tx.execute(sql`select title, body from notifications where user_id = ${userId} and module_id = 'crm'`)).rows as { title: string; body: string }[])

test("reminderText formats in India time without the lead's data", () => {
  assert.equal(reminderText('call', new Date('2026-11-03T09:00:00Z')), 'A call is due at 14:30 on 3 Nov 2026.')
})

test('a due reminder is sent once to the assignee through notifications', async () => {
  const c = await sales()
  const l = await createLead(c.rep, lead('Secret deal name'))
  await createActivity(c.rep, { leadId: l.id, kind: 'call', summary: 'Call Asha', dueAt: inMinutes(10), remindBefore: '15m' })
  assert.equal(await withTenant(c.id, tx => sendDueReminders(tx, c.id)), 1)
  const got = await notes(c, c.rep.id)
  assert.equal(got.length, 1)
  assert.equal(got[0]!.title, 'Sales activity due')
  assert.ok(!got[0]!.body.includes('Secret deal name') && !got[0]!.body.includes('Asha'))
  assert.equal(await withTenant(c.id, tx => sendDueReminders(tx, c.id)), 0)
})

test('no reminder for done activities, closed or erased leads, or one not yet due', async () => {
  const c = await sales()
  const ids = await Promise.all(['Done', 'Lost', 'Erased', 'Later'].map(t => createLead(c.rep, lead('Lead ' + t))))
  const [done, lost, erased, later] = ids as [typeof ids[0], typeof ids[0], typeof ids[0], typeof ids[0]]
  const act = (id: string, minutes: number) => createActivity(c.rep, { leadId: id, kind: 'task', summary: 'Do it', dueAt: inMinutes(minutes), remindBefore: '15m' })
  const a1 = await act(done.id, 10)
  await completeActivity(c.rep, { activityId: a1.id })
  await act(lost.id, 10); await act(erased.id, 10); await act(later.id, 24 * 60)
  await authDb.execute(sql`update crm_leads set status = 'lost', lost_reason_id = (select id from crm_lost_reasons where institution_id = ${c.id} limit 1) where id = ${lost.id}`)
  await authDb.execute(sql`update crm_leads set erased_at = now() where id = ${erased.id}`)
  assert.equal(await withTenant(c.id, tx => sendDueReminders(tx, c.id)), 0)
})

test("an activity's assignee is the actor or the lead's owner", async () => {
  const c = await sales()
  const l = await createLead(c.rep, lead('Theirs'))
  const body = (assigneeId: string) => ({ leadId: l.id, kind: 'call', summary: 'Ring', dueAt: inMinutes(60), assigneeId })
  await createActivity(c.manager, body(c.rep.id))
  await assert.rejects(() => createActivity(c.manager, body(c.rep2.id)), refused(400, 'bad_assignee'))
  await assert.rejects(() => createActivity(c.rep2, body(c.rep2.id)), refused(404))
})

test('two runs at once remind once', async () => {
  const c = await sales()
  const l = await createLead(c.rep, lead('Race'))
  await createActivity(c.rep, { leadId: l.id, kind: 'call', summary: 'Ring', dueAt: inMinutes(5), remindBefore: '15m' })
  const [a, b] = await Promise.all([withTenant(c.id, tx => sendDueReminders(tx, c.id)), withTenant(c.id, tx => sendDueReminders(tx, c.id))])
  assert.equal(a + b, 1)
  assert.equal((await notes(c, c.rep.id)).length, 1)
})

test('the job is declared every 15 minutes', () => {
  const job = jobs.find(j => j.kind === 'crm.activity-reminders')
  assert.equal(job?.everyMinutes, 15)
})

test('an opted-out person gets no reminder, and it is not retried', async () => {
  const c = await sales()
  const l = await createLead(c.rep, lead('Muted'))
  const a = await createActivity(c.rep, { leadId: l.id, kind: 'call', summary: 'Ring', dueAt: inMinutes(5), remindBefore: '15m' })
  await withTenant(c.id, tx => tx.execute(sql`insert into notification_opt_outs (institution_id, user_id, module_id) values (${c.id}, ${c.rep.id}, 'crm')`))
  await withTenant(c.id, tx => sendDueReminders(tx, c.id))
  assert.equal((await notes(c, c.rep.id)).length, 0)
  const row = (await authDb.execute(sql`select reminded_at from crm_activities where id = ${a.id}`)).rows[0] as { reminded_at: string | null }
  assert.ok(row.reminded_at)
})
