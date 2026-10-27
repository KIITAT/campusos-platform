import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { eq, sql } from 'drizzle-orm'
import { authDb } from './client'
import {
  PAIRING_CODE_LENGTH,
  PAIRING_TTL_MS,
  claimPairing,
  deviceTokens,
  listDevices,
  revokeDevice,
  revokeDeviceToken,
  rotateDeviceToken,
  startPairing,
  userForToken,
} from './device-tokens'
import { institutions, users } from './schema'

const SLUG = 'device-test'
let inst: string
let student: string

before(async () => {
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: SLUG, name: 'Device College', allowedEmailDomains: ['device.test'] })
    .returning({ id: institutions.id })
  inst = i!.id

  const [u] = await authDb
    .insert(users)
    .values({ email: 's@device.test', institutionId: inst, role: 'student', name: 'S' })
    .returning({ id: users.id })
  student = u!.id
})

beforeEach(async () => {
  await authDb.delete(deviceTokens).where(eq(deviceTokens.userId, student))
})

after(async () => {
  await authDb.delete(institutions).where(eq(institutions.slug, SLUG))
})

test('a pairing code is short, typable, and free of ambiguous characters', async () => {
  const { code, expiresAt } = await startPairing(inst, student, 'a phone')
  assert.equal(PAIRING_CODE_LENGTH, 8)
  assert.equal(code.length, 8)
  assert.match(code, /^[A-HJ-NP-Z2-9]+$/, 'no 0/O or 1/I to mistype')
  assert.ok(expiresAt.getTime() - Date.now() <= PAIRING_TTL_MS)
})

test('the pairing code is never stored, only its hash', async () => {
  const { code } = await startPairing(inst, student)
  const [row] = await authDb
    .select()
    .from(deviceTokens)
    .where(eq(deviceTokens.userId, student))
  assert.ok(row)
  assert.ok(!JSON.stringify(row).includes(code), 'the code itself is in the database')
})

test('claiming a code yields a token that resolves to the user', async () => {
  const { code } = await startPairing(inst, student, 'a phone')
  const claimed = await claimPairing(code, 'a phone')
  assert.ok(claimed)
  assert.equal(claimed!.userId, student)
  assert.ok(claimed!.token.length >= 32)
  assert.equal(await userForToken(claimed!.token), student)
})

test('the token itself is not stored either', async () => {
  const { code } = await startPairing(inst, student)
  const claimed = await claimPairing(code, null)
  const [row] = await authDb
    .select()
    .from(deviceTokens)
    .where(eq(deviceTokens.userId, student))
  assert.ok(!JSON.stringify(row).includes(claimed!.token))
})

test('a pairing code is single use', async () => {
  const { code } = await startPairing(inst, student)
  assert.ok(await claimPairing(code, null))
  assert.equal(await claimPairing(code, null), null, 'the second claim must fail')
})

test('case and surrounding space do not stop a person typing it correctly', async () => {
  const { code } = await startPairing(inst, student)
  assert.ok(await claimPairing(`  ${code.toLowerCase()} `, null))
})

test('an expired code is refused and cleaned up', async () => {
  const { code } = await startPairing(inst, student)
  await authDb
    .update(deviceTokens)
    .set({ pairingExpiresAt: new Date(Date.now() - 1000) })
    .where(eq(deviceTokens.userId, student))

  assert.equal(await claimPairing(code, null), null)
  const left = await authDb.select().from(deviceTokens).where(eq(deviceTokens.userId, student))
  assert.equal(left.length, 0, 'a dead pairing does not linger')
})

test('asking twice does not leave two live codes', async () => {
  const first = await startPairing(inst, student)
  const second = await startPairing(inst, student)
  assert.equal(await claimPairing(first.code, null), null, 'the first is superseded')
  assert.ok(await claimPairing(second.code, null))
})

test('a wrong or malformed token resolves to nobody', async () => {
  for (const bad of ['', 'short', 'x'.repeat(43), 'not-a-real-token-but-long-enough-here']) {
    assert.equal(await userForToken(bad), null, bad.slice(0, 12))
  }
})

test('an unclaimed pairing row is not itself a usable token', async () => {
  const { code } = await startPairing(inst, student)
  // The placeholder in token_hash must not be presentable as a credential.
  assert.equal(await userForToken(code), null)
  assert.equal(await userForToken(`unclaimed:${code}`), null)
})

test('revoking takes effect immediately and keeps the record', async () => {
  const { code } = await startPairing(inst, student, 'the lost phone')
  const claimed = await claimPairing(code, 'the lost phone')
  const [device] = await listDevices(student)

  assert.equal(await revokeDevice(student, device!.id), true)
  assert.equal(await userForToken(claimed!.token), null)

  const after = await listDevices(student)
  assert.equal(after.length, 1, 'which phone it was is still answerable')
  assert.ok(after[0]!.revokedAt)
})

test('somebody cannot revoke another person’s device', async () => {
  const [other] = await authDb
    .insert(users)
    .values({ email: 'other@device.test', institutionId: inst, role: 'student' })
    .returning({ id: users.id })
  try {
    const { code } = await startPairing(inst, student)
    await claimPairing(code, null)
    const [device] = await listDevices(student)
    assert.equal(await revokeDevice(other!.id, device!.id), false)
  } finally {
    await authDb.delete(users).where(eq(users.id, other!.id))
  }
})

test('the device list shows a pending pairing as pending', async () => {
  await startPairing(inst, student, 'not yet paired')
  const [row] = await listDevices(student)
  assert.equal(row!.pending, true)
  assert.equal(row!.lastUsedAt, null)
})

/** The audit rows about one device. */
const deviceTrail = async (id: string) =>
  (
    await authDb.execute<{ action: string; actor_id: string | null; institution_id: string; detail: Record<string, unknown> | null }>(sql`
      select action, actor_id, institution_id::text as institution_id, detail from audit_log
       where entity = 'device_tokens' and entity_id = ${id} order by action`)
  ).rows

/**
 * Makes the next audit row with this action fail, as a full disk or a broken
 * trigger would, to show that the change it describes is rolled back with it.
 */
async function refusingAudit(action: string, run: () => Promise<unknown>): Promise<void> {
  await authDb.execute(sql.raw(`
    create function test_refuse_audit() returns trigger language plpgsql as $$
    begin if new.action = '${action}' then raise exception 'audit refused for the test'; end if; return new; end $$;
    create trigger test_refuse_audit before insert on audit_log for each row execute function test_refuse_audit();`))
  try {
    await assert.rejects(run)
  } finally {
    await authDb.execute(sql.raw('drop trigger test_refuse_audit on audit_log; drop function test_refuse_audit();'))
  }
}

test('pairing, claiming and revoking a phone each leave one audit row, by the person, naming no secret (NEW-10)', async () => {
  const { code } = await startPairing(inst, student, 'a phone')
  const [pending] = await listDevices(student)
  const claimed = await claimPairing(code, 'a phone')
  assert.ok(claimed)
  assert.equal(await revokeDevice(student, pending!.id), true)

  const rows = await deviceTrail(pending!.id)
  assert.deepEqual(rows.map((r) => r.action), ['device.paired', 'device.pairing', 'device.revoked'])
  assert.ok(rows.every((r) => r.actor_id === student && r.institution_id === inst))
  assert.ok(rows.every((r) => r.detail?.deviceId === pending!.id))
  assert.ok(!JSON.stringify(rows).includes(code) && !JSON.stringify(rows).includes(claimed.token), 'no secret on the trail')
})

test('asking twice records how many pending codes the new one replaced (NEW-10)', async () => {
  await startPairing(inst, student)
  await startPairing(inst, student)
  const [pending] = await listDevices(student)
  const [row] = await deviceTrail(pending!.id)
  assert.equal(row!.detail?.replaced, 1)
})

test('a wrong code, an expired code and somebody else’s revoke write nothing (NEW-10)', async () => {
  const count = async () =>
    (await authDb.execute<{ n: number }>(sql`select count(*)::int as n from audit_log where institution_id = ${inst} and entity = 'device_tokens'`)).rows[0]!.n
  const { code } = await startPairing(inst, student)
  const [device] = await listDevices(student)
  const start = await count()

  assert.equal(await claimPairing('ZZZZZZ'), null)
  await authDb.update(deviceTokens).set({ pairingExpiresAt: new Date(Date.now() - 1000) }).where(eq(deviceTokens.id, device!.id))
  assert.equal(await claimPairing(code), null)
  assert.equal(await revokeDevice(randomUUID(), device!.id), false)
  assert.equal(await count(), start)
})

test('a pairing, claim or revoke whose audit row fails leaves nothing changed (NEW-10)', async () => {
  await refusingAudit('device.pairing', () => startPairing(inst, student, 'refused'))
  assert.deepEqual(await listDevices(student), [], 'no pairing without its audit row')

  const { code } = await startPairing(inst, student, 'kept')
  await refusingAudit('device.paired', () => claimPairing(code))
  const [pending] = await listDevices(student)
  assert.equal(pending!.pending, true, 'the code is still unclaimed')
  const claimed = await claimPairing(code)
  assert.ok(claimed)

  await refusingAudit('device.rotated', () => rotateDeviceToken(claimed.token))
  assert.equal(await userForToken(claimed.token), student, 'still the same token')

  await refusingAudit('device.revoked', () => revokeDevice(student, pending!.id))
  assert.equal(await userForToken(claimed.token), student, 'still not revoked')
})

/** Pairs a phone the way the web page and the phone do between them: returns its token. */
async function pair(name = 'a phone'): Promise<string> {
  const { code } = await startPairing(inst, student, name)
  const claimed = await claimPairing(code, name)
  assert.ok(claimed)
  return claimed.token
}

/** The owner makes a token look as if it was last used this many days ago. */
const idleFor = (token: string, days: number) =>
  authDb.execute(sql`
    update device_tokens set last_used_at = now() - make_interval(days => ${days})
     where token_hash = encode(sha256(convert_to(${token}, 'UTF8')), 'hex')`)

/** A database-clock watermark, for reading the audit rows written after it. */
const watermark = async () => (await authDb.execute<{ t: string }>(sql`select clock_timestamp()::text as t`)).rows[0]!.t

const trailSince = async (since: string, action: string) =>
  (
    await authDb.execute<{ actor_id: string | null; reason: string | null; detail: Record<string, unknown> | null }>(sql`
      select actor_id, reason, detail from audit_log
       where entity = 'device_tokens' and action = ${action} and institution_id = ${inst} and at > ${since}::timestamptz`)
  ).rows

/**
 * Forces a race instead of hoping for one: an owner connection holds the row
 * `lock` names, two calls start and queue behind it, and the lock is released
 * only once both are waiting. The calls then run one after the other, so the
 * second finds what the first left.
 */
async function racing<T>(lock: string, arg: string, run: () => Promise<T>): Promise<Awaited<T>[]> {
  const holder = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL })
  await holder.connect()
  try {
    await holder.query('begin')
    await holder.query(lock, [arg])
    const calls = [run(), run()]
    for (const call of calls) call.catch(() => {})
    let waiting = 0
    for (let i = 0; i < 100 && waiting < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      const { rows } = await holder.query<{ n: number }>(
        `select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and query like '%device_tokens%'`,
      )
      waiting = rows[0]!.n
    }
    await holder.query('commit')
    assert.ok(waiting >= 2, `both calls were waiting on the row (${waiting} were)`)
    return await Promise.all(calls)
  } finally {
    await holder.end()
  }
}

test('two concurrent claims of one code yield exactly one token (SEC-06)', async () => {
  const { code } = await startPairing(inst, student, 'race')
  const results = await racing(
    `select id from device_tokens where pairing_hash = encode(sha256(convert_to(upper($1), 'UTF8')), 'hex') for update`,
    code,
    () => claimPairing(code),
  )
  assert.equal(results.filter((r) => r !== null).length, 1, 'one claim is handed a token')
  const { rows } = await authDb.execute<{ n: number }>(sql`
    select count(*)::int as n from device_tokens
     where user_id = ${student} and device_name = 'race' and pairing_hash is null
       and revoked_at is null and token_hash not like 'unclaimed:%'`)
  assert.equal(rows[0]!.n, 1, 'one device row came of it')
})

test('a token idle for 90 days resolves to nobody, and one idle for 89 still works (SEC-06)', async () => {
  const token = await pair()
  await idleFor(token, 91)
  assert.equal(await userForToken(token), null)
  await idleFor(token, 89)
  assert.equal(await userForToken(token), student)
})

test('the device list marks an idle token as expired (SEC-06)', async () => {
  const old = await pair('old phone')
  await pair('new phone')
  await idleFor(old, 91)
  const rows = await listDevices(student)
  assert.equal(rows.find((r) => r.deviceName === 'old phone')!.expired, true)
  assert.equal(rows.find((r) => r.deviceName === 'new phone')!.expired, false)
})

test('rotating replaces the token at once and is audited (SEC-06)', async () => {
  const t1 = await pair()
  const since = await watermark()
  const t2 = await rotateDeviceToken(t1)
  assert.ok(typeof t2 === 'string' && t2 !== t1)
  assert.equal(await userForToken(t1), null, 'the old token stops working at once')
  assert.equal(await userForToken(t2), student)

  const rows = await trailSince(since, 'device.rotated')
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.actor_id, student)
  assert.ok(!JSON.stringify(rows).includes(t1) && !JSON.stringify(rows).includes(t2), 'no secret on the trail')
})

test('a revoked or expired token cannot be rotated (SEC-06)', async () => {
  const revoked = await pair('revoked')
  const [device] = await listDevices(student)
  assert.equal(await revokeDevice(student, device!.id), true)
  assert.equal(await rotateDeviceToken(revoked), null)

  const expired = await pair('expired')
  await idleFor(expired, 91)
  assert.equal(await rotateDeviceToken(expired), null)

  assert.equal(await rotateDeviceToken('short'), null)
})

test('two concurrent rotations of one token yield exactly one new token (SEC-06)', async () => {
  const t1 = await pair()
  const results = await racing(
    `select id from device_tokens where token_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex') for update`,
    t1,
    () => rotateDeviceToken(t1),
  )
  assert.equal(results.filter((r) => r !== null).length, 1, 'one rotation is handed a token')
})

test('a phone can revoke its own token, once, and is audited (SEC-06)', async () => {
  const token = await pair()
  const since = await watermark()
  assert.equal(await revokeDeviceToken(token), true)
  assert.equal(await userForToken(token), null)
  assert.equal(await revokeDeviceToken(token), false, 'a second sign-out finds nothing to revoke')
  assert.equal(await revokeDeviceToken('x'.repeat(43)), false, 'a token nobody holds')

  const rows = await trailSince(since, 'device.revoked')
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.actor_id, student)
  assert.equal(rows[0]!.reason, 'a phone signed itself out')
})
