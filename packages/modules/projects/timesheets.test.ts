import { test } from 'node:test'
import assert from 'node:assert/strict'
import { authDb } from '@campusos/db'
import { sql } from 'drizzle-orm'
import { createCostCenter } from '@campusos/module-finance/api'
import {
  createProject, createTask, decideTime, deleteTime, listTimesheets, logTime, reopenTime, setProjectStatus, sheetPage, updateTime,
} from './api'
import { actions, office, project, projectInput, since, type Office } from './test-support.test'

const refused = (p: Promise<unknown>, code: string) =>
  assert.rejects(p, (e: unknown) => (e as { code?: string }).code === code, `expected ${code}`)

const NOTE = 'Confidential survey note'

/** A project with one task T assigned to the worker. */
async function withTask(o: Office, over: Record<string, unknown> = {}) {
  const p = await project(o, over)
  const t = await createTask(o.manager, { projectId: p.id, title: 'Survey', assigneeId: o.worker.id }) as { id: string }
  return { p, t: t.id }
}

const log = (o: Office, t: string, who = o.worker, over: Record<string, unknown> = {}) =>
  logTime(who, { taskId: t, workDate: o.last.days[0], minutes: 60, description: NOTE, ...over }) as Promise<{ id: string; status: string; userId: string; enteredBy: string }>

test('a member logs time on a task, in quarter hours (MG-63)', async () => {
  const o = await office()
  const { t } = await withTask(o)
  const l = await logTime(o.worker, { taskId: t, workDate: o.last.days[0], minutes: 480, description: 'Field survey' }) as { status: string; userId: string; enteredBy: string }
  assert.equal(l.status, 'submitted')
  assert.equal(l.userId, o.worker.id)
  assert.equal(l.enteredBy, o.worker.id)
  for (const minutes of [10, 1445, 50]) await refused(log(o, t, o.worker, { minutes }), 'bad_minutes')
})

test('time is not logged in the future, outside the project or on a closed project', async () => {
  const o = await office()
  const { p, t } = await withTask(o)
  const tomorrow = new Date(`${o.today}T00:00:00Z`)
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)
  await refused(log(o, t, o.worker, { workDate: tomorrow.toISOString().slice(0, 10) }), 'future_date')
  await createCostCenter(o.admin, { code: 'PRJ2', name: 'Second' })
  const q = await createProject(o.accounts, projectInput(o, { costCenter: 'PRJ2', startsOn: o.last.days[2] })) as { id: string }
  const qt = await createTask(o.accounts, { projectId: q.id, title: 'Late start' }) as { id: string }
  await refused(logTime(o.manager, { taskId: qt.id, workDate: o.last.days[0], minutes: 60, description: 'Too early' }), 'outside_project')
  await setProjectStatus(o.accounts, { projectId: p.id, status: 'closed' })
  await refused(log(o, t), 'project_closed')
})

test('people log their own time; the manager logs for a member, never for an outsider', async () => {
  const o = await office()
  const { t } = await withTask(o)
  await refused(log(o, t, o.worker, { userId: o.manager.id }), 'not_for_others')
  const l = await log(o, t, o.manager, { userId: o.worker.id })
  assert.equal(l.userId, o.worker.id)
  assert.equal(l.enteredBy, o.manager.id)
  await refused(log(o, t, o.manager, { userId: o.outsider.id }), 'not_a_member')
  await refused(log(o, t, o.outsider), 'no_such_project')
  await refused(log(o, t, o.student), 'forbidden')
})

test('the manager approves; nobody approves their own time; accounts staff do not approve', async () => {
  const o = await office()
  const { t } = await withTask(o)
  const m = await log(o, t, o.manager)
  const w = await log(o, t)
  await refused(decideTime(o.manager, { ids: [m.id], decision: 'approved' }), 'own_timesheet')
  await refused(decideTime(o.accounts, { ids: [w.id], decision: 'approved' }), 'not_approver')
  await decideTime(o.admin, { ids: [m.id], decision: 'approved' })
  await decideTime(o.manager, { ids: [w.id], decision: 'approved' })
  const rows = (await listTimesheets(o.manager, {})).rows
  assert.equal(rows.find((r) => r.id === w.id)!.status, 'approved')
  const [d] = (await authDb.execute<{ decided_by: string }>(sql`select decided_by from projects_timesheets where id = ${w.id}`)).rows
  assert.equal(d!.decided_by, o.manager.id)
})

test('a rejection needs a note and goes back to its author', async () => {
  const o = await office()
  const { t } = await withTask(o)
  const w = await log(o, t)
  await refused(decideTime(o.manager, { ids: [w.id], decision: 'rejected' }), 'note_required')
  await decideTime(o.manager, { ids: [w.id], decision: 'rejected', note: 'Wrong task code' })
  let row = (await listTimesheets(o.worker, {})).rows[0]!
  assert.equal(row.status, 'rejected')
  assert.equal(row.decisionNote, 'Wrong task code')
  await updateTime(o.worker, { lineId: w.id, workDate: o.last.days[0], minutes: 240, description: 'Field survey' })
  row = (await listTimesheets(o.worker, {})).rows[0]!
  assert.equal(row.status, 'submitted')
  assert.equal(row.decisionNote, null)
})

test('approved time is not changed; reopening sends it back', async () => {
  const o = await office()
  const { t } = await withTask(o)
  const w = await log(o, t)
  await decideTime(o.manager, { ids: [w.id], decision: 'approved' })
  const edit = { lineId: w.id, workDate: o.last.days[0], minutes: 240, description: 'Field survey' }
  await refused(updateTime(o.worker, edit), 'not_editable')
  await refused(deleteTime(o.worker, { lineId: w.id }), 'not_editable')
  await refused(reopenTime(o.worker, { lineId: w.id, reason: 'Hours were wrong' }), 'not_approver')
  await reopenTime(o.manager, { lineId: w.id, reason: 'Hours were wrong' })
  assert.equal((await listTimesheets(o.worker, {})).rows[0]!.status, 'submitted')
  await updateTime(o.worker, edit)
})

test('a decision takes every line it names or none', async () => {
  const o = await office()
  const { t } = await withTask(o)
  const w1 = await log(o, t)
  const w2 = await log(o, t, o.worker, { workDate: o.last.days[1] })
  await decideTime(o.manager, { ids: [w1.id], decision: 'approved' })
  await refused(decideTime(o.manager, { ids: [w2.id, w1.id], decision: 'approved' }), 'not_pending')
  const rows = (await listTimesheets(o.manager, {})).rows
  assert.equal(rows.find((r) => r.id === w2.id)!.status, 'submitted')
})

test('people see their own time and the time of projects they manage', async () => {
  const o = await office()
  const { t } = await withTask(o)
  const w = await log(o, t)
  const m = await log(o, t, o.manager)
  assert.deepEqual((await listTimesheets(o.outsider, {})).rows, [])
  assert.deepEqual((await listTimesheets(o.worker, {})).rows.map((r) => r.id), [w.id])
  assert.deepEqual((await listTimesheets(o.manager, {})).rows.map((r) => r.id).sort(), [w.id, m.id].sort())
  assert.deepEqual((await listTimesheets(o.manager, { queue: 'approvals' })).rows.map((r) => r.id), [w.id])
})

test('the timesheet list pages without a cap', async () => {
  const o = await office()
  const { t } = await withTask(o)
  for (const d of [0, 1, 2]) await log(o, t, o.worker, { workDate: o.last.days[d] })
  const p1 = await listTimesheets(o.worker, {}, sheetPage(new Request('https://x/?n=2'), ''))
  assert.equal(p1.rows.length, 2)
  assert.equal(p1.total, 3)
  assert.ok(p1.next)
  const p2 = await listTimesheets(o.worker, {}, sheetPage(new Request(`https://x/?n=2&after=${p1.next}`), ''))
  assert.equal(p2.rows.length, 1)
  assert.equal(p2.next, null)
})

test('every change to time is on the audit trail, without its description', async () => {
  const o = await office()
  const { t } = await withTask(o)
  const from = await since()
  const a = await log(o, t, o.worker, { workDate: o.last.days[0] })
  const b = await log(o, t, o.worker, { workDate: o.last.days[1] })
  const c = await log(o, t, o.worker, { workDate: o.last.days[2] })
  await updateTime(o.worker, { lineId: a.id, workDate: o.last.days[0], minutes: 90, description: NOTE })
  await deleteTime(o.worker, { lineId: b.id })
  await decideTime(o.manager, { ids: [a.id], decision: 'approved' })
  await decideTime(o.manager, { ids: [c.id], decision: 'rejected', note: 'Wrong task code' })
  await reopenTime(o.manager, { lineId: a.id, reason: 'Hours were wrong' })
  assert.deepEqual(await actions(o, from), [
    'timesheet.logged', 'timesheet.logged', 'timesheet.logged', 'timesheet.updated', 'timesheet.deleted',
    'timesheet.approved', 'timesheet.rejected', 'timesheet.reopened',
  ])
  const rows = await authDb.execute(sql`select detail, reason from audit_log where institution_id = ${o.id} and module_id = 'projects' and at >= ${from}::timestamptz`)
  assert.ok(!JSON.stringify(rows.rows).includes(NOTE))
})
