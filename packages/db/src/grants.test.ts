import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, sql } from 'drizzle-orm'
import { auditLog } from './audit'
import { authDb, db, withTenant } from './client'
import { institutionModules, institutions, users } from './schema'

/**
 * What the application role may touch, checked against the database rather
 * than against intentions.
 *
 * The application role is what every request runs as, so it is what an
 * injection or a misbehaving plugin gets. It must not be able to read another
 * tenant's credentials (SEC-05), entitle or un-suspend a tenant (SEC-05),
 * rewrite the audit trail (AUD-01) or delete a person and their records with
 * them (DATA-09). The owner may do none of the audit-trail rewriting either:
 * the trigger binds every role, and only offboarding an institution removes
 * its trail.
 */

const SLUG = 'grants-test'
let inst: string
let person: string

/** Postgres's message, which drizzle hangs off `.cause`. */
const says = (re: RegExp) => (e: unknown) => {
  let text = ''
  for (let x: unknown = e; x instanceof Error; x = (x as { cause?: unknown }).cause) text += x.message + '\n'
  return re.test(text)
}
const denied = says(/permission denied/)
const appendOnly = says(/audit_log is append-only/)

before(async () => {
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: SLUG, name: 'Grants College', allowedEmailDomains: ['grants.test'] })
    .returning({ id: institutions.id })
  inst = i!.id
  const [u] = await authDb
    .insert(users)
    .values({ email: 'person@grants.test', institutionId: inst, role: 'faculty', name: 'A Person' })
    .returning({ id: users.id })
  person = u!.id
  await withTenant(inst, (tx) =>
    tx.insert(auditLog).values({
      institutionId: inst, actorId: person, moduleId: 'core', action: 'test.event',
      entity: 'users', entityId: person, reason: 'a trail to protect',
    }),
  )
})

after(async () => {
  await authDb.delete(institutions).where(eq(institutions.slug, SLUG))
})

test('the application role holds exactly the planned privileges on core control tables (SEC-05, AUD-01)', async () => {
  const want: Record<string, string[]> = {
    sessions: [],
    accounts: [],
    verificationToken: [],
    device_tokens: [],
    institutions: ['SELECT'],
    institution_modules: ['SELECT'],
    audit_log: ['INSERT', 'SELECT'],
    audit_chain: ['SELECT'],
    platform_audit_log: [],
    users: ['INSERT', 'SELECT', 'UPDATE'],
  }
  const got = await authDb.execute<{ t: string; p: string[] }>(sql`
    select t, array(
      select p from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p
       where has_table_privilege('campusos_app', format('public.%I', t), p)
       order by p) as p
      from unnest(${sql.raw(`array[${Object.keys(want).map((t) => `'${t}'`).join(', ')}]`)}::text[]) t`)
  const actual = Object.fromEntries(got.rows.map((r) => [r.t, r.p]))
  assert.deepEqual(actual, want)
})

test('the application role cannot read credentials (SEC-05)', async () => {
  for (const table of ['sessions', 'accounts', '"verificationToken"', 'device_tokens']) {
    await assert.rejects(
      () => withTenant(inst, (tx) => tx.execute(sql.raw(`select 1 from ${table} limit 1`))),
      denied,
      table,
    )
  }
})

test('the application role cannot entitle, un-suspend or rename a tenant (SEC-05)', async () => {
  await assert.rejects(
    () => withTenant(inst, (tx) => tx.update(institutions).set({ suspendedAt: null }).where(eq(institutions.id, inst))),
    denied,
  )
  await assert.rejects(
    () => withTenant(inst, (tx) => tx.insert(institutionModules).values({ institutionId: inst, moduleId: 'finance', enabled: true })),
    denied,
  )
  await assert.rejects(
    () => db.insert(institutions).values({ slug: 'grants-forged', name: 'Forged', allowedEmailDomains: [] }),
    denied,
  )
})

test('the application role cannot rewrite or delete the audit trail (AUD-01)', async () => {
  await assert.rejects(
    () => withTenant(inst, (tx) => tx.update(auditLog).set({ reason: 'tampered' }).where(eq(auditLog.institutionId, inst))),
    denied,
  )
  await assert.rejects(
    () => withTenant(inst, (tx) => tx.delete(auditLog).where(eq(auditLog.institutionId, inst))),
    denied,
  )
})

test('the application role cannot delete a person (DATA-09)', async () => {
  await assert.rejects(
    () => withTenant(inst, (tx) => tx.delete(users).where(eq(users.id, person))),
    denied,
  )
})

test('the audit trail is append-only for the owner too (AUD-01)', async () => {
  await assert.rejects(
    () => authDb.update(auditLog).set({ reason: 'tampered' }).where(eq(auditLog.institutionId, inst)),
    appendOnly,
  )
  await assert.rejects(() => authDb.delete(auditLog).where(eq(auditLog.institutionId, inst)), appendOnly)
  // Since P0-02 the chain's foreign key refuses a bare truncate before the guard
  // runs; truncating both together reaches the guards.
  await assert.rejects(() => authDb.execute(sql`truncate audit_log`), says(/append-only|referenced in a foreign key constraint/))
  await assert.rejects(() => authDb.execute(sql`truncate audit_log, audit_chain`), says(/append-only/))
  // Deleting a person who has a trail would null the actor on every row they
  // wrote. That is a rewrite too, so it is refused: people are erased instead.
  await assert.rejects(() => authDb.delete(users).where(eq(users.id, person)), appendOnly)
  const [row] = await withTenant(inst, (tx) => tx.select().from(auditLog).where(eq(auditLog.entityId, person)))
  assert.equal(row!.reason, 'a trail to protect')
  assert.equal(row!.actorId, person)
})

test('the two definer functions answer only for the caller’s own institution (SEC-05)', async () => {
  const [elsewhere] = await authDb
    .insert(institutions)
    .values({ slug: 'grants-elsewhere', name: 'Elsewhere', allowedEmailDomains: [] })
    .returning({ id: institutions.id })
  try {
    const [u] = await authDb
      .insert(users)
      .values({ email: 'guardian@grants-elsewhere.test', institutionId: elsewhere!.id, role: 'parent' })
      .returning({ id: users.id })
    await authDb.execute(sql`insert into sessions ("sessionToken", "userId", expires) values ('grants-elsewhere', ${u!.id}, now() + interval '1 day')`)

    // Ending another institution's guardian's sessions ends none of them.
    const ended = await withTenant(inst, (tx) => tx.execute<{ n: number }>(sql`select campusos_end_sessions(${u!.id}) as n`))
    assert.equal(ended.rows[0]!.n, 0)
    const left = await authDb.execute<{ n: number }>(sql`select count(*)::int as n from sessions where "userId" = ${u!.id}`)
    assert.equal(left.rows[0]!.n, 1)
    // In their own institution, it does.
    const own = await withTenant(elsewhere!.id, (tx) => tx.execute<{ n: number }>(sql`select campusos_end_sessions(${u!.id}) as n`))
    assert.equal(own.rows[0]!.n, 1)

    // A job may lock and read only its own institution, and never outside one.
    const elsewhereGate = sql`select * from campusos_job_gate(${elsewhere!.id}, null)`
    await assert.rejects(() => withTenant(inst, (tx) => tx.execute(elsewhereGate)), says(/its own institution/))
    await assert.rejects(() => db.execute(sql`select * from campusos_job_gate(${inst}, null)`), says(/its own institution/))
    const gate = await withTenant(inst, (tx) => tx.execute<{ is_active: boolean }>(sql`select * from campusos_job_gate(${inst}, 'finance')`))
    assert.equal(gate.rows[0]!.is_active, true)
  } finally {
    await authDb.delete(institutions).where(eq(institutions.id, elsewhere!.id))
  }
})

test('offboarding an institution still removes it and its trail', async () => {
  const [gone] = await authDb
    .insert(institutions)
    .values({ slug: 'grants-offboard', name: 'Leaving', allowedEmailDomains: [] })
    .returning({ id: institutions.id })
  const [u] = await authDb
    .insert(users)
    .values({ email: 'leaver@grants-offboard.test', institutionId: gone!.id, role: 'faculty' })
    .returning({ id: users.id })
  await withTenant(gone!.id, (tx) =>
    tx.insert(auditLog).values({
      institutionId: gone!.id, actorId: u!.id, moduleId: 'core', action: 'test.event',
      entity: 'users', entityId: u!.id, reason: 'leaving with the institution',
    }),
  )
  await authDb.delete(institutions).where(eq(institutions.id, gone!.id))
  const left = await authDb.execute<{ n: number }>(sql`
    select (select count(*) from audit_log where institution_id = ${gone!.id})::int
         + (select count(*) from users where institution_id = ${gone!.id})::int as n`)
  assert.equal(left.rows[0]!.n, 0)
})
