import { sql, type SQL } from 'drizzle-orm'
import type { withTenant } from '@campusos/db'
import { postedSql } from '@campusos/module-fees/api'
import { PluginError } from '@campusos/module-framework'

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]

export interface CertificateClearance {
  clear: boolean
}

/** A configured Fees or Library whose tables are missing: the answer is unknown, so nothing is issued. */
class ClearanceUnavailableError extends Error {
  readonly status = 503
  readonly code = 'certificate_clearance_unavailable'
  constructor() {
    super('Certificate clearance is temporarily unavailable.')
  }
}

/**
 * Does this student owe anything? Run in the transaction that writes the
 * document, after the caller has authorized the operation and found the
 * student in this tenant (P1-07d, decisions 900 to 906).
 *
 * Dues are: a positive posted balance in any term (a credit in one term does
 * not pay a debit in another); a live charge raised for the student and not
 * on a live invoice; and a Library fine assessed and not yet settled. Fees and
 * Library are soft dependencies: the tenant's tables are read even when the
 * entitlement is off, so switching a module off clears no debt. A provider that
 * is on but has no tables, or has a schema missing what the predicates read, fails closed. One statement reads the money, so a
 * loan moving to Fees or an invoice being voided cannot fall between reads.
 */
export async function checkCertificateClearanceWithin(tx: Tx, institutionId: string, studentId: string): Promise<CertificateClearance> {
  // Every table and column the predicates read, so an older or half-restored provider is told apart from an absent one.
  const FEES: Record<string, string[]> = {
    fee_invoices: ['institution_id', 'id', 'student_id', 'term_id', 'charged_paise', 'voided_at'],
    fee_student_charges: ['institution_id', 'student_id', 'term_id', 'amount_paise', 'created_at', 'cancelled_at', 'invoiced_at'],
    fee_payments: ['student_id', 'term_id', 'amount_paise', 'status', 'reconciled_at'],
    fee_refunds: ['payment_id', 'amount_paise'],
    fee_waivers: ['student_id', 'fee_item_id', 'posted_paise'],
    fee_items: ['id', 'term_id'],
    fee_scholarship_awards: ['student_id', 'term_id', 'amount_paise', 'status'],
    fee_drop_credits: ['student_id', 'term_id', 'amount_paise'],
    finance_journal_entries: ['institution_id', 'source_module', 'source_ref', 'created_at'],
  }
  const LIBRARY: Record<string, string[]> = {
    library_loans: ['institution_id', 'borrower_id', 'fine_paid_at', 'fine_paise', 'fine_waived_paise'],
  }
  const have = (cols: Record<string, string[]>) =>
    sql.raw(
      Object.entries(cols)
        .map(([t, cs]) => `(select count(*) from pg_attribute where attrelid = to_regclass('public.${t}') and attnum > 0 and not attisdropped and attname in (${cs.map((c) => `'${c}'`).join(',')})) = ${cs.length}`)
        .join(' and '),
    )
  const any = (cols: Record<string, string[]>) => sql.raw(Object.keys(cols).filter((t) => !t.startsWith('finance_')).map((t) => `to_regclass('public.${t}') is not null`).join(' or '))
  const probe = (
    await tx.execute(sql`
      select current_setting('app.institution_id', true) = ${institutionId} as same_tenant,
             (${any(FEES)}) as fees_any, (${have(FEES)}) as fees_whole,
             (${any(LIBRARY)}) as library_any, (${have(LIBRARY)}) as library_whole,
             exists (select 1 from institution_modules where institution_id = ${institutionId}::uuid and module_id = 'fees' and enabled) as fees_on,
             exists (select 1 from institution_modules where institution_id = ${institutionId}::uuid and module_id = 'library' and enabled) as library_on`)
  ).rows[0] as Record<string, boolean | null>
  if (probe.same_tenant !== true) throw new Error("Certificate clearance requires the document's tenant transaction.")
  // Wholly absent and not configured: no such debt. Configured but absent, or present but unreadable: unknown.
  const unknown = (any: boolean, whole: boolean, on: boolean) => (any && !whole) || (on && !any)
  if (unknown(!!probe.fees_any, !!probe.fees_whole, !!probe.fees_on) || unknown(!!probe.library_any, !!probe.library_whole, !!probe.library_on)) {
    throw new ClearanceUnavailableError()
  }

  const none: SQL = sql`false`
  // A charge counts as billed only if the live invoice's books entry (any version) was posted after the charge existed:
  // before NEW-91 Fees stamped invoiced_at on charges raised while an invoice was priced, which that invoice never carried.
  // ponytail: timestamps, not invoice lines (Fees keeps none); a charge committed after pricing from an earlier-started transaction still passes.
  const owesFees: SQL = probe.fees_any
    ? sql`(exists (select 1 from (${postedSql({ studentId })}) p where p.balance_paise > 0)
        or exists (select 1 from fee_student_charges c
                    where c.institution_id = ${institutionId}::uuid and c.student_id = ${studentId}
                      and c.cancelled_at is null and c.amount_paise > 0
                      and (c.invoiced_at is null
                           or not exists (select 1 from fee_invoices i
                                           where i.institution_id = c.institution_id and i.student_id = c.student_id
                                             and i.term_id = c.term_id and i.voided_at is null
                                             and exists (select 1 from finance_journal_entries e
                                                          where e.institution_id = i.institution_id and e.source_module = 'fees'
                                                            and e.source_ref like 'invoice:' || i.id || ':v%'
                                                            and e.created_at >= c.created_at)))))`
    : none
  const owesLibrary: SQL = probe.library_any
    ? sql`exists (select 1 from library_loans l
                   where l.institution_id = ${institutionId}::uuid and l.borrower_id = ${studentId}
                     and l.fine_paid_at is null and l.fine_paise > l.fine_waived_paise)`
    : none
  const row = (await tx.execute(sql`select not (${owesFees} or ${owesLibrary}) as clear`)).rows[0] as { clear: boolean }
  return { clear: row.clear === true }
}

/** Refuse, with the stable 409, unless the student is clear. */
export async function assertCertificateClearanceWithin(tx: Tx, institutionId: string, studentId: string): Promise<void> {
  if (!(await checkCertificateClearanceWithin(tx, institutionId, studentId)).clear) {
    throw new PluginError(409, 'certificate_dues_outstanding', 'Outstanding dues must be cleared before issuing this certificate.')
  }
}
