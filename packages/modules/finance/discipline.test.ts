import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { like, sql } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import type { Role } from '@campusos/module-framework'
import {
  FinanceError,
  accountFor,
  createAssetCategory,
  createItem,
  createParty,
  createStockEntry,
  loadIndiaPreset,
  postDepreciation,
  postEntry,
  postWithin,
  refusal,
  saveAsset,
  saveInvoice,
  saveJournal,
  savePayment,
  submitInvoice,
  subledgerReport,
  type Actor,
} from './api'
import { gstFilings } from './schema'

/**
 * Close discipline (P1-04): control accounts, sub-ledgers against the books, the
 * close checklist, Rule 46 numbering, filed GST returns, TDS under a lock,
 * encumbrance and the report fixes.
 */

let n = 0
const SLUG = 'fin-disc-'

interface Books {
  id: string
  admin: Actor
  admin2: Actor
  clerk: Actor
}

async function books(): Promise<Books> {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Discipline College', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const id = i!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Adm' },
      { email: `adm2@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Adm Two' },
      { email: `acc@${tag}.test`, institutionId: id, role: 'accounts_staff', name: 'Acc' },
    ])
    .returning({ id: users.id })
  const who = (at: number, role: Role): Actor => ({ id: people[at]!.id, email: `${at}@${tag}.test`, role, institutionId: id })
  const b = { id, admin: who(0, 'institution_admin'), admin2: who(1, 'institution_admin'), clerk: who(2, 'accounts_staff') }
  await loadIndiaPreset(b.admin)
  return b
}

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

const customer = (b: Books) =>
  createParty(b.clerk, { code: `C${++n}`, name: `Customer ${n}`, isCustomer: true, stateCode: '21' }).then((r) => r.id)

/** The refusal a database rule raises, named the way a caller sees it. */
async function dbRefuses(p: Promise<unknown>, constraint: string) {
  await assert.rejects(p, (e: unknown) => {
    const r = refusal(e)
    assert.ok(r instanceof FinanceError && r.code === constraint, `expected ${constraint}, got ${String(r)}`)
    return true
  })
}

test('gst filings are isolated by institution', async () => {
  const a = await books()
  const other = await books()
  await withTenant(a.id, (tx) =>
    tx.insert(gstFilings).values({ institutionId: a.id, returnType: 'gstr1', periodFrom: '2026-04-01', periodTo: '2026-04-30', filedOn: '2026-05-11' }),
  )
  assert.equal((await withTenant(other.id, (tx) => tx.select().from(gstFilings))).length, 0)
  assert.equal((await withTenant(a.id, (tx) => tx.select().from(gstFilings))).length, 1)
})

test('a receivable line without a party is refused by the database', async () => {
  const b = await books()
  const entry = (purpose: 'accounts_receivable' | 'fees_receivable', ref: string) =>
    withTenant(b.id, (tx) =>
      postWithin(tx, b.id, b.admin.id, {
        memo: 'x',
        sourceModule: 'test',
        sourceRef: ref,
        lines: [
          { purpose, debitPaise: 100, creditPaise: 0 },
          { purpose: 'sales_income', debitPaise: 0, creditPaise: 100 },
        ],
      }),
    )
  await dbRefuses(entry('accounts_receivable', 'r1'), 'finance_control_line_needs_party')
  await entry('fees_receivable', 'r2')
})

test('a sales invoice inside a filed GSTR-1 cannot be cancelled in the database', async () => {
  const b = await books()
  const c = await customer(b)
  const inv = (await saveInvoice(b.clerk, {
    kind: 'sales',
    partyId: c,
    postingDate: '2026-04-10',
    lines: [{ description: 'Hire', qty: '1', rate: '100' }],
    submit: true,
  })) as { id: string }
  await withTenant(b.id, (tx) =>
    tx.insert(gstFilings).values({ institutionId: b.id, returnType: 'gstr1', periodFrom: '2026-04-01', periodTo: '2026-04-30', filedOn: '2026-05-11' }),
  )
  await dbRefuses(
    withTenant(b.id, (tx) =>
      tx.execute(sql`update finance_invoices set docstatus = 'cancelled', cancelled_at = now(), cancel_reason = 'test' where id = ${inv.id}`),
    ),
    'finance_invoice_in_filed_return',
  )
})

const supplier = (b: Books) =>
  createParty(b.clerk, { code: `S${++n}`, name: `Supplier ${n}`, isSupplier: true, stateCode: '21' }).then((r) => r.id)

async function refused(p: Promise<unknown>, code: string, status?: number) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof FinanceError, `expected a FinanceError, got ${String(e)}`)
    assert.equal(e.code, code)
    if (status) assert.equal(e.status, status)
    return true
  })
}

// --- Step 2: control accounts and the sub-ledger report (ACC-02) -------------------

test('raw postings to control accounts are refused (ACC-02)', async () => {
  const b = await books()
  const c = await customer(b)
  await refused(
    postEntry(b.admin, {
      memo: 'x',
      sourceModule: 'test',
      sourceRef: 'raw-1',
      lines: [
        { purpose: 'accounts_receivable', debitPaise: 100, creditPaise: 0, partyId: c },
        { purpose: 'sales_income', debitPaise: 0, creditPaise: 100 },
      ],
    }),
    'control_account',
    400,
  )
  await refused(
    postEntry(b.admin, {
      memo: 'x',
      sourceModule: 'test',
      sourceRef: 'raw-2',
      lines: [
        { purpose: 'stock_in_hand', debitPaise: 100, creditPaise: 0 },
        { purpose: 'sales_income', debitPaise: 0, creditPaise: 100 },
      ],
    }),
    'control_account',
    400,
  )
})

test('a journal voucher cannot touch a stock account', async () => {
  const b = await books()
  const [stock, cash] = await withTenant(b.id, async (tx) => [await accountFor(tx, b.id, 'stock_in_hand'), await accountFor(tx, b.id, 'cash')])
  await refused(
    saveJournal(b.admin, { kind: 'journal', memo: 'Stock by hand', postingDate: '2026-10-01', lines: [{ accountId: stock, debit: '1' }, { accountId: cash, credit: '1' }], submit: false }),
    'control_account',
    400,
  )
})

test('the sub-ledgers agree after ordinary business', async () => {
  const b = await books()
  const DAY = '2026-10-01'
  const c = await customer(b)
  const s = await supplier(b)
  const bank = await withTenant(b.id, (tx) => accountFor(tx, b.id, 'bank'))
  const service = await createItem(b.clerk, { code: 'SVC', name: 'Service', nature: 'service' })
  await saveInvoice(b.clerk, { kind: 'sales', partyId: c, postingDate: DAY, lines: [{ itemId: service.id, qty: '1', rate: '1000' }], submit: true })
  await savePayment(b.clerk, { kind: 'receive', partyId: c, postingDate: DAY, accountId: bank, amount: '500', submit: true })
  const bill = (await saveInvoice(b.clerk, { kind: 'purchase', partyId: s, postingDate: DAY, billNo: 'B-1', lines: [{ description: 'Paper', qty: '1', rate: '700' }] })) as { id: string }
  await submitInvoice(b.admin, { invoiceId: bill.id })
  const chalk = await createItem(b.clerk, { code: 'CHALK', name: 'Chalk' })
  await createStockEntry(b.clerk, { kind: 'receipt', postingDate: DAY, submit: true, lines: [{ itemId: chalk.id, qty: '10', rate: '20' }] })
  const cat = (await createAssetCategory(b.admin, { name: 'Computers', method: 'slm', lifeYears: '3', residualPercent: '0', frequency: 'month' })) as { id: string }
  await saveAsset(b.clerk, { name: 'Laptop', categoryId: cat.id, purchasedOn: '2025-04-01', gross: '36000', existing: true, openingAccumulated: '12000', depreciateFrom: '2026-04-01', submit: true })
  await postDepreciation(b.clerk, { upTo: '2026-06-30' })

  const { rows } = await subledgerReport(b.admin, { on: '2026-10-31' })
  assert.deepEqual(rows.map((r) => r.ledger).sort(), ['assets', 'payable', 'receivable', 'stock'])
  for (const r of rows) assert.equal(r.differencePaise, 0, `${r.ledger} ${r.name} differs by ${r.differencePaise}`)
})

test('a manual entry on a receivable account shows as a difference', async () => {
  const b = await books()
  const c = await customer(b)
  await withTenant(b.id, (tx) =>
    postWithin(tx, b.id, b.admin.id, {
      memo: 'a module posted without the party ledger',
      sourceModule: 'test',
      sourceRef: 'diff-1',
      postingDate: '2026-10-01',
      lines: [
        { purpose: 'accounts_receivable', debitPaise: 500, creditPaise: 0, partyId: c },
        { purpose: 'sales_income', debitPaise: 0, creditPaise: 500 },
      ],
    }),
  )
  const { rows } = await subledgerReport(b.admin, { on: '2026-10-31' })
  const r = rows.find((x) => x.ledger === 'receivable')!
  assert.equal(r.differencePaise, 500)
})
