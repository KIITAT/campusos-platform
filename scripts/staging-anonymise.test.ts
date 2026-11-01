/**
 * The staging anonymiser (OPS-04, decision 389): refuses without the staging
 * switch, and inside a transaction removes names, e-mails, audit detail and
 * device tokens. Both tests roll back, so the database keeps its data.
 *
 *   node --import ./packages/db/node_modules/tsx/dist/loader.mjs --test scripts/staging-anonymise.test.ts
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { eq } from '../packages/db/node_modules/drizzle-orm/index.js'
import { authDb, institutions, users } from '../packages/db/src/index'

const { Client } = createRequire(join(resolve(import.meta.dirname, '..'), 'packages/db/package.json'))('pg')
const sql = readFileSync(join(resolve(import.meta.dirname), 'staging-anonymise.sql'), 'utf8')

let client: InstanceType<typeof Client>
let inst: string
let userId: string

before(async () => {
  await authDb.delete(institutions).where(eq(institutions.slug, 'p111-anon'))
  const [row] = await authDb.insert(institutions).values({ slug: 'p111-anon', name: 'Anon College', allowedEmailDomains: [] }).returning()
  inst = row!.id
  const [user] = await authDb.insert(users).values({ institutionId: inst, email: 'asha@p111.test', role: 'student' as never, name: 'Asha Verma' }).returning()
  userId = user!.id
  client = new Client({ connectionString: process.env.MIGRATION_DATABASE_URL })
  await client.connect()
  await client.query(
    `insert into audit_log (institution_id, actor_id, actor_email, module_id, action, entity, entity_id, reason, detail)
     values ($1, $2, 'asha@p111.test', 'core', 'test', 'user', $2, 'because', $3)`,
    [inst, userId, JSON.stringify({ after: { name: 'Asha Verma' } })],
  )
})

after(async () => {
  await client.end()
  await authDb.delete(institutions).where(eq(institutions.slug, 'p111-anon'))
})

test('refuses without the setting', async () => {
  await client.query('BEGIN')
  try {
    await assert.rejects(client.query(sql), /refusing to anonymise/)
  } finally {
    await client.query('ROLLBACK')
  }
})

test('anonymises inside the transaction', async () => {
  await client.query('BEGIN')
  try {
    await client.query(`SET LOCAL campusos.anonymise = 'staging'`)
    await client.query(sql)
    const u = (await client.query('select name, email, erased_at from users where id = $1', [userId])).rows[0]
    assert.equal(u.name, `Person ${userId.slice(0, 8)}`)
    assert.match(u.email, /@staging\.invalid$/)
    assert.equal(u.erased_at, null)
    const a = (await client.query('select detail, reason, actor_email from audit_log where institution_id = $1', [inst])).rows
    assert.ok(a.length > 0)
    for (const r of a) {
      assert.equal(r.detail, null)
      assert.equal(r.reason, 'redacted for staging')
      assert.equal(r.actor_email, null)
    }
    assert.equal((await client.query('select count(*)::int as n from device_tokens')).rows[0].n, 0)
  } finally {
    await client.query('ROLLBACK')
  }
})
