import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import pg from 'pg'
import { like, sql } from 'drizzle-orm'
import { audit } from './audit'
import { authDb, withTenant } from './client'
import { institutions, users } from './schema'

/**
 * The audit trail as evidence (AUD-01).
 *
 * Append-only (P0-01) stops the application role rewriting history, but the
 * owner can switch a trigger off. What makes the trail evidence is that every
 * row is sealed into a hash chain per institution when its transaction commits,
 * and that the chain can be checked by code that does not live in the database
 * and against anchors that do not live on the server.
 *
 * Several tests here drive two connections at once and force the interleaving
 * they are about, rather than hoping a race happens.
 */

const PREFIX = 'chain-test'
const app = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 12 })

/** Postgres's message, which drizzle hangs off `.cause`. */
const says = (re: RegExp) => (e: unknown) => {
  let text = ''
  for (let x: unknown = e; x instanceof Error; x = (x as { cause?: unknown }).cause) text += x.message + '\n'
  return re.test(text)
}
const denied = says(/permission denied/)

async function tenant(name: string): Promise<string> {
  const [row] = await authDb
    .insert(institutions)
    .values({ slug: `${PREFIX}-${name}`, name, allowedEmailDomains: [] })
    .returning({ id: institutions.id })
  return row!.id
}

/** An application-role connection with a transaction open in one tenant. */
async function session(inst: string) {
  const c = await app.connect()
  await c.query('begin')
  await c.query(`select set_config('app.institution_id', $1, true)`, [inst])
  return c
}

/** One audit row through a raw connection; `detail` is JSON text, so big numbers survive. */
const write = (c: pg.PoolClient, inst: string, action: string, detail: string | null = null) =>
  c.query(
    `insert into audit_log (institution_id, module_id, action, entity, entity_id, reason, detail)
     values ($1, 'core', $2, 'x', '1', 'chain test', $3::jsonb)`,
    [inst, action, detail],
  )

const trail = (inst: string, action: string, n = 1) =>
  withTenant(inst, (tx) =>
    audit(tx, { institutionId: inst, actorId: null, moduleId: 'core', action, entity: 'x', entityId: String(n), reason: 'chain test' }),
  )

async function chain(inst: string) {
  const r = await authDb.execute<{ seq: string; action: string; prev_hash: Buffer; hash: Buffer }>(sql`
    select c.seq::text as seq, a.action, c.prev_hash, c.hash
      from audit_chain c join audit_log a on a.id = c.audit_id
     where c.institution_id = ${inst} order by c.seq`)
  return r.rows
}

/** Owner statements in one transaction: how someone with the server's keys would tamper. */
const asOwner = (...statements: string[]) =>
  authDb.transaction(async (tx) => {
    for (const s of statements) await tx.execute(sql.raw(s))
  })

before(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${PREFIX}-%`))
})

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${PREFIX}-%`))
  await app.end()
})

test('each audit row is sealed into its institution’s chain at commit, linked from that chain’s genesis (AUD-01)', async () => {
  const t = await tenant('linked')
  for (const n of [1, 2, 3]) await trail(t, `linked.${n}`, n)

  const rows = await chain(t)
  assert.deepEqual(rows.map((r) => [r.seq, r.action]), [['1', 'linked.1'], ['2', 'linked.2'], ['3', 'linked.3']])
  assert.deepEqual(rows[0]!.prev_hash, createHash('sha256').update(`campusos-audit-genesis:${t}`).digest())
  for (let i = 1; i < rows.length; i++) assert.deepEqual(rows[i]!.prev_hash, rows[i - 1]!.hash)
})

test('an independent recompute in Node agrees with every sealed hash, whatever the content (AUD-01)', async () => {
  const { verifyChains } = await import('./audit-chain')
  const t = await tenant('awkward')
  const c = await session(t)
  try {
    await c.query(
      `insert into audit_log (institution_id, actor_email, module_id, action, entity, entity_id, reason, detail) values
       ($1, 'ଅଭିଷେକ@example.in', 'core', 'awkward.indic', 'x', '1', 'कारण ଅଭିଷେକ 🙂', '{"ଅ": [1, 2, {"z": null}], "big": 123456789012345678901234567890}'),
       ($1, null, 'core', 'awkward.nulls', 'x', '2', '', null),
       ($1, 'a@example.in', 'core', 'awkward.order', 'x', '3', 'keys and numbers', '{"b": 1, "a": 1.50, "e": "", "q": "\\"quoted\\" \\u00e9"}')`,
      [t],
    )
    await c.query('commit')
  } finally {
    c.release()
  }

  const salts = await authDb.execute<{ salt: Buffer }>(sql`select salt from audit_log where institution_id = ${t}`)
  assert.equal(salts.rows.length, 3)
  assert.ok(salts.rows.every((r) => r.salt?.length === 32), 'every new row carries a 32-byte salt')
  assert.equal(new Set(salts.rows.map((r) => r.salt.toString('hex'))).size, 3, 'salts are per row')

  const report = await verifyChains({ institutionId: t })
  assert.deepEqual(report.problems, [])
  assert.equal(report.chains.find((x) => x.chain === `tenant:${t}`)?.rows, 3)
})

test('the verifier names an edited row, a deleted row and an unsealed row (AUD-01)', async () => {
  const { verifyChains } = await import('./audit-chain')
  const t = await tenant('tamper')
  for (const n of [1, 2, 3, 4]) await trail(t, `tamper.${n}`, n)

  // Edited: the owner switches the guard off, rewrites a row, and switches it back on.
  await asOwner(
    'alter table audit_log disable trigger audit_log_append_only',
    `update audit_log set detail = '{"after": 999}' where institution_id = '${t}' and action = 'tamper.2'`,
    'alter table audit_log enable trigger audit_log_append_only',
  )
  // Deleted: the row and its link both go, as a careful attacker would do it.
  await asOwner(
    'alter table audit_log disable trigger audit_log_append_only',
    'alter table audit_chain disable trigger audit_chain_append_only',
    `delete from audit_chain where institution_id = '${t}' and seq = 3`,
    `delete from audit_log where institution_id = '${t}' and action = 'tamper.3'`,
    'alter table audit_chain enable trigger audit_chain_append_only',
    'alter table audit_log enable trigger audit_log_append_only',
  )
  // Unsealed: written with the seal switched off.
  await asOwner(
    'alter table audit_log disable trigger audit_log_seal',
    `insert into audit_log (institution_id, module_id, action, entity, entity_id, reason) values ('${t}', 'core', 'tamper.forged', 'x', '9', 'never sealed')`,
    'alter table audit_log enable trigger audit_log_seal',
  )

  const { problems } = await verifyChains({ institutionId: t })
  const found = problems.map((p) => `${p.kind}@${p.seq ?? '-'}`).sort()
  assert.deepEqual(found, ['altered@2', 'missing@3', 'unsealed@-'])
  assert.ok(problems.every((p) => p.chain === `tenant:${t}`))
})

test('a chain rewritten consistently passes on its own and is caught against an earlier anchor (AUD-01)', async () => {
  const { anchorDocument, chainHeads, verifyChains } = await import('./audit-chain')
  const t = await tenant('rewrite')
  for (const n of [1, 2, 3]) await trail(t, `rewrite.${n}`, n)
  const anchor = anchorDocument(await chainHeads({ institutionId: t }), { runId: randomUUID(), server: 'test' })

  // Rewrite row 2 and re-seal everything after it with the database's own hash function.
  await asOwner(
    'alter table audit_log disable trigger audit_log_append_only',
    'alter table audit_chain disable trigger audit_chain_append_only',
    `update audit_log set reason = 'rewritten' where institution_id = '${t}' and action = 'rewrite.2'`,
    `delete from audit_chain where institution_id = '${t}' and seq >= 2`,
    `do $$ declare r record; prev bytea; s bigint := 1; h bytea; begin
       select hash into prev from audit_chain where institution_id = '${t}' and seq = 1;
       for r in select a.* from audit_log a where a.institution_id = '${t}'
                   and not exists (select 1 from audit_chain c where c.audit_id = a.id) order by a.at, a.id loop
         s := s + 1;
         h := campusos_audit_hash(prev, r.institution_id::text, s, r.id, r.at, r.institution_id, r.actor_id, r.module_id,
                                  r.action, r.entity, r.entity_id, r.actor_email, r.reason, r.detail, r.salt);
         insert into audit_chain (audit_id, institution_id, seq, prev_hash, hash) values (r.id, r.institution_id, s, prev, h);
         prev := h;
       end loop;
     end $$`,
    'alter table audit_chain enable trigger audit_chain_append_only',
    'alter table audit_log enable trigger audit_log_append_only',
  )

  assert.deepEqual((await verifyChains({ institutionId: t })).problems, [], 'a consistent rewrite verifies on its own')
  const { problems } = await verifyChains({ institutionId: t, anchors: [anchor] })
  assert.deepEqual(problems.map((p) => `${p.kind}@${p.seq}`), ['anchor_mismatch@3'])
})

test('two transactions in one institution are chained in commit order, not insert order (AUD-01)', async () => {
  const { verifyChains } = await import('./audit-chain')
  const t = await tenant('order')
  const first = await session(t)
  const second = await session(t)
  try {
    await write(first, t, 'order.inserted-first')
    await write(second, t, 'order.inserted-second')
    await second.query('commit')
    await first.query('commit')
  } finally {
    first.release()
    second.release()
  }
  assert.deepEqual((await chain(t)).map((r) => r.action), ['order.inserted-second', 'order.inserted-first'])
  assert.deepEqual((await verifyChains({ institutionId: t })).problems, [])
})

test('auditing never deadlocks against a row lock taken in the other order (AUD-01)', async () => {
  const t = await tenant('deadlock')
  const [u] = await authDb
    .insert(users)
    .values({ email: 'row@chain-test.invalid', institutionId: t, role: 'faculty' })
    .returning({ id: users.id })
  const a = await session(t)
  const b = await session(t)
  try {
    // A holds the row; B audits; A audits; B wants the row. A design that took
    // the chain lock at insert would now have A waiting for B and B for A.
    await a.query('select 1 from users where id = $1 for update', [u!.id])
    await write(b, t, 'deadlock.b')
    await write(a, t, 'deadlock.a')
    const bWaits = b.query(`update users set name = 'touched' where id = $1`, [u!.id])
    await new Promise((r) => setTimeout(r, 200))
    await a.query('commit')
    await bWaits
    await b.query('commit')
  } finally {
    a.release()
    b.release()
  }
  assert.deepEqual((await chain(t)).map((r) => r.action), ['deadlock.a', 'deadlock.b'])
})

test('one institution’s seal does not hold up another’s (AUD-01)', async () => {
  const held = await tenant('held')
  const free = await tenant('free')
  const lock = await app.connect()
  const heldWriter = await session(held)
  const freeWriter = await session(free)
  try {
    // The seal serialises on a per-institution advisory lock; hold the one for `held`.
    await lock.query('begin')
    await lock.query(`select pg_advisory_xact_lock(1096107092, hashtext($1))`, [held])

    await write(freeWriter, free, 'free.commits')
    await freeWriter.query('commit')

    await write(heldWriter, held, 'held.waits')
    let done = false
    const heldCommit = heldWriter.query('commit').then(() => (done = true))
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(done, false, 'the held institution’s commit waits for its chain lock')
    await lock.query('commit')
    await heldCommit
  } finally {
    lock.release()
    heldWriter.release()
    freeWriter.release()
  }
  assert.deepEqual((await chain(free)).map((r) => r.action), ['free.commits'])
  assert.deepEqual((await chain(held)).map((r) => r.action), ['held.waits'])
})

test('a row written in a rolled-back savepoint is never sealed, and the chain has no gap (AUD-01)', async () => {
  const { verifyChains } = await import('./audit-chain')
  const t = await tenant('savepoint')
  const c = await session(t)
  try {
    await write(c, t, 'savepoint.kept')
    await c.query('savepoint s')
    await write(c, t, 'savepoint.rolled-back')
    await c.query('rollback to savepoint s')
    await write(c, t, 'savepoint.after')
    await c.query('commit')
  } finally {
    c.release()
  }
  assert.deepEqual((await chain(t)).map((r) => [r.seq, r.action]), [['1', 'savepoint.kept'], ['2', 'savepoint.after']])
  assert.deepEqual((await verifyChains({ institutionId: t })).problems, [])
})

test('the application role reads only its own institution’s chain and can change none of it (AUD-01)', async () => {
  const mine = await tenant('rls-mine')
  const theirs = await tenant('rls-theirs')
  await trail(mine, 'rls.mine')
  await trail(theirs, 'rls.theirs')

  const c = await session(mine)
  try {
    const seen = await c.query(`select institution_id from audit_chain`)
    assert.deepEqual(seen.rows.map((r) => r.institution_id), [mine])
  } finally {
    await c.query('rollback')
    c.release()
  }

  const attempts = [
    `insert into audit_chain (audit_id, institution_id, seq, prev_hash, hash) values (gen_random_uuid(), '${mine}', 99, '\\x00', '\\x00')`,
    `update audit_chain set hash = '\\x00' where institution_id = '${mine}'`,
    `delete from audit_chain where institution_id = '${mine}'`,
    `select 1 from platform_audit_log limit 1`,
    `insert into platform_audit_log (module_id, action, entity, entity_id, reason) values ('core', 'forged', 'x', '1', 'forged')`,
  ]
  for (const statement of attempts) {
    const s = await session(mine)
    try {
      await assert.rejects(() => s.query(statement), /permission denied/, statement)
    } finally {
      await s.query('rollback')
      s.release()
    }
  }
})

test('the chain and the platform log are append-only for the owner too; offboarding still removes a tenant’s chain (AUD-01)', async () => {
  const { platformAudit } = await import('./audit')
  const t = await tenant('append-only')
  await trail(t, 'append-only.row')
  await authDb.transaction((tx) =>
    platformAudit(tx, { actorId: null, moduleId: 'core', action: 'test.platform', entity: 'x', entityId: '1', reason: 'append-only check' }),
  )

  await assert.rejects(() => authDb.execute(sql`update audit_chain set hash = decode('00', 'hex') where institution_id = ${t}`), says(/audit_chain is append-only/))
  await assert.rejects(() => authDb.execute(sql`delete from audit_chain where institution_id = ${t}`), says(/audit_chain is append-only/))
  await assert.rejects(() => authDb.execute(sql`truncate audit_chain`), says(/audit_chain is append-only/))
  await assert.rejects(() => authDb.execute(sql`update platform_audit_log set reason = 'x' where action = 'test.platform'`), says(/platform_audit_log is append-only/))
  await assert.rejects(() => authDb.execute(sql`delete from platform_audit_log where action = 'test.platform'`), says(/platform_audit_log is append-only/))
  await assert.rejects(() => authDb.execute(sql`truncate platform_audit_log`), says(/platform_audit_log is append-only/))

  await authDb.delete(institutions).where(sql`${institutions.id} = ${t}`)
  const left = await authDb.execute<{ n: number }>(sql`select count(*)::int as n from audit_chain where institution_id = ${t}`)
  assert.equal(left.rows[0]!.n, 0)
})

test('platform events are chained too, and the application role cannot write them (AUD-01, AUD-02)', async () => {
  const { platformAudit } = await import('./audit')
  const { verifyChains } = await import('./audit-chain')
  // The platform log keeps every earlier run's rows, so this run's are told apart by entity id.
  const run = randomUUID()
  for (const n of [1, 2]) {
    await authDb.transaction((tx) =>
      platformAudit(tx, {
        actorId: null, actorEmail: 'operator', moduleId: 'core', action: 'test.platform-chain',
        entity: 'x', entityId: `${run}-${n}`, reason: 'platform chain', detail: { n, 'ଅ': 'अ' },
      }),
    )
  }
  const rows = await authDb.execute<{ seq: string }>(sql`select seq::text as seq from platform_audit_log where action = 'test.platform-chain' and entity_id like ${run + '-%'} order by seq`)
  assert.equal(rows.rows.length, 2)
  assert.equal(Number(rows.rows[1]!.seq), Number(rows.rows[0]!.seq) + 1)
  assert.deepEqual((await verifyChains({ platform: true })).problems, [])
  await assert.rejects(
    () => withTenant(randomUUID(), (tx) => platformAudit(tx, { actorId: null, moduleId: 'core', action: 'forged', entity: 'x', entityId: '1', reason: 'forged' })),
    denied,
  )
})

test('deleting an institution leaves a platform record of its final chain head; only then may its chain vanish (NEW-09)', async () => {
  const { anchorDocument, chainHeads, verifyChains } = await import('./audit-chain')
  const t = await tenant('offboarded')
  for (const n of [1, 2]) await trail(t, `offboarded.${n}`, n)
  const [head] = await chainHeads({ institutionId: t })
  const anchor = anchorDocument([head!], { runId: randomUUID(), server: 'test' })

  await authDb.delete(institutions).where(sql`${institutions.id} = ${t}`)

  const rec = await authDb.execute<{ detail: { slug: string; finalSeq: number; finalHash: string; auditRows: number; by: string } }>(sql`
    select detail from platform_audit_log where action = 'institution.deleted' and institution_id = ${t}`)
  assert.equal(rec.rows.length, 1)
  const { by, ...rest } = rec.rows[0]!.detail
  assert.deepEqual(rest, { slug: `${PREFIX}-offboarded`, finalSeq: 2, finalHash: head!.hash, auditRows: 2 })
  assert.equal(by, new URL(process.env.MIGRATION_DATABASE_URL!).username, 'the database role that deleted it')
  assert.deepEqual((await verifyChains({ institutionId: t, anchors: [anchor] })).problems, [])

  // A chain that vanished with no such record is reported.
  const ghost = randomUUID()
  const forged = anchorDocument([{ chain: `tenant:${ghost}`, slug: 'ghost', seq: 4, hash: 'ab'.repeat(32) }], { runId: randomUUID(), server: 'test' })
  const { problems } = await verifyChains({ institutionId: ghost, anchors: [forged] })
  assert.deepEqual(problems.map((p) => `${p.kind}@${p.seq}`), ['chain_vanished@4'])
})

test('anchors that go backwards, or do not match their own digest, are reported (AUD-01)', async () => {
  const { anchorDocument, chainHeads, verifyChains } = await import('./audit-chain')
  const t = await tenant('anchors')
  await trail(t, 'anchors.1')
  const early = anchorDocument(await chainHeads({ institutionId: t }), { runId: randomUUID(), server: 'test' })
  await trail(t, 'anchors.2')
  const late = anchorDocument(await chainHeads({ institutionId: t }), { runId: randomUUID(), server: 'test' })

  assert.deepEqual((await verifyChains({ institutionId: t, anchors: [early, late] })).problems, [])

  // Presented in time order, a later anchor with a lower seq means history was cut.
  const backwards = { ...early, at: new Date(Date.parse(late.at) + 1000).toISOString() }
  const regressed = await verifyChains({ institutionId: t, anchors: [late, { ...backwards, digest: anchorDocument(backwards.chains, backwards).digest }] })
  assert.deepEqual(regressed.problems.map((p) => p.kind), ['anchor_regressed'])

  const corrupt = { ...late, chains: late.chains.map((c) => ({ ...c, seq: c.seq + 1 })) }
  const bad = await verifyChains({ institutionId: t, anchors: [corrupt] })
  assert.ok(bad.problems.some((p) => p.kind === 'anchor_corrupt'))
})

test('sealing the import maximum of 5,000 rows in one transaction is quick (AUD-01)', async () => {
  const t = await tenant('volume')
  const c = await session(t)
  let commitMs: number
  try {
    await c.query(
      `insert into audit_log (institution_id, module_id, action, entity, entity_id, reason)
       select $1, 'core', 'volume.row', 'x', g::text, 'bulk' from generate_series(1, 5000) g`,
      [t],
    )
    const started = performance.now()
    await c.query('commit')
    commitMs = performance.now() - started
  } finally {
    c.release()
  }
  const sealed = await authDb.execute<{ n: number }>(sql`select count(*)::int as n from audit_chain where institution_id = ${t}`)
  assert.equal(sealed.rows[0]!.n, 5000)
  console.log(`sealing 5,000 rows at commit took ${Math.round(commitMs)} ms`)
  assert.ok(commitMs < 10_000, `sealing took ${Math.round(commitMs)} ms`)
})

test('a prefix cut from a chain is reported missing; no platform row excuses it (AUD-01, for P1-08)', async () => {
  const { platformAudit } = await import('./audit')
  const { verifyChains } = await import('./audit-chain')
  const t = await tenant('purged')
  for (const n of [1, 2, 3]) await trail(t, `purged.${n}`, n)
  const [first] = await chain(t)

  // What a retention purge (P1-08) will do: drop a prefix, with the guards off.
  await asOwner(
    'alter table audit_log disable trigger audit_log_append_only',
    'alter table audit_chain disable trigger audit_chain_append_only',
    `delete from audit_chain where institution_id = '${t}' and seq = 1`,
    `delete from audit_log where institution_id = '${t}' and action = 'purged.1'`,
    'alter table audit_chain enable trigger audit_chain_append_only',
    'alter table audit_log enable trigger audit_log_append_only',
  )
  assert.deepEqual((await verifyChains({ institutionId: t })).problems.map((p) => `${p.kind}@${p.seq}`), ['missing@1'])

  // A checkpoint is reserved for P1-08, which will carry it in the off-server
  // anchors; on the platform chain alone anybody with the owner's keys could
  // write one, so it is refused there and would be ignored anyway.
  await assert.rejects(
    () =>
      authDb.transaction((tx) =>
        platformAudit(tx, {
          institutionId: t, actorId: null, moduleId: 'core', action: 'audit.checkpoint', entity: 'audit_chain', entityId: t,
          reason: 'retention purge', detail: { chain: `tenant:${t}`, seq: 1, hash: first!.hash.toString('hex') },
        }),
      ),
    says(/written by the database only/),
  )
  assert.deepEqual((await verifyChains({ institutionId: t })).problems.map((p) => `${p.kind}@${p.seq}`), ['missing@1'])
})

test('ten sessions committing audited work in one institution at once leave one gap-free chain (AUD-01)', async () => {
  const { verifyChains } = await import('./audit-chain')
  const t = await tenant('stress')
  const sessions = await Promise.all(Array.from({ length: 10 }, () => session(t)))
  try {
    // Every session has written before any commits, so all ten commits contend for the seal.
    for (const [i, c] of sessions.entries()) {
      for (const n of [1, 2, 3]) await write(c, t, `stress.${i}.${n}`)
    }
    await Promise.all(sessions.map((c) => c.query('commit')))
  } finally {
    for (const c of sessions) c.release()
  }
  const rows = await chain(t)
  assert.equal(rows.length, 30)
  assert.deepEqual(rows.map((r) => Number(r.seq)), Array.from({ length: 30 }, (_, i) => i + 1))
  // Each transaction's three rows are sealed together, since a commit seals all of its own rows at once.
  for (let i = 0; i < 30; i += 3) {
    const owner = rows[i]!.action.split('.')[1]
    assert.ok(rows.slice(i, i + 3).every((r) => r.action.split('.')[1] === owner), `seq ${i + 1}..${i + 3} come from one transaction`)
  }
  assert.deepEqual((await verifyChains({ institutionId: t })).problems, [])
})

// --- review findings (P0-02) -------------------------------------------------

test('only the database writes the platform rows that explain missing history (AUD-01)', async () => {
  const { platformAudit } = await import('./audit')
  for (const action of ['institution.deleted', 'audit.checkpoint']) {
    await assert.rejects(
      () =>
        authDb.transaction((tx) =>
          platformAudit(tx, { actorId: null, moduleId: 'core', action, entity: 'institutions', entityId: randomUUID(), reason: 'forged' }),
        ),
      says(/written by the database only/),
      action,
    )
  }
})

test('a vanished chain is excused only if its institution is really gone (AUD-01, NEW-09)', async () => {
  const { anchorDocument, chainHeads, verifyChains } = await import('./audit-chain')
  const t = await tenant('wiped')
  for (const n of [1, 2]) await trail(t, `wiped.${n}`, n)
  const [head] = await chainHeads({ institutionId: t })
  const anchor = anchorDocument([head!], { runId: randomUUID(), server: 'test' })

  // As someone with the owner's keys: wipe a live institution's trail, then
  // append a chain-valid "institution.deleted" for it, the platform trigger off.
  await asOwner(
    'alter table audit_log disable trigger audit_log_append_only',
    'alter table audit_chain disable trigger audit_chain_append_only',
    `delete from audit_chain where institution_id = '${t}'`,
    `delete from audit_log where institution_id = '${t}'`,
    'alter table audit_chain enable trigger audit_chain_append_only',
    'alter table audit_log enable trigger audit_log_append_only',
    'alter table platform_audit_log disable trigger platform_audit_log_chain',
    `do $$ declare prev bytea; s bigint; r platform_audit_log; begin
       select p.seq, p.hash into s, prev from platform_audit_log p order by p.seq desc limit 1;
       if not found then s := 0; prev := campusos_audit_genesis('platform'); end if;
       r.id := gen_random_uuid(); r.at := now(); r.institution_id := '${t}'; r.module_id := 'core';
       r.action := 'institution.deleted'; r.entity := 'institutions'; r.entity_id := '${t}'; r.reason := 'forged';
       r.detail := jsonb_build_object('finalSeq', 2, 'finalHash', '${head!.hash}');
       r.seq := s + 1; r.prev_hash := prev;
       r.hash := campusos_audit_hash(prev, 'platform', r.seq, r.id, r.at, r.institution_id, null, r.module_id,
                                     r.action, r.entity, r.entity_id, null, r.reason, r.detail, null);
       insert into platform_audit_log values (r.*);
     end $$`,
    'alter table platform_audit_log enable trigger platform_audit_log_chain',
  )

  const { problems } = await verifyChains({ institutionId: t, anchors: [anchor] })
  assert.deepEqual(problems.map((p) => `${p.kind}@${p.seq}`), ['chain_vanished@2'])
})

test('the definer trigger functions cannot be attached to another table (AUD-01)', async () => {
  const c = await app.connect()
  try {
    await c.query('begin')
    await c.query('create temp table forged (id uuid, institution_id uuid, slug text) on commit drop')
    for (const fn of ['campusos_institution_deleted', 'campusos_platform_audit_chain', 'campusos_audit_seal']) {
      await c.query('savepoint s')
      await assert.rejects(
        () => c.query(`create trigger forged_${fn} before delete on forged for each row execute function ${fn}()`),
        /permission denied/,
        fn,
      )
      await c.query('rollback to savepoint s')
    }
  } finally {
    await c.query('rollback')
    c.release()
  }
})

test('a temporary table named institutions does not open the trail (AUD-01)', async () => {
  const t = await tenant('shadow')
  const [u] = await authDb
    .insert(users)
    .values({ email: 'shadow@chain-test.invalid', institutionId: t, role: 'faculty' })
    .returning({ id: users.id })
  await withTenant(t, (tx) =>
    audit(tx, { institutionId: t, actorId: u!.id, moduleId: 'core', action: 'shadow.1', entity: 'x', entityId: '1', reason: 'chain test' }),
  )
  // Deleting the person would null the actor on their trail; the guard allows
  // that only during offboarding, which it checks against public.institutions.
  await assert.rejects(
    () => asOwner('create temp table institutions (id uuid) on commit drop', `delete from users where id = '${u!.id}'`),
    says(/audit_log is append-only/),
  )
})

test('the database, not the caller, says when an audit row was written (AUD-01)', async () => {
  const { verifyChains } = await import('./audit-chain')
  const t = await tenant('clock')
  const c = await session(t)
  try {
    await c.query(
      `insert into audit_log (institution_id, module_id, action, entity, entity_id, reason, at) values
       ($1, 'core', 'clock.past', 'x', '1', 'chain test', '1999-01-01'),
       ($1, 'core', 'clock.infinite', 'x', '2', 'chain test', 'infinity')`,
      [t],
    )
    await c.query('commit')
  } finally {
    c.release()
  }
  const rows = await authDb.execute<{ action: string; recent: boolean }>(sql`
    select action, (at > now() - interval '5 minutes' and at <= now()) as recent
      from audit_log where institution_id = ${t} order by action`)
  assert.deepEqual(rows.rows.map((r) => [r.action, r.recent]), [['clock.infinite', true], ['clock.past', true]])
  assert.deepEqual((await verifyChains({ institutionId: t })).problems, [])
})
