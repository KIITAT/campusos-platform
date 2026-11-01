import { sql } from 'drizzle-orm'
import type { Tx } from './core'

/**
 * Open purchase orders' commitments by (cost centre, account), in base currency
 * (P1-04, ACC-12). Computed, not stored: an open order commits what is still
 * unbilled, at the order's rate, to the cost centre of the line and the expense
 * account the line would bill to. Only lines whose item is neither a stock item
 * nor an asset count, because those bill to stock or asset accounts, which carry
 * no budgets. The arithmetic is the same as `commitments()` in buying.ts.
 *
 * `fy` is every open submitted order dated in a fiscal year; `orderId` is one
 * order, draft or not (the one being submitted).
 *
 * ponytail: base amount by the order's rate per line, and a two-decimal currency is assumed, as commitments() does.
 */
export async function committedWithin(
  tx: Tx,
  scope: { fy: { startsOn: string; endsOn: string } } | { orderId: string },
): Promise<Map<string, number>> {
  const which =
    'orderId' in scope
      ? sql`o.id = ${scope.orderId}`
      : sql`o.kind = 'purchase_order' and o.docstatus = 'submitted'
        and not exists (select 1 from finance_order_closures c where c.order_id = o.id)
        and o.posting_date between ${scope.fy.startsOn} and ${scope.fy.endsOn}`
  const res = await tx.execute<{ cost_center: string; account_id: string; committed: string }>(sql`
    select coalesce(ol.cost_center, o.cost_center) as cost_center,
           coalesce(i.expense_account_id, g.expense_account_id, pe.id) as account_id,
           sum(round((ol.qty_milli - coalesce(b.billed, 0))::numeric * ol.amount_fc / ol.qty_milli * o.exchange_rate))::bigint as committed
      from finance_order_lines ol
      join finance_orders o on o.id = ol.order_id
      left join finance_items i on i.id = ol.item_id
      left join finance_item_groups g on g.id = i.group_id
      left join finance_accounts pe on pe.purpose = 'purchase_expense'
      left join lateral (
        select sum(case when iv.is_return then -il.qty_milli else il.qty_milli end) as billed
          from finance_invoice_lines il join finance_invoices iv on iv.id = il.invoice_id
         where il.order_line_id = ol.id and iv.docstatus = 'submitted') b on true
     where ${which}
       and o.kind = 'purchase_order'
       and ol.qty_milli > coalesce(b.billed, 0)
       and coalesce(i.is_stock, false) = false and coalesce(i.is_asset, false) = false
       and coalesce(ol.cost_center, o.cost_center) is not null
       and coalesce(i.expense_account_id, g.expense_account_id, pe.id) is not null
     group by 1, 2`)
  return new Map(res.rows.map((r) => [`${r.cost_center}|${r.account_id}`, Number(r.committed)]))
}
