import { test } from 'node:test'
import assert from 'node:assert/strict'
import { and, eq, gt } from 'drizzle-orm'
import { auditLog, authDb, withTenant } from '@campusos/db'
import { sql } from 'drizzle-orm'
import { addTeamMember, createStage, createTeam, ownersOf, removeTeamMember } from './api/settings'
import { college, team } from './test-support.test'

const refused = (status: number, code?: string) => (e: unknown) => (e as { status?: number }).status === status && (!code || (e as { code?: string }).code === code)

test('only an administrator configures the pipeline', async () => {
  const c = await college()
  await assert.rejects(() => createStage(c.rep, { name: 'X', seq: 5 }), refused(403))
  await assert.rejects(() => createTeam(c.rep, { name: 'Team', managerId: c.rep.id }), refused(403))
  await assert.rejects(() => addTeamMember(c.rep, { teamId: crypto.randomUUID(), userId: c.rep.id }), refused(403))
})

test('stage names are unique per institution', async () => {
  const a = await college(), b = await college()
  await createStage(a.admin, { name: 'Won over', seq: 50 })
  await assert.rejects(() => createStage(a.admin, { name: 'Won over', seq: 60 }), refused(409, 'stage_exists'))
  await createStage(b.admin, { name: 'Won over', seq: 50 })
})

test('a person is in one team at most', async () => {
  const c = await college()
  const t1 = await team(c.admin, 'Team A', c.manager.id, [c.rep.id])
  const t2 = await createTeam(c.admin, { name: 'Team B', managerId: c.manager.id })
  await assert.rejects(() => addTeamMember(c.admin, { teamId: t2.id, userId: c.rep.id }), refused(409, 'already_in_team'))
  assert.ok(t1)
})

test('ownersOf: a salesperson sees themself, a manager their team, an outsider nothing', async () => {
  const c = await college()
  await team(c.admin, 'T1', c.manager.id, [c.rep.id])
  await team(c.admin, 'T2', c.admin.id, [c.rep2.id])
  const of = (actor: typeof c.rep) => withTenant(c.id, tx => ownersOf(tx, actor))
  assert.deepEqual(await of(c.rep), [c.rep.id])
  assert.deepEqual((await of(c.manager))!.sort(), [c.manager.id, c.rep.id].sort())
  assert.equal(await of(c.admin), null)
  await assert.rejects(() => of(c.outsider), refused(403, 'not_in_sales_team'))
  assert.ok(!(await of(c.rep2))!.includes(c.rep.id))
})

test('a member who owns open leads cannot be removed', async () => {
  const c = await college()
  const t = await team(c.admin, 'Team T', c.manager.id, [c.rep.id])
  await authDb.execute(sql`insert into crm_leads (institution_id, title, source, owner_id, created_by) values (${c.id}, 'L', 'website', ${c.rep.id}, ${c.rep.id})`)
  await assert.rejects(() => removeTeamMember(c.admin, { teamId: t, userId: c.rep.id }), refused(409, 'owns_open_leads'))
})

test('settings changes are audited without free text in the trail', async () => {
  const c = await college()
  const rows = () => withTenant(c.id, tx => tx.select({ action: auditLog.action, reason: auditLog.reason }).from(auditLog).where(and(eq(auditLog.moduleId, 'crm'), gt(auditLog.at, mark))))
  const mark = new Date(((await authDb.execute<{ now: string }>(sql`select now() - interval '1 second' as now`)).rows[0]!).now)
  await createStage(c.admin, { name: 'Audited stage', seq: 7 })
  const t = await createTeam(c.admin, { name: 'Audited team', managerId: c.manager.id })
  await addTeamMember(c.admin, { teamId: t.id, userId: c.rep.id })
  const found = (await rows()).map(r => r.action).sort()
  assert.deepEqual(found, ['stage.created', 'team.created', 'team.member_added'])
  assert.ok((await rows()).every(r => !/Audited/.test(r.reason)))
})
