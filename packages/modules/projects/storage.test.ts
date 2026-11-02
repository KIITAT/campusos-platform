import { test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, sql } from 'drizzle-orm'
import { authDb, institutions, withTenant } from '@campusos/db'
import { createCostCenter } from '@campusos/module-finance/api'
import { office, type Office } from './test-support.test'

const TABLES = [
  'projects_billings', 'projects_cost_rates', 'projects_costings', 'projects_idempotency_keys', 'projects_members',
  'projects_milestones', 'projects_projects', 'projects_stages', 'projects_tasks', 'projects_timesheets',
]

const says = (re: RegExp) => (e: unknown) => re.test(String((e as Error).cause ?? e))

/** Owner inserts: a project on PRJ with a stage, a task and one line of time. */
async function seed(o: Office, status: 'submitted' | 'approved' = 'submitted') {
  const [p] = (await authDb.execute<{ id: string }>(sql`
    insert into projects_projects (institution_id, code, name, manager_id, cost_center, starts_on, created_by)
    values (${o.id}, 'ISO', 'Isolation', ${o.manager.id}, 'PRJ', ${o.last.first}, ${o.accounts.id}) returning id`)).rows
  const [s] = (await authDb.execute<{ id: string }>(sql`
    insert into projects_stages (institution_id, project_id, name, seq) values (${o.id}, ${p!.id}, 'To do', 1) returning id`)).rows
  const [t] = (await authDb.execute<{ id: string }>(sql`
    insert into projects_tasks (institution_id, project_id, stage_id, title, created_by)
    values (${o.id}, ${p!.id}, ${s!.id}, 'Task', ${o.accounts.id}) returning id`)).rows
  const decided = status === 'approved'
  const [l] = (await authDb.execute<{ id: string }>(sql`
    insert into projects_timesheets (institution_id, project_id, task_id, user_id, work_date, minutes, description, status, entered_by, decided_by, decided_at)
    values (${o.id}, ${p!.id}, ${t!.id}, ${o.worker.id}, ${o.last.days[0]}, 60, 'Isolation', ${status}, ${o.worker.id},
            ${decided ? o.manager.id : null}, ${decided ? sql`now()` : null}) returning id`)).rows
  return { project: p!.id, stage: s!.id, task: t!.id, line: l!.id }
}

test('every projects table has row level security and a tenant policy', async () => {
  const tables = await authDb.execute<{ relname: string; relrowsecurity: boolean }>(sql`
    select c.relname, c.relrowsecurity from pg_class c
     where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relname like 'projects\_%' order by 1`)
  assert.deepEqual(tables.rows.map((r) => [r.relname, r.relrowsecurity]).sort(), TABLES.map((t) => [t, true]).sort())
  for (const t of TABLES) {
    const p = await authDb.execute<{ policyname: string; roles: string; qual: string }>(sql`
      select policyname, roles::text as roles, qual from pg_policies where schemaname = 'public' and tablename = ${t}`)
    assert.equal(p.rows.length, 1, t)
    assert.equal(p.rows[0]!.policyname, `${t}_tenant_isolation`)
    assert.equal(p.rows[0]!.roles, '{campusos_app}')
    assert.match(p.rows[0]!.qual, /app\.institution_id/)
  }
})

test("one institution cannot read or write another institution's projects, tasks or time", async () => {
  const [a, b] = [await office(), await office()]
  await seed(a)
  for (const t of ['projects_projects', 'projects_stages', 'projects_tasks', 'projects_timesheets']) {
    const rows = await withTenant(b.id, (tx) => tx.execute(sql.raw(`select 1 from ${t}`)))
    assert.deepEqual(rows.rows, [], t)
  }
  await assert.rejects(
    () => withTenant(b.id, (tx) => tx.execute(sql`
      insert into projects_projects (institution_id, code, name, manager_id, cost_center, starts_on, created_by)
      values (${a.id}, 'EVIL', 'Evil', ${a.manager.id}, 'PRJ', ${a.last.first}, ${a.accounts.id})`)),
    says(/row-level security/i),
  )
})

test('a line belongs to a task of its own project', async () => {
  const o = await office()
  const s = await seed(o)
  await createCostCenter(o.admin, { code: 'PRJ2', name: 'Second' })
  const [q] = (await authDb.execute<{ id: string }>(sql`
    insert into projects_projects (institution_id, code, name, manager_id, cost_center, starts_on, created_by)
    values (${o.id}, 'TWO', 'Two', ${o.manager.id}, 'PRJ2', ${o.last.first}, ${o.accounts.id}) returning id`)).rows
  await assert.rejects(
    () => authDb.execute(sql`
      insert into projects_timesheets (institution_id, project_id, task_id, user_id, work_date, minutes, description, entered_by)
      values (${o.id}, ${q!.id}, ${s.task}, ${o.worker.id}, ${o.last.days[0]}, 60, 'Wrong project', ${o.worker.id})`),
    says(/projects_timesheets_task_fk/),
  )
})

test('approved time is neither edited nor deleted, and unsettled approved time can be reopened', async () => {
  const o = await office()
  const s = await seed(o, 'approved')
  await assert.rejects(() => withTenant(o.id, (tx) => tx.execute(sql`update projects_timesheets set minutes = 120 where id = ${s.line}`)), says(/projects_timesheets_kept/))
  await assert.rejects(() => withTenant(o.id, (tx) => tx.execute(sql`delete from projects_timesheets where id = ${s.line}`)), says(/projects_timesheets_kept/))
  await withTenant(o.id, (tx) => tx.execute(sql`update projects_timesheets set status = 'submitted', decided_by = null, decided_at = null where id = ${s.line}`))
  const r = await authDb.execute<{ status: string }>(sql`select status from projects_timesheets where id = ${s.line}`)
  assert.equal(r.rows[0]!.status, 'submitted')
})

test('submitted time can be deleted', async () => {
  const o = await office()
  const s = await seed(o)
  await withTenant(o.id, (tx) => tx.execute(sql`delete from projects_timesheets where id = ${s.line}`))
  const r = await authDb.execute<{ n: number }>(sql`select count(*)::int as n from projects_timesheets where id = ${s.line}`)
  assert.equal(r.rows[0]!.n, 0)
})

test('offboarding an institution takes its projects with it', async () => {
  const o = await office()
  await seed(o, 'approved')
  await authDb.delete(institutions).where(eq(institutions.id, o.id))
  const r = await authDb.execute<{ n: number }>(sql`select count(*)::int as n from projects_timesheets where institution_id = ${o.id}`)
  assert.equal(r.rows[0]!.n, 0)
})
