/**
 * AUD-08 (P1-08d): retention purges. One institution with rows that are past
 * their period and rows that are not; `purgeExpired` removes or anonymises the
 * first and leaves the second. The purge runs as the database owner only.
 *
 *   node --import ./packages/db/node_modules/tsx/dist/loader.mjs --test --test-concurrency=1 scripts/dpdp-retention.test.ts
 *
 * Needs the throwaway database with every module applied (KIITAT/CLAUDE.md).
 * Rows are seeded as the owner with foreign-key and trigger checks off, as in
 * dpdp-erasure.test.ts.
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { eq, sql } from '../packages/db/node_modules/drizzle-orm/index.js'
import { authDb, eraseSubject, institutions, users, verifyChains, withTenant } from '../packages/db/src/index'
import { purgeExpired } from '../packages/db/src/retention'

const pg = createRequire(import.meta.url)('../packages/db/node_modules/pg') as typeof import('pg')

const SLUG = `dpdp-retention-${randomUUID().slice(0, 8)}`
let I: string
const id = {} as Record<'A' | 'S' | 'E' | 'F', string>
let owner: InstanceType<typeof pg.Client>
const q = (text: string, params: unknown[] = []) => owner.query(text, params)
const rejectsWith = (run: () => Promise<unknown>, pattern: RegExp) =>
  assert.rejects(run, (e: Error) => pattern.test(`${e.message} ${(e.cause as Error | undefined)?.message ?? ''}`))
const uid = () => randomUUID()
const count = async (table: string, where: string, ...params: unknown[]) =>
  Number((await q(`select count(*)::int as n from ${table} where ${where}`, params)).rows[0].n)

before(async () => {
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: SLUG, name: 'Retention College', allowedEmailDomains: [] })
    .returning({ id: institutions.id })
  I = i!.id
  const roles = { A: 'institution_admin', S: 'student', E: 'student', F: 'faculty' } as const
  const people = await authDb
    .insert(users)
    .values((Object.keys(roles) as (keyof typeof roles)[]).map((k) => ({
      institutionId: I, email: `${k.toLowerCase()}@${SLUG}.test`, role: roles[k], name: `Person ${k}`,
    })))
    .returning({ id: users.id, email: users.email })
  for (const p of people) id[p.email!.split('@')[0]!.toUpperCase() as keyof typeof roles] = p.id
  owner = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL })
  await owner.connect()
  await q('set session_replication_role = replica')
})

after(async () => {
  await q('set session_replication_role = origin').catch(() => {})
  await authDb.delete(institutions).where(eq(institutions.slug, SLUG))
  await owner?.end()
})

test('expired sessions and sign-in tokens go; live ones stay (AUD-08, NEW-33)', async () => {
  const tag = uid()
  const ident = `ret-${tag}@x.test`
  for (const days of [-2, 2]) {
    await q(`insert into sessions ("sessionToken", "userId", expires) values ($1, $2, now() + $3 * interval '1 day')`, [`${tag}-${days}`, id.S, days])
    await q(`insert into "verificationToken" (identifier, token, expires) values ($1, $2, now() + $3 * interval '1 day')`, [ident, `${tag}-${days}`, days])
  }
  const report = await purgeExpired({ institutionId: I })
  assert.deepEqual((await q(`select "sessionToken" from sessions where "sessionToken" like $1`, [`${tag}-%`])).rows.map((r) => r.sessionToken), [`${tag}-2`])
  assert.deepEqual((await q(`select token from "verificationToken" where identifier = $1`, [ident])).rows.map((r) => r.token), [`${tag}-2`])
  assert.ok(report.platform.sessions! >= 1)
  assert.ok(report.platform.verificationToken! >= 1)
})

test('finished jobs go after 90 days (AUD-08)', async () => {
  const job = (status: string, completedDaysAgo: number | null, createdDaysAgo = 200) =>
    q(
      `insert into background_jobs (institution_id, kind, dedupe_key, payload, status, created_at, completed_at)
       values ($1, 'ret.test', $2, '{}', $3, now() - $4 * interval '1 day', case when $5::int is null then null else now() - $5::int * interval '1 day' end)`,
      [I, uid(), status, createdDaysAgo, completedDaysAgo],
    )
  await job('succeeded', 91)
  await job('dead', 91)
  await job('succeeded', 89)
  await job('queued', null)
  const report = await purgeExpired({ institutionId: I })
  const left = await q(`select status from background_jobs where institution_id = $1 and kind = 'ret.test' order by status`, [I])
  assert.deepEqual(left.rows.map((r) => r.status), ['queued', 'succeeded'])
  assert.equal(report.institutions[0]!.purged.background_jobs, 2)
})

test('notifications go after a year (AUD-08)', async () => {
  for (const [title, days] of [['old', 366], ['recent', 10]] as const) {
    await q(
      `insert into notifications (institution_id, user_id, module_id, title, body, created_at) values ($1, $2, 'notices', $3, 'b', now() - $4 * interval '1 day')`,
      [I, id.S, title, days],
    )
  }
  await purgeExpired({ institutionId: I })
  const left = await q(`select title from notifications where user_id = $1`, [id.S])
  assert.deepEqual(left.rows.map((r) => r.title), ['recent'])
})

test('an enquiry that never became a student is anonymised after a year', async () => {
  const [X, Y, Z] = [uid(), uid(), uid()]
  const enquiry = (e: string) =>
    q(
      `insert into admissions_enquiries (id, institution_id, name, email, phone, note, created_at)
       values ($1, $2, 'Enquirer', $3, '9999999999', 'a note', now() - interval '400 days')`,
      [e, I, `${e}@enq.test`],
    )
  const application = (e: string, status: string, updatedDaysAgo: number, studentId: string | null, reason: string | null) =>
    q(
      `insert into admissions_applications (institution_id, enquiry_id, program_id, term_id, status, reason, student_id, student_program_id, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, now() - interval '400 days', now() - $9 * interval '1 day')`,
      [I, e, uid(), uid(), status, reason, studentId, studentId ? uid() : null, updatedDaysAgo],
    )
  for (const e of [X, Y, Z]) await enquiry(e)
  await application(X, 'rejected', 400, null, 'no seat')
  await application(Y, 'accepted', 400, id.S, null)
  await application(Z, 'rejected', 10, null, 'late')
  await purgeExpired({ institutionId: I })
  const row = async (e: string) => (await q(`select name, email, phone, note from admissions_enquiries where id = $1`, [e])).rows[0]
  assert.deepEqual(await row(X), { name: '[erased]', email: `erased+${X}@invalid`, phone: null, note: null })
  assert.equal((await q(`select reason from admissions_applications where enquiry_id = $1`, [X])).rows[0].reason, null)
  assert.equal((await row(Y)).name, 'Enquirer')
  assert.equal((await row(Z)).name, 'Enquirer')
  assert.equal((await q(`select reason from admissions_applications where enquiry_id = $1`, [Z])).rows[0].reason, 'late')
})

test('an applicant who was not hired is anonymised a year after the opening closed', async () => {
  const requisition = uid()
  await q(`insert into hr_job_requisitions (id, institution_id, designation, positions, reason, status) values ($1, $2, 'Lecturer', 1, 'growth', 'approved')`, [requisition, I])
  const opening = async (closedDaysAgo: number) => {
    const o = uid()
    await q(
      `insert into hr_job_openings (id, institution_id, requisition_id, title, opens_on, closed_at) values ($1, $2, $3, 'Lecturer', current_date, now() - $4 * interval '1 day')`,
      [o, I, requisition, closedDaysAgo],
    )
    return o
  }
  const applicant = async (o: string, status: string) => {
    const a = uid()
    await q(
      `insert into hr_job_applicants (id, institution_id, opening_id, name, email, phone, source, status, notes)
       values ($1, $2, $3, 'Candidate', $4, '8888888888', 'portal', $5, 'n')`,
      [a, I, o, `${a}@cand.test`, status],
    )
    return a
  }
  const [old, recent] = [await opening(400), await opening(30)]
  const [R, H, Q] = [await applicant(old, 'rejected'), await applicant(old, 'hired'), await applicant(recent, 'rejected')]
  const interview = uid()
  await q(`insert into hr_interviews (id, institution_id, applicant_id, round, scheduled_at, panel, status) values ($1, $2, $3, 1, now(), $4, 'completed')`, [interview, I, R, [id.F]])
  await q(
    `insert into hr_interview_feedback (institution_id, interview_id, interviewer_id, rating, recommendation, notes) values ($1, $2, $3, 4, 'hire', 'strong maths answer')`,
    [I, interview, id.F],
  )
  await purgeExpired({ institutionId: I })
  const row = async (a: string) => (await q(`select name, email, phone, source, notes from hr_job_applicants where id = $1`, [a])).rows[0]
  assert.deepEqual(await row(R), { name: '[erased]', email: `erased+${R}@invalid`, phone: null, source: null, notes: null })
  assert.equal((await q(`select notes from hr_interview_feedback where interview_id = $1`, [interview])).rows[0].notes, '[erased]')
  assert.equal((await row(H)).name, 'Candidate')
  assert.equal((await row(Q)).name, 'Candidate')
})

test('an erased person’s attendance devices go (NEW-33)', async () => {
  for (const u of [id.E, id.S]) {
    await q(`insert into attendance_devices (institution_id, user_id, device_hash, label, status) values ($1, $2, $3, 'phone', 'active')`, [I, u, uid()])
  }
  await q('set session_replication_role = origin')
  await eraseSubject(I, id.E, { actorId: id.A, reason: 'retention test' })
  await q('set session_replication_role = replica')
  await purgeExpired({ institutionId: I })
  assert.equal(await count('attendance_devices', 'user_id = $1', id.E), 0)
  assert.equal(await count('attendance_devices', 'user_id = $1', id.S), 1)
})

test('a purge is on the trail and a dry run changes nothing (AUD-08)', async () => {
  await q(`insert into notifications (institution_id, user_id, module_id, title, body, created_at) values ($1, $2, 'notices', 'old', 'b', now() - interval '400 days')`, [I, id.S])
  const mark = (await q(`select clock_timestamp() as t`)).rows[0].t as Date
  const trail = (action: string) =>
    q(`select actor_id, detail from audit_log where institution_id = $1 and action = $2 and at > $3`, [I, action, mark])
  const dry = await purgeExpired({ institutionId: I, dryRun: true })
  assert.equal(dry.dryRun, true)
  assert.equal(dry.institutions[0]!.purged.notifications, 1)
  assert.equal(await count('notifications', `user_id = $1 and title = 'old'`, id.S), 1)
  assert.equal((await trail('dpdp.retention_purged')).rows.length, 0)

  const real = await purgeExpired({ institutionId: I })
  assert.equal(real.institutions[0]!.purged.notifications, 1)
  const rows = (await trail('dpdp.retention_purged')).rows
  assert.equal(rows.length, 1)
  assert.equal(rows[0].actor_id, null)
  assert.equal(rows[0].detail.purged.notifications, 1)
  const run = await q(`select count(*)::int as n from platform_audit_log where action = 'dpdp.retention_run' and at > $1`, [mark])
  assert.equal(run.rows[0].n, 1)
  const report = await verifyChains({ institutionId: I })
  assert.deepEqual(report.problems, [])
})

test('only the owner runs a purge', async () => {
  await rejectsWith(() => withTenant(I, (tx) => tx.execute(sql`select public.campusos_purge_expired(${I})`)), /permission denied/)
  await rejectsWith(() => withTenant(I, (tx) => tx.execute(sql`select public.campusos_purge_platform()`)), /permission denied/)
})
