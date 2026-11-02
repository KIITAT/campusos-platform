import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCostCenter } from '@campusos/module-finance/api'
import {
  addMilestone, addStage, createTask, listTasks, projectDetail, reachMilestone, setProjectStatus, taskPage, updateTask,
} from './api'
import { actions, office, project, since } from './test-support.test'

const refused = (p: Promise<unknown>, code: string) =>
  assert.rejects(p, (e: unknown) => (e as { code?: string }).code === code, `expected ${code}`)

test('the manager adds a stage, a milestone and a task, which starts in the first stage (MG-62)', async () => {
  const o = await office()
  const p = await project(o)
  await addStage(o.manager, { projectId: p.id, name: 'Review', seq: 4 })
  const m = await addMilestone(o.manager, { projectId: p.id, name: 'Phase one', dueOn: o.today }) as { id: string }
  const t = await createTask(o.manager, { projectId: p.id, title: 'Draft report', assigneeId: o.worker.id }) as { id: string }
  let rows = (await listTasks(o.manager, { projectId: p.id })).rows
  assert.equal(rows[0]!.stageName, 'To do')
  assert.equal(rows[0]!.assigneeName, 'Worker')
  await updateTask(o.manager, { taskId: t.id, title: 'Draft report', stageId: p.doing, milestoneId: m.id, assigneeId: o.worker.id })
  rows = (await listTasks(o.manager, { projectId: p.id })).rows
  assert.equal(rows[0]!.stageName, 'In progress')
  assert.equal(rows[0]!.milestoneName, 'Phase one')
})

test("a task takes only its own project's stages and milestones", async () => {
  const o = await office()
  const p = await project(o)
  await createCostCenter(o.admin, { code: 'PRJ2', name: 'Second' })
  const q = await project(o, { costCenter: 'PRJ2' })
  const qm = await addMilestone(o.manager, { projectId: q.id, name: 'Elsewhere' }) as { id: string }
  await refused(createTask(o.manager, { projectId: p.id, title: 'Wrong stage', stageId: q.todo }), 'no_such_stage')
  await refused(createTask(o.manager, { projectId: p.id, title: 'Wrong milestone', milestoneId: qm.id }), 'no_such_milestone')
})

test('only someone on the project is assigned a task', async () => {
  const o = await office()
  const p = await project(o)
  await refused(createTask(o.manager, { projectId: p.id, title: 'For a stranger', assigneeId: o.outsider.id }), 'not_a_member')
})

test('members do not add tasks, and nobody adds tasks to a closed project', async () => {
  const o = await office()
  const p = await project(o)
  await refused(createTask(o.worker, { projectId: p.id, title: 'From a member' }), 'not_manager')
  await setProjectStatus(o.accounts, { projectId: p.id, status: 'closed' })
  await refused(createTask(o.manager, { projectId: p.id, title: 'On a closed project' }), 'project_closed')
})

test('a milestone is reached once', async () => {
  const o = await office()
  const p = await project(o)
  const m = await addMilestone(o.manager, { projectId: p.id, name: 'Phase one' }) as { id: string }
  await reachMilestone(o.manager, { milestoneId: m.id })
  const d = await projectDetail(o.manager, p.id)
  assert.equal(d.milestones[0]!.reachedOn, o.today)
  await refused(reachMilestone(o.manager, { milestoneId: m.id }), 'already_reached')
})

test('the task list pages without a cap', async () => {
  const o = await office()
  const p = await project(o)
  const made: string[] = []
  for (const title of ['Task one', 'Task two', 'Task three']) {
    made.push(((await createTask(o.manager, { projectId: p.id, title })) as { id: string }).id)
  }
  const p1 = await listTasks(o.manager, { projectId: p.id }, taskPage(new Request('https://x/?n=2'), ''))
  assert.equal(p1.rows.length, 2)
  assert.equal(p1.total, 3)
  assert.ok(p1.next)
  const p2 = await listTasks(o.manager, { projectId: p.id }, taskPage(new Request(`https://x/?n=2&after=${p1.next}`), ''))
  assert.equal(p2.rows.length, 1)
  assert.equal(p2.next, null)
  assert.deepEqual([...p1.rows, ...p2.rows].map((r) => r.id).sort(), [...made].sort())
})

test('every change to tasks is on the audit trail', async () => {
  const o = await office()
  const p = await project(o)
  const from = await since()
  await addStage(o.manager, { projectId: p.id, name: 'Review', seq: 4 })
  const m = await addMilestone(o.manager, { projectId: p.id, name: 'Phase one' }) as { id: string }
  const t = await createTask(o.manager, { projectId: p.id, title: 'Draft report' }) as { id: string }
  await updateTask(o.manager, { taskId: t.id, title: 'Draft report', stageId: p.doing })
  await reachMilestone(o.manager, { milestoneId: m.id })
  assert.deepEqual(await actions(o, from), ['stage.created', 'milestone.created', 'task.created', 'task.updated', 'milestone.reached'])
})
