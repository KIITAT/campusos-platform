import { and, desc, eq, sql } from 'drizzle-orm'
import { withTenant } from '@campusos/db'
import * as z from 'zod'
import {
  approvals,
  invoiceLines,
  invoices,
  journalLines,
  journals,
  materialRequestLines,
  materialRequests,
  orderLines,
  orders,
  paymentAllocations,
  payments,
} from '../schema'
import { FinanceError, named, requireStaff, tenantOf, type Actor, type Tx } from './core'
import { approvalViewOfRequest } from './buying'
import { approvalViewOfInvoice } from './invoices'
import { approvalViewOfJournal } from './journals'
import { approvalViewOfPayment } from './payments'
import { APPROVABLE, decide, fingerprint, mayApprove, ruleFor } from './setup'
import { approvalViewOfOrder } from './trade'

/**
 * Approving a draft, for every kind of document that can need it.
 *
 * Each kind says what an approver signs (its substance, fingerprinted) and
 * what it is worth (which rule it falls under). The approval is for the draft
 * as it stands: change it afterwards and it needs approving again.
 */

type Approvable = (typeof APPROVABLE)[number]

async function viewOf(tx: Tx, docType: Approvable, docId: string): Promise<{ view: unknown; amountPaise: number; draft: boolean }> {
  switch (docType) {
    case 'purchase_order': {
      const [o] = await tx.select().from(orders).where(eq(orders.id, docId))
      if (!o || o.kind !== 'purchase_order') break
      const ls = await tx.select().from(orderLines).where(eq(orderLines.orderId, docId))
      return { view: approvalViewOfOrder(o, ls), amountPaise: o.totalPaise, draft: o.docstatus === 'draft' }
    }
    case 'purchase_invoice': {
      const [i] = await tx.select().from(invoices).where(eq(invoices.id, docId))
      if (!i || i.kind !== 'purchase') break
      const ls = await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, docId))
      return { view: approvalViewOfInvoice(i, ls.sort((a, b) => a.seq - b.seq)), amountPaise: i.totalPaise, draft: i.docstatus === 'draft' }
    }
    case 'payment_pay': {
      const [p] = await tx.select().from(payments).where(eq(payments.id, docId))
      if (!p || p.kind !== 'pay') break
      const allocs = await tx.select().from(paymentAllocations).where(eq(paymentAllocations.paymentId, docId))
      return { view: approvalViewOfPayment(p, allocs), amountPaise: p.amountPaise, draft: p.docstatus === 'draft' }
    }
    case 'journal': {
      const [j] = await tx.select().from(journals).where(eq(journals.id, docId))
      if (!j) break
      const ls = await tx.select().from(journalLines).where(eq(journalLines.journalId, docId))
      const sorted = ls.sort((a, b) => a.seq - b.seq)
      const debit = sorted.reduce((n, l) => n + l.debitPaise, 0)
      const credit = sorted.reduce((n, l) => n + l.creditPaise, 0)
      return { view: approvalViewOfJournal(j, sorted), amountPaise: Math.max(debit, credit), draft: j.docstatus === 'draft' }
    }
    case 'material_request': {
      const [r] = await tx.select().from(materialRequests).where(eq(materialRequests.id, docId))
      if (!r) break
      const ls = await tx.select().from(materialRequestLines).where(eq(materialRequestLines.requestId, docId))
      // Weighed as the request is submitted: by its items' standard rates.
      const res = await tx.execute(sql`
        select coalesce(sum(l.qty_milli * coalesce(i.standard_rate_paise, 0) / 1000), 0)::bigint as v
          from finance_material_request_lines l join finance_items i on i.id = l.item_id
         where l.request_id = ${docId}`)
      return { view: approvalViewOfRequest(r, ls), amountPaise: Number((res.rows[0] as { v: number }).v), draft: r.docstatus === 'draft' }
    }
  }
  throw new FinanceError(404, 'no_such_document', 'no such document')
}

export const decideSchema = z
  .object({
    docType: z.enum(APPROVABLE),
    docId: z.uuid(),
    decision: z.enum(['approved', 'rejected']),
    note: z
      .string()
      .trim()
      .max(500)
      .optional()
      .transform((v) => (v ? v : undefined)),
  })
  .meta({ id: 'FinanceApprovalDecision' })

export async function decideApproval(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  const data = decideSchema.parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      const { view, amountPaise, draft } = await viewOf(tx, data.docType, data.docId)
      if (!draft) throw new FinanceError(409, 'not_a_draft', 'only a draft is approved')
      await decide(tx, tenant, actor, data.docType, data.docId, view, amountPaise, data.decision, data.note)
      return { notice: data.decision === 'approved' ? 'Approved.' : 'Refused.' }
    }),
  )
}

/** Whether a draft needs an approval, and from whom. */
export async function approvalNeeded(tx: Tx, docType: Approvable, docId: string) {
  const { amountPaise } = await viewOf(tx, docType, docId)
  return ruleFor(tx, docType, amountPaise)
}

const PAGE: Record<Approvable, string> = {
  purchase_order: '/m/finance/order?id=',
  purchase_invoice: '/m/finance/invoice?id=',
  payment_pay: '/m/finance/payment?id=',
  journal: '/m/finance/voucher?id=',
  material_request: '/m/finance/material-request?id=',
}

/**
 * Drafts waiting for an approval this reader may give: each draft of a kind
 * that can need one, weighed against the rules, less those already approved
 * as they stand. A refusal stays in the list, marked, until the draft changes
 * and is approved, or is deleted.
 */
export async function pendingApprovals(actor: Actor) {
  const tenant = requireStaff(actor)
  return withTenant(tenant, async (tx) => {
    const drafts: { docType: Approvable; id: string; number: string | null; createdAt: Date }[] = [
      ...(await tx.select({ id: orders.id, number: orders.number, createdAt: orders.createdAt }).from(orders)
        .where(and(eq(orders.kind, 'purchase_order'), eq(orders.docstatus, 'draft')))).map((r) => ({ docType: 'purchase_order' as const, ...r })),
      ...(await tx.select({ id: invoices.id, number: invoices.number, createdAt: invoices.createdAt }).from(invoices)
        .where(and(eq(invoices.kind, 'purchase'), eq(invoices.docstatus, 'draft')))).map((r) => ({ docType: 'purchase_invoice' as const, ...r })),
      ...(await tx.select({ id: payments.id, number: payments.number, createdAt: payments.createdAt }).from(payments)
        .where(and(eq(payments.kind, 'pay'), eq(payments.docstatus, 'draft')))).map((r) => ({ docType: 'payment_pay' as const, ...r })),
      ...(await tx.select({ id: journals.id, number: journals.number, createdAt: journals.createdAt }).from(journals)
        .where(eq(journals.docstatus, 'draft'))).map((r) => ({ docType: 'journal' as const, ...r })),
      ...(await tx.select({ id: materialRequests.id, number: materialRequests.number, createdAt: materialRequests.createdAt }).from(materialRequests)
        .where(eq(materialRequests.docstatus, 'draft'))).map((r) => ({ docType: 'material_request' as const, ...r })),
    ]
    const out: {
      docType: Approvable
      docId: string
      number: string | null
      amountPaise: number
      approver: string
      refused: boolean
      createdAt: Date
      href: string
    }[] = []
    for (const d of drafts) {
      const { view, amountPaise } = await viewOf(tx, d.docType, d.id)
      const rule = await ruleFor(tx, d.docType, amountPaise)
      if (!rule || !(await mayApprove(tx, actor, rule.approver))) continue
      const [last] = await tx
        .select({ decision: approvals.decision })
        .from(approvals)
        .where(and(eq(approvals.docType, d.docType), eq(approvals.docId, d.id), eq(approvals.fingerprint, fingerprint(view))))
        .orderBy(desc(approvals.createdAt))
        .limit(1)
      if (last?.decision === 'approved') continue
      out.push({
        docType: d.docType,
        docId: d.id,
        number: d.number,
        amountPaise,
        approver: rule.approver,
        refused: last?.decision === 'rejected',
        createdAt: d.createdAt,
        href: `${PAGE[d.docType]}${d.id}`,
      })
    }
    return out.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  })
}
