import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { eq, like, sql } from 'drizzle-orm'
import { auditLog, authDb, institutions, users, withTenant } from '@campusos/db'
import {
  addSectionMember,
  createDepartment,
  createProgram,
  createSection,
  createTerm,
  declareProgram,
  endStudentProgram,
  type Actor,
} from './api'
import { plugin } from './plugin'
import { sectionMembers, sections, studentPrograms } from './schema'

/**
 * Year-end promotion and detention (P1-13c, MG-04, NEW-121): a school student
 * has one section per class and school year, and a section is promoted once,
 * whole, in one transaction.
 */

const SLUG = 'acad-promotion-'
const ONE_SECTION = 'academic_school_member_one_section'
let n = 0

async function campus() {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'School', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const id = i!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Office' },
      { email: `t@${tag}.test`, institutionId: id, role: 'faculty', name: 'Teacher' },
      { email: `a@${tag}.test`, institutionId: id, role: 'student', name: 'Asha' },
      { email: `b@${tag}.test`, institutionId: id, role: 'student', name: 'Bala' },
      { email: `c@${tag}.test`, institutionId: id, role: 'student', name: 'Chitra' },
    ])
    .returning({ id: users.id })
  const [adm, tch, a, b, cc] = people.map((p) => p.id) as [string, string, string, string, string]
  const admin = { id: adm, role: 'institution_admin', institutionId: id } as Actor
  const dept = await createDepartment(admin, { code: 'sch', name: 'School' })
  const prog = (code: string, level: 'school' | 'undergraduate') =>
    createProgram(admin, { departmentId: dept.id, code, name: code, level, durationTerms: 2 })
  const [c6, c7, ug] = [await prog('c6', 'school'), await prog('c7', 'school'), await prog('ug', 'undergraduate')]
  const sec = async (programId: string, label: string, admissionYear: number) =>
    (await createSection(admin, { programId, label, admissionYear })).id
  const old = await createTerm(admin, { code: 'T25', name: 'Session 2025-26', startsOn: '2025-10-01', endsOn: '2026-03-31' })
  const next = await createTerm(admin, { code: 'T26', name: 'Session 2026-27', startsOn: '2026-04-01', endsOn: '2026-09-30' })
  return {
    id,
    admin,
    faculty: { id: tch, role: 'faculty', institutionId: id } as Actor,
    asha: a,
    bala: b,
    chitra: cc,
    c6,
    c7,
    ug,
    sec,
    oldTerm: old.id,
    nextTerm: next.id,
  }
}

type Campus = Awaited<ReturnType<typeof campus>>

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

const code = (e: unknown) => (e as { code?: string }).code
const status = (e: unknown) => (e as { status?: number }).status

/** A POST route of the plugin, by path. A route that is not there fails the test, not the import. */
function call(actor: Actor, path: string, body: unknown): Promise<Record<string, unknown> & { promoted: number; detained: number; sourceSectionId: string }> {
  const route = plugin.routes.find((r) => r.method === 'POST' && r.path === path)
  assert.ok(route, `POST ${path} is not a route of the academic plugin`)
  return Promise.resolve(route.handler(actor as never, new Request(`http://x${path}`, { method: 'POST', body: JSON.stringify(body) }))) as ReturnType<typeof call>
}

const token = (members: string[], participants: string[]) =>
  createHash('sha256').update(JSON.stringify([[...members].sort(), [...participants].sort()])).digest('hex')

const insertMember = (c: Campus, sectionId: string, userId: string) =>
  withTenant(c.id, (tx) => tx.insert(sectionMembers).values({ institutionId: c.id, sectionId, userId }))

const named = (e: unknown) => {
  const cause = ((e as { cause?: unknown }).cause ?? e) as { constraint?: string; message?: string }
  return `${cause.constraint ?? ''} ${cause.message ?? ''}`
}

/** Until a session is blocked behind another on a statement that matches. */
async function blockedOn(pattern: string, count = 1) {
  const deadline = Date.now() + 5_000
  for (;;) {
    const r = await authDb.execute<{ n: number }>(sql`
      select count(*)::int as n from pg_stat_activity
       where cardinality(pg_blocking_pids(pid)) > 0 and query ilike ${pattern}`)
    if (r.rows[0]!.n >= count) return
    if (Date.now() > deadline) throw new Error(`nobody is blocked on ${pattern}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

const programsOf = (c: Campus, studentId: string) =>
  withTenant(c.id, (tx) => tx.select().from(studentPrograms).where(eq(studentPrograms.studentId, studentId)).orderBy(studentPrograms.declaredOn, studentPrograms.createdAt))

const sectionsOf = async (c: Campus, userId: string) =>
  (await withTenant(c.id, (tx) => tx.select({ s: sectionMembers.sectionId }).from(sectionMembers).where(eq(sectionMembers.userId, userId)))).map((r) => r.s).sort()

const promotions = (c: Campus) =>
  withTenant(c.id, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, 'school.section_promoted')))

/** Class 6 (2025) with Asha, Bala and Chitra; Chitra left on 2026-01-15. Targets exist in 2026. */
async function year(c: Campus) {
  const s6 = await c.sec(c.c6.id, 'A', 2025)
  const next7 = await c.sec(c.c7.id, 'A', 2026)
  const again6 = await c.sec(c.c6.id, 'A', 2026)
  for (const who of [c.asha, c.bala, c.chitra]) {
    await declareProgram(c.admin, { studentId: who, programId: c.c6.id, declaredOn: '2025-06-01' })
    await addSectionMember(c.admin, { sectionId: s6, userId: who })
  }
  const [left] = await programsOf(c, c.chitra)
  await endStudentProgram(c.admin, { studentProgramId: left!.id, status: 'transferred_out', endedOn: '2026-01-15' })
  await call(c.admin, '/programs/next', { programId: c.c6.id, nextProgramId: c.c7.id })
  const members = [c.asha, c.bala, c.chitra]
  const body = (over: Record<string, unknown> = {}) => ({
    sourceSectionId: s6,
    sourceTermId: c.oldTerm,
    nextTermId: c.nextTerm,
    promotedSectionId: next7,
    detainedSectionId: again6,
    detainedStudentIds: [c.bala],
    rosterToken: token(members, [c.asha, c.bala]),
    reason: 'Year end 2025-26',
    ...over,
  })
  return { s6, next7, again6, body }
}

test('school roster has one section per class and year', async () => {
  const c = await campus()
  const a1 = await c.sec(c.c6.id, 'A', 2025)
  const b1 = await c.sec(c.c6.id, 'B', 2025)
  await insertMember(c, a1, c.asha)
  await assert.rejects(insertMember(c, b1, c.asha), (e) => named(e).includes(ONE_SECTION))
  // The identical row stays a no-op.
  await withTenant(c.id, (tx) =>
    tx.insert(sectionMembers).values({ institutionId: c.id, sectionId: a1, userId: c.asha }).onConflictDoNothing({ target: [sectionMembers.sectionId, sectionMembers.userId] }),
  )
  // Another year, another class, and two non-school sections are all fine.
  await insertMember(c, await c.sec(c.c6.id, 'A', 2026), c.asha)
  await insertMember(c, await c.sec(c.c7.id, 'A', 2025), c.asha)
  await insertMember(c, await c.sec(c.ug.id, 'A', 2025), c.asha)
  await insertMember(c, await c.sec(c.ug.id, 'B', 2025), c.asha)
  const rows = await withTenant(c.id, (tx) => tx.select().from(sectionMembers).where(eq(sectionMembers.userId, c.asha)))
  assert.equal(rows.length, 5)
})

test('school roster refuses concurrent competing inserts', async () => {
  const c = await campus()
  const a1 = await c.sec(c.c6.id, 'A', 2025)
  const b1 = await c.sec(c.c6.id, 'B', 2025)
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  let holding!: () => void
  const first = new Promise<void>((resolve) => (holding = resolve))
  const a = withTenant(c.id, async (tx) => {
    await tx.insert(sectionMembers).values({ institutionId: c.id, sectionId: a1, userId: c.asha })
    holding()
    await held
  })
  await first
  const b = insertMember(c, b1, c.asha).then(() => null, (e: unknown) => e)
  try {
    await blockedOn('%academic_section_members%')
  } finally {
    release()
    await a
  }
  const lost = await b
  assert.ok(lost, 'the second insert was refused')
  assert.ok(named(lost).includes(ONE_SECTION))
  const rows = await withTenant(c.id, (tx) => tx.select().from(sectionMembers).where(eq(sectionMembers.userId, c.asha)))
  assert.equal(rows.length, 1)
})

test('promotes and detains one roster with one audit', async () => {
  const c = await campus()
  const y = await year(c)
  const out = await call(c.admin, '/sections/promote', y.body())
  assert.deepEqual([out.sourceSectionId, out.promoted, out.detained], [y.s6, 1, 1])

  const [asha0, asha1] = await programsOf(c, c.asha)
  assert.deepEqual([asha0!.status, asha0!.endedOn, asha0!.isPrimary, asha0!.programId], ['completed', '2026-03-31', false, c.c6.id])
  assert.deepEqual([asha1!.status, asha1!.declaredOn, asha1!.endedOn, asha1!.isPrimary, asha1!.programId, asha1!.curriculumId], ['active', '2026-04-01', null, true, c.c7.id, null])
  const [, bala1] = await programsOf(c, c.bala)
  assert.deepEqual([bala1!.status, bala1!.declaredOn, bala1!.programId], ['active', '2026-04-01', c.c6.id])
  const chitra = await programsOf(c, c.chitra)
  assert.deepEqual(chitra.map((p) => p.status), ['transferred_out'], 'a departed student gets nothing new')

  assert.deepEqual(await sectionsOf(c, c.asha), [y.s6, y.next7].sort())
  assert.deepEqual(await sectionsOf(c, c.bala), [y.s6, y.again6].sort())
  assert.deepEqual(await sectionsOf(c, c.chitra), [y.s6])

  const trail = await promotions(c)
  assert.equal(trail.length, 1)
  assert.equal(trail[0]!.entity, 'academic_sections')
  assert.equal(trail[0]!.entityId, y.s6)
  assert.equal(trail[0]!.reason, 'Year end 2025-26')
  assert.deepEqual(trail[0]!.detail, {
    sourceTermId: c.oldTerm,
    nextTermId: c.nextTerm,
    endedOn: '2026-03-31',
    startedOn: '2026-04-01',
    promotedSectionId: y.next7,
    detainedSectionId: y.again6,
    promoted: 1,
    detained: 1,
    departed: 1,
  })

  await assert.rejects(call(c.admin, '/sections/promote', y.body()), (e) => code(e) === 'school_section_finalised' && status(e) === 409)
  assert.equal((await promotions(c)).length, 1)
})

test('bad cohort does not promote anybody', async () => {
  const c = await campus()
  const y = await year(c)
  // Asha already sits in another class 7 section of 2026.
  await addSectionMember(c.admin, { sectionId: await c.sec(c.c7.id, 'B', 2026), userId: c.asha })
  const before = {
    programs: [await programsOf(c, c.asha), await programsOf(c, c.bala)],
    members: [await sectionsOf(c, c.asha), await sectionsOf(c, c.bala)],
  }
  await assert.rejects(call(c.admin, '/sections/promote', y.body()), (e) => code(e) === 'school_section_taken' && status(e) === 409)
  assert.deepEqual(
    { programs: [await programsOf(c, c.asha), await programsOf(c, c.bala)], members: [await sectionsOf(c, c.asha), await sectionsOf(c, c.bala)] },
    before,
  )
  assert.equal((await promotions(c)).length, 0)
  const [src] = await withTenant(c.id, (tx) => tx.select().from(sections).where(eq(sections.id, y.s6)))
  assert.equal((src as unknown as { schoolPromotedAt: Date | null }).schoolPromotedAt ?? null, null)
})

test('promotion requires a tenant office and a current preview', async () => {
  const c = await campus()
  const other = await campus()
  const y = await year(c)
  const stranger = await other.sec(other.c6.id, 'A', 2025)
  const writes = async () => [(await promotions(c)).length, (await programsOf(c, c.asha)).length, (await sectionsOf(c, c.asha)).length]
  const before = await writes()

  await assert.rejects(call(c.faculty, '/sections/promote', y.body()), (e) => status(e) === 403)
  await assert.rejects(call(c.admin, '/sections/promote', y.body({ sourceSectionId: stranger })), (e) => code(e) === 'no_such_section' && status(e) === 404)
  await assert.rejects(call(c.admin, '/sections/promote', y.body({ nextTermId: other.nextTerm })), (e) => code(e) === 'no_such_term' && status(e) === 404)
  await assert.rejects(call(c.admin, '/sections/promote', y.body({ rosterToken: token([c.asha], [c.asha]) })), (e) => code(e) === 'promotion_roster_changed' && status(e) === 409)
  assert.deepEqual(await writes(), before)
})

test('a successor must be a different school class, without a cycle', async () => {
  const c = await campus()
  await call(c.admin, '/programs/next', { programId: c.c6.id, nextProgramId: c.c7.id })
  await assert.rejects(call(c.admin, '/programs/next', { programId: c.c7.id, nextProgramId: c.c6.id }), (e) => code(e) === 'invalid_next_class')
  await assert.rejects(call(c.admin, '/programs/next', { programId: c.c6.id, nextProgramId: c.c6.id }), (e) => code(e) === 'invalid_next_class')
  await assert.rejects(call(c.admin, '/programs/next', { programId: c.c6.id, nextProgramId: c.ug.id }), (e) => code(e) === 'invalid_next_class')
  assert.deepEqual(await call(c.admin, '/programs/next', { programId: c.c6.id, nextProgramId: '' }), { programId: c.c6.id, nextProgramId: null })
  await assert.rejects(call(c.faculty, '/programs/next', { programId: c.c6.id, nextProgramId: c.c7.id }), (e) => status(e) === 403)
})


test('the database holds a school class and section still, and refuses another tenant’s section', async () => {
  const c = await campus()
  const other = await campus()
  const s = await c.sec(c.c6.id, 'A', 2025)
  const owner = (stmt: ReturnType<typeof sql>) => authDb.execute(stmt).then(() => null, (e: unknown) => e)
  assert.match(named(await owner(sql`update academic_programs set level = 'undergraduate' where id = ${c.c6.id}`)), /school programme identity is fixed/)
  assert.match(named(await owner(sql`update academic_sections set admission_year = 2024 where id = ${s}`)), /school section identity is fixed/)
  assert.match(named(await owner(sql`update academic_sections set program_id = ${c.c7.id} where id = ${s}`)), /school section identity is fixed/)
  // A section of another tenant cannot take a member here, with or without RLS to hide it.
  const foreign = await other.sec(other.c6.id, 'A', 2025)
  const refused = await withTenant(c.id, (tx) => tx.insert(sectionMembers).values({ institutionId: c.id, sectionId: foreign, userId: c.asha })).then(() => null, (e: unknown) => e)
  assert.ok(refused)
  const refusedAsOwner = await owner(sql`insert into academic_section_members (institution_id, section_id, user_id) values (${c.id}, ${foreign}, ${c.asha})`)
  assert.ok(refusedAsOwner)
  assert.match(named(refusedAsOwner), /missing from membership tenant|foreign key/)
})

test('two promotions of the same section race: one wins, one is told it is finalised, one audit row', async () => {
  const c = await campus()
  const y = await year(c)
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  let holding!: () => void
  const locked = new Promise<void>((resolve) => (holding = resolve))
  const holder = authDb.transaction(async (tx) => {
    await tx.execute(sql`select 1 from academic_sections where id = ${y.s6} for update`)
    holding()
    await held
  })
  await locked
  const go = () => call(c.admin, '/sections/promote', y.body()).then(() => null, (e: unknown) => e)
  const both = [go(), go()]
  try {
    await blockedOn('%academic_sections%for update%', 2)
  } finally {
    release()
    await holder
  }
  const outcomes = await Promise.all(both)
  assert.equal(outcomes.filter((o) => o === null).length, 1)
  assert.deepEqual(outcomes.filter((o) => o !== null).map(code), ['school_section_finalised'])
  assert.equal((await promotions(c)).length, 1)
  assert.deepEqual((await programsOf(c, c.asha)).map((p) => p.status), ['completed', 'active'])
})

const pageOf = (actor: Actor, sourceSectionId?: string) => {
  const page = plugin.pages!.find((p) => p.path === '/promotion')
  assert.ok(page, 'the promotion page is declared')
  return page.load(actor as never, new Request(`http://x/promotion${sourceSectionId ? `?sourceSectionId=${sourceSectionId}` : ''}`)).then((data) => ({ data, sections: page.sections(data) }))
}

test('the promotion page is for the office, previews the exact token and offers the form once', async () => {
  const c = await campus()
  const y = await year(c)
  await assert.rejects(pageOf(c.faculty, y.s6), (e) => status(e) === 403)

  const preview = await pageOf(c.admin, y.s6)
  const form = preview.sections.find((s) => s.kind === 'form' && s.path === '/sections/promote')
  assert.ok(form && form.kind === 'form', 'a valid roster shows the promote form')
  assert.equal(preview.data.rosterToken, token([c.asha, c.bala, c.chitra], [c.asha, c.bala]))
  assert.deepEqual((preview.data.candidates as { value: string }[]).map((x) => x.value).sort(), [c.asha, c.bala].sort())
  assert.deepEqual((preview.data.roster as { standing: string }[]).map((r) => r.standing).sort(), ['Departed', 'On roll', 'On roll'])
  assert.deepEqual(form.fields.map((f) => f.label).filter((l) => !/^(Source section|Roster)$/.test(l)), [
    'Last term of old session',
    'First term of new session',
    'Promoted students’ section',
    'Detained students’ section',
    'Students to detain',
    'Reason',
  ])

  await call(c.admin, '/sections/promote', y.body())
  const after = await pageOf(c.admin, y.s6)
  assert.equal(after.data.state, 'finalised')
  assert.ok(!after.sections.some((s) => s.kind === 'form' && s.path === '/sections/promote'))
  assert.ok(after.sections.some((s) => s.kind === 'note' && /already been promoted/.test(s.text)))
})

test('a second section for the same class and year gets the office’s own answer, and a promoted section takes nobody new', async () => {
  const c = await campus()
  const y = await year(c)
  const b = await c.sec(c.c6.id, 'B', 2025)
  await assert.rejects(addSectionMember(c.admin, { sectionId: b, userId: c.asha }), (e) => code(e) === 'school_section_taken' && status(e) === 409)
  await call(c.admin, '/sections/promote', y.body())
  // The same person again is still a no-op; a new person is refused.
  await addSectionMember(c.admin, { sectionId: y.s6, userId: c.asha })
  const fresh = await authDb.insert(users).values({ email: `late@${SLUG}x.test`, institutionId: c.id, role: 'student', name: 'Late' }).returning({ id: users.id })
  await assert.rejects(addSectionMember(c.admin, { sectionId: y.s6, userId: fresh[0]!.id }), (e) => code(e) === 'school_section_finalised' && status(e) === 409)
})

test('the two terms must be adjacent regular terms across the cut', async () => {
  const c = await campus()
  const y = await year(c)
  // The old session had an earlier term, and the new one gets a later term.
  const early = await createTerm(c.admin, { code: 'T25a', name: 'Session 2025 first term', startsOn: '2025-04-01', endsOn: '2025-09-30' })
  const late = await createTerm(c.admin, { code: 'T26b', name: 'Session 2026 second term', startsOn: '2026-10-01', endsOn: '2027-03-31' })
  const refused = async (over: Record<string, unknown>) => {
    await assert.rejects(call(c.admin, '/sections/promote', y.body(over)), (e) => code(e) === 'invalid_promotion')
    const [s] = await withTenant(c.id, (tx) => tx.select().from(sections).where(eq(sections.id, y.s6)))
    assert.equal(s!.schoolPromotedAt, null, 'a refused pick leaves the section open')
  }
  await refused({ sourceTermId: early.id }) // not the last term of the old session
  await refused({ nextTermId: late.id }) // not the first term of the new session
  await call(c.admin, '/sections/promote', y.body())
})

test('an erased student is no part of the promotion (P1-13c Opus review)', async () => {
  const c = await campus()
  const y = await year(c)
  await authDb.update(users).set({ erasedAt: new Date() }).where(eq(users.id, c.bala))
  const members = [c.asha, c.bala, c.chitra]
  const { detainedSectionId: _none, ...body } = y.body({ detainedStudentIds: [], rosterToken: token(members, [c.asha]) })
  const res = await call(c.admin, '/sections/promote', body)
  assert.equal(res.promoted, 1)
  assert.deepEqual(await sectionsOf(c, c.bala), [y.s6])
  assert.deepEqual(await sectionsOf(c, c.asha), [y.next7, y.s6].sort())
  assert.equal((await programsOf(c, c.bala)).length, 1)
})
