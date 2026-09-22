import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { and, eq, like } from 'drizzle-orm'
import { auditLog, authDb, institutions, users, withTenant } from '@campusos/db'
import type { Role } from '@campusos/module-framework'
import {
  FinanceError,
  archiveAccount,
  createAccount,
  entryLines,
  isPosted,
  listAccounts,
  listEntries,
  postEntry,
  postWithin,
  reverseEntry,
  trialBalance,
  type Actor,
} from './api'
import { accounts, entries, lines } from './schema'

/**
 * A fresh institution per test rather than a shared one wiped between them:
 * the journal is append-only by design, so there is no supported way to empty
 * it, and a test that reached around the triggers to do so would be testing a
 * database this module never runs on.
 */

let n = 0
const SLUG = 'fin-test-'

interface Books {
  id: string
  admin: Actor
  staff: Actor
  faculty: Actor
}

async function books(): Promise<Books> {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Fin', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const id = i!.id

  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Adm' },
      { email: `acc@${tag}.test`, institutionId: id, role: 'accounts_staff', name: 'Acc' },
      { email: `fac@${tag}.test`, institutionId: id, role: 'faculty', name: 'Fac' },
    ])
    .returning({ id: users.id })

  const who = (at: number, role: Role): Actor => ({
    id: people[at]!.id,
    email: `${role}@${tag}.test`,
    role,
    institutionId: id,
  })

  return {
    id,
    admin: who(0, 'institution_admin'),
    staff: who(1, 'accounts_staff'),
    faculty: who(2, 'faculty'),
  }
}

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

/** One fee invoice: receivable up, income up. The shape fees will post. */
const invoice = (ref: string, paise: number, occurredAt?: Date) => ({
  memo: 'Tuition, term 1',
  sourceModule: 'fees',
  sourceRef: ref,
  ...(occurredAt ? { occurredAt } : {}),
  lines: [
    { purpose: 'fees_receivable', debitPaise: paise },
    { purpose: 'fee_income', creditPaise: paise },
  ],
})

const code = (e: unknown) => (e as FinanceError).code

/**
 * What Postgres said, from under drizzle's wrapper. A failed query arrives as
 * "Failed query: update ..." with the real refusal on `cause`, and the refusal
 * is the whole point of these tests.
 */
const says = (e: unknown, what: RegExp): boolean => {
  for (let x = e as { message?: string; cause?: unknown } | undefined; x; x = x.cause as never) {
    if (what.test(String(x.message))) return true
  }
  return false
}
const row = <T extends { code: string }>(tb: { rows: T[] }, c: string) =>
  tb.rows.find((r) => r.code === c)!

// --- the chart -------------------------------------------------------------

test('an institution that has never opened the screen still has a chart', async () => {
  const b = await books()
  const chart = await listAccounts(b.admin)

  assert.equal(chart.length, 11)
  assert.equal(chart.find((a) => a.code === '4000')!.purpose, 'fee_income')
  // Reading twice does not write it twice.
  assert.equal((await listAccounts(b.admin)).length, 11)
})

test('two accounts cannot share a code, or a purpose', async () => {
  const b = await books()
  await listAccounts(b.admin)

  await assert.rejects(
    () => createAccount(b.admin, { code: '4000', name: 'Something else', type: 'income' }),
    (e: unknown) => code(e) === 'account_exists',
  )
  await assert.rejects(
    () =>
      createAccount(b.admin, {
        code: '4001',
        name: 'More fee income',
        type: 'income',
        purpose: 'fee_income',
      }),
    (e: unknown) => code(e) === 'account_exists',
  )
})

// --- posting ---------------------------------------------------------------

test('a balanced entry posts, and the trial balance agrees', async () => {
  const b = await books()
  const posted = await postEntry(b.admin, invoice('invoice:1', 5_000_00))

  assert.equal(posted.totalPaise, 5_000_00)

  const tb = await trialBalance(b.admin)
  assert.equal(tb.differencePaise, 0)
  assert.equal(tb.debitPaise, 5_000_00)
  // Receivable is an asset: a debit balance reads positive.
  assert.equal(row(tb, '1100').balancePaise, 5_000_00)
  // Income is a credit account: the same convention, other side.
  assert.equal(row(tb, '4000').balancePaise, 5_000_00)
  assert.equal(row(tb, '4000').debitPaise, 0)
})

test('the two sides of an entry must agree', async () => {
  const b = await books()
  await assert.rejects(
    () =>
      postEntry(b.admin, {
        memo: 'Lopsided',
        sourceRef: 'x1',
        lines: [
          { purpose: 'cash', debitPaise: 100 },
          { purpose: 'fee_income', creditPaise: 99 },
        ],
      }),
    (e: unknown) => code(e) === 'unbalanced',
  )
  assert.equal((await listEntries(b.admin)).length, 0)
})

test('a line is a debit or a credit, never both and never neither', async () => {
  const b = await books()
  for (const bad of [
    { purpose: 'cash', debitPaise: 100, creditPaise: 100 },
    { purpose: 'cash' },
  ]) {
    await assert.rejects(() =>
      postEntry(b.admin, {
        memo: 'Nonsense',
        sourceRef: 'x2',
        lines: [bad, { purpose: 'fee_income', creditPaise: 100 }],
      }),
    )
  }
  assert.equal((await listEntries(b.admin)).length, 0)
})

test('an account is named by code or by purpose, not both and not neither', async () => {
  const b = await books()
  for (const bad of [
    { accountCode: '1000', purpose: 'cash', debitPaise: 100 },
    { debitPaise: 100 },
  ]) {
    await assert.rejects(() =>
      postEntry(b.admin, {
        memo: 'Nonsense',
        sourceRef: 'x3',
        lines: [bad, { purpose: 'fee_income', creditPaise: 100 }],
      }),
    )
  }
})

test("an institution's own account code posts like a purpose does", async () => {
  const b = await books()
  await createAccount(b.admin, { code: '1020', name: 'Petty cash', type: 'asset' })

  await postEntry(b.admin, {
    memo: 'Float for the office',
    sourceRef: 'float:1',
    lines: [
      { accountCode: '1020', debitPaise: 2_000_00 },
      { purpose: 'cash', creditPaise: 2_000_00 },
    ],
  })

  const tb = await trialBalance(b.admin)
  assert.equal(row(tb, '1020').balancePaise, 2_000_00)
  assert.equal(row(tb, '1000').balancePaise, -2_000_00)
})

test('an account nobody has is a refusal, not an invented account', async () => {
  const b = await books()
  await assert.rejects(
    () =>
      postEntry(b.admin, {
        memo: 'Into thin air',
        sourceRef: 'x4',
        lines: [
          { accountCode: '9999', debitPaise: 100 },
          { purpose: 'cash', creditPaise: 100 },
        ],
      }),
    (e: unknown) => code(e) === 'no_such_account',
  )
})

test('the same source reference posts once, however many times it is sent', async () => {
  const b = await books()
  const first = await postEntry(b.admin, invoice('invoice:7', 1_000_00))

  await assert.rejects(
    () => postEntry(b.admin, invoice('invoice:7', 1_000_00)),
    (e: unknown) => code(e) === 'already_posted',
  )

  assert.equal((await listEntries(b.admin)).length, 1)
  const seen = await withTenant(b.id, (tx) => isPosted(tx, 'fees', 'invoice:7'))
  assert.equal(seen, first.id)
})

// --- what the database guarantees on its own --------------------------------

test('an unbalanced entry written around this module is refused at commit', async () => {
  const b = await books()
  const chart = await listAccounts(b.admin)
  const cash = chart.find((a) => a.purpose === 'cash')!.id

  await assert.rejects(
    () =>
      withTenant(b.id, async (tx) => {
        const [e] = await tx
          .insert(entries)
          .values({
            institutionId: b.id,
            memo: 'One-legged',
            sourceModule: 'manual',
            sourceRef: 'raw:1',
          })
          .returning({ id: entries.id })
        await tx.insert(lines).values({
          institutionId: b.id,
          entryId: e!.id,
          accountId: cash,
          debitPaise: 500,
        })
      }),
    (e: unknown) => says(e, /out of balance/),
  )

  assert.equal((await listEntries(b.admin)).length, 0)
})

test('an entry with no lines at all is refused at commit', async () => {
  const b = await books()
  await assert.rejects(
    () =>
      withTenant(b.id, (tx) =>
        tx.insert(entries).values({
          institutionId: b.id,
          memo: 'Nothing happened',
          sourceModule: 'manual',
          sourceRef: 'raw:2',
        }),
      ),
    (e: unknown) => says(e, /has no lines/),
  )
})

test('a posted entry cannot be edited or deleted, by anybody', async () => {
  const b = await books()
  const posted = await postEntry(b.admin, invoice('invoice:9', 3_000_00))

  await assert.rejects(
    () =>
      withTenant(b.id, (tx) =>
        tx.update(entries).set({ memo: 'Different story' }).where(eq(entries.id, posted.id)),
      ),
    (e: unknown) => says(e, /cannot be changed or deleted/),
  )
  await assert.rejects(
    () => withTenant(b.id, (tx) => tx.delete(entries).where(eq(entries.id, posted.id))),
    (e: unknown) => says(e, /cannot be changed or deleted/),
  )
  await assert.rejects(
    () => withTenant(b.id, (tx) => tx.delete(lines).where(eq(lines.entryId, posted.id))),
    (e: unknown) => says(e, /cannot be changed or deleted/),
  )

  assert.equal((await listEntries(b.admin))[0]!.memo, 'Tuition, term 1')
})

// --- reversal --------------------------------------------------------------

test('a reversal is the mirror image, and leaves the books flat', async () => {
  const b = await books()
  const posted = await postEntry(b.admin, invoice('invoice:11', 7_500_00))

  const mirror = await reverseEntry(b.admin, {
    entryId: posted.id,
    reason: 'the student never enrolled',
  })

  const original = await entryLines(b.admin, posted.id)
  const reversed = await entryLines(b.admin, mirror.id)
  assert.equal(original.find((l) => l.code === '1100')!.debitPaise, 7_500_00)
  assert.equal(reversed.find((l) => l.code === '1100')!.creditPaise, 7_500_00)
  assert.equal(reversed.find((l) => l.code === '4000')!.debitPaise, 7_500_00)

  const tb = await trialBalance(b.admin)
  assert.equal(tb.differencePaise, 0)
  assert.equal(row(tb, '1100').balancePaise, 0)
  assert.equal(row(tb, '4000').balancePaise, 0)
  // Flat, not gone: both entries are still there to read.
  assert.equal((await listEntries(b.admin)).length, 2)
})

test('an entry is reversed once, and a reversal is not itself reversed', async () => {
  const b = await books()
  const posted = await postEntry(b.admin, invoice('invoice:12', 100_00))
  const mirror = await reverseEntry(b.admin, { entryId: posted.id, reason: 'keyed twice' })

  await assert.rejects(
    () => reverseEntry(b.admin, { entryId: posted.id, reason: 'keyed twice again' }),
    (e: unknown) => code(e) === 'already_reversed',
  )
  await assert.rejects(
    () => reverseEntry(b.admin, { entryId: mirror.id, reason: 'undo the undo' }),
    (e: unknown) => code(e) === 'already_a_reversal',
  )
})

test('a reversal says who did it and why', async () => {
  const b = await books()
  const posted = await postEntry(b.admin, invoice('invoice:13', 250_00))
  await reverseEntry(b.admin, { entryId: posted.id, reason: 'posted against the wrong student' })

  const [trail] = await withTenant(b.id, (tx) =>
    tx
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.moduleId, 'finance'), eq(auditLog.action, 'journal.reverse'))),
  )
  assert.equal(trail!.entityId, posted.id)
  assert.equal(trail!.actorId, b.admin.id)
  assert.match(trail!.reason, /wrong student/)
})

// --- archiving -------------------------------------------------------------

test('a closed account takes no new postings but keeps its history', async () => {
  const b = await books()
  const posted = await postEntry(b.admin, invoice('invoice:15', 600_00))
  const chart = await listAccounts(b.admin)
  const receivable = chart.find((a) => a.purpose === 'fees_receivable')!

  await archiveAccount(b.admin, { accountId: receivable.id, archived: true })

  await assert.rejects(
    () => postEntry(b.admin, invoice('invoice:16', 600_00)),
    (e: unknown) => code(e) === 'account_archived',
  )
  // The history is exactly as readable as it was.
  assert.equal((await entryLines(b.admin, posted.id)).length, 2)
  assert.equal(row(await trialBalance(b.admin), '1100').balancePaise, 600_00)

  await archiveAccount(b.admin, { accountId: receivable.id, archived: false })
  await postEntry(b.admin, invoice('invoice:16', 600_00))
  assert.equal(row(await trialBalance(b.admin), '1100').balancePaise, 1_200_00)
})

// --- who may do what -------------------------------------------------------

test('the accounts office reads the books and does not post to them', async () => {
  const b = await books()
  await postEntry(b.admin, invoice('invoice:17', 900_00))

  assert.equal((await listEntries(b.staff)).length, 1)
  assert.equal((await trialBalance(b.staff)).debitPaise, 900_00)

  await assert.rejects(
    () => postEntry(b.staff, invoice('invoice:18', 900_00)),
    (e: unknown) => (e as FinanceError).status === 403,
  )
  await assert.rejects(
    () => createAccount(b.staff, { code: '1030', name: 'Another', type: 'asset' }),
    (e: unknown) => (e as FinanceError).status === 403,
  )
})

test('a lecturer is out of the books entirely', async () => {
  const b = await books()
  for (const call of [
    () => trialBalance(b.faculty),
    () => listAccounts(b.faculty),
    () => listEntries(b.faculty),
  ]) {
    await assert.rejects(call, (e: unknown) => (e as FinanceError).status === 403)
  }
})

// --- tenants ---------------------------------------------------------------

test("one institution's books are invisible to another", async () => {
  const one = await books()
  const two = await books()

  await postEntry(one.admin, invoice('invoice:21', 4_000_00))
  await postEntry(two.admin, invoice('invoice:21', 11_00))

  assert.equal(Number((await listEntries(one.admin))[0]!.totalPaise), 4_000_00)
  assert.equal(Number((await listEntries(two.admin))[0]!.totalPaise), 11_00)
  assert.equal((await trialBalance(two.admin)).debitPaise, 11_00)

  // And the same at the table, not only through the module's own filters.
  const rows = await withTenant(two.id, (tx) => tx.select().from(entries))
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.institutionId, two.id)
  const chart = await withTenant(two.id, (tx) => tx.select().from(accounts))
  assert.ok(chart.every((a) => a.institutionId === two.id))
})

// --- posting from another module -------------------------------------------

test('a module posting inside its own transaction gets one atomic act', async () => {
  const b = await books()

  await withTenant(b.id, (tx) =>
    postWithin(tx, b.id, b.admin.id, invoice('payment:1', 2_500_00)),
  )
  assert.equal((await listEntries(b.admin)).length, 1)

  // Whatever the caller was doing fails after the posting: the books must not
  // have heard about it either.
  await assert.rejects(() =>
    withTenant(b.id, async (tx) => {
      await postWithin(tx, b.id, b.admin.id, invoice('payment:2', 100_00))
      throw new Error('the caller fell over')
    }),
  )
  assert.equal((await listEntries(b.admin)).length, 1)
})

// --- reporting -------------------------------------------------------------

test('a trial balance can be taken for one period', async () => {
  const b = await books()
  await postEntry(b.admin, invoice('invoice:31', 1_000_00, new Date('2026-04-10T10:00:00Z')))
  await postEntry(b.admin, invoice('invoice:32', 3_000_00, new Date('2026-05-10T10:00:00Z')))

  const april = await trialBalance(b.admin, {
    from: '2026-04-01T00:00:00Z',
    to: '2026-04-30T23:59:59Z',
  })
  assert.equal(april.debitPaise, 1_000_00)
  assert.equal(april.differencePaise, 0)

  const both = await trialBalance(b.admin, {})
  assert.equal(both.debitPaise, 4_000_00)
})
