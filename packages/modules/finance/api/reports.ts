import { and, asc, eq, sql } from 'drizzle-orm'
import { withTenant } from '@campusos/db'
import { accounts, costCenters, funds } from '../schema'
import { normalSide, cashFlowOf } from './chart'
import { FinanceError, requireRead, type Actor, type Tx } from './core'
import { daysBetween } from './numbers'
import { treeOrder } from './operations'
import { fiscalBounds, localToday, settingsWithin } from './years'

/**
 * The books, read: the statements an auditor signs and the reports an
 * accounts office lives in.
 *
 * Everything here is a sum of journal lines by posting date -- no report
 * keeps figures of its own, so no two reports can disagree. Income and
 * expenditure leave out the entries that close a year, which only move the
 * year's result into retained surplus; the balance sheet keeps them, and so
 * shows the surplus where it now lives.
 */

type Kind = 'asset' | 'liability' | 'equity' | 'income' | 'expense'

/** Entries that close a year (and their reversals, if the year was reopened). */
const NOT_CLOSING = sql`e.source_ref not like 'year-close:%'
  and not exists (select 1 from finance_journal_entries c where c.id = e.reversal_of and c.source_ref like 'year-close:%')`

interface Filters {
  fundId?: string | null
  costCenter?: string | null
}

const filterSql = (f: Filters) =>
  sql`${f.fundId ? sql`and l.fund_id = ${f.fundId}::uuid` : sql``} ${f.costCenter ? sql`and l.cost_center = ${f.costCenter}` : sql``}`

/** Per account: debits and credits before `from`, between `from` and `to`, signed by kind. */
async function movements(tx: Tx, from: string | null, to: string, f: Filters & { closing?: boolean } = {}) {
  const res = await tx.execute(sql`
    select l.account_id,
           coalesce(sum(l.debit_paise) filter (where ${from}::date is not null and e.posting_date < ${from}::date), 0)::bigint as od,
           coalesce(sum(l.credit_paise) filter (where ${from}::date is not null and e.posting_date < ${from}::date), 0)::bigint as oc,
           coalesce(sum(l.debit_paise) filter (where ${from}::date is null or e.posting_date >= ${from}::date), 0)::bigint as pd,
           coalesce(sum(l.credit_paise) filter (where ${from}::date is null or e.posting_date >= ${from}::date), 0)::bigint as pc
      from finance_journal_lines l
      join finance_journal_entries e on e.id = l.entry_id
     where e.posting_date <= ${to}::date
       ${f.closing === false ? sql`and ${NOT_CLOSING}` : sql``}
       ${filterSql(f)}
     group by l.account_id`)
  return new Map(
    (res.rows as { account_id: string; od: number; oc: number; pd: number; pc: number }[]).map((r) => [
      r.account_id,
      { od: Number(r.od), oc: Number(r.oc), pd: Number(r.pd), pc: Number(r.pc) },
    ]),
  )
}

async function chart(tx: Tx) {
  return treeOrder(await tx.select().from(accounts))
}

export interface StatementRow {
  id: string
  code: string
  name: string
  type: Kind
  isGroup: boolean
  depth: number
  parentId: string | null
  openingPaise: number
  debitPaise: number
  creditPaise: number
  closingPaise: number
}

/**
 * Rows for every account and group, with groups carrying the sums of what is
 * under them. Balances are on the account's normal side: an asset's debit
 * balance is positive, a liability's credit balance is.
 */
function rollUp(
  rows: ReturnType<typeof treeOrder<typeof accounts.$inferSelect>>,
  m: Map<string, { od: number; oc: number; pd: number; pc: number }>,
): StatementRow[] {
  const out = new Map<string, StatementRow>()
  for (const a of rows) {
    const x = m.get(a.id) ?? { od: 0, oc: 0, pd: 0, pc: 0 }
    const sign = normalSide(a.type) === 'debit' ? 1 : -1
    out.set(a.id, {
      id: a.id,
      code: a.code,
      name: a.name,
      type: a.type as Kind,
      isGroup: a.isGroup,
      depth: a.depth,
      parentId: a.parentId,
      openingPaise: sign * (x.od - x.oc),
      debitPaise: x.pd,
      creditPaise: x.pc,
      closingPaise: sign * (x.od - x.oc + x.pd - x.pc),
    })
  }
  // Children before parents: walk the tree order backwards.
  for (const a of [...rows].reverse()) {
    if (!a.parentId) continue
    const child = out.get(a.id)!
    const parent = out.get(a.parentId)
    if (!parent) continue
    const same = normalSide(parent.type) === normalSide(child.type) ? 1 : -1
    parent.openingPaise += same * child.openingPaise
    parent.debitPaise += child.debitPaise
    parent.creditPaise += child.creditPaise
    parent.closingPaise += same * child.closingPaise
  }
  return rows.map((a) => out.get(a.id)!)
}

const nonZero = (r: StatementRow) => r.openingPaise !== 0 || r.debitPaise !== 0 || r.creditPaise !== 0 || r.closingPaise !== 0

async function fyOf(tx: Tx, institutionId: string, on: string) {
  const s = await settingsWithin(tx, institutionId)
  return fiscalBounds(s.fiscalYearStartMonth, on)
}

// --- trial balance -----------------------------------------------------------------

/** The trial balance for a period: opening, the period's debits and credits, and closing, account by account and group by group. */
export async function trialBalanceReport(actor: Actor, input: { from?: string; to?: string; fundId?: string; costCenter?: string } = {}) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) => {
    const to = input.to ?? (await localToday(tx, tenant))
    const from = input.from ?? (await fyOf(tx, tenant, to)).startsOn
    const rows = rollUp(await chart(tx), await movements(tx, from, to, input)).filter(nonZero)
    const leaves = rows.filter((r) => !r.isGroup)
    // A balance on its normal side counts in that column; one gone the other
    // way (an overdrawn bank, a supplier paid ahead) in the other.
    const onDebit = (r: StatementRow, k: 'openingPaise' | 'closingPaise') =>
      normalSide(r.type) === 'debit' ? r[k] : -r[k]
    const dr = (r: StatementRow, k: 'openingPaise' | 'closingPaise') => Math.max(onDebit(r, k), 0)
    const cr = (r: StatementRow, k: 'openingPaise' | 'closingPaise') => Math.max(-onDebit(r, k), 0)
    return {
      from,
      to,
      rows,
      totals: {
        openingDebitPaise: leaves.reduce((n, r) => n + dr(r, 'openingPaise'), 0),
        openingCreditPaise: leaves.reduce((n, r) => n + cr(r, 'openingPaise'), 0),
        debitPaise: leaves.reduce((n, r) => n + r.debitPaise, 0),
        creditPaise: leaves.reduce((n, r) => n + r.creditPaise, 0),
        closingDebitPaise: leaves.reduce((n, r) => n + dr(r, 'closingPaise'), 0),
        closingCreditPaise: leaves.reduce((n, r) => n + cr(r, 'closingPaise'), 0),
      },
    }
  })
}

// --- income and expenditure ------------------------------------------------------------

/**
 * Income and expenditure (profit and loss) for a period, with the same period
 * a year before beside it when asked.
 */
export async function incomeAndExpenditure(
  actor: Actor,
  input: { from?: string; to?: string; fundId?: string; costCenter?: string; compare?: boolean } = {},
) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) => {
    const to = input.to ?? (await localToday(tx, tenant))
    const from = input.from ?? (await fyOf(tx, tenant, to)).startsOn
    const tree = await chart(tx)
    const read = async (f: string, t: string) =>
      rollUp(tree, await movements(tx, f, t, { ...input, closing: false })).filter((r) => r.type === 'income' || r.type === 'expense')
    const now = await read(from, to)
    // A period's figure is its movement: closing less opening.
    const period = (r: StatementRow) => r.closingPaise - r.openingPaise
    let before: Map<string, number> | null = null
    if (input.compare) {
      const shift = (d: string) => `${Number(d.slice(0, 4)) - 1}${d.slice(4)}`
      before = new Map((await read(shift(from), shift(to))).map((r) => [r.id, period(r)]))
    }
    const rows = now
      .map((r) => ({ ...r, amountPaise: period(r), previousPaise: before?.get(r.id) ?? null }))
      .filter((r) => r.amountPaise !== 0 || (r.previousPaise ?? 0) !== 0)
    const top = (type: Kind) => now.filter((r) => r.type === type && !r.parentId).reduce((n, r) => n + period(r), 0)
    const income = top('income')
    const expense = top('expense')
    return {
      from,
      to,
      income: rows.filter((r) => r.type === 'income'),
      expense: rows.filter((r) => r.type === 'expense'),
      incomePaise: income,
      expensePaise: expense,
      surplusPaise: income - expense,
    }
  })
}

// --- balance sheet ---------------------------------------------------------------------

/**
 * The balance sheet on a day: what is owned, what is owed, and the funds --
 * with the surplus or deficit of years not yet closed shown among the funds,
 * where it belongs, so the two sides agree.
 */
export async function balanceSheet(actor: Actor, input: { on?: string; fundId?: string } = {}) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) => {
    const on = input.on ?? (await localToday(tx, tenant))
    const rows = rollUp(await chart(tx), await movements(tx, null, on, { fundId: input.fundId })).filter(nonZero)
    const sumTop = (type: Kind) => rows.filter((r) => r.type === type && !r.parentId).reduce((n, r) => n + r.closingPaise, 0)
    const unclosed = sumTop('income') - sumTop('expense')
    const assetsPaise = sumTop('asset')
    const liabilitiesPaise = sumTop('liability')
    const fundsPaise = sumTop('equity') + unclosed
    return {
      on,
      assets: rows.filter((r) => r.type === 'asset'),
      liabilities: rows.filter((r) => r.type === 'liability'),
      funds: rows.filter((r) => r.type === 'equity'),
      unclosedSurplusPaise: unclosed,
      assetsPaise,
      liabilitiesPaise,
      fundsPaise,
      differencePaise: assetsPaise - liabilitiesPaise - fundsPaise,
    }
  })
}

// --- cash: receipts and payments, and the cash flow --------------------------------------

/**
 * Money through the cash and bank accounts in a period, by what was on the
 * other side of each entry: the receipts and payments account a society or
 * trust files, and -- grouped as operating, investing and financing -- a
 * direct-method cash flow statement. Transfers between cash and bank cancel
 * out and are left out.
 */
export async function cashMovements(actor: Actor, input: { from?: string; to?: string; fundId?: string } = {}) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) => {
    const to = input.to ?? (await localToday(tx, tenant))
    const from = input.from ?? (await fyOf(tx, tenant, to)).startsOn
    const res = await tx.execute(sql`
      with cash as (
        select id from finance_accounts where subtype in ('cash', 'bank') or purpose in ('cash', 'bank')
      ),
      moved as (
        select l.entry_id, sum(l.debit_paise - l.credit_paise) as net
          from finance_journal_lines l join finance_journal_entries e on e.id = l.entry_id
         where l.account_id in (select id from cash) and e.posting_date between ${from}::date and ${to}::date
           ${input.fundId ? sql`and l.fund_id = ${input.fundId}::uuid` : sql``}
         group by l.entry_id having sum(l.debit_paise - l.credit_paise) <> 0
      ),
      other as (
        select l.entry_id, l.account_id, sum(l.credit_paise - l.debit_paise) as amount
          from finance_journal_lines l
         where l.entry_id in (select entry_id from moved) and l.account_id not in (select id from cash)
         group by l.entry_id, l.account_id
      ),
      shares as (
        -- An entry that moved cash against several accounts is shared between
        -- them by their size, so each receipt and payment lands on its own head.
        select o.account_id,
               round(m.net * o.amount / nullif(sum(o.amount) over (partition by o.entry_id), 0))::bigint as cash
          from other o join moved m on m.entry_id = o.entry_id
      )
      select a.id, a.code, a.name, a.type, a.subtype, a.cash_flow,
             coalesce(sum(s.cash) filter (where s.cash > 0), 0)::bigint as received,
             coalesce(-sum(s.cash) filter (where s.cash < 0), 0)::bigint as paid
        from shares s join finance_accounts a on a.id = s.account_id
       group by a.id order by a.code`)
    const heads = (res.rows as { id: string; code: string; name: string; type: string; subtype: string | null; cash_flow: string | null; received: number; paid: number }[]).map((r) => ({
      accountId: r.id,
      code: r.code,
      name: r.name,
      activity: cashFlowOf(r.subtype, r.type, r.cash_flow),
      receivedPaise: Number(r.received),
      paidPaise: Number(r.paid),
    }))
    const bal = await tx.execute(sql`
      select coalesce(sum(l.debit_paise - l.credit_paise) filter (where e.posting_date < ${from}::date), 0)::bigint as opening,
             coalesce(sum(l.debit_paise - l.credit_paise), 0)::bigint as closing
        from finance_journal_lines l join finance_journal_entries e on e.id = l.entry_id
        join finance_accounts a on a.id = l.account_id
       where (a.subtype in ('cash', 'bank') or a.purpose in ('cash', 'bank')) and e.posting_date <= ${to}::date
         ${input.fundId ? sql`and l.fund_id = ${input.fundId}::uuid` : sql``}`)
    const b = bal.rows[0] as { opening: number; closing: number }
    const by = (activity: string) => {
      const hs = heads.filter((h) => h.activity === activity)
      return { heads: hs, netPaise: hs.reduce((n, h) => n + h.receivedPaise - h.paidPaise, 0) }
    }
    return {
      from,
      to,
      openingPaise: Number(b.opening),
      closingPaise: Number(b.closing),
      receipts: heads.filter((h) => h.receivedPaise > 0),
      payments: heads.filter((h) => h.paidPaise > 0),
      operating: by('operating'),
      investing: by('investing'),
      financing: by('financing'),
    }
  })
}

// --- ledgers and the day book --------------------------------------------------------

/** An account's ledger for a period: its opening, every line with the running balance, its closing. */
export async function generalLedger(actor: Actor, input: { accountId: string; from?: string; to?: string; partyId?: string; costCenter?: string }) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) => {
    const [account] = await tx.select().from(accounts).where(eq(accounts.id, input.accountId))
    if (!account) throw new FinanceError(404, 'no_such_account', 'no such account')
    const to = input.to ?? (await localToday(tx, tenant))
    const from = input.from ?? (await fyOf(tx, tenant, to)).startsOn
    const sign = normalSide(account.type) === 'debit' ? 1 : -1
    // A group's ledger is its accounts' together.
    let ids = [account.id]
    if (account.isGroup) {
      const parents = await chartParents(tx)
      ids = (await chart(tx)).filter((a) => isUnder(a, account.id, parents)).map((a) => a.id)
      if (ids.length === 0) ids = [account.id]
    }
    const idList = sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)
    const extra = sql`${input.partyId ? sql`and l.party_id = ${input.partyId}::uuid` : sql``} ${input.costCenter ? sql`and l.cost_center = ${input.costCenter}` : sql``}`
    const [open] = (
      await tx.execute(sql`
        select coalesce(sum(l.debit_paise - l.credit_paise), 0)::bigint as v
          from finance_journal_lines l join finance_journal_entries e on e.id = l.entry_id
         where l.account_id in (${idList}) and e.posting_date < ${from}::date ${extra}`)
    ).rows as { v: number }[]
    const res = await tx.execute(sql`
      select l.id, e.id as entry_id, e.posting_date::text as posting_date, e.memo, e.source_module, e.source_ref,
             l.debit_paise, l.credit_paise, l.cost_center, l.memo as line_memo, p.name as party, a.code, a.name as account
        from finance_journal_lines l
        join finance_journal_entries e on e.id = l.entry_id
        join finance_accounts a on a.id = l.account_id
        left join finance_parties p on p.id = l.party_id
       where l.account_id in (${idList}) and e.posting_date between ${from}::date and ${to}::date ${extra}
       order by e.posting_date, e.occurred_at, l.id
       limit 5000`)
    let balance = sign * Number(open?.v ?? 0)
    const openingPaise = balance
    const lines = (res.rows as Record<string, unknown>[]).map((r) => {
      balance += sign * (Number(r.debit_paise) - Number(r.credit_paise))
      return {
        id: String(r.id),
        entryId: String(r.entry_id),
        postingDate: String(r.posting_date),
        memo: String(r.memo),
        lineMemo: (r.line_memo as string | null) ?? null,
        sourceModule: String(r.source_module),
        sourceRef: String(r.source_ref),
        party: (r.party as string | null) ?? null,
        costCenter: (r.cost_center as string | null) ?? null,
        account: `${r.code} ${r.account}`,
        debitPaise: Number(r.debit_paise),
        creditPaise: Number(r.credit_paise),
        balancePaise: balance,
      }
    })
    return { account, from, to, openingPaise, lines, closingPaise: balance }
  })
}

async function chartParents(tx: Tx) {
  return new Map((await tx.select({ id: accounts.id, parentId: accounts.parentId }).from(accounts)).map((a) => [a.id, a.parentId]))
}
function isUnder(a: { id: string; isGroup: boolean }, groupId: string, parents: Map<string, string | null>) {
  if (a.isGroup) return false
  let p = parents.get(a.id) ?? null
  for (let i = 0; p && i < 20; i++) {
    if (p === groupId) return true
    p = parents.get(p) ?? null
  }
  return false
}

/** Every entry in a period, in order, with its lines: the day book. */
export async function dayBook(actor: Actor, input: { from?: string; to?: string; sourceModule?: string } = {}) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) => {
    const to = input.to ?? (await localToday(tx, tenant))
    const from = input.from ?? to
    const res = await tx.execute(sql`
      select e.id, e.posting_date::text as posting_date, e.memo, e.source_module, e.source_ref, e.reversal_of,
             l.debit_paise, l.credit_paise, a.code, a.name, p.name as party, l.cost_center
        from finance_journal_entries e
        join finance_journal_lines l on l.entry_id = e.id
        join finance_accounts a on a.id = l.account_id
        left join finance_parties p on p.id = l.party_id
       where e.posting_date between ${from}::date and ${to}::date
         ${input.sourceModule ? sql`and e.source_module = ${input.sourceModule}` : sql``}
       order by e.posting_date, e.occurred_at, e.id, l.debit_paise desc
       limit 10000`)
    const byEntry = new Map<string, { id: string; postingDate: string; memo: string; sourceModule: string; sourceRef: string; reversal: boolean; lines: { account: string; party: string | null; costCenter: string | null; debitPaise: number; creditPaise: number }[] }>()
    for (const r of res.rows as Record<string, unknown>[]) {
      const id = String(r.id)
      const e = byEntry.get(id) ?? {
        id,
        postingDate: String(r.posting_date),
        memo: String(r.memo),
        sourceModule: String(r.source_module),
        sourceRef: String(r.source_ref),
        reversal: !!r.reversal_of,
        lines: [],
      }
      e.lines.push({
        account: `${r.code} ${r.name}`,
        party: (r.party as string | null) ?? null,
        costCenter: (r.cost_center as string | null) ?? null,
        debitPaise: Number(r.debit_paise),
        creditPaise: Number(r.credit_paise),
      })
      byEntry.set(id, e)
    }
    return { from, to, entries: [...byEntry.values()] }
  })
}

// --- what is owed -------------------------------------------------------------------

export const AGING_BUCKETS = [30, 60, 90, 180] as const

/**
 * Receivables or payables by how long they have been due, party by party:
 * each open invoice in the bucket its days past due put it in (from its due
 * date, or its date if it has none), and money received or paid ahead as a
 * credit beside them.
 */
export async function aging(actor: Actor, input: { side: 'receivable' | 'payable'; on?: string; partyId?: string }) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) => {
    const on = input.on ?? (await localToday(tx, tenant))
    const res = await tx.execute(sql`
      select p.party_id, pa.name, p.against_id, i.number, i.posting_date::text as posting_date,
             coalesce(i.due_date, i.posting_date)::text as due,
             sum(p.amount_paise)::bigint as open
        from finance_party_ledger p
        join finance_parties pa on pa.id = p.party_id
        left join finance_invoices i on i.id = p.against_id
       where p.side = ${input.side} and p.posting_date <= ${on}::date
         ${input.partyId ? sql`and p.party_id = ${input.partyId}::uuid` : sql``}
       group by p.party_id, pa.name, p.against_id, i.number, i.posting_date, i.due_date
      having sum(p.amount_paise) <> 0
       order by pa.name, i.posting_date`)
    const parties = new Map<
      string,
      { partyId: string; name: string; buckets: number[]; advancePaise: number; totalPaise: number; invoices: { id: string; number: string; postingDate: string; dueDate: string; days: number; openPaise: number }[] }
    >()
    for (const r of res.rows as { party_id: string; name: string; against_id: string | null; number: string | null; posting_date: string | null; due: string | null; open: number }[]) {
      const p = parties.get(r.party_id) ?? {
        partyId: r.party_id,
        name: r.name,
        buckets: [0, 0, 0, 0, 0, 0],
        advancePaise: 0,
        totalPaise: 0,
        invoices: [],
      }
      const open = Number(r.open)
      p.totalPaise += open
      if (!r.against_id) p.advancePaise += open
      else {
        const days = daysBetween(r.due!, on)
        // Not yet due, then 1-30, 31-60, 61-90, 91-180, over 180 days past due.
        const at = days <= 0 ? 0 : 1 + AGING_BUCKETS.filter((b) => days > b).length
        p.buckets[at]! += open
        p.invoices.push({ id: r.against_id, number: r.number ?? '', postingDate: r.posting_date ?? '', dueDate: r.due ?? '', days, openPaise: open })
      }
      parties.set(r.party_id, p)
    }
    const rows = [...parties.values()].filter((p) => p.totalPaise !== 0 || p.invoices.length)
    const totals = [0, 1, 2, 3, 4, 5].map((i) => rows.reduce((n, p) => n + p.buckets[i]!, 0))
    return {
      on,
      side: input.side,
      bucketLabels: ['Not yet due', '1–30 days', '31–60 days', '61–90 days', '91–180 days', 'Over 180 days'],
      rows,
      totals,
      advancePaise: rows.reduce((n, p) => n + p.advancePaise, 0),
      totalPaise: rows.reduce((n, p) => n + p.totalPaise, 0),
    }
  })
}

// --- funds and grants ----------------------------------------------------------------

/**
 * A fund's account for a period: what it brought in, what was spent from it
 * by head, and what is left -- the figures a utilisation certificate asks
 * for, for a grant.
 */
export async function fundStatement(actor: Actor, input: { fundId: string; from?: string; to?: string }) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) => {
    const [fund] = await tx.select().from(funds).where(eq(funds.id, input.fundId))
    if (!fund) throw new FinanceError(404, 'no_such_fund', 'no such fund')
    const to = input.to ?? (await localToday(tx, tenant))
    const from = input.from ?? fund.startsOn ?? (await fyOf(tx, tenant, to)).startsOn
    const res = await tx.execute(sql`
      select a.id, a.code, a.name, a.type,
             coalesce(sum(l.credit_paise - l.debit_paise) filter (where e.posting_date < ${from}::date), 0)::bigint as before,
             coalesce(sum(l.credit_paise - l.debit_paise) filter (where e.posting_date >= ${from}::date), 0)::bigint as during
        from finance_journal_lines l
        join finance_journal_entries e on e.id = l.entry_id
        join finance_accounts a on a.id = l.account_id
       where l.fund_id = ${input.fundId}::uuid and e.posting_date <= ${to}::date
         and a.type in ('income', 'expense', 'equity')
         and ${NOT_CLOSING}
       group by a.id order by a.code`)
    const rows = (res.rows as { id: string; code: string; name: string; type: Kind; before: number; during: number }[]).map((r) => ({
      accountId: r.id,
      code: r.code,
      name: r.name,
      type: r.type,
      beforePaise: Number(r.before),
      duringPaise: Number(r.during),
    }))
    const openingPaise = rows.reduce((n, r) => n + r.beforePaise, 0)
    const received = rows.filter((r) => r.type !== 'expense' && r.duringPaise !== 0).map((r) => ({ ...r, amountPaise: r.duringPaise }))
    const spent = rows.filter((r) => r.type === 'expense' && r.duringPaise !== 0).map((r) => ({ ...r, amountPaise: -r.duringPaise }))
    // Fixed assets bought from the fund are spent from it too, though not expensed.
    const capital = await tx.execute(sql`
      select coalesce(sum(l.debit_paise - l.credit_paise), 0)::bigint as v
        from finance_journal_lines l join finance_journal_entries e on e.id = l.entry_id
        join finance_accounts a on a.id = l.account_id
       where l.fund_id = ${input.fundId}::uuid and a.subtype in ('fixed_asset', 'capital_wip')
         and e.posting_date between ${from}::date and ${to}::date`)
    const capitalPaise = Number((capital.rows[0] as { v: number }).v)
    const receivedPaise = received.reduce((n, r) => n + r.amountPaise, 0)
    const spentPaise = spent.reduce((n, r) => n + r.amountPaise, 0) + capitalPaise
    return {
      fund,
      from,
      to,
      openingPaise,
      received,
      receivedPaise,
      spent,
      capitalPaise,
      spentPaise,
      closingPaise: openingPaise + receivedPaise - spentPaise,
      sanctionedPaise: fund.sanctionedPaise,
      utilisedPercent: fund.sanctionedPaise ? Math.round((spentPaise * 10_000) / fund.sanctionedPaise) / 100 : null,
    }
  })
}

/** Every fund's balance on a day. */
export async function fundBalances(actor: Actor, input: { on?: string } = {}) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) => {
    const on = input.on ?? (await localToday(tx, tenant))
    const res = await tx.execute(sql`
      select f.id, f.code, f.name, f.kind, f.sanctioned_paise,
             coalesce(sum(l.credit_paise - l.debit_paise) filter (where a.type in ('income', 'equity')), 0)::bigint as received,
             coalesce(sum(l.debit_paise - l.credit_paise) filter (where a.type = 'expense' or a.subtype in ('fixed_asset', 'capital_wip')), 0)::bigint as spent
        from finance_funds f
        left join finance_journal_lines l on l.fund_id = f.id
        left join finance_journal_entries e on e.id = l.entry_id and e.posting_date <= ${on}::date
        left join finance_accounts a on a.id = l.account_id and e.id is not null
       group by f.id order by f.code`)
    return (res.rows as { id: string; code: string; name: string; kind: string; sanctioned_paise: number | null; received: number; spent: number }[]).map((r) => ({
      fundId: r.id,
      code: r.code,
      name: r.name,
      kind: r.kind,
      sanctionedPaise: r.sanctioned_paise === null ? null : Number(r.sanctioned_paise),
      receivedPaise: Number(r.received),
      spentPaise: Number(r.spent),
      balancePaise: Number(r.received) - Number(r.spent),
    }))
  })
}

// --- cost centres --------------------------------------------------------------------

/** Income and expenditure by cost centre for a period: what each department brought in and spent. */
export async function costCenterReport(actor: Actor, input: { from?: string; to?: string } = {}) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) => {
    const to = input.to ?? (await localToday(tx, tenant))
    const from = input.from ?? (await fyOf(tx, tenant, to)).startsOn
    const res = await tx.execute(sql`
      select coalesce(l.cost_center, '(none)') as cost_center,
             coalesce(sum(l.credit_paise - l.debit_paise) filter (where a.type = 'income'), 0)::bigint as income,
             coalesce(sum(l.debit_paise - l.credit_paise) filter (where a.type = 'expense'), 0)::bigint as expense
        from finance_journal_lines l
        join finance_journal_entries e on e.id = l.entry_id
        join finance_accounts a on a.id = l.account_id
       where e.posting_date between ${from}::date and ${to}::date and a.type in ('income', 'expense') and ${NOT_CLOSING}
       group by 1 order by 1`)
    const names = new Map((await tx.select({ code: costCenters.code, name: costCenters.name }).from(costCenters)).map((c) => [c.code, c.name]))
    return {
      from,
      to,
      rows: (res.rows as { cost_center: string; income: number; expense: number }[]).map((r) => ({
        costCenter: r.cost_center,
        name: names.get(r.cost_center) ?? r.cost_center,
        incomePaise: Number(r.income),
        expensePaise: Number(r.expense),
        netPaise: Number(r.income) - Number(r.expense),
      })),
    }
  })
}

/** Accounts by kind, for a report's account filter. */
export async function accountChoices(tx: Tx, kinds?: Kind[]) {
  const rows = await tx
    .select({ id: accounts.id, code: accounts.code, name: accounts.name, type: accounts.type, isGroup: accounts.isGroup })
    .from(accounts)
    .where(and(kinds ? sql`${accounts.type} in ${sql`(${sql.join(kinds.map((k) => sql`${k}`), sql`, `)})`}` : undefined, sql`${accounts.archivedAt} is null`))
    .orderBy(asc(accounts.code))
  return rows.map((r) => ({ value: r.id, label: `${r.code} ${r.name}${r.isGroup ? ' (group)' : ''}` }))
}


// --- the workspace ------------------------------------------------------------------

/**
 * What the accounts office opens the books to: money in hand, what is owed
 * each way, the year's result so far, month by month, and the work waiting.
 */
export async function dashboard(actor: Actor) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) => {
    const on = await localToday(tx, tenant)
    const fy = await fyOf(tx, tenant, on)
    const res = await tx.execute(sql`
      select
        coalesce(sum(l.debit_paise - l.credit_paise) filter (where a.subtype in ('cash', 'bank') or a.purpose in ('cash', 'bank')), 0)::bigint as cash,
        coalesce(sum(l.credit_paise - l.debit_paise) filter (where a.type = 'income' and e.posting_date >= ${fy.startsOn}::date and ${NOT_CLOSING}), 0)::bigint as income,
        coalesce(sum(l.debit_paise - l.credit_paise) filter (where a.type = 'expense' and e.posting_date >= ${fy.startsOn}::date and ${NOT_CLOSING}), 0)::bigint as expense
        from finance_journal_lines l
        join finance_journal_entries e on e.id = l.entry_id
        join finance_accounts a on a.id = l.account_id
       where e.posting_date <= ${on}::date`)
    const owed = await tx.execute(sql`
      select coalesce(sum(amount_paise) filter (where side = 'receivable'), 0)::bigint as receivable,
             coalesce(sum(amount_paise) filter (where side = 'payable'), 0)::bigint as payable
        from finance_party_ledger`)
    const counts = await tx.execute(sql`
      select
        (select count(*) from finance_invoices where docstatus = 'draft')::int as draft_invoices,
        (select count(*) from finance_invoices i where i.kind = 'sales' and i.docstatus = 'submitted' and not i.is_return
            and i.due_date < ${on}::date
            and (select coalesce(sum(p.amount_fc), 0) from finance_party_ledger p where p.against_id = i.id) > 0)::int as overdue_sales,
        (select count(*) from finance_invoices i where i.kind = 'purchase' and i.docstatus = 'submitted' and not i.is_return
            and coalesce(i.due_date, i.posting_date) <= ${on}::date
            and (select coalesce(sum(p.amount_fc), 0) from finance_party_ledger p where p.against_id = i.id) > 0)::int as bills_due,
        (select count(*) from finance_bank_statement_lines where status = 'unmatched')::int as unmatched,
        (select count(*) from finance_material_requests where docstatus = 'submitted')::int as requests,
        (select count(*) from finance_depreciation_schedule d join finance_assets a on a.id = d.asset_id
            where d.entry_id is null and d.period_end <= ${on}::date and a.docstatus = 'submitted')::int as depreciation_due,
        (select count(*) from (select i.id from finance_items i left join finance_stock_bins b on b.item_id = i.id
            where i.reorder_level_milli is not null and i.archived_at is null
            group by i.id having coalesce(sum(b.qty_milli), 0) <= max(i.reorder_level_milli)) x)::int as reorder,
        (select count(*) from finance_recurring where stopped_at is null and next_on <= ${on}::date)::int as recurring_due`)
    const months = await tx.execute(sql`
      select to_char(date_trunc('month', e.posting_date), 'YYYY-MM') as month,
             coalesce(sum(l.credit_paise - l.debit_paise) filter (where a.type = 'income'), 0)::bigint as income,
             coalesce(sum(l.debit_paise - l.credit_paise) filter (where a.type = 'expense'), 0)::bigint as expense
        from finance_journal_lines l
        join finance_journal_entries e on e.id = l.entry_id
        join finance_accounts a on a.id = l.account_id
       where e.posting_date between ${fy.startsOn}::date and ${on}::date and a.type in ('income', 'expense') and ${NOT_CLOSING}
       group by 1 order by 1`)
    const r = res.rows[0] as { cash: number; income: number; expense: number }
    const o = owed.rows[0] as { receivable: number; payable: number }
    return {
      on,
      fiscalYear: fy.label,
      cashPaise: Number(r.cash),
      incomePaise: Number(r.income),
      expensePaise: Number(r.expense),
      surplusPaise: Number(r.income) - Number(r.expense),
      receivablePaise: Number(o.receivable),
      payablePaise: Number(o.payable),
      counts: counts.rows[0] as Record<string, number>,
      months: (months.rows as { month: string; income: number; expense: number }[]).map((m) => ({
        month: m.month,
        incomePaise: Number(m.income),
        expensePaise: Number(m.expense),
      })),
    }
  })
}
