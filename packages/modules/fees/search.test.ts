import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { like, sql } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import * as academic from '@campusos/module-academic/api'
import { authorizeRoute } from '@campusos/module-framework'
import { plugin } from './plugin'
import { feePayments } from './schema'
import type { Actor } from './api'

/**
 * UX-04, P1-09c: receipts found by number (old and fiscal-year styles) and a
 * student picker that is searched rather than preloaded.
 */

const SLUG = 'fees-search-'
let n = 0

type Hit = { id: string; title: string; detail: string | null; href: string | null }

async function campus() {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Receipt College', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const id = i!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: `clerk@${tag}.test`, institutionId: id, role: 'accounts_staff', name: 'Clerk' },
      { email: `adm@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Adm' },
      { email: `f@${tag}.test`, institutionId: id, role: 'faculty', name: 'Fac' },
      { email: `s@${tag}.test`, institutionId: id, role: 'student', name: 'Asha Verma' },
      { email: `gone@${tag}.test`, institutionId: id, role: 'student', name: 'Asha Erased', erasedAt: new Date() },
      { email: `nameless@${tag}.test`, institutionId: id, role: 'student', name: null },
    ])
    .returning({ id: users.id })
  const [clerkId, admId, facId, sId, goneId, namelessId] = people.map((p) => p.id) as [string, string, string, string, string, string]
  const as = (uid: string, role: string) => ({ id: uid, role, institutionId: id }) as Actor
  const admin = as(admId, 'institution_admin')
  const term = await academic.createTerm(admin as never, { code: 't1', name: 'Term 1', startsOn: '2026-01-05', endsOn: '2026-05-30' })
  const receipt = (receiptNo: string, extra: Partial<typeof feePayments.$inferInsert> = {}) =>
    withTenant(id, async (tx) => {
      const [p] = await tx
        .insert(feePayments)
        .values({ institutionId: id, studentId: sId, termId: term.id, amountPaise: 123456, method: 'cash', receiptNo, reference: 'SECRET-BANK-REF', ...extra })
        .returning({ id: feePayments.id })
      return p!.id
    })
  return { id, tag, admin, clerk: as(clerkId, 'accounts_staff'), faculty: as(facId, 'faculty'), student: as(sId, 'student'), sId, goneId, namelessId, receipt }
}

const find = (path: string) => {
  const r = plugin.routes.find((x) => x.method === 'GET' && x.path === path)
  assert.ok(r, `Fees declares GET ${path}`)
  return r
}
const call = async (path: string, actor: Actor, q: string | null, raw?: string): Promise<{ hits: Hit[] }> => {
  const url = raw ?? `http://x${path}${q === null ? '' : `?q=${encodeURIComponent(q)}`}`
  return (await find(path).handler(actor as never, new Request(url))) as { hits: Hit[] }
}
const code = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (e) {
    return (e as { code?: string }).code
  }
  return 'resolved'
}

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

test('both routes are declared as lookups for the accounts office', () => {
  assert.equal(find('/record-search').lookup, 'global')
  assert.equal(find('/student-choices').lookup, 'picker')
  for (const path of ['/record-search', '/student-choices']) {
    const r = find(path)
    assert.deepEqual([...(r.roles ?? [])].sort(), ['accounts_staff', 'institution_admin', 'super_admin'])
    for (const role of ['faculty', 'student', 'parent', 'hod', 'pending'] as const) assert.equal(authorizeRoute(plugin.manifest, r, role), 'deny', `${path} ${role}`)
  }
})

test('a legacy or fiscal receipt opens the original print route', async () => {
  const c = await campus()
  const other = await campus()
  const legacy = await c.receipt('R-000123')
  const fiscal = await c.receipt('R/2627/000124')
  const voided = await c.receipt('R/2627/000125', { status: 'voided', voidedAt: new Date(), voidReason: 'entered twice' })
  const bounced = await c.receipt('R/2627/000126', { method: 'cheque', status: 'bounced', voidedAt: new Date(), voidReason: 'funds insufficient', bouncedOn: '2026-02-01' })
  await other.receipt('R-000123')

  const one = (await call('/record-search', c.clerk, 'r-000123')).hits
  assert.deepEqual(one.map((h) => h.id), [legacy])
  assert.equal(one[0]!.title, 'R-000123')
  assert.equal(one[0]!.detail, 'Recorded')
  assert.equal(one[0]!.href, `/api/v1/modules/fees/receipt.pdf?paymentId=${encodeURIComponent(legacy)}`)
  assert.deepEqual((await call('/record-search', c.admin, 'R/2627/000124')).hits.map((h) => h.id), [fiscal])
  assert.equal((await call('/record-search', c.admin, 'R/2627/000125')).hits[0]?.detail, 'Void')
  assert.equal((await call('/record-search', c.admin, 'R/2627/000126')).hits[0]?.id, bounced)
  assert.equal((await call('/record-search', c.admin, 'R/2627/000126')).hits[0]?.detail, 'Cheque returned unpaid')
  // A fragment finds the whole series, own tenant only, and carries no money or person.
  const series = (await call('/record-search', c.admin, '2627')).hits
  assert.deepEqual(series.map((h) => h.id).sort(), [fiscal, voided, bounced].sort())
  const text = JSON.stringify(series)
  assert.ok(!/123456|SECRET-BANK-REF|Asha|Verma/.test(text))
  for (const h of series) assert.deepEqual(Object.keys(h).sort(), ['detail', 'href', 'id', 'title'])
})

test('wildcard characters in a receipt search are literal', async () => {
  const c = await campus()
  await c.receipt('R/2627/000200')
  assert.deepEqual((await call('/record-search', c.admin, 'R%2627')).hits, [])
  assert.deepEqual((await call('/record-search', c.admin, 'R_/2627')).hits, [])
})

test('the student picker finds accounts and never an erased identity', async () => {
  const c = await campus()
  const hits = (await call('/student-choices', c.clerk, 'asha')).hits
  assert.deepEqual(hits.map((h) => h.id), [c.sId])
  assert.equal(hits[0]!.href, null)
  const email = `nameless@${c.tag}.test`
  // An exact address finds an account with no name; a fragment of one finds nothing.
  const byEmail = (await call('/student-choices', c.clerk, email)).hits
  assert.deepEqual(byEmail.map((h) => h.id), [c.namelessId])
  assert.equal(byEmail[0]!.title, email)
  assert.deepEqual((await call('/student-choices', c.clerk, 'nameless@')).hits, [])
  assert.ok(!(await call('/student-choices', c.clerk, 'Asha Erased')).hits.length)
})

test('learners, faculty and bad queries are refused', async () => {
  const c = await campus()
  for (const path of ['/record-search', '/student-choices']) {
    for (const who of [c.student, c.faculty]) assert.equal(await code(call(path, who, 'asha')), 'forbidden', `${path} ${who.role}`)
    for (const q of ['', ' ', 'x'.repeat(101), 'a\u0007b']) assert.equal(await code(call(path, c.admin, q)), 'invalid_search', `${path} ${JSON.stringify(q)}`)
    assert.equal(await code(call(path, c.admin, null)), 'invalid_search')
    assert.equal(await code(call(path, c.admin, null, `http://x${path}?q=a&q=b`)), 'invalid_search')
  }
})

test('the charge and demand-letter pages no longer preload students', async () => {
  const c = await campus()
  const { pages } = await import('./pages')
  const { transferPages } = await import('./transfer-pages')
  for (const page of [...pages, ...transferPages].filter((p) => p.path === '/student-charges' || p.path === '/accounts-and-letters' || p.menu === 'Accounts and letters')) {
    const data = (await page.load!(c.clerk as never, new Request(`http://x${page.path}`))) as Record<string, unknown>
    assert.equal('students' in data, false, page.path)
    const forms = page.sections(data as never).filter((s) => s.kind === 'form') as { fields: { name: string; kind?: string; lookup?: { path: string } }[] }[]
    const field = forms.flatMap((f) => f.fields).find((f) => f.name === 'studentId')
    if (field) assert.deepEqual(field.lookup, { path: '/student-choices' })
  }
})

test('0013 lifts the statement timeout and caps the lock wait for the installer\'s transaction (NEW-80 class)', async () => {
  const file = readFileSync(new URL('./migrations/0013_record_search.sql', import.meta.url), 'utf8')
  const alterAt = file.indexOf('ALTER TABLE public.fee_payments ADD COLUMN')
  const settings = file.slice(0, alterAt).split('--> statement-breakpoint').map((s) => s.trim()).filter((s) => /^SET LOCAL /m.test(s.replace(/^--.*$/gm, '').trim()))
  assert.deepEqual(
    settings.map((s) => s.replace(/^--.*$/gm, '').trim()),
    ['SET LOCAL statement_timeout = 0;', "SET LOCAL lock_timeout = '5s';"],
    'both settings come before the ALTER',
  )
  // As the installer runs a migration: one transaction on a pool that has a 30 s limit (here 1 s), statement by statement.
  const seen = await authDb.transaction(async (tx) => {
    await tx.execute(sql`set local statement_timeout = '1s'`)
    for (const s of settings) await tx.execute(sql.raw(s.replace(/^--.*$/gm, '')))
    await tx.execute(sql`select pg_sleep(1.5)`) // would be cancelled without the first setting
    const r = await tx.execute(sql`select current_setting('statement_timeout') as st, current_setting('lock_timeout') as lt`)
    return r.rows[0] as { st: string; lt: string }
  })
  assert.deepEqual(seen, { st: '0', lt: '5s' })
})

test('academic 0014, library 0004 and core 0018 lift the timeouts before their stored-column ALTER too', () => {
  for (const f of ['../academic/migrations/0014_record_search.sql', '../library/migrations/0004_record_search.sql', '../../db/migrations/0018_record_search.sql']) {
    const file = readFileSync(new URL(f, import.meta.url), 'utf8')
    const sets = file.indexOf("SET LOCAL lock_timeout = '5s'")
    assert.ok(file.indexOf('SET LOCAL statement_timeout = 0') >= 0 && sets > file.indexOf('SET LOCAL statement_timeout = 0'), f)
    assert.ok(sets < file.indexOf('ADD COLUMN'), f)
  }
})
