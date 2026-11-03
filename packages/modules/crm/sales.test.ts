import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sql } from 'drizzle-orm'
import { authDb, withTenant } from '@campusos/db'
import { completeActivity, createActivity } from './api/activities'
import { createLead, leadDetail, markLost, markWon, moveStage, openBoard, qualifyLead, updateLead } from './api/leads'
import { parseCsv, addNote, captureLead, deleteScript, duplicates, forecast, importLeads, mergeLeads, nextOwner, report, setScript } from './api/sales'
import { leadScore } from './api/score'
import { eraseLead } from './api/leads'
import { setAutoAssign, settings, updateStage } from './api/settings'
import { college, team } from './test-support.test'

const refused = (status: number, code?: string) => (e: unknown) => (e as { status?: number }).status === status && (!code || (e as { code?: string }).code === code)
const lead = (title: string, extra: Record<string, unknown> = {}) => ({ kind: 'lead', title, source: 'website', ...extra })

async function sales() {
  const c = await college()
  await team(c.admin, 'Team One', c.manager.id, [c.rep.id])
  await team(c.admin, 'Team Two', c.admin.id, [c.rep2.id])
  return c
}

test('a lead scores higher the more complete, the better sourced and the further along it is', () => {
  const bare = leadScore({ source: 'other', kind: 'lead' })
  const full = leadScore({ source: 'referral', kind: 'opportunity', email: 'a@b.c', phone: '9', company: 'A', contactName: 'B', gstin: 'G', expectedValuePaise: 1, expectedClose: '2027-01-01', stageProbability: 80, priority: 3 }, 3)
  assert.ok(bare < 20 && full === 100, `${bare} ${full}`)
  assert.ok(leadScore({ source: 'referral', kind: 'lead' }) > leadScore({ source: 'cold_call', kind: 'lead' }))
})

test('each stage has a win chance, and the forecast weighs open opportunities by it', async () => {
  const c = await sales()
  const a = await createLead(c.rep, lead('Deal A', { kind: 'opportunity', expectedValue: '1000', expectedClose: '2027-03-10' }))
  const b = await createLead(c.rep, lead('Deal B', { kind: 'opportunity', expectedValue: '2000', expectedClose: '2027-04-01' }))
  await createLead(c.rep, lead('Deal C', { kind: 'opportunity', expectedValue: '500' }))
  const cfg = await settings(c.admin)
  const [first, second] = cfg.stages
  assert.deepEqual(cfg.stages.map(s => s.probability), [10, 30, 60, 80])
  await moveStage(c.rep, { leadId: b.id, stageId: second!.id })
  const f = await forecast(c.rep)
  assert.equal(f.totalPaise, 350000)
  // A and C sit in the first stage at 10%, B in the second at 30%.
  assert.equal(f.weightedPaise, Math.floor(100000 * 0.1) + Math.floor(200000 * 0.3) + Math.floor(50000 * 0.1))
  assert.deepEqual(f.months.map(m => m.month), ['2027-03', '2027-04', 'unscheduled'])
  assert.equal(f.stages.find(s => s.stageId === first!.id)!.count, 2)
  await updateStage(c.admin, { stageId: first!.id, probability: '50' })
  assert.equal((await forecast(c.rep)).stages.find(s => s.stageId === first!.id)!.probability, 50)
  await assert.rejects(() => updateStage(c.admin, { stageId: first!.id, probability: '101' }))
  void a
})

test("the forecast and the report show a salesperson only what they may see", async () => {
  const c = await sales()
  await createLead(c.rep, lead('Mine', { kind: 'opportunity', expectedValue: '100' }))
  await createLead(c.rep2, lead('Theirs', { kind: 'opportunity', expectedValue: '900' }))
  assert.equal((await forecast(c.rep)).totalPaise, 10000)
  assert.equal((await forecast(c.admin)).totalPaise, 100000)
  assert.deepEqual((await report(c.rep)).owners.map(o => o.ownerId), [c.rep.id])
  await assert.rejects(() => forecast(c.outsider), refused(403, 'not_in_sales_team'))
  await assert.rejects(() => report(c.clerk), refused(403, 'not_in_sales_team'))
})

test('the report counts wins and losses per person, the win rate and the reasons', async () => {
  const c = await sales()
  const w = await createLead(c.rep, lead('Deal W', { kind: 'opportunity', expectedValue: '700' }))
  await markWon(c.rep, { leadId: w.id })
  const reasons = (await settings(c.admin)).reasons
  for (const t of ['Lost 1', 'Lost 2']) { const l = await createLead(c.rep, lead(t)); await markLost(c.rep, { leadId: l.id, reasonId: reasons[0]!.id }) }
  const r = await report(c.admin)
  const mine = r.owners.find(o => o.ownerId === c.rep.id)!
  assert.deepEqual([mine.won, mine.lost, mine.wonPaise, mine.winRate], [1, 2, 70000, 33])
  assert.deepEqual(r.lostReasons, [{ name: reasons[0]!.name, count: 2 }])
  assert.equal(r.winRate, 33)
  assert.equal((await report(c.admin, { from: '2000-01-01', to: '2000-01-02' })).won, 0)
  await assert.rejects(() => report(c.admin, { from: 'yesterday' }))
})

test('a lead keeps a history: notes by people, lines for what happened, none with contact data', async () => {
  const c = await sales()
  const l = await createLead(c.rep, lead('Hist', { email: 'secret.person@example.test' }))
  await addNote(c.rep, { leadId: l.id, body: 'Called; wants a demo next week.' })
  await qualifyLead(c.rep, { leadId: l.id })
  const d = await leadDetail(c.rep, l.id)
  const bodies = d.history.map(h => h.body)
  assert.ok(bodies.includes('Called; wants a demo next week.') && bodies.includes('Qualified as an opportunity') && bodies.includes('Opportunity created') === false && bodies.includes('Lead created'))
  assert.ok(d.history.filter(h => h.kind === 'system').every(h => !h.body.includes('secret.person')))
  await assert.rejects(() => addNote(c.rep2, { leadId: l.id, body: 'Not mine' }), refused(404))
  await assert.rejects(() => addNote(c.rep, { leadId: l.id, body: '   ' }))
  await markLost(c.rep, { leadId: l.id, reasonId: (await settings(c.admin)).reasons[0]!.id })
  await addNote(c.rep, { leadId: l.id, body: 'Chose the competitor.' }) // a closed lead still takes a note
})

test("erasing a contact erases the notes people wrote, and keeps the lines that say what happened", async () => {
  const c = await sales()
  const l = await createLead(c.rep, lead('Erase me'))
  await addNote(c.rep, { leadId: l.id, body: 'Her mobile is 9876543210' })
  await eraseLead(c.admin, { leadId: l.id, reason: 'Request ref DPDP-2026-001' })
  const rows = await withTenant(c.id, async tx => (await tx.execute(sql`select kind, body from crm_notes where lead_id = ${l.id}::uuid`)).rows as { kind: string; body: string }[])
  assert.ok(rows.some(r => r.kind === 'note' && r.body === '[erased]'))
  assert.ok(!rows.some(r => r.body.includes('9876543210')))
  assert.ok(rows.some(r => r.kind === 'system' && r.body === 'Lead created'))
})

test('finishing an activity plans the next one from the sales script', async () => {
  const c = await sales()
  await assert.rejects(() => setScript(c.rep, { afterKind: 'call', nextKind: 'email', afterDays: 2, summary: 'Send the proposal' }), refused(403))
  const s = await setScript(c.admin, { afterKind: 'call', nextKind: 'email', afterDays: 2, summary: 'Send the proposal' })
  await setScript(c.admin, { afterKind: 'call', nextKind: 'quotation', afterDays: 3, summary: 'Quote it' }) // replaces, one per kind
  assert.equal((await settings(c.admin)).scripts.length, 1)
  const l = await createLead(c.rep, lead('Scripted'))
  const a = await createActivity(c.rep, { leadId: l.id, kind: 'call', summary: 'Intro call', dueAt: '2027-01-01T10:00', remindBefore: 'none' })
  const done = await completeActivity(c.rep, { activityId: a.id })
  assert.match(done.notice, /next activity is planned/)
  const next = (await leadDetail(c.rep, l.id)).activities.filter(x => !x.doneAt)
  assert.deepEqual(next.map(x => [x.kind, x.summary]), [['quotation', 'Quote it']])
  assert.equal(next[0]!.assigneeId, c.rep.id)
  // Email and quotation are activity kinds now, and a kind with no script plans nothing.
  const e = await createActivity(c.rep, { leadId: l.id, kind: 'email', summary: 'Mail', dueAt: '2027-01-02T10:00', remindBefore: 'none' })
  assert.doesNotMatch((await completeActivity(c.rep, { activityId: e.id })).notice, /planned/)
  await deleteScript(c.admin, { scriptId: (await settings(c.admin)).scripts[0]!.id })
  await assert.rejects(() => deleteScript(c.admin, { scriptId: s.id }), refused(404))
  // A script does not plan work on a lead that is no longer open.
  await setScript(c.admin, { afterKind: 'task', nextKind: 'call', afterDays: 0, summary: 'Ring' })
  const l2 = await createLead(c.rep, lead('Closing'))
  const t = await createActivity(c.rep, { leadId: l2.id, kind: 'task', summary: 'Task', dueAt: '2027-01-01T10:00', remindBefore: 'none' })
  await markLost(c.rep, { leadId: l2.id, reasonId: (await settings(c.admin)).reasons[0]!.id })
  await completeActivity(c.rep, { activityId: t.id })
  assert.equal((await leadDetail(c.rep, l2.id)).activities.filter(x => !x.doneAt).length, 0)
})

test('a captured lead goes to the team member with the fewest open leads, in turn', async () => {
  const c = await college()
  const t = await team(c.admin, 'Inbound', c.manager.id, [c.rep.id, c.rep2.id])
  // No team takes automatic assignment yet: the caller keeps the lead.
  assert.equal((await captureLead(c.admin, lead('First', { email: 'x@y.z' }))).ownerId, c.admin.id)
  await assert.rejects(() => setAutoAssign(c.rep, { teamId: t, autoAssign: 'on' }), refused(403))
  await setAutoAssign(c.admin, { teamId: t, autoAssign: 'on' })
  assert.equal((await settings(c.admin)).teams[0]!.autoAssign, true)
  const owners: string[] = []
  for (const n of [1, 2, 3, 4]) owners.push((await captureLead(c.admin, lead('Inbound ' + n))).ownerId)
  const count = (id: string) => owners.filter(o => o === id).length
  assert.deepEqual([count(c.rep.id), count(c.rep2.id)], [2, 2])
  assert.notEqual(owners[0], owners[1])
  await assert.rejects(() => captureLead(c.rep, lead('Nope')), refused(403))
  assert.equal(await withTenant(c.id, tx => nextOwner(tx, c.id, crypto.randomUUID())), null)
  await setAutoAssign(c.admin, { teamId: t, autoAssign: '' })
  assert.equal((await captureLead(c.admin, lead('Off again'))).ownerId, c.admin.id)
})

test('an import records the good rows, reports the bad ones and does not stop', async () => {
  const c = await college()
  const t = await team(c.admin, 'Inbound', c.manager.id, [c.rep.id])
  await setAutoAssign(c.admin, { teamId: t, autoAssign: 'on' })
  const r = await importLeads(c.admin, { rows: [
    lead('Good one', { email: 'a@b.test' }), { title: 'x' }, lead('Bad value', { expectedValue: 'lots' }), lead('Good two', { company: 'Co', expectedValue: '1,500.50' }), lead('Bad gstin', { gstin: '123' }),
  ] })
  assert.equal(r.created, 2)
  assert.deepEqual(r.skipped.map(s => s.row), [2, 3, 5])
  const rows = await withTenant(c.id, async tx => (await tx.execute(sql`select owner_id, source, kind from crm_leads order by title`)).rows as { owner_id: string; source: string; kind: string }[])
  assert.equal(rows.length, 2)
  assert.ok(rows.every(x => x.owner_id === c.rep.id && x.kind === 'lead'))
  await assert.rejects(() => importLeads(c.rep, { rows: [lead('x')] }), refused(403))
  await assert.rejects(() => importLeads(c.admin, { rows: [] }))
  await assert.rejects(() => importLeads(c.admin, { rows: Array.from({ length: 501 }, () => lead('x')) }))
})

test('duplicates are found by e-mail, phone or company within what you can see, and merge into one', async () => {
  const c = await sales()
  const a = await createLead(c.rep, lead('Acme enquiry', { email: 'Buyer@Acme.test', phone: '+91 98765 43210', company: 'Acme' }))
  const b = await createLead(c.rep, lead('Acme again', { email: 'buyer@acme.test', notes: 'Second contact', itemId: undefined }))
  const p = await createLead(c.rep, lead('Phone only', { phone: '098765-43210' }))
  const other = await createLead(c.rep2, lead('Not visible', { email: 'buyer@acme.test' }))
  await createLead(c.rep, lead('Unrelated', { email: 'z@z.test', company: 'Other' }))
  const found = await duplicates(c.rep, a.id)
  assert.deepEqual(found.map(f => [f.id, f.matches]).sort(), [[b.id, ['e-mail']], [p.id, ['phone']]].sort())
  assert.ok(!found.some(f => f.id === other.id))
  await addNote(c.rep, { leadId: b.id, body: 'From the second lead' })
  await createActivity(c.rep, { leadId: b.id, kind: 'call', summary: 'Ring back', dueAt: '2027-01-01T10:00', remindBefore: 'none' })
  await assert.rejects(() => mergeLeads(c.rep, { keepId: a.id, mergeId: a.id }), refused(400, 'same_lead'))
  await assert.rejects(() => mergeLeads(c.rep, { keepId: a.id, mergeId: other.id }), refused(404))
  await mergeLeads(c.rep, { keepId: a.id, mergeId: b.id })
  const d = await leadDetail(c.rep, a.id)
  assert.equal(d.lead.notes, 'Second contact') // a blank on the kept lead is filled
  assert.equal(d.lead.company, 'Acme') // a filled one is not overwritten
  assert.deepEqual(d.activities.map(x => x.summary), ['Ring back'])
  assert.ok(d.history.some(h => h.body === 'From the second lead') && d.history.some(h => h.body === 'Merged with a duplicate lead'))
  await assert.rejects(() => leadDetail(c.rep, b.id), refused(404))
  const won = await createLead(c.rep, lead('Closed one', { kind: 'opportunity', email: 'buyer@acme.test' }))
  await markWon(c.rep, { leadId: won.id })
  await assert.rejects(() => mergeLeads(c.rep, { keepId: a.id, mergeId: won.id }), refused(409, 'not_open'))
  assert.ok(!(await duplicates(c.rep, a.id)).some(f => f.id === won.id))
})

test('priority is kept, bounded, and lifts the score; a board card carries the score and no contact data', async () => {
  const c = await sales()
  const l = await createLead(c.rep, lead('Starred', { kind: 'opportunity', email: 'private@x.test', phone: '9999999999', priority: '3' }))
  assert.equal((await leadDetail(c.rep, l.id)).lead.priority, 3)
  await updateLead(c.rep, { leadId: l.id, priority: '1' })
  assert.equal((await leadDetail(c.rep, l.id)).lead.priority, 1)
  await assert.rejects(() => createLead(c.rep, lead('Too high', { priority: '4' })))
  const card = (await openBoard(c.rep))[0]!
  assert.equal(typeof card.score, 'number')
  assert.ok(!JSON.stringify(card).includes('private@x.test') && !JSON.stringify(card).includes('9999999999'))
  assert.equal(card.priority, 1)
  await authDb.execute(sql`select 1`)
})

test('a pasted spreadsheet imports like rows do: quotes, commas and blank lines are handled', async () => {
  const c = await college()
  const csv = ['Title,Contact Name,Source,Expected Value,Notes', '"Acme, Inc",Asha,referral,"1,500","line one', 'line two"', '', 'Beta Ltd,,website,,', 'x,,website,,'].join('\r\n')
  assert.deepEqual(parseCsv(csv).map(r => r.title), ['Acme, Inc', 'Beta Ltd', 'x'])
  const r = await importLeads(c.admin, { csv })
  assert.deepEqual([r.created, r.skipped.map(s => s.row)], [2, [3]])
  const rows = await withTenant(c.id, async tx => (await tx.execute(sql`select title, contact_name, expected_value_paise, notes from crm_leads order by title`)).rows as Record<string, unknown>[])
  assert.deepEqual(rows.map(x => [x.title, x.contact_name, x.expected_value_paise === null ? null : Number(x.expected_value_paise)]), [['Acme, Inc', 'Asha', 150000], ['Beta Ltd', null, null]])
  assert.equal(rows[0]!.notes, 'line one\nline two')
  await assert.rejects(() => importLeads(c.admin, { csv, rows: [lead('x')] }))
  await assert.rejects(() => importLeads(c.admin, { csv: 'Title,Source' }), refused(400, 'empty_import'))
})
