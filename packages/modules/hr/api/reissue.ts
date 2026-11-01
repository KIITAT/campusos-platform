/**
 * Reissue a payslip as reverse-and-replace (P1-06c, ACC-24).
 *
 * A payslip is a document of record and is never edited. A correction removes
 * the old one, keeping it as JSON in hr_payslip_reissues, reverses its books
 * entry, and makes a new one from today's pay data, all in one transaction.
 * The cases the existing tables cannot undo (a payment, a recovery, a later
 * month that chains from this one, a remittance) are refused: correct those on
 * the next payslip.
 */
import { and, eq, gt, isNull, sql } from 'drizzle-orm'
import { audit, withTenant } from '@campusos/db'
import { isPosted, reverseWithin } from '@campusos/module-finance/api'
import { HrError, MODULE, requireAdmin, type Actor } from './guards'
import { generatePayrollIn, lockPayrollPeriod } from './operations'
import { reissueSchema } from './schemas'
import { advanceRecoveries, payslipReissues, payslips, remittances, salaryPayments } from '../schema'

export async function reissuePayslip(actor: Actor, input: unknown): Promise<{ payslipId: string; reissueId: string }> {
  const tenant = requireAdmin(actor)
  const d = reissueSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [first] = await tx.select().from(payslips).where(eq(payslips.id, d.payslipId))
    if (!first) throw new HrError(404, 'no_such_payslip', 'no such payslip')
    await lockPayrollPeriod(tx, tenant, first.period)
    // It may have been reissued, or the month paid, while this waited for the lock.
    const [slip] = await tx.select().from(payslips).where(eq(payslips.id, d.payslipId))
    if (!slip) throw new HrError(404, 'no_such_payslip', 'no such payslip')

    const count = async (q: Promise<{ n: number }[]>) => (await q)[0]!.n
    const [paid] = await tx.select({ id: salaryPayments.id }).from(salaryPayments).where(eq(salaryPayments.period, slip.period))
    if (paid) throw new HrError(409, 'period_paid', 'the month is paid: correct this on the next payslip')
    if (slip.withheld && slip.releasedAt) throw new HrError(409, 'reissue_released', 'a payslip that was held back and released cannot be reissued')
    const recoveries = await count(tx.select({ n: sql<number>`count(*)::int` }).from(advanceRecoveries).where(eq(advanceRecoveries.payslipId, slip.id)))
    if (recoveries > 0) throw new HrError(409, 'reissue_has_recoveries', 'an advance was recovered on this payslip: correct it on the next one')
    const later = await count(
      tx.select({ n: sql<number>`count(*)::int` }).from(payslips).where(and(eq(payslips.staffId, slip.staffId), gt(payslips.period, slip.period))),
    )
    if (later > 0) throw new HrError(409, 'reissue_not_latest', 'this person has a later payslip: correct this on the next one')
    const remitted = await count(
      tx.select({ n: sql<number>`count(*)::int` }).from(remittances).where(and(eq(remittances.period, slip.period), isNull(remittances.voidedAt))),
    )
    if (remitted > 0) throw new HrError(409, 'reissue_remitted', 'the month has been remitted: void the remittances first')

    const entry = await isPosted(tx, MODULE, `payslip:${slip.id}`)
    const reversalId = entry ? await reverseWithin(tx, tenant, actor.id, entry, d.reason) : null
    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: 'hr.payslip_reissued',
      entity: 'hr_payslips',
      entityId: slip.id,
      reason: d.reason,
      detail: { period: slip.period, netPaise: slip.netPaise },
    })
    await tx.delete(payslips).where(eq(payslips.id, slip.id))

    const run = await generatePayrollIn(tx, actor, tenant, { period: slip.period, staffId: slip.staffId })
    if (run.failed.length > 0) throw new HrError(409, 'reissue_failed', run.failed[0]!.message)
    if (run.payslips.length !== 1) throw new HrError(409, 'reissue_failed', 'the replacement was not made')

    const [row] = await tx
      .insert(payslipReissues)
      .values({
        institutionId: tenant,
        staffId: slip.staffId,
        period: slip.period,
        originalId: slip.id,
        snapshot: JSON.parse(JSON.stringify(slip)) as Record<string, unknown>,
        reason: d.reason,
        reversalEntryId: reversalId,
        replacementId: run.payslips[0]!.id,
        reissuedBy: actor.id,
      })
      .returning({ id: payslipReissues.id })
    return { payslipId: run.payslips[0]!.id, reissueId: row!.id }
  })
}
