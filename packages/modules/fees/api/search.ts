import { sql } from 'drizzle-orm'
import { withTenant } from '@campusos/db'
import type { LookupResult } from '@campusos/module-framework'
import { findStudentChoicesWithin, lookupQuery, lookupTimeout } from '@campusos/module-academic/api'
import { requireFinance, type Actor } from './operations'

/**
 * Record lookups for the accounts office (UX-04, P1-09c, decisions 1000 to
 * 1004): a receipt by its number, old or fiscal-year, and a student for the
 * charge and demand-letter forms. Hits carry no amount, bank reference or
 * student, and the print route keeps its own check.
 */

const DETAIL = { live: 'Recorded', voided: 'Void', bounced: 'Cheque returned unpaid' } as const

export async function searchFeeReceipts(actor: Actor, req: Request): Promise<LookupResult> {
  const tenant = requireFinance(actor)
  const { q, like } = lookupQuery(req)
  const rows = await withTenant(tenant, async (tx) => {
    await lookupTimeout(tx)
    const { rows } = await tx.execute<{ id: string; receipt_no: string; status: keyof typeof DETAIL }>(sql`
      select id, receipt_no, status from fee_payments
       where institution_id = ${tenant}
         and (lower(receipt_no) = lower(${q})${like ? sql` or lower(receipt_no) like lower(${like}) escape '!'` : sql``})
       order by (lower(receipt_no) = lower(${q})) desc, lower(receipt_no), id
       limit 12`)
    return rows
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
