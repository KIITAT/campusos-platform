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
 * is on but has no tables fails closed. One statement reads the money, so a
 * loan moving to Fees or an invoice being voided cannot fall between reads.
 */
export async function checkCertificateClearanceWithin(tx: Tx, institutionId: string, studentId: string): Promise<CertificateClearance> {
  const probe = (
    await tx.execute(sql`
      select current_setting('app.institution_id', true) = ${institutionId} as same_tenant,
             to_regclass('public.fee_invoices') is not null as fees_present,
             to_regclass('public.library_loans') is not null as library_present,
             exists (select 1 from institution_modules where institution_id = ${institutionId}::uuid and module_id = 'fees' and enabled) as fees_on,
             exists (select 1 from institution_modules where institution_id = ${institutionId}::uuid and module_id = 'library' and enabled) as library_on`)
  ).rows[0] as { same_tenant: boolean | null; fees_present: boolean; library_present: boolean; fees_on: boolean; library_on: boolean }
  if (probe.same_tenant !== true) throw new Error("Certificate clearance requires the document's tenant transaction.")
  if ((probe.fees_on && !probe.fees_present) || (probe.library_on && !probe.library_present)) throw new ClearanceUnavailableError()

  const none: SQL = sql`false`
  const owesFees: SQL = probe.fees_present
    ? sql`(exists (select 1 from (${postedSql({ studentId })}) p where p.balance_paise > 0)
        or exists (select 1 from fee_student_charges c
                    where c.institution_id = ${institutionId}::uuid and c.student_id = ${studentId}
                      and c.cancelled_at is null and c.amount_paise > 0
                      and (c.invoiced_at is null
                           or not exists (select 1 from fee_invoices i
                                           where i.institution_id = c.institution_id and i.student_id = c.student_id
                                             and i.term_id = c.term_id and i.voided_at is null))))`
    : none
  const owesLibrary: SQL = probe.library_present
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
