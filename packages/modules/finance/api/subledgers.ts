import { inArray, sql } from 'drizzle-orm'
import { withTenant } from '@campusos/db'
import { accounts } from '../schema'
import { assetRowsWithin } from './assets'
import { FinanceError, requireRead, type Actor, type Tx } from './core'
import { stockAccountOf } from './stock'
import { localToday } from './years'

/**
 * Control accounts and the sub-ledgers beside them (P1-04, ACC-02).
 *
 * A receivable, payable or stock account is a control account: its balance is
 * the total of a sub-ledger (the party ledger, the stock ledger), so a person
 * posting to it directly makes the two disagree and nothing says so. The doors a
 * person can open refuse such a line; the report shows where the books and a
 * sub-ledger differ anyway.
 */

export const CONTROL_SUBTYPES = ['receivable', 'payable', 'stock'] as const

/**
 * Refuse a line on a control account at a door a person can open (a raw
 * posting, a journal voucher, a bank line). Modules and documents post through
 * `postWithin`, which does not call this on purpose. `stockOnly` is for the
 * journal voucher, which may carry a receivable or payable line that names its
 * party.
 */
export async function refuseControlAccounts(tx: Tx, accountIds: string[], allow: { stockOnly?: boolean } = {}): Promise<void> {
  if (accountIds.length === 0) return
  const rows = await tx
    .select({ id: accounts.id, name: accounts.name, subtype: accounts.subtype, purpose: accounts.purpose })
    .from(accounts)
    .where(inArray(accounts.id, [...new Set(accountIds)]))
  const refused = allow.stockOnly ? ['stock'] : (CONTROL_SUBTYPES as readonly string[])
  for (const a of rows) {
    // Fee receivable has its own sub-ledger (the fee ledger, P1-03) and fees posts it directly.
    if (!a.subtype || !refused.includes(a.subtype) || a.purpose === 'fees_receivable') continue
    throw new FinanceError(
      400,
      'control_account',
      a.subtype === 'stock'
        ? `${a.name} is a stock account: stock moves through a stock entry`
        : `${a.name} is a control account: post to it through an invoice, a payment, a stock entry or a journal voucher that names the party`,
    )
  }
}

export interface SubledgerRow {
  ledger: 'receivable' | 'payable' | 'stock' | 'assets'
  accountId: string | null
  code: string
  name: string
  subledgerPaise: number
  booksPaise: number
  differencePaise: number
}

const row = (r: Omit<SubledgerRow, 'differencePaise'>): SubledgerRow => ({ ...r, differencePaise: r.booksPaise - r.subledgerPaise })

/** Every sub-ledger against its control account(s), as of a day. Fee receivables are left to P1-03 (D5). */
export async function subledgerRows(tx: Tx, tenant: string, on: string): Promise<SubledgerRow[]> {
  const out: SubledgerRow[] = []

  const gl = await tx.execute<{ account_id: string; dr: string }>(sql`
    select l.account_id, sum(l.debit_paise - l.credit_paise)::bigint as dr
      from finance_journal_lines l join finance_journal_entries e on e.id = l.entry_id
     where e.posting_date <= ${on} group by l.account_id`)
  const debit = new Map(gl.rows.map((r) => [r.account_id, Number(r.dr)]))

  // receivable and payable: the party ledger against the books, per control account
  const control = await tx.execute<{ id: string; code: string; name: string; subtype: 'receivable' | 'payable'; subledger: string }>(sql`
    with sub as (
      select p.account_id, sum(p.amount_paise)::bigint as amt
        from finance_party_ledger p where p.posting_date <= ${on} group by p.account_id
    )
    select a.id, a.code, a.name, a.subtype, coalesce(s.amt, 0)::bigint as subledger
      from finance_accounts a
      left join sub s on s.account_id = a.id
     where a.subtype in ('receivable', 'payable') and a.is_group = false
       and a.purpose is distinct from 'fees_receivable'
     order by a.code`)
  for (const a of control.rows) {
    const dr = debit.get(a.id) ?? 0
    const subledgerPaise = Number(a.subledger)
    const booksPaise = a.subtype === 'receivable' ? dr : -dr
    if (dr === 0 && subledgerPaise === 0) continue
    out.push(row({ ledger: a.subtype, accountId: a.id, code: a.code, name: a.name, subledgerPaise, booksPaise }))
  }

  // stock: the stock ledger's value, mapped to the account each store keeps it in
  const moves = await tx.execute<{ warehouse_id: string; item_id: string; v: string }>(sql`
    select l.warehouse_id, l.item_id, sum(l.value_change_paise)::bigint as v
      from finance_stock_ledger l where l.posting_date <= ${on} group by 1, 2`)
  const byAccount = new Map<string, number>()
  for (const m of moves.rows) {
    const id = await stockAccountOf(tx, tenant, m.warehouse_id, m.item_id)
    byAccount.set(id, (byAccount.get(id) ?? 0) + Number(m.v))
  }
  const stockAccounts = await tx.execute<{ id: string; code: string; name: string }>(sql`
    select id, code, name from finance_accounts where subtype = 'stock' and is_group = false order by code`)
  for (const a of stockAccounts.rows) {
    const subledgerPaise = byAccount.get(a.id) ?? 0
    const booksPaise = debit.get(a.id) ?? 0
    if (subledgerPaise === 0 && booksPaise === 0) continue
    out.push(row({ ledger: 'stock', accountId: a.id, code: a.code, name: a.name, subledgerPaise, booksPaise }))
  }

  // fixed assets: the register's net book value against cost less accumulated depreciation in the books
  const register = await assetRowsWithin(tx, on)
  const subledgerPaise = register.filter((a) => a.docstatus === 'submitted').reduce((n, a) => n + a.netPaise, 0)
  const categoryAccounts = await tx.execute<{ id: string }>(sql`
    select asset_account_id as id from finance_asset_categories
    union select accumulated_account_id from finance_asset_categories`)
  const booksPaise = categoryAccounts.rows.reduce((n, a) => n + (debit.get(a.id) ?? 0), 0)
  if (subledgerPaise !== 0 || booksPaise !== 0) {
    out.push(row({ ledger: 'assets', accountId: null, code: '', name: 'Fixed assets (net)', subledgerPaise, booksPaise }))
  }
  return out
}

export async function subledgerReport(actor: Actor, input: { on?: string } = {}) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) => {
    const on = input.on || (await localToday(tx, tenant))
    return { on, rows: await subledgerRows(tx, tenant, on) }
  })
}
