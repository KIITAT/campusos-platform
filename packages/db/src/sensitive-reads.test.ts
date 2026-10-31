import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { eq, like, sql } from 'drizzle-orm'
import { authDb, withTenant } from './client'
import { genesis, rowHash, type ChainRow } from './audit-chain'
import { institutions, users } from './schema'
import { logSensitiveRead, privacyOfficerOf, readSensitiveLog } from './sensitive-reads'

/**
 * The log of who opened a sensitive record (AUD-07, P1-08c).
 *
 * It is a core table, not `audit_log`: the office reads `audit_log`, and care
 * promises students the office never learns who asked for counselling. It is
 * append-only and hash-chained per institution at insert, so a reader cannot
 * be removed from it quietly.
 */

const PREFIX = 'sr'
let n = 0
let I: string
let other: string
let office: string
let reader: string
let student: string

const says = (re: RegExp) => (e: unknown) => {
  let text = ''
  for (let x: unknown = e; x instanceof Error; x = (x as { cause?: unknown }).cause) text += x.message + '\n'
  return re.test(text)
}

async function institution(slug: string) {
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: `${PREFIX}-${slug}-${++n}`, name: slug, allowedEmailDomains: [] })
    .returning({ id: institutions.id })
  const people = await authDb
    .insert(users)
    .values([
      { email: `office@${slug}${n}.test`, institutionId: i!.id, role: 'institution_admin', name: 'Office' },
      { email: `reader@${slug}${n}.test`, institutionId: i!.id, role: 'faculty', name: 'Reader' },
      { email: `student@${slug}${n}.test`, institutionId: i!.id, role: 'student', name: 'Student' },
    ])
    .returning({ id: users.id })
  return { id: i!.id, office: people[0]!.id, reader: people[1]!.id, student: people[2]!.id }
}

const read = (inst: string, who: string, whom: string, entityId = 'r1') =>
  withTenant(inst, (tx) =>
    logSensitiveRead(tx, {
      institutionId: inst, readerId: who, subjectId: whom, moduleId: 'care', kind: 'care.case',
      entity: 'care_requests', entityId, purpose: 'counselling',
    }),
  )

async function rows(inst: string) {
  const r = await authDb.execute<ChainRow & { seq: string }>(sql`
    select r.seq::text as seq, r.prev_hash, r.hash, r.id::text as id,
           to_char(r.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at_text,
           r.institution_id::text as institution_id, r.reader_id as actor_id, r.module_id, r.kind as action,
           r.entity, r.entity_id, r.subject_id as actor_email, r.purpose as reason, null::text as detail, r.salt
      from sensitive_reads r where r.institution_id = ${inst} order by r.seq`)
  return r.rows
}

before(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${PREFIX}-%`))
  const a = await institution('main')
  const b = await institution('other')
  I = a.id; office = a.office; reader = a.reader; student = a.student
  other = b.id
})

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${PREFIX}-%`))
})

test('a sensitive read is chained from the genesis of its institution (AUD-07)', async () => {
  await read(I, reader, student)
  await read(I, reader, student, 'r2')
  const r = await rows(I)
  assert.deepEqual(r.map((x) => x.seq), ['1', '2'])
  assert.deepEqual(r[0]!.prev_hash, genesis(`reads:${I}`))
  assert.deepEqual(r[1]!.prev_hash, r[0]!.hash)
  for (const x of r) assert.deepEqual(rowHash(x.prev_hash!, `reads:${I}`, x), x.hash)
})

test('the read log cannot be changed, deleted or truncated (AUD-07)', async () => {
  await assert.rejects(() => authDb.execute(sql`update sensitive_reads set purpose = 'x' where institution_id = ${I}`), says(/sensitive_reads is append-only/))
  await assert.rejects(() => authDb.execute(sql`delete from sensitive_reads where institution_id = ${I}`), says(/sensitive_reads is append-only/))
  await assert.rejects(() => authDb.execute(sql`truncate sensitive_reads`), says(/append-only|foreign key/))
})

test('the caller cannot choose the chain (AUD-07)', async () => {
  const c = await institution('chain')
  await withTenant(c.id, (tx) =>
    tx.execute(sql`
      insert into sensitive_reads (institution_id, reader_id, subject_id, module_id, kind, entity, entity_id, purpose, seq, prev_hash, hash, at)
      values (${c.id}, ${c.reader}, ${c.student}, 'care', 'care.case', 'care_requests', 'r1', 'counselling', 99, '\\x00', '\\x00', '2000-01-01')`),
  )
  const [row] = await rows(c.id)
  assert.equal(row!.seq, '1')
  assert.deepEqual(row!.prev_hash, genesis(`reads:${c.id}`))
  const near = await authDb.execute<{ ok: boolean }>(sql`
    select abs(extract(epoch from (clock_timestamp() - at))) < 60 as ok from sensitive_reads where institution_id = ${c.id}`)
  assert.equal(near.rows[0]!.ok, true)
})

test('another institution sees none of it (AUD-07)', async () => {
  assert.deepEqual(await withTenant(other, (tx) => readSensitiveLog(tx, other, {})), [])
  await assert.rejects(() =>
    withTenant(other, (tx) =>
      logSensitiveRead(tx, {
        institutionId: I, readerId: reader, subjectId: student, moduleId: 'care', kind: 'care.case',
        entity: 'care_requests', entityId: 'x', purpose: 'counselling',
      }),
    ),
  )
})

test('two reads at once take consecutive places (AUD-07)', async () => {
  const c = await institution('race')
  const open = async () => {
    const cl = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await cl.connect()
    await cl.query('begin')
    await cl.query(`select set_config('app.institution_id', $1, true)`, [c.id])
    return cl
  }
  const ins = (cl: pg.Client, id: string) =>
    cl.query(
      `insert into sensitive_reads (institution_id, reader_id, subject_id, module_id, kind, entity, entity_id, purpose)
       values ($1, $2, $3, 'care', 'care.case', 'care_requests', $4, 'counselling')`,
      [c.id, c.reader, c.student, id],
    )
  const a = await open()
  const b = await open()
  try {
    await ins(a, 'a')
    const pending = ins(b, 'b')
    const waiting = async () => {
      for (let i = 0; i < 100; i++) {
        const w = await authDb.execute<{ n: number }>(sql`
          select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and wait_event = 'advisory'`)
        if (w.rows[0]!.n > 0) return true
        await new Promise((r) => setTimeout(r, 50))
      }
      return false
    }
    assert.equal(await waiting(), true, 'the second read waits for the first')
    await a.query('commit')
    await pending
    await b.query('commit')
  } finally {
    await a.end()
    await b.end()
  }
  const r = await rows(c.id)
  assert.deepEqual(r.map((x) => x.seq), ['1', '2'])
  assert.deepEqual(r[1]!.prev_hash, r[0]!.hash)
})

test('deleting the institution removes its read log (AUD-07)', async () => {
  const c = await institution('gone')
  await read(c.id, c.reader, c.student)
  await authDb.delete(institutions).where(sql`${institutions.id} = ${c.id}`)
  const left = await authDb.execute<{ n: number }>(sql`select count(*)::int as n from sensitive_reads where institution_id = ${c.id}`)
  assert.equal(left.rows[0]!.n, 0)
})

test('the privacy officer is a member of staff (AUD-07)', async () => {
  await assert.rejects(
    () => withTenant(I, (tx) => tx.execute(sql`insert into privacy_officers (institution_id, user_id, named_by) values (${I}, ${student}, ${office})`)),
    says(/privacy_officer_staff|member of staff/),
  )
  await withTenant(I, (tx) => tx.execute(sql`insert into privacy_officers (institution_id, user_id, named_by) values (${I}, ${reader}, ${office})`))
  assert.equal(await withTenant(I, (tx) => privacyOfficerOf(tx, I)), reader)
})

test('an officer who stops being staff is no longer the officer (NEW-48)', async () => {
  await authDb.update(users).set({ role: 'student' }).where(eq(users.id, reader))
  try {
    assert.equal(await withTenant(I, (tx) => privacyOfficerOf(tx, I)), null)
  } finally {
    await authDb.update(users).set({ role: 'faculty' }).where(eq(users.id, reader))
  }
})

test('readSensitiveLog filters by subject and dates (AUD-07)', async () => {
  const c = await institution('filter')
  await read(c.id, c.reader, c.student, 'a')
  await read(c.id, c.reader, c.student, 'b')
  await read(c.id, c.reader, c.office, 'c')
  const mine = await withTenant(c.id, (tx) => readSensitiveLog(tx, c.id, { subjectId: c.student }))
  assert.equal(mine.length, 2)
  assert.deepEqual(mine.map((x) => x.entityId), ['b', 'a'])
  assert.equal(mine[0]!.readerName, 'Reader')
  const tomorrow = new Date(Date.now() + 86_400_000 + 5.5 * 3_600_000).toISOString().slice(0, 10)
  assert.equal((await withTenant(c.id, (tx) => readSensitiveLog(tx, c.id, { from: tomorrow }))).length, 0)
})
