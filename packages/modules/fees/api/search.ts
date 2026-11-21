import { sql } from 'drizzle-orm'
import { withTenant } from '@campusos/db'
import type { LookupResult } from '@campusos/module-framework'
import { findStudentChoicesWithin, lookupQuery, lookupTimeout, type LookupQuery } from '@campusos/module-academic/api'
import { requireFinance, type Actor } from './operations'

/**
 * Record lookups for the accounts office (UX-04, P1-09c, decisions 1000 to
 * 1004): a receipt by its number, old or fiscal-year, and a student for the
 * charge and demand-letter forms. Hits carry no amount, bank reference or
 * student, and the print route keeps its own check.
 */

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]

const DETAIL = { live: 'Recorded', voided: 'Void', bounced: 'Cheque returned unpaid' } as const

type ReceiptRow = { id: string; receipt_no: string; status: keyof typeof DETAIL }

/** Receipts of one tenant matching the query, exact number first. */
export async function findReceiptsWithin(tx: Tx, tenant: string, { q, like }: LookupQuery): Promise<ReceiptRow[]> {
  // Equality on the stored lower-cased number is an index condition under row-level security;
  // lower() and LIKE are not leakproof (NEW-175), so the contains-test filters one tenant's rows only.
  const branches = [sql`select id, 0 as rank from fee_payments where institution_id = ${tenant} and receipt_no_key = lower(${q})`]
  if (like) branches.push(sql`select id, 1 as rank from fee_payments where institution_id = ${tenant} and receipt_no_key like lower(${like}) escape '!'`)
  const { rows } = await tx.execute<ReceiptRow>(sql`
    with cand as (${sql.join(branches, sql` union all `)})
    select p.id, p.receipt_no, p.status
      from (select id, min(rank) as rank from cand group by id) c
      join fee_payments p on p.id = c.id and p.institution_id = ${tenant}
     order by c.rank, p.receipt_no_key, p.id
     limit 12`)
  return rows
}

export async function searchFeeReceipts(actor: Actor, req: Request): Promise<LookupResult> {
  const tenant = requireFinance(actor)
  const query = lookupQuery(req)
  const rows = await withTenant(tenant, async (tx) => {
    await lookupTimeout(tx)
    return findReceiptsWithin(tx, tenant, query)
  })
  return {
    hits: rows.map((r) => ({
      id: r.id,
      title: r.receipt_no,
      detail: DETAIL[r.status] ?? 'Recorded',
      href: `/api/v1/modules/fees/receipt.pdf?paymentId=${encodeURIComponent(r.id)}`,
    })),
  }
}

/** The student picker for the charge and demand-letter forms: a search, not the whole roll. */
export async function searchFeeStudents(actor: Actor, req: Request): Promise<LookupResult> {
  const tenant = requireFinance(actor)
  const query = lookupQuery(req)
  return {
    hits: await withTenant(tenant, async (tx) => {
      await lookupTimeout(tx)
      return findStudentChoicesWithin(tx, tenant, query, true)
    }),
  }
}
