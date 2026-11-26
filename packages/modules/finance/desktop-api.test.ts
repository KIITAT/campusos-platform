import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { and, eq, like } from 'drizzle-orm'
import { auditLog, authDb, institutions, users, withTenant } from '@campusos/db'
import { authorizeRoute } from '@campusos/module-framework'
import { closePeriod, createParty, saveOrder, setApprovalRule, setSingleOfficer, createItem, type Actor } from './api'
import { plugin } from './plugin'

/**
 * P2-23 (W6, W9, W11): what the desktop client reads from the books. A period's
 * lock, the approvals waiting for the caller across documents, and the records
 * whose history the host may serve.
 */

let n = 0
const SLUG = 'fin-desk-'

async function books() {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb.insert(institutions).values({ slug: tag, name: 'Desk College', allowedEmailDomains: [`${tag}.test`] }).returning({ id: institutions.id })
  const id = i!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Adm' },
      { email: `acc@${tag}.test`, institutionId: id, role: 'accounts_staff', name: 'Acc' },
      { email: `stu@${tag}.test`, institutionId: id, role: 'student', name: 'Stu' },
    ])
    .returning({ id: users.id })
  const who = (at: number, role: Actor['role']): Actor => ({ id: people[at]!.id, email: `${at}@${tag}.test`, role, institutionId: id })
  const b = { id, admin: who(0, 'institution_admin'), staff: who(1, 'accounts_staff'), student: who(2, 'student') }
  await setSingleOfficer(b.admin, { enabled: true, reason: 'test fixture: one officer' })
  return b
}

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

const route = (path: string) => plugin.routes.find((r) => r.method === 'GET' && r.path === path)!

test('periods carry a label, the dates of the month and whether it is locked, beside the old keys', async () => {
  const b = await books()
  const d = new Date()
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() - 1)
  const year = d.getUTCFullYear()
  const month = d.getUTCMonth() + 1
  await closePeriod(b.admin, { year, month })
  const rows = (await route('/periods').handler(b.staff, new Request('http://x/periods'))) as Record<string, unknown>[]
  assert.equal(rows.length, 1)
  const [p] = rows
  const mm = String(month).padStart(2, '0')
  assert.equal(p!.from, `${year}-${mm}-01`)
  assert.match(String(p!.to), new RegExp(`^${year}-${mm}-(28|29|30|31)$`))
  assert.equal(p!.locked, true)
  assert.match(String(p!.label), new RegExp(`^[A-Z][a-z]{2} ${year}$`))
  assert.equal(p!.status, 'closed')
  assert.equal(p!.year, year)
  assert.equal(typeof p!.id, 'string')
})

test('the approvals feed lists a waiting draft with its party and refuses a student', async () => {
  const b = await books()
  const supplier = (await createParty(b.staff, { code: 'S1', name: 'Sharma Stationers', isSupplier: true })).id
  const toner = (await createItem(b.staff, { code: 'TONER', name: 'Toner' })).id
  await setApprovalRule(b.admin, { docType: 'purchase_order', minAmount: '10000', approver: 'institution_admin' })
  const po = (await saveOrder(b.staff, { kind: 'purchase_order', partyId: supplier, postingDate: '2026-10-01', lines: [{ itemId: toner, qty: '10', rate: '2000' }] })) as { id: string }

  const feed = route('/approvals/feed')
  const { items } = (await feed.handler(b.admin, new Request('http://x/approvals/feed'))) as { items: Record<string, unknown>[] }
  assert.equal(items.length, 1)
  assert.deepEqual(Object.keys(items[0]!).sort(), ['amountPaise', 'document', 'href', 'party', 'since'])
  assert.equal(items[0]!.party, 'Sharma Stationers')
  assert.equal(items[0]!.amountPaise, 2_000_000)
  assert.equal(items[0]!.href, `/m/finance/order?id=${po.id}`)
  assert.match(String(items[0]!.document), /^Purchase order/)
  assert.ok(!Number.isNaN(Date.parse(String(items[0]!.since))))

  // The clerk may not approve at this amount, so nothing is waiting for the clerk.
  const clerk = (await feed.handler(b.staff, new Request('http://x/approvals/feed'))) as { items: unknown[] }
  assert.equal(clerk.items.length, 0)
  assert.equal(authorizeRoute(plugin.manifest, feed, 'student'), 'deny')
})

test('the manifest declares the feed, its screen and the records whose history may be served', () => {
  assert.deepEqual(plugin.manifest.approvals, { route: '/approvals/feed', href: '/m/finance/approvals' })
  const entities = plugin.manifest.auditEntities ?? []
  assert.ok(entities.some((e) => e.entity === 'finance_periods' && e.roles.includes('accounts_staff') && !e.roles.includes('student')))
  assert.ok(entities.every((e) => !e.roles.includes('pending')))
})

test('a declared record kind is one finance really audits: change a period and read its trail back', async () => {
  const b = await books()
  const d = new Date()
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() - 1)
  const period = await closePeriod(b.admin, { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 })
  const declared = (plugin.manifest.auditEntities ?? []).map((e) => e.entity)
  assert.ok(declared.length > 0)
  // The host serves a trail by (entity, id) from audit_log: every declared kind must have rows there.
  const rows = await withTenant(b.id, (tx) =>
    tx.select({ action: auditLog.action }).from(auditLog).where(and(eq(auditLog.entity, 'finance_periods'), eq(auditLog.entityId, period.id), eq(auditLog.moduleId, 'finance'))),
  )
  assert.ok(declared.includes('finance_periods'))
  assert.deepEqual(rows.map((r) => r.action), ['period.closed'])
  // The old master-data kinds were never written anywhere, so none may be declared.
  for (const dead of ['finance_party', 'finance_item', 'finance_bank_account', 'finance_rfq', 'finance_supplier_quotation']) {
    assert.ok(!declared.includes(dead), dead)
  }
})
