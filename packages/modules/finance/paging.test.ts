import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { like, sql } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import {
  accountFor,
  createParty,
  dayBook,
  dayBookPage,
  generalLedger,
  glPage,
  invoicePage,
  journalPage,
  listInvoices,
  listJournals,
  listPayments,
  paymentPage,
  postWithin,
  saveInvoice,
  savePayment,
  setSingleOfficer,
  type Actor,
} from './api'

/**
 * Paged document lists (DATA-01): past the old 1,000-row cap, the status
 * filter in SQL, and a hundred thousand rows inside the time budget.
 */

let n = 0
const SLUG = 'fin-page-'

interface Books { id: string; admin: Actor; staff: Actor; party: string }

async function books(): Promise<Books> {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Paging', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const id = i!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Adm' },
      { email: `acc@${tag}.test`, institutionId: id, role: 'accounts_staff', name: 'Acc' },
    ])
    .returning({ id: users.id })
  const admin: Actor = { id: people[0]!.id, email: `adm@${tag}.test`, role: 'institution_admin', institutionId: id }
  const staff: Actor = { id: people[1]!.id, email: `acc@${tag}.test`, role: 'accounts_staff', institutionId: id }
  await setSingleOfficer(admin, { enabled: true, reason: 'test fixture: one officer' })
  const party = (await createParty(staff, { code: `C${n}`, name: `Customer ${n}`, isCustomer: true, stateCode: '21' })).id
  return { id, admin, staff, party }
}

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

/** A table filled a moment ago has no statistics, and the planner then plans badly; autovacuum does this in life. */
const analyse = (table: string) => authDb.execute(sql.raw(`analyze ${table}`))

/**
 * Drop an institution's invoices without the row-by-row foreign-key checks.
 * finance_invoices points at itself twice (return_against, amended_from) with
 * no index on either column, so deleting 100,000 invoices one check at a time
 * scans the table 100,000 times (minutes). The owner connection may skip the
 * checks; where it may not, the ordinary cascade in `after` still cleans up.
 */
async function dropInvoices(b: Books) {
  try {
    await authDb.transaction(async (tx) => {
      await tx.execute(sql`set local session_replication_role = replica`)
      await tx.execute(sql`delete from finance_invoices where institution_id = ${b.id}`)
    })
  } catch {
    /* not permitted here: leave it to the cascade */
  }
}

const seedInvoices = (b: Books, count: number) =>
  withTenant(b.id, (tx) =>
    tx.execute(sql`insert into finance_invoices (institution_id, kind, party_id, posting_date, currency)
      select ${b.id}, 'sales', ${b.party}, '2026-04-01'::date + (g % 30), 'INR' from generate_series(1, ${count}::int) g`),
  )

/** Follow `next` from the first page until it runs out. */
async function every<T extends { id: string }>(
  fetch: (url: string) => Promise<{ rows: T[]; total: number; next: string | null }>,
  size: number,
) {
  const ids: string[] = []
  const totals = new Set<number>()
  let after: string | null = null
  do {
    const page: { rows: T[]; total: number; next: string | null } = await fetch(`https://x/?n=${size}${after ? `&after=${after}` : ''}`)
    totals.add(page.total)
    ids.push(...page.rows.map((r) => r.id))
    after = page.next
  } while (after)
  return { ids, totals: [...totals] }
}

test('the 1001st invoice is reachable (DATA-01)', async () => {
  const b = await books()
  await seedInvoices(b, 1005)
  const { ids, totals } = await every((url) => listInvoices(b.admin, { kind: 'sales' }, invoicePage(new Request(url), '')), 500)
  assert.equal(new Set(ids).size, 1005)
  assert.deepEqual(totals, [1005])
})

test('an open-status filter pages exactly the open invoices (DATA-01, regression)', async () => {
  const b = await books()
  const save = (rate: string) =>
    saveInvoice(b.staff, { kind: 'sales', partyId: b.party, postingDate: '2026-10-01', lines: [{ description: 'Hall hire', rate }], submit: true }) as Promise<{ id: string }>
  const [one, two, three] = [await save('1000'), await save('2000'), await save('3000')]
  const bank = await withTenant(b.id, (tx) => accountFor(tx, b.id, 'bank'))
  await savePayment(b.staff, {
    kind: 'receive',
    partyId: b.party,
    postingDate: '2026-10-01',
    accountId: bank,
    amount: '1000',
    allocations: [{ invoiceId: one.id, amount: '1000' }],
    submit: true,
  })
  const open = await listInvoices(b.admin, { kind: 'sales', status: 'open' })
  assert.deepEqual(open.rows.map((r) => r.id).sort(), [two.id, three.id].sort())
  assert.equal(open.total, 2)
  const paid = await listInvoices(b.admin, { kind: 'sales', status: 'paid' })
  assert.equal(paid.total, 1)
  assert.equal(paid.rows[0]!.id, one.id)
  // search by party name, in SQL
  const found = await listInvoices(b.admin, { kind: 'sales', q: 'Customer' })
  assert.equal(found.total, 3)
  const none = await listInvoices(b.admin, { kind: 'sales', q: 'nobody-by-this-name' })
  assert.equal(none.total, 0)
})

test('a hundred thousand invoices page in under 500 ms (DATA-01)', async () => {
  const b = await books()
  try {
    await seedInvoices(b, 100_000)
    await analyse('finance_invoices')
    const first = invoicePage(new Request('https://x/?n=20'), '')
    const warm = await listInvoices(b.admin, { kind: 'sales' }, first)
    assert.ok(warm.next)
    const t0 = performance.now()
    const p1 = await listInvoices(b.admin, { kind: 'sales' }, first)
    const t1 = performance.now()
    const p2 = await listInvoices(b.admin, { kind: 'sales' }, invoicePage(new Request(`https://x/?n=20&after=${p1.next}`), ''))
    const t2 = performance.now()
    console.log(`invoices 100k: first page ${(t1 - t0).toFixed(0)} ms, next page ${(t2 - t1).toFixed(0)} ms`)
    assert.equal(p2.rows.length, 20)
    assert.ok(t1 - t0 < 500, 'first page')
    assert.ok(t2 - t1 < 500, 'next page')
  } finally {
    await dropInvoices(b)
  }
})

test('payments and journal vouchers page past 1000 (DATA-01)', async () => {
  const b = await books()
  const bank = await withTenant(b.id, (tx) => accountFor(tx, b.id, 'bank'))
  await withTenant(b.id, async (tx) => {
    await tx.execute(sql`insert into finance_journals (institution_id, posting_date, memo)
      select ${b.id}, '2026-04-01'::date + (g % 30), 'Voucher ' || g from generate_series(1, 1005) g`)
    await tx.execute(sql`insert into finance_payments (institution_id, kind, party_id, side, posting_date, account_id, currency, amount_fc, amount_paise)
      select ${b.id}, 'receive', ${b.party}, 'receivable', '2026-04-01'::date + (g % 30), ${bank}, 'INR', 100, 100 from generate_series(1, 1005) g`)
  })
  const vouchers = await every((url) => listJournals(b.admin, {}, journalPage(new Request(url), '')), 500)
  assert.equal(new Set(vouchers.ids).size, 1005)
  assert.deepEqual(vouchers.totals, [1005])
  const receipts = await every((url) => listPayments(b.admin, {}, paymentPage(new Request(url), '')), 500)
  assert.equal(new Set(receipts.ids).size, 1005)
  assert.deepEqual(receipts.totals, [1005])
})


// --- general ledger and day book (DATA-01) -----------------------------------

async function postedBooks(count: number) {
  const b = await books()
  const receivable = await withTenant(b.id, async (tx) => {
    for (let i = 0; i < count; i += 100) {
      for (let j = i; j < Math.min(i + 100, count); j++) {
        await postWithin(tx, b.id, b.admin.id, {
          memo: `Fee ${j}`,
          sourceModule: 'fees',
          sourceRef: `ref:${j}`,
          postingDate: '2026-10-01',
          lines: [
            { purpose: 'fees_receivable', debitPaise: 100 },
            { purpose: 'fee_income', creditPaise: 100 },
          ],
        })
      }
    }
    return accountFor(tx, b.id, 'fees_receivable')
  })
  return { b, receivable }
}

test('the general ledger closes correctly past 5000 lines (DATA-01)', async () => {
  const { b, receivable } = await postedBooks(5100)
  const gl = await generalLedger(b.admin, { accountId: receivable, from: '2026-10-01', to: '2026-10-01' })
  assert.equal(gl.lines.length, 5100)
  assert.equal(gl.closingPaise, gl.openingPaise + 510_000)
  assert.equal(gl.total, 5100)

  // pages carry the running balance across the cut
  let after: string | null = null
  let previous: number | null = null
  let last: number | undefined
  let seen = 0
  do {
    const page = glPage(new Request(`https://x/?n=1000${after ? `&after=${after}` : ''}`), '')
    const p = await generalLedger(b.admin, { accountId: receivable, from: '2026-10-01', to: '2026-10-01' }, page)
    assert.equal(p.total, 5100)
    assert.equal(p.closingPaise, gl.closingPaise)
    assert.equal(p.openingPaise, gl.openingPaise)
    if (previous !== null) assert.equal(p.lines[0]!.balancePaise, previous + 100, 'the balance runs on across the cut')
    previous = p.lines[p.lines.length - 1]!.balancePaise
    last = previous
    seen += p.lines.length
    after = p.next
  } while (after)
  assert.equal(seen, 5100)
  assert.equal(last, gl.closingPaise)
})

test('the day book pages by entry (DATA-01)', async () => {
  const { b } = await postedBooks(120)
  const seen = new Set<string>()
  let after: string | null = null
  let pages = 0
  do {
    const page = dayBookPage(new Request(`https://x/?n=50${after ? `&after=${after}` : ''}`), '')
    const book = await dayBook(b.admin, { from: '2026-10-01', to: '2026-10-01' }, page)
    assert.equal(book.total, 120)
    assert.ok(book.entries.length <= 50)
    for (const e of book.entries) {
      assert.ok(!seen.has(e.id), 'no entry on two pages')
      assert.equal(e.lines.length, 2, 'an entry keeps both its lines')
      seen.add(e.id)
    }
    pages++
    after = book.next
  } while (after)
  assert.equal(seen.size, 120)
  assert.equal(pages, 3)
})
