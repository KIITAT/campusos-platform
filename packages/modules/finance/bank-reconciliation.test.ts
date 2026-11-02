import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, like } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import { createBankAccount, importStatement, postEntry, reconciliation, reconciliationPage, type Actor } from './api'
import { bankAccounts } from './schema'

/**
 * The bank reconciliation's totals cover every line while its lists are pages
 * (P1-10b, REL-03): a BRS with a great many uncleared lines no longer loads them all.
 */

let n = 0
const SLUG = 'fin-brs-'

async function books() {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Reconciling College', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const id = i!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Adm' },
      { email: `acc@${tag}.test`, institutionId: id, role: 'accounts_staff', name: 'Clerk' },
    ])
    .returning({ id: users.id })
  return {
    id,
    admin: { id: people[0]!.id, email: `adm@${tag}.test`, role: 'institution_admin', institutionId: id } as Actor,
    staff: { id: people[1]!.id, email: `acc@${tag}.test`, role: 'accounts_staff', institutionId: id } as Actor,
  }
}

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

const PAYMENTS = 120
const CLEARED = 20
/** Each payment moves a different amount, so a statement line can only mean one of them. */
const amount = (i: number) => 10_000 + i * 100
/** The cleared payments are all posted on the 1st; the rest spread over three days. */
const day = (i: number) => (i < CLEARED ? 1 : 1 + (i % 3))
const date = (d: number) => `2025-05-0${d}`

test('the reconciliation\'s totals cover every line while its lists are paged (REL-03)', async () => {
  const b = await books()
  const ba = (await createBankAccount(b.admin, { bankName: 'State Bank', accountNumber: '1234567890', ifsc: 'SBIN0001234' })) as { id: string }

  // The bank account has a ledger account of its own; the postings go to it by id.
  const [bankRow] = await withTenant(b.id, (tx) => tx.select().from(bankAccounts).where(eq(bankAccounts.id, ba.id)))
  const bankLedger = bankRow!.accountId

  for (let i = 0; i < PAYMENTS; i++) {
    await postEntry(b.admin, {
      memo: `Payment ${i}`,
      sourceModule: 'manual',
      sourceRef: `pay:${i}`,
      postingDate: date(day(i)),
      lines: [
        { purpose: 'purchase_expense', debitPaise: amount(i) },
        { accountId: bankLedger, creditPaise: amount(i) },
      ],
    })
  }
  for (let r = 1; r <= 3; r++) {
    await postEntry(b.admin, {
      memo: `Receipt ${r}`,
      sourceModule: 'manual',
      sourceRef: `rec:${r}`,
      postingDate: date(r),
      lines: [
        { accountId: bankLedger, debitPaise: 20_000 * r },
        { purpose: 'fee_income', creditPaise: 20_000 * r },
      ],
    })
  }

  // 20 withdrawals, one per cleared payment, and one deposit the books do not have.
  const rows = ['Txn Date,Narration,Chq/Ref No,Withdrawal Amt,Deposit Amt,Closing Balance']
  for (let i = 0; i < CLEARED; i++) rows.push(`02/05/2025,CHQ ${i},CHQ${i},${(amount(i) / 100).toFixed(2)},,0.00`)
  rows.push('02/05/2025,CASH DEPOSIT,,,5.00,0.00')
  const csv = rows.join('\n') + '\n'
  const imp = (await importStatement(b.staff, {
    bankAccountId: ba.id,
    file: { name: 'may.csv', type: 'text/csv', size: csv.length, base64: Buffer.from(csv).toString('base64') },
  })) as { lines: number; matched: number }
  assert.equal(imp.lines, CLEARED + 1)
  assert.equal(imp.matched, CLEARED)

  const uncleared = Array.from({ length: PAYMENTS - CLEARED }, (_, k) => amount(CLEARED + k)).reduce((s, v) => s + v, 0)
  const first = await reconciliation(b.staff, { bankAccountId: ba.id, on: '2025-05-31' })
  assert.equal(first.notPresented.length, 50)
  assert.equal(first.notPresentedPage.total, PAYMENTS - CLEARED)
  assert.equal(first.notPresentedPaise, uncleared)
  assert.equal(first.notCreditedPage.total, 3)
  assert.equal(first.notCreditedPaise, 20_000 * (1 + 2 + 3))
  assert.equal(first.bankOnlyPage.total, 1)
  assert.equal(first.bankOnlyNetPaise, 500)

  const next = await reconciliation(b.staff, { bankAccountId: ba.id, on: '2025-05-31' }, {
    notPresented: reconciliationPage(new Request('https://x/?notPresented.after=' + encodeURIComponent(first.notPresentedPage.next!)), 'notPresented'),
    notCredited: reconciliationPage(new Request('https://x/'), 'notCredited'),
    bankOnly: reconciliationPage(new Request('https://x/'), 'bankOnly'),
  })
  assert.equal(next.notPresented.length, 50)
  const seen = new Set(first.notPresented.map((p) => p.id))
  assert.ok(next.notPresented.every((p) => !seen.has(p.id)), 'the second page repeats nothing')

  // Before the statement line's date the 20 cleared payments were still outstanding.
  const early = await reconciliation(b.staff, { bankAccountId: ba.id, on: '2025-05-01' })
  const postedByThe1st = Array.from({ length: PAYMENTS }, (_, i) => i).filter((i) => day(i) === 1).length
  assert.equal(early.notPresentedPage.total, postedByThe1st)
})
