import { test } from 'node:test'
import assert from 'node:assert/strict'
import { archiveCostCenter, createCostCenter } from '@campusos/module-finance/api'
import {
  addMember, createProject, listProjects, projectDetail, projectPage, removeMember, setProjectStatus, updateProject,
} from './api'
import { actions, office, project, projectInput, since } from './test-support.test'

const refused = (p: Promise<unknown>, code: string) =>
  assert.rejects(p, (e: unknown) => (e as { code?: string }).code === code, `expected ${code}`)

test('the accounts office creates a project with three stages on a cost centre of the books (MG-62)', async () => {
  const o = await office()
  const p = await project(o)
  const d = await projectDetail(o.accounts, p.id)
  assert.equal(d.project.costCenter, 'PRJ')
  const stages = [...d.stages].sort((a, b) => a.seq - b.seq)
  assert.deepEqual(stages.map((s) => s.name), ['To do', 'In progress', 'Done'])
  assert.deepEqual(stages.map((s) => s.closes), [false, false, true])
})

test('a project needs an open cost centre of its own', async () => {
  const o = await office()
  await refused(createProject(o.accounts, projectInput(o, { costCenter: 'NOPE' })), 'no_such_cost_center')
  await project(o)
  await refused(createProject(o.accounts, projectInput(o)), 'cost_center_taken')
  const old = await createCostCenter(o.admin, { code: 'OLD', name: 'Old' })
  await archiveCostCenter(o.admin, { id: old.id })
  await refused(createProject(o.accounts, projectInput(o, { costCenter: 'OLD' })), 'cost_center_archived')
})

test('a billable project needs a customer and an hourly rate', async () => {
  const o = await office()
  await refused(createProject(o.accounts, projectInput(o, { partyId: undefined })), 'billing_needs_customer_and_rate')
  await refused(createProject(o.accounts, projectInput(o, { partyId: o.supplier })), 'not_customer')
  await refused(createProject(o.accounts, projectInput(o, { billingRate: 'abc' })), 'bad_amount')
})

test('nobody outside the office creates projects, and outsiders cannot see one', async () => {
  const o = await office()
  await refused(createProject(o.manager, projectInput(o)), 'forbidden')
  await refused(createProject(o.student, projectInput(o)), 'forbidden')
  const p = await project(o)
  assert.deepEqual((await listProjects(o.outsider, {})).rows, [])
  await refused(projectDetail(o.outsider, p.id), 'no_such_project')
  const other = await office()
  await refused(projectDetail(other.admin, p.id), 'no_such_project')
})

test('the manager adds and removes members; a member reads but does not manage', async () => {
  const o = await office()
  const p = await project(o)
  assert.equal((await listProjects(o.worker, {})).rows.length, 1)
  await refused(addMember(o.worker, { projectId: p.id, userId: o.outsider.id }), 'not_manager')
  await refused(addMember(o.manager, { projectId: p.id, userId: o.student.id }), 'not_staff')
  await refused(addMember(o.manager, { projectId: p.id, userId: o.worker.id }), 'already_member')
  await removeMember(o.manager, { projectId: p.id, userId: o.worker.id })
  assert.deepEqual((await listProjects(o.worker, {})).rows, [])
  await refused(removeMember(o.manager, { projectId: p.id, userId: o.worker.id }), 'not_a_member')
})

test('only the accounts office edits or closes a project', async () => {
  const o = await office()
  const p = await project(o)
  const edit = { projectId: p.id, name: 'Renamed', managerId: o.manager.id, billable: true, partyId: o.customer, billingRate: '1500' }
  await refused(updateProject(o.manager, edit), 'forbidden')
  await updateProject(o.accounts, edit)
  await setProjectStatus(o.accounts, { projectId: p.id, status: 'closed' })
  assert.equal((await projectDetail(o.accounts, p.id)).project.status, 'closed')
  await refused(setProjectStatus(o.accounts, { projectId: p.id, status: 'closed' }), 'no_change')
})

test('the project list pages without a cap', async () => {
  const o = await office()
  for (const code of ['A1', 'A2', 'A3']) {
    await createCostCenter(o.admin, { code, name: code })
    await project(o, { code, costCenter: code })
  }
  const p1 = await listProjects(o.accounts, {}, projectPage(new Request('https://x/?n=2'), ''))
  assert.deepEqual(p1.rows.map((r) => r.code), ['A1', 'A2'])
  assert.equal(p1.total, 3)
  assert.ok(p1.next)
  const p2 = await listProjects(o.accounts, {}, projectPage(new Request(`https://x/?n=2&after=${p1.next}`), ''))
  assert.deepEqual(p2.rows.map((r) => r.code), ['A3'])
  assert.equal(p2.total, 3)
  assert.equal(p2.next, null)
  const found = await listProjects(o.accounts, {}, projectPage(new Request('https://x/?q=a2'), ''))
  assert.deepEqual(found.rows.map((r) => r.code), ['A2'])
  assert.equal(found.total, 1)
})

test('every change to a project is on the audit trail', async () => {
  const o = await office()
  const from = await since()
  const p = await project(o)
  await updateProject(o.accounts, { projectId: p.id, name: 'Renamed', managerId: o.manager.id, billable: true, partyId: o.customer, billingRate: '1500' })
  await setProjectStatus(o.accounts, { projectId: p.id, status: 'closed' })
  await addMember(o.accounts, { projectId: p.id, userId: o.outsider.id })
  await removeMember(o.accounts, { projectId: p.id, userId: o.outsider.id })
  assert.deepEqual(await actions(o, from), ['project.created', 'member.added', 'project.updated', 'project.status', 'member.added', 'member.removed'])
})
