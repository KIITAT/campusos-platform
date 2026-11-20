import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import { assertCanAccessStudent } from '@campusos/module-framework'
import { withTenant } from '@campusos/db'
import { bankAccounts, feeInvoices } from '../schema'
import { postedOf, postedSql } from './books'
import { FeeError, type Actor } from './operations'

/**
 * Paying by UPI (P1-03c): the link a QR carries, and the reference that ties a
 * payment on the bank statement to the student and term it is for.
 */

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]

export const PAY_REFERENCE = /^CF[0-9A-F]{10}$/
export const payReference = (invoiceId: string) => 'CF' + invoiceId.replace(/-/g, '').slice(0, 10).toUpperCase()
/** The same, in SQL, over an invoice id column. */
export const payReferenceSql = (id: unknown) => sql`'CF' || upper(left(replace(${id}::text, '-', ''), 10))`

export function upiLink(p: { vpa: string; payee: string; amountPaise?: number | null; reference?: string | null }): string {
  const parts = [`pa=${p.vpa}`, `pn=${encodeURIComponent(p.payee.slice(0, 50))}`]
  const amount = p.amountPaise && p.amountPaise > 0 ? p.amountPaise : null
  if (amount) parts.push(`am=${Math.floor(amount / 100)}.${String(amount % 100).padStart(2, '0')}`)
  if (amount && p.reference) parts.push(`tr=${p.reference}`)
  if (p.reference) parts.push(`tn=${encodeURIComponent(`Fees ${p.reference}`)}`)
  parts.push('cu=INR')
  return `upi://pay?${parts.join('&')}`
}

export interface UpiPay {
  vpa: string
  payee: string
  link: string
  amountPaise: number | null
  reference: string | null
  dynamic: boolean
}

export async function upiWithin(tx: Tx, studentId: string, termId: string): Promise<UpiPay | null> {
  const [a] = await tx
    .select({ vpa: bankAccounts.upiVpa, merchant: bankAccounts.upiMerchant, payee: bankAccounts.accountName })
    .from(bankAccounts)
    .where(and(isNull(bankAccounts.retiredAt), isNotNull(bankAccounts.upiVpa)))
    .orderBy(asc(bankAccounts.createdAt))
    .limit(1)
  if (!a?.vpa) return null
  const [inv] = await tx
    .select({ id: feeInvoices.id })
    .from(feeInvoices)
    .where(and(eq(feeInvoices.studentId, studentId), eq(feeInvoices.termId, termId), isNull(feeInvoices.voidedAt)))
  const reference = inv ? payReference(inv.id) : null
  let amountPaise: number | null = null
  if (a.merchant && inv) {
    const [row] = (await tx.execute(sql`select * from (${postedSql({ termId, studentId })}) p`)).rows
    const due = Math.max(0, postedOf(row as Record<string, unknown> | undefined).balancePaise)
    if (due > 0) amountPaise = due
  }
  return {
    vpa: a.vpa,
    payee: a.payee,
    amountPaise,
    reference,
    dynamic: amountPaise !== null,
    link: upiLink({ vpa: a.vpa, payee: a.payee, amountPaise, reference }),
  }
}

/** How this student pays this term by UPI; null when no account takes UPI. The student, a guardian through the parents portal, or the office. */
export async function upiFor(actor: Actor, studentId: string, termId: string): Promise<UpiPay | null> {
  if (!actor.institutionId) throw new FeeError(400, 'no_institution', 'no institution for this session')
  return withTenant(actor.institutionId, async (tx) => {
    await assertCanAccessStudent(tx, actor, studentId, 'fee_ledger')
    return upiWithin(tx, studentId, termId)
  })
}
