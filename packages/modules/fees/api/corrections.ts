import { and, eq, isNull, sql } from 'drizzle-orm'
import { audit, users, withTenant } from '@campusos/db'
import { checkOtherPerson, localToday } from '@campusos/module-finance/api'
import { notify } from '@campusos/module-notices/api'
import { terms } from '@campusos/module-academic/schema'
import { feeInvoices, feePayments } from '../schema'
import { FeeError, localDayOf, lockTermIssue, requireAdmin, requireFinance, type Actor } from './operations'
import { chargeStudentWithin } from './charges'
import { postedOf, postedSql } from './books'
import { postInvoiceVoid, reversePayment } from './posting'
import { bouncePaymentSchema, voidInvoiceSchema, voidPaymentSchema } from './schemas'

/**
 * Correcting money already receipted (ACC-23). A receipt is never deleted: a
 * mistake is voided and a cheque the bank sends back is marked returned
 * unpaid. Either keeps the row, reverses its journal entry through
 * reverseWithin, and leaves the student ledger, which counts live payments
 * only, so the amount is owed again and the ledger still equals the books.
 */

const MODULE = 'fees'

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]
type Payment = typeof feePayments.$inferSelect

const rupees = (p: number) => '₹' + (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** The payment, locked, and still live (D6, D7). */
async function livePayment(tx: Tx, id: string): Promise<Payment> {
  const [p] = await tx.select().from(feePayments).where(eq(feePayments.id, id)).for('update')
  if (!p) throw new FeeError(404, 'no_such_payment', 'no such payment')
  if (p.status === 'voided') throw new FeeError(409, 'payment_not_live', `receipt ${p.receiptNo} is already void`)
  if (p.status === 'bounced') {
    throw new FeeError(409, 'payment_not_live', `receipt ${p.receiptNo} is already marked returned unpaid`)
  }
  return p
}

/** Money already gone back out against a receipt pins it (D6). */
async function refuseIfRefunded(tx: Tx, p: Payment) {
  const r = await tx.execute(sql`select 1 from fee_refunds where payment_id = ${p.id} limit 1`)
  if (r.rows.length > 0) {
    throw new FeeError(409, 'payment_refunded', `receipt ${p.receiptNo} has refunds against it; it cannot be voided or returned`)
  }
}

/**
 * Void a receipt recorded by mistake: the wrong student, the wrong amount,
 * entered twice. Reversed today in the institution's zone (D3), by an
 * administrator who did not record it (D4, D5), and the student and their
 * guardians are told (D9).
 */
export async function voidPayment(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const data = voidPaymentSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const p = await livePayment(tx, data.paymentId)
    if ((await checkOtherPerson(tx, actor, tenant, { creatorId: p.recordedBy, act: 'refund', moduleId: MODULE, entity: 'fee_payments', entityId: p.id })) === 'refused') {
      throw new FeeError(403, 'separation_of_duties', 'you recorded this payment, so someone else must void it')
    }
    await refuseIfRefunded(tx, p)

    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: 'fee.payment_voided',
      entity: 'fee_payments',
      entityId: p.id,
      reason: data.reason,
      detail: { studentId: p.studentId, receiptNo: p.receiptNo, amountPaise: p.amountPaise, method: p.method, reference: p.reference },
    })
    const [row] = await tx
      .update(feePayments)
      .set({ status: 'voided', voidedAt: new Date(), voidedBy: actor.id, voidReason: data.reason })
      .where(eq(feePayments.id, p.id))
      .returning()
    await reversePayment(tx, tenant, actor.id, p.id, `voided: ${data.reason}`, await localToday(tx, tenant))

    await notify(tx, tenant, {
      userIds: [p.studentId],
      moduleId: MODULE,
      title: 'Receipt cancelled',
      body: `Receipt ${p.receiptNo} for ${rupees(p.amountPaise)} has been cancelled by the accounts office. Ask the office if you did not expect this.`,
      link: '/m/fees/me',
      alsoGuardians: { link: '/m/parents' },
    })

    return { ...row!, notice: `Receipt ${p.receiptNo} is void. Its entry in the books is reversed and the amount is due again.` }
  })
}

/**
 * A cheque the bank returned unpaid. Reversed on the bank's date of return
 * (D3), by someone other than its recorder (D5); the drawer's IFSC and account
 * are recorded so the same cheque is recognised again (D16); an optional bounce
 * charge is raised on the student and billed at the next issue (D8).
 */
export async function bouncePayment(actor: Actor, input: unknown) {
  const tenant = requireFinance(actor)
  const data = bouncePaymentSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const p = await livePayment(tx, data.paymentId)
    if (p.method !== 'cheque') {
      throw new FeeError(400, 'not_a_cheque', 'only a cheque is returned unpaid; void anything else')
    }
    if ((await checkOtherPerson(tx, actor, tenant, { creatorId: p.recordedBy, act: 'reconcile', moduleId: MODULE, entity: 'fee_payments', entityId: p.id })) === 'refused') {
      throw new FeeError(403, 'separation_of_duties', 'you recorded this payment, so someone else must record it returned')
    }
    await refuseIfRefunded(tx, p)

    const ifsc = p.drawerIfsc ?? data.drawerIfsc ?? null
    const account = p.drawerAccount ?? data.drawerAccount ?? null
    if (!ifsc || !account) {
      throw new FeeError(400, 'drawer_required', 'give the IFSC and account number printed on the cheque')
    }
    const received = await localDayOf(tx, tenant, p.receivedAt)
    const today = await localToday(tx, tenant)
    if (data.bouncedOn < received) {
      throw new FeeError(400, 'bounce_before_receipt', 'a cheque cannot be returned before it was received')
    }
    if (data.bouncedOn > today) throw new FeeError(400, 'future_bounce', 'a return cannot be dated in the future')
    if (data.charge !== undefined && data.charge > 1_000_000) {
      throw new FeeError(400, 'bad_charge', 'a bounce charge is more than nothing and at most ₹10,000')
    }

    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: 'fee.cheque_returned',
      entity: 'fee_payments',
      entityId: p.id,
      reason: data.reason,
      detail: {
        studentId: p.studentId,
        receiptNo: p.receiptNo,
        amountPaise: p.amountPaise,
        reference: p.reference,
        drawerIfsc: ifsc,
        drawerAccount: account,
        bouncedOn: data.bouncedOn,
        chargePaise: data.charge ?? 0,
      },
    })
    const [row] = await tx
      .update(feePayments)
      .set({
        status: 'bounced',
        voidedAt: new Date(),
        voidedBy: actor.id,
        voidReason: data.reason,
        bouncedOn: data.bouncedOn,
        drawerIfsc: ifsc,
        drawerAccount: account,
      })
      .where(eq(feePayments.id, p.id))
      .returning()
    await reversePayment(tx, tenant, actor.id, p.id, `cheque returned unpaid: ${data.reason}`, data.bouncedOn)

    if (data.charge !== undefined) {
      await chargeStudentWithin(tx, tenant, actor.id, {
        studentId: p.studentId,
        termId: p.termId,
        label: `Cheque returned unpaid, receipt ${p.receiptNo}`,
        amountPaise: data.charge,
        sourceModule: MODULE,
        sourceId: `bounce:${p.id}`,
      })
    }

    await notify(tx, tenant, {
      userIds: [p.studentId],
      moduleId: MODULE,
      title: 'Cheque returned unpaid',
      body: `Cheque ${p.reference ?? 'without a number'} for ${rupees(p.amountPaise)} (receipt ${p.receiptNo}) was returned unpaid by the bank. The amount is due again.`,
      link: '/m/fees/me',
      alsoGuardians: { link: '/m/parents' },
    })

    return {
      ...row!,
      notice:
        `Receipt ${p.receiptNo} is marked returned unpaid; the amount is due again.` +
        (data.charge !== undefined ? ` A charge of ${rupees(data.charge)} is billed when the term's fees are next issued.` : ''),
    }
  })
}

/**
 * Void an invoice issued in error, such as to a student who was not enrolled
 * (D3 of tools/p006-diagnostics.sql). Only when nothing is paid or credited
 * against the term. One entry takes the student's position back to nothing
 * (D13); the waivers it carried go back to unposted and ride again if the term
 * is issued afresh (D14). Under the term's issue lock, so an issue run and a
 * void take turns.
 */
export async function voidInvoice(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const data = voidInvoiceSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    await lockTermIssue(tx, data.termId)
    const [invoice] = await tx
      .select()
      .from(feeInvoices)
      .where(and(eq(feeInvoices.studentId, data.studentId), eq(feeInvoices.termId, data.termId), isNull(feeInvoices.voidedAt)))
      .for('update')
    if (!invoice) throw new FeeError(404, 'no_such_invoice', 'no live invoice for that student and term')

    const [posted] = (await tx.execute(sql`select * from (${postedSql({ termId: data.termId, studentId: data.studentId })}) p`)).rows
    const p = postedOf(posted as Record<string, unknown> | undefined)
    const net = p.paidPaise - p.refundedPaise
    if (net !== 0) {
      throw new FeeError(409, 'invoice_has_payments', `${rupees(net)} is paid against this term; void or refund those receipts first`)
    }
    if (p.creditedPaise !== 0) {
      throw new FeeError(
        409,
        'invoice_has_credits',
        'this term has scholarship awards or drop credits; revoke the awards first (a drop credit cannot be undone)',
      )
    }

    const waivers = (
      await tx.execute(sql`
        select w.id, w.posted_paise from fee_waivers w join fee_items f on f.id = w.fee_item_id
         where w.student_id = ${data.studentId} and f.term_id = ${data.termId}::uuid and w.posted_paise <> 0
           for update of w`)
    ).rows as { id: string; posted_paise: string | number }[]
    const waived = waivers.reduce((n, w) => n + Number(w.posted_paise), 0)

    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: 'fee.invoice_voided',
      entity: 'fee_invoices',
      entityId: invoice.id,
      reason: data.reason,
      detail: { studentId: data.studentId, termId: data.termId, chargedPaise: invoice.chargedPaise, waivedPaise: waived, version: invoice.version },
    })
    await tx
      .update(feeInvoices)
      .set({ voidedAt: new Date(), voidedBy: actor.id, voidReason: data.reason })
      .where(eq(feeInvoices.id, invoice.id))
    if (waivers.length > 0) {
      await tx.execute(sql`update fee_waivers set posted_paise = 0 where id in (${sql.join(waivers.map((w) => sql`${w.id}::uuid`), sql`, `)})`)
    }

    const [term] = await tx.select({ code: terms.code }).from(terms).where(eq(terms.id, data.termId))
    const [student] = await tx.select({ name: users.name }).from(users).where(eq(users.id, data.studentId))
    const termCode = term?.code ?? 'term'
    await postInvoiceVoid(tx, tenant, actor.id, {
      id: invoice.id,
      studentName: student?.name ?? null,
      termCode,
      chargedPaise: invoice.chargedPaise,
      waivedPaise: waived,
      reason: data.reason,
      postingDate: await localToday(tx, tenant),
    })

    return {
      invoiceId: invoice.id,
      notice: `Invoice for ${termCode} voided; ${rupees(invoice.chargedPaise - waived)} is no longer owed. Issuing the term again bills the student afresh if they are enrolled.`,
    }
  })
}
