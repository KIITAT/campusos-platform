/**
 * AUD-03 (P1-08a): erasing and exporting a person reaches every module. One
 * institution, a student with a row in each module that holds free text about
 * them, a second student whose rows must stay untouched, and the staff around
 * them. A sentinel in every free-text column the erasure is meant to reach is
 * searched for, in every table, afterwards.
 *
 *   node --import ./packages/db/node_modules/tsx/dist/loader.mjs --test --test-concurrency=1 scripts/dpdp-erasure.test.ts
 *
 * Needs the throwaway database with every module applied (KIITAT/CLAUDE.md).
 * The rows are seeded as the owner with foreign-key and trigger checks off, so
 * a module's parent rows (a drive, a timetable slot) need not be built: the
 * erasure runs as the application role, with every constraint and guard on.
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { eq, sql } from '../packages/db/node_modules/drizzle-orm/index.js'
import { authDb, eraseSubject, exportSubject, institutions, users, withTenant } from '../packages/db/src/index'

const pg = createRequire(import.meta.url)('../packages/db/node_modules/pg') as typeof import('pg')

const X = `ERASE-${randomUUID()}`
const XO = `OTHER-${randomUUID()}`
const K = `KEEP-${randomUUID()}`
const SLUG = `dpdp-erasure-${randomUUID().slice(0, 8)}`

let inst: string
const id = {} as Record<'A' | 'C' | 'M' | 'S' | 'O' | 'G', string>
let studentRequest: string
let owner: InstanceType<typeof pg.Client>
const q = (text: string, params: unknown[] = []) => owner.query(text, params)
/** drizzle wraps a database error: the database's own message is its cause. */
const rejectsWith = (run: () => Promise<unknown>, pattern: RegExp) =>
  assert.rejects(run, (e: Error) => pattern.test(`${e.message} ${(e.cause as Error | undefined)?.message ?? ''}`))

before(async () => {
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: SLUG, name: 'Erasure College', allowedEmailDomains: [] })
    .returning({ id: institutions.id })
  inst = i!.id
  const roles = { A: 'institution_admin', C: 'faculty', M: 'faculty', S: 'student', O: 'student', G: 'parent' } as const
  const people = await authDb
    .insert(users)
    .values((Object.keys(roles) as (keyof typeof roles)[]).map((k) => ({
      institutionId: inst, email: `${k.toLowerCase()}@${SLUG}.test`, role: roles[k], name: `Person ${k}`,
    })))
    .returning({ id: users.id, email: users.email })
  for (const p of people) id[p.email!.split('@')[0]!.toUpperCase() as keyof typeof roles] = p.id

  owner = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL })
  await owner.connect()
  // Parent rows (a drive, a timetable slot, a block) are not built: only the
  // rows under test are seeded.
  await q('set session_replication_role = replica')
  const [I, S, O, G, C, M, A] = [inst, id.S, id.O, id.G, id.C, id.M, id.A]
  const uid = () => randomUUID()

  // care
  await q(`insert into care_counsellors (institution_id, user_id, title) values ($1, $2, 'Counsellor')`, [I, C])
  const req = async (student: string, text: string) => {
    const r = uid()
    await q(
      `insert into care_requests (id, institution_id, student_id, message, status, counsellor_id, accepted_at)
       values ($1, $2, $3, $4, 'accepted', $5, now())`,
      [r, I, student, text, C],
    )
    await q(`insert into care_notes (institution_id, request_id, author_id, body) values ($1, $2, $3, $4)`, [I, r, C, text])
    return r
  }
  studentRequest = await req(S, X)
  await req(O, XO)
  await q(
    `insert into care_appointments (institution_id, request_id, counsellor_id, starts_at, ends_at, mode, place, note_to_student, status)
     values ($1, $2, $3, now() + interval '1 day', now() + interval '1 day 1 hour', 'in_person', 'Room 4', $4, 'booked')`,
    [I, studentRequest, C, X],
  )
  // a cancelled one: its reason may not simply become NULL
  await q(
    `insert into care_appointments (institution_id, request_id, counsellor_id, starts_at, ends_at, mode, place, status, cancelled_by, cancel_reason)
     values ($1, $2, $3, now() + interval '2 day', now() + interval '2 day 1 hour', 'phone', 'Room 5', 'cancelled', $3, $4)`,
    [I, studentRequest, C, X],
  )
  const result = uid()
  await q(
    `insert into care_results (id, institution_id, student_id, instrument_code, answers, score, max_score, band, band_rank)
     values ($1, $2, $3, 'phq9', '{0}', 0, 27, 'minimal', 0)`,
    [result, I, S],
  )
  await q(`insert into care_shared_results (institution_id, request_id, result_id) values ($1, $2, $3)`, [I, studentRequest, result])

  // mentoring
  await q(`insert into mentor_assignments (institution_id, student_id, mentor_id, reason) values ($1, $2, $3, $4)`, [I, S, M, X])
  await q(
    `insert into mentor_notes (institution_id, student_id, author_id, met_on, kind, body) values ($1, $2, $3, current_date, 'meeting', $4)`,
    [I, S, M, X],
  )
  await q(`insert into mentor_messages (institution_id, student_id, sender_id, body) values ($1, $2, $3, $4), ($1, $2, $5, $4)`, [I, S, S, X, M])
  const doc = Buffer.from(X)
  await q(
    `insert into mentor_leave_applications (institution_id, student_id, leave_type_id, starts_on, ends_on, purpose, place_of_visit,
       leaving_at, arriving_at, contact_phone, document_name, document_sha256, document_size, document)
     values ($1, $2, $3, current_date, current_date, $4, 'Home', now(), now() + interval '2 hours', '9999999999', 'certificate.pdf', $5, $6, $7)`,
    [I, S, uid(), X, createHash('sha256').update(doc).digest('hex'), doc.length, doc],
  )

  // attendance, hostel, skills
  await q(
    `insert into attendance_excuses (institution_id, student_id, from_on, to_on, kind, reason) values ($1, $2, current_date, current_date, 'medical', $3)`,
    [I, S, X],
  )
  // a revoked one: its reason may not simply become NULL
  await q(
    `insert into attendance_excuses (institution_id, student_id, from_on, to_on, kind, reason, revoked_at, revoked_by, revoke_reason)
     values ($1, $2, current_date, current_date, 'leave', $3, now(), $4, $3)`,
    [I, S, X, A],
  )
  await q(
    `insert into attendance_records (institution_id, session_id, student_id, method, latitude, longitude, accuracy_m)
     values ($1, $2, $3, 'scan', 12.97, 77.59, 8)`,
    [I, uid(), S],
  )
  await q(`insert into hostel_leaves (institution_id, student_id, from_on, to_on, reason) values ($1, $2, current_date, current_date, $3)`, [I, S, X])
  await q(`insert into hostel_visitors (institution_id, block_id, student_id, name) values ($1, $2, $3, $4)`, [I, uid(), S, X])
  await q(
    `insert into skill_assessments (institution_id, student_id, skill_id, rank, source, assessor_id, evidence) values ($1, $2, $3, 3, 'self', null, $4)`,
    [I, S, uid(), X],
  )
  // one a faculty member wrote: evidence is required, so it cannot become NULL
  await q(
    `insert into skill_assessments (institution_id, student_id, skill_id, rank, source, assessor_id, evidence) values ($1, $2, $3, 4, 'faculty', $4, $5)`,
    [I, S, uid(), M, X],
  )

  // alumni, placement, helpdesk, admissions
  await q(
    `insert into alumni_profiles (institution_id, user_id, graduation_year, qualification, employer) values ($1, $2, 2026, 'BTech', $3)`,
    [I, S, X],
  )
  const application = uid()
  await q(`insert into placement_applications (id, institution_id, drive_id, student_id, eligibility) values ($1, $2, $3, $4, '{}')`, [application, I, uid(), S])
  await q(
    `insert into placement_results (institution_id, application_id, round_id, outcome, note) values ($1, $2, $3, 'passed', $4)`,
    [I, application, uid(), X],
  )
  const kase = uid()
  await q(
    `insert into helpdesk_cases (id, institution_id, reporter_id, subject, description, kind, status, resolution)
     values ($1, $2, $3, 'Broken tap', $4, 'helpdesk', 'open', $4)`,
    [kase, I, S, X],
  )
  await q(`insert into helpdesk_messages (institution_id, case_id, author_id, body) values ($1, $2, $3, $4)`, [I, kase, A, X])
  const enquiry = uid()
  await q(`insert into admissions_enquiries (id, institution_id, name, email, phone, note) values ($1, $2, 'Enquirer', 'enq@example.test', '9999999999', $3)`, [enquiry, I, X])
  await q(`insert into admissions_applications (institution_id, enquiry_id, program_id, term_id, student_id) values ($1, $2, $3, $4, $5)`, [I, enquiry, uid(), uid(), S])

  // academic, parents, notices
  await q(`insert into academic_student_profiles (student_id, institution_id, roll_no, address_line) values ($1, $2, 'R-1', $3)`, [S, I, X])
  await q(`insert into parent_links (institution_id, parent_id, student_id, relation, refused_reason) values ($1, $2, $3, 'mother', $4)`, [I, G, S, X])
  await q(
    `insert into notifications (institution_id, user_id, module_id, title, body)
     select $1, $2, 'notices', 'Notice ' || n, $3 from generate_series(1, 5001) n`,
    [I, S, X],
  )
  await q(
    `insert into academic_course_completions (institution_id, student_id, course_id, credits, note) values ($1, $2, $3, 3, $4)`,
    [I, S, uid(), K],
  )

  // a staff member's own HR row
  const staff = uid()
  await q(
    `insert into hr_staff (id, institution_id, user_id, employee_code, name, designation, joined_on) values ($1, $2, $3, 'E-1', 'Mentor M', 'Lecturer', current_date)`,
    [staff, I, M],
  )
  await q(
    `insert into hr_leave_requests (institution_id, staff_id, leave_type_id, from_on, to_on, reason) values ($1, $2, $3, current_date, current_date, 'family function')`,
    [I, staff, uid()],
  )
  await q('set session_replication_role = origin')
})

after(async () => {
  await owner?.end()
  if (inst) await authDb.delete(institutions).where(eq(institutions.id, inst))
})

const count = async (table: string, where: string, ...params: unknown[]) =>
  Number((await q(`select count(*) as n from ${table} where ${where}`, params)).rows[0].n)

// The export is read before anything is erased, so these two come first.
test('the export carries rows about the person and has no cap (AUD-03)', async () => {
  const bundle = await exportSubject(inst, id.S)
  assert.equal(bundle.records['notifications.user_id']?.length, 5001)
  assert.equal((bundle.records['about.care_about.care_notes']?.[0] as { body: string }).body, X)
  assert.ok(bundle.records['about.helpdesk_about.helpdesk_messages']?.some((m) => (m as { author_id: string }).author_id === id.A))
  assert.equal(bundle.records['about.placement_about.placement_results']?.length, 1)
})

test('a staff member’s export carries their own HR rows (AUD-03)', async () => {
  const bundle = await exportSubject(inst, id.M)
  assert.equal(bundle.records['about.hr_about.hr_leave_requests']?.length, 1)
})

test('a module guard still refuses changing a live person’s free text (AUD-03)', async () => {
  await rejectsWith(
    () => withTenant(inst, (tx) => tx.execute(sql`update care_notes set body = 'x' where request_id = ${studentRequest}`)),
    /a note is kept as written/,
  )
})

let receipt: Awaited<ReturnType<typeof eraseSubject>>
test('erasure leaves no free text about the person in any table (AUD-03)', async () => {
  receipt = await eraseSubject(inst, id.S, { actorId: id.A, reason: 'test erasure' })
  const tables = (
    await q(
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'
          and table_name not in ('audit_log', 'audit_chain', 'platform_audit_log') order by 1`,
    )
  ).rows.map((r) => r.table_name as string)
  const found: string[] = []
  for (const t of tables) {
    if ((await count(`public."${t}" x`, `x::text like '%' || $1 || '%'`, X)) > 0) found.push(t)
  }
  assert.deepEqual(found, [])
  assert.equal(await count('mentor_leave_applications', 'student_id = $1 and document is null', id.S), 1)
})

test('erasure keeps the institution’s record and other people’s data (AUD-03)', async () => {
  assert.equal(await count('academic_course_completions', `note = $1`, K), 1)
  assert.equal(await count('care_requests', `message = $1`, XO), 1)
  assert.equal(await count('care_notes', `body = $1`, XO), 1)
  for (const [table, where] of [
    ['care_requests', 'student_id = $1'],
    ['mentor_leave_applications', 'student_id = $1'],
    ['placement_applications', 'student_id = $1'],
    ['helpdesk_cases', 'reporter_id = $1'],
    ['attendance_records', 'student_id = $1'],
  ] as const) {
    assert.equal(await count(table, where, id.S), 1, `${table} rows should stay`)
  }
  assert.equal(await count('care_results', 'student_id = $1', id.S), 0)
  assert.equal(await count('notifications', 'user_id = $1', id.S), 0)
})

test('the receipt says what was overwritten and why the rest was kept (AUD-03)', () => {
  assert.equal(receipt.redacted.care_notes, 1)
  assert.equal(receipt.redacted.mentor_messages, 2)
  assert.equal(receipt.redacted.notifications, 5001)
  assert.equal(
    receipt.retainedBecause.academic_course_completions,
    "the institution's own record, kept with the person's name and contact details removed",
  )
})

test('a second erasure changes nothing', async () => {
  const again = await eraseSubject(inst, id.S, { actorId: id.A, reason: 'test erasure again' })
  assert.deepEqual(Object.values(again.redacted).filter((n) => n !== 0), [])
})
