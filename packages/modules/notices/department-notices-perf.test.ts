import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, sql } from 'drizzle-orm'
import { authDb, institutions, withTenant } from '@campusos/db'
import { board, inbox, noticePage, type Actor } from './api'
import { memberDepartments, scopedNoticeGuard } from './api/department-audience'

/**
 * Department notices at scale (P1-07e review, BLOCKER): the member check must
 * cost what the person belongs to, not what the institution holds. 50
 * departments, 100,000 students and as many parents took 4 to 13 s per board or
 * inbox request when it ran the delivery audience once per department.
 */

const SLUG = 'notice-dept-scale'
const DEPTS = 20
const PER = 500
const PARENTS = 50 // parents per department; users are slow to delete, so not one per student
let inst = ''
const bound = 1000 // ms; the fixed code takes under 150 on a quiet machine

const actor = (id: string, role: Actor['role']): Actor => ({ id, role, email: `${id}@sperf.test`, institutionId: inst })
const timed = async <T>(fn: () => Promise<T>) => {
  const t0 = performance.now()
  const out = await fn()
  return { out, ms: performance.now() - t0 }
}

before(async () => {
  const [i] = await authDb.insert(institutions).values({ slug: SLUG, name: 'Perf College', allowedEmailDomains: ['sperf.test'] }).returning({ id: institutions.id })
  inst = i!.id
  const n = DEPTS * PER
  await authDb.execute(sql`insert into users (id, email, institution_id, role, name)
    select 'sx' || g, 'sx' || g || '@sperf.test', ${inst}, 'student', 'S' || g from generate_series(1, ${n}::int) g`)
  await authDb.execute(sql`insert into users (id, email, institution_id, role, name)
    select 'sy' || g, 'sy' || g || '@sperf.test', ${inst}, 'parent', 'P' || g from generate_series(1, ${n}::int) g where (g - 1) % ${PER} < ${PARENTS}`)
  await authDb.execute(sql`insert into users (id, email, institution_id, role, name) values ('sadm', 'sadm@sperf.test', ${inst}, 'institution_admin', 'A')`)
  await authDb.execute(sql`insert into academic_departments (id, institution_id, code, name)
    select gen_random_uuid(), ${inst}, 'D' || lpad(g::text, 3, '0'), 'Dept ' || g from generate_series(1, ${DEPTS}) g`)
  await authDb.execute(sql`insert into academic_programs (institution_id, department_id, code, name, level, duration_terms)
    select ${inst}, d.id, 'P' || d.code, 'Prog', 'undergraduate', 8 from academic_departments d where d.institution_id = ${inst}`)
  await authDb.execute(sql`insert into academic_student_programs (institution_id, student_id, program_id, declared_on)
    select ${inst}, 'sx' || g, p.id, current_date - 30
      from generate_series(1, ${n}::int) g
      join academic_departments d on d.institution_id = ${inst} and d.code = 'D' || lpad((((g - 1) / ${PER}) + 1)::text, 3, '0')
      join academic_programs p on p.department_id = d.id`)
  await authDb.execute(sql`insert into parent_links (institution_id, parent_id, student_id, relation, verified_at)
    select ${inst}, 'sy' || g, 'sx' || g, 'mother', now() from generate_series(1, ${n}::int) g where (g - 1) % ${PER} < ${PARENTS}`)
  await authDb.execute(sql`insert into notices (institution_id, title, body, author_id, published_at, department_id)
    select ${inst}, 'DN' || d.code, 'b', 'sadm', now(), d.id from academic_departments d where d.institution_id = ${inst}`)
  await authDb.execute(sql`insert into notices (institution_id, title, body, author_id, published_at)
    select ${inst}, 'N' || g, 'b', 'sadm', now() - (g || ' seconds')::interval from generate_series(1, 5000) g`)
  for (const t of ['notices', 'academic_student_programs', 'parent_links', 'users']) await authDb.execute(sql.raw(`analyze ${t}`))
})

after(async () => {
  // Children first: parent_links.verified_by and notices.author_id have no index, so a cascade from users is quadratic.
  for (const t of ['parent_links', 'notices', 'academic_student_programs', 'academic_programs'])
    await authDb.execute(sql.raw(`delete from ${t} where institution_id = '${inst}'`))
  await authDb.delete(institutions).where(eq(institutions.slug, SLUG))
})

test('a student, a parent and an administrator read the board and inbox in bounded time', async () => {
  for (const a of [actor('sx1', 'student'), actor('sy1', 'parent'), actor('sadm', 'institution_admin')]) {
    const b = await timed(() => board(a, false, noticePage(new Request('https://x/?n=20'), '')))
    const i = await timed(() => inbox(a, true))
    assert.ok(b.ms < bound, `${a.role} board ${b.ms.toFixed(0)} ms`)
    assert.ok(i.ms < bound, `${a.role} inbox ${i.ms.toFixed(0)} ms`)
  }
})

test('the member check reads a bounded number of blocks, not the audience of every department', async () => {
  // Buffer accesses in this transaction, from the statistics system: independent of how loaded the machine is.
  // The per-department audience read 430,000 here at this size; the person's own side reads 20,000 or fewer (catalog reads included).
  const blocks = await withTenant(inst, async (tx) => {
    await memberDepartments(tx, inst, 'sx1')
    await memberDepartments(tx, inst, 'sy1')
    const r = (await tx.execute(sql`select coalesce(sum(pg_stat_get_xact_blocks_fetched(c.oid)), 0)::bigint as b from pg_class c where c.relkind in ('r', 'i')`)).rows as { b: string }[]
    return Number(r[0]!.b)
  })
  assert.ok(blocks < 100000, `${blocks} blocks`)
})

test('the member list is exactly the own department, whoever asks', async () => {
  const mine = await withTenant(inst, async (tx) => {
    const own = (await tx.execute(sql`select p.department_id as d from academic_student_programs sp join academic_programs p on p.id = sp.program_id where sp.student_id = 'sx1'`)).rows as { d: string }[]
    return { own: own.map((r) => r.d), student: await memberDepartments(tx, inst, 'sx1'), parent: await memberDepartments(tx, inst, 'sy1'), admin: await memberDepartments(tx, inst, 'sadm') }
  })
  assert.equal(mine.own.length, 1)
  assert.deepEqual(mine.student, mine.own)
  assert.deepEqual(mine.parent, mine.own)
  assert.deepEqual(mine.admin, [])
})

test('the scoped-notice guard costs the caller, not the hub (P1-07e review 2, HIGH)', async () => {
  const [o] = await authDb.insert(institutions).values({ slug: 'notice-dept-scale-other', name: 'Busy College', allowedEmailDomains: ['sother.test'] }).returning({ id: institutions.id })
  const [q] = await authDb.insert(institutions).values({ slug: 'notice-dept-scale-quiet', name: 'Quiet College', allowedEmailDomains: ['squiet.test'] }).returning({ id: institutions.id })
  try {
    await authDb.execute(sql`insert into users (id, email, institution_id, role, name) values ('oadm', 'oadm@sother.test', ${o!.id}, 'institution_admin', 'A')`)
    await authDb.execute(sql`insert into users (id, email, institution_id, role, name) values ('qadm', 'qadm@squiet.test', ${q!.id}, 'institution_admin', 'A')`)
    await authDb.execute(sql`insert into academic_departments (institution_id, code, name) values (${o!.id}, 'BUSY', 'Busy')`)
    await authDb.execute(sql`insert into notices (institution_id, title, body, author_id, published_at, department_id)
      select ${o!.id}, 'X' || g, 'b', 'oadm', now(), (select id from academic_departments where institution_id = ${o!.id}) from generate_series(1, 200000) g`)
    await authDb.execute(sql`insert into notices (institution_id, title, body, author_id, published_at)
      select ${q!.id}, 'Q' || g, 'b', 'qadm', now() - (g || ' seconds')::interval from generate_series(1, 100000) g`)
    await authDb.execute(sql`analyze notices`)
    const plan = await withTenant(q!.id, async (tx) => {
      assert.deepEqual(await memberDepartments(tx, q!.id, 'nobody'), [])
      return ((await tx.execute(sql`explain (analyze, buffers) ${scopedNoticeGuard(q!.id)}`)).rows as { 'QUERY PLAN': string }[]).map((r) => r['QUERY PLAN']).join(' ')
    })
    // The caller's own 100,000 unscoped notices and the hub's 200,000 scoped ones must not be read: the first form read thousands of blocks.
    const read = Number(/Buffers: shared hit=(\d+)/.exec(plan)?.[1] ?? 0) // the top node's count
    assert.ok(read < 100, `${read} blocks: ${plan}`)
  } finally {
    await authDb.execute(sql`delete from notices where institution_id in (${o!.id}, ${q!.id})`)
    await authDb.delete(institutions).where(eq(institutions.id, o!.id))
    await authDb.delete(institutions).where(eq(institutions.id, q!.id))
  }
})
