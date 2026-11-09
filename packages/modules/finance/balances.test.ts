import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { like, sql } from 'drizzle-orm'
import { authDb, institutions, users } from '@campusos/db'
import { incomeAndExpenditure, postEntry, reverseEntry, trialBalanceReport, type Actor } from './api'

/**
 * The daily balances the journal keeps (P1-10b, REL-03).
 *
 * `finance_daily_balances` is written only by a trigger on the journal's lines.
 * These tests hold it to the journal: the same sums, line for line, however the
 * lines arrived.
 */

let n = 0
const SLUG = 'fin-bal-'

interface Books {
  id: string
  admin: Actor
  staff: Actor
}

async function books(): Promise<Books> {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Balances College', allowedEmailDomains: [`${tag}.test`] })
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
    admin: { id: people[0]!.id, email: `adm@${tag}.test`, role: 'institution_admin', institutionId: id },
    staff: { id: people[1]!.id, email: `acc@${tag}.test`, role: 'accounts_staff', institutionId: id },
  }
}

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

const entry = (b: Books, over: Record<string, unknown> = {}) =>
  postEntry(b.admin, {
    memo: 'An ordinary entry',
    sourceModule: 'manual',
    sourceRef: `ref:${++n}`,
    lines: [
      { purpose: 'cash', debitPaise: 10_000 },
      { purpose: 'fee_income', creditPaise: 10_000 },
    ],
    ...over,
  })

/** The slice of a pooled connection these tests use. */
interface Conn {
  query(text: string, values?: unknown[]): Promise<{ rows: { id: string }[] }>
  release(): void
}

/** Rows where the balance table and the journal disagree (as the owner, past RLS). */
async function drift(tenant: string) {
  const res = await authDb.execute(sql`
    with l as (
      select l.account_id, e.posting_date, l.fund_id, l.cost_center,
             (e.source_ref like 'year-close:%' or exists (select 1 from finance_journal_entries c where c.id = e.reversal_of and c.source_ref like 'year-close:%')) as closing,
             sum(l.debit_paise)::bigint d, sum(l.credit_paise)::bigint c
        from finance_journal_lines l join finance_journal_entries e on e.id = l.entry_id
       where l.institution_id = ${tenant} group by 1, 2, 3, 4, 5),
    b as (select account_id, posting_date, fund_id, cost_center, closing, debit_paise d, credit_paise c
            from finance_daily_balances where institution_id = ${tenant})
    select coalesce(l.account_id, b.account_id) as account_id, l.d as line_d, l.c as line_c, b.d as bal_d, b.c as bal_c
      from l full join b
        on l.account_id = b.account_id and l.posting_date = b.posting_date
       and l.fund_id is not distinct from b.fund_id and l.cost_center is not distinct from b.cost_center
       and l.closing = b.closing
     where l.d is distinct from b.d or l.c is distinct from b.c`)
  return res.rows
}

const balanceRows = async (tenant: string) =>
  (
    await authDb.execute(sql`
      select account_id, posting_date::text as posting_date, fund_id, cost_center, closing, debit_paise::text, credit_paise::text
        from finance_daily_balances where institution_id = ${tenant}
       order by account_id, posting_date, fund_id nulls first, cost_center nulls first, closing`)
  ).rows

test('the daily balances add up to the journal, line for line (REL-03)', async () => {
  const b = await books()
  const first = await entry(b, { postingDate: '2025-05-01' })
  await entry(b, { postingDate: '2025-05-01' })
  await entry(b, {
    postingDate: '2025-05-02',
    lines: [
      { purpose: 'cash', debitPaise: 7_000, costCenter: 'Hostel' },
      { purpose: 'fee_income', creditPaise: 7_000 },
    ],
  })
  await reverseEntry(b.admin, { entryId: first.id, reason: 'test reversal' })
  const close = await entry(b, { sourceRef: 'year-close:test', memo: 'Year close', postingDate: '2025-05-03' })
  await reverseEntry(b.admin, { entryId: close.id, reason: 'test reversal' })

  assert.deepEqual(await drift(b.id), [])
  const closing = await authDb.execute(sql`select count(*)::int n from finance_daily_balances where institution_id = ${b.id} and closing`)
  assert.ok((closing.rows[0] as { n: number }).n >= 1, 'a year-close entry is kept apart')
})

test('two postings to the same account on the same day both count (REL-03)', async () => {
  const b = await books()
  await entry(b, { postingDate: '2025-05-01' }) // makes the chart
  const acct = async (purpose: string) =>
    ((await authDb.execute(sql`select id from finance_accounts where institution_id = ${b.id} and purpose = ${purpose}`)).rows[0] as { id: string }).id
  const cash = await acct('cash')
  const income = await acct('fee_income')

  const open: Conn[] = []
  const post = async (ref: string, creditFirst: boolean) => {
    const c: Conn = await authDb.$client.connect()
    open.push(c)
    await c.query('begin')
    await c.query("select set_config('app.institution_id', $1, true)", [b.id])
    await c.query('set local role campusos_app')
    const { rows } = await c.query(
      `insert into finance_journal_entries (institution_id, memo, source_module, source_ref, posting_date)
       values ($1, 'Race', 'manual', $2, '2025-06-01') returning id`,
      [b.id, ref],
    )
    const lines: [string, number, number][] = [
      [cash, 100, 0],
      [income, 0, 100],
    ]
    if (creditFirst) lines.reverse()
    for (const [account, d, cr] of lines) {
      await c.query(
        'insert into finance_journal_lines (institution_id, entry_id, account_id, debit_paise, credit_paise) values ($1, $2, $3, $4, $5)',
        [b.id, rows[0]!.id, account, d, cr],
      )
    }
    return c
  }

  try {
  const a = await post('race:a', false)
  let bDone = false
  const second = post('race:b', true).then((c) => {
    bDone = true
    return c
  })
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(bDone, false, 'the second posting waits for the first on the shared balance row')
  await a.query('commit')
  a.release()
  const c2 = await second
  await c2.query('commit')
  c2.release()
  open.length = 0
  } finally {
    // A failed assertion must not leave a transaction holding locks that the clean-up would wait on.
    for (const c of open) {
      await c.query('rollback').catch(() => {})
      c.release()
    }
  }

  assert.deepEqual(await drift(b.id), [])
  const cashRow = await authDb.execute(
    sql`select debit_paise::text d from finance_daily_balances where institution_id = ${b.id} and account_id = ${cash} and posting_date = '2025-06-01'`,
  )
  assert.equal((cashRow.rows[0] as { d: string }).d, '200')
})

test('the rebuild gives back the same rows (REL-03)', async () => {
  const b = await books()
  await entry(b, { postingDate: '2025-05-01' })
  await entry(b, { postingDate: '2025-05-02' })
  const before = await balanceRows(b.id)
  assert.ok(before.length > 0)
  const rebuilt = await authDb.execute(sql`select finance_rebuild_daily_balances(${b.id}::uuid) as n`)
  assert.equal(Number((rebuilt.rows[0] as { n: string }).n), before.length)
  assert.deepEqual(await balanceRows(b.id), before)
})

test('0017 backfills every tenant in one statement, past the auth pool\'s 30 s limit, to the rebuild\'s rows (NEW-80)', async () => {
  const b = await books()
  await entry(b, { postingDate: '2025-05-01' })
  await entry(b, { postingDate: '2025-05-02' })
  const file = readFileSync(new URL('./migrations/0017_daily_balances.sql', import.meta.url), 'utf8')
  const backfill = file.split('--> statement-breakpoint').at(-1)!
  assert.doesNotMatch(backfill, /finance_rebuild_daily_balances\(/, 'one scan of the journal, not one per tenant')
  assert.match(file, /SET LOCAL statement_timeout = 0/)
  // Read-only: the backfill's SELECT for this tenant against the rows the trigger kept.
  const select = backfill.slice(backfill.indexOf('SELECT')).replace(/;\s*$/, '')
  const cols = 'institution_id, account_id, posting_date, fund_id, cost_center, closing, debit_paise, credit_paise'
  const order = 'order by 1, 2, 3, 4 nulls first, 5 nulls first, 6'
  const kept = await authDb.execute(sql.raw(`select ${cols} from finance_daily_balances where institution_id = '${b.id}' ${order}`))
  const filled = await authDb.execute(sql.raw(`select * from (${select}) s(${cols}) where institution_id = '${b.id}' ${order}`))
  assert.ok(kept.rows.length > 0)
  assert.deepEqual(filled.rows, kept.rows)
})

test('the trial balance is the journal\'s (REL-03)', async () => {
  const b = await books()
  const first = await entry(b, { postingDate: '2025-05-01' })
  await entry(b, { postingDate: '2025-05-02', lines: [{ purpose: 'cash', debitPaise: 7_000, costCenter: 'Hostel' }, { purpose: 'fee_income', creditPaise: 7_000 }] })
  await reverseEntry(b.admin, { entryId: first.id, reason: 'test reversal' })
  const close = await entry(b, { sourceRef: 'year-close:test', memo: 'Year close', postingDate: '2025-05-03' })
  void close

  // The pre-change SQL: sums of lines joined to entries.
  const oracle = async (from: string, to: string, notClosing: boolean) =>
    (
      await authDb.execute(sql`
        select l.account_id as id, a.type::text as type,
               coalesce(sum(l.debit_paise) filter (where e.posting_date >= ${from}::date), 0)::bigint::text as pd,
               coalesce(sum(l.credit_paise) filter (where e.posting_date >= ${from}::date), 0)::bigint::text as pc
          from finance_journal_lines l
          join finance_journal_entries e on e.id = l.entry_id
          join finance_accounts a on a.id = l.account_id
         where l.institution_id = ${b.id} and e.posting_date <= ${to}::date
           ${notClosing ? sql`and e.source_ref not like 'year-close:%' and not exists (select 1 from finance_journal_entries c where c.id = e.reversal_of and c.source_ref like 'year-close:%')` : sql``}
         group by l.account_id, a.type`)
    ).rows as { id: string; type: string; pd: string; pc: string }[]

  const tb = await trialBalanceReport(b.staff, { from: '2025-05-02', to: '2025-12-31' })
  const want = await oracle('2025-05-02', '2025-12-31', false)
  for (const o of want) {
    const row = tb.rows.find((r) => r.id === o.id)!
    assert.equal(row.debitPaise, Number(o.pd))
    assert.equal(row.creditPaise, Number(o.pc))
  }

  const ie = await incomeAndExpenditure(b.staff, { from: '2025-04-01', to: '2026-03-31' })
  const inc = await oracle('2025-04-01', '2026-03-31', true)
  const sumOf = (type: string, side: 'pd' | 'pc') => inc.filter((o) => o.type === type).reduce((s, o) => s + Number(o[side]), 0)
  assert.equal(ie.incomePaise, sumOf('income', 'pc') - sumOf('income', 'pd'))
  assert.equal(ie.expensePaise, sumOf('expense', 'pd') - sumOf('expense', 'pc'))
})
