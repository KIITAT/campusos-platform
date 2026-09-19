import {
  jsonBody,
  param,
  requiredParam,
  type PluginRoute,
} from '@campusos/module-framework'
import { eq } from 'drizzle-orm'
import { db, institutions } from '@campusos/db'
import {
  createFeeItem,
  duesReport,
  grantWaiver,
  issueInvoices,
  listFeeItems,
  listInvoices,
  paymentForReceipt,
  receiptPdf,
  recordPayment,
  reconcilePayment,
  refundPayment,
  revokeWaiver,
  studentLedger,
  type Actor,
} from './api'

export const routes: PluginRoute[] = [
  {
    method: 'GET',
    path: '/items',
    handler: (actor, req) => listFeeItems(actor as Actor, param(req, 'termId')),
  },
  {
    method: 'POST',
    path: '/items',
    handler: async (actor, req) => createFeeItem(actor as Actor, await jsonBody(req)),
  },

  {
    method: 'POST',
    path: '/waivers',
    handler: async (actor, req) => grantWaiver(actor as Actor, await jsonBody(req)),
  },
  {
    method: 'POST',
    path: '/waivers/revoke',
    handler: async (actor, req) => {
      await revokeWaiver(actor as Actor, await jsonBody(req))
    },
  },

  {
    method: 'POST',
    path: '/payments',
    handler: async (actor, req) => recordPayment(actor as Actor, await jsonBody(req)),
  },
  {
    method: 'POST',
    path: '/payments/reconcile',
    handler: async (actor, req) => {
      await reconcilePayment(actor as Actor, await jsonBody(req))
    },
  },

  {
    method: 'GET',
    path: '/invoices',
    handler: (actor, req) => listInvoices(actor as Actor, requiredParam(req, 'termId')),
  },
  {
    method: 'POST',
    path: '/invoices',
    handler: async (actor, req) => issueInvoices(actor as Actor, await jsonBody(req)),
  },
  {
    method: 'POST',
    path: '/refunds',
    handler: async (actor, req) => refundPayment(actor as Actor, await jsonBody(req)),
  },

  {
    method: 'GET',
    path: '/ledger',
    handler: (actor, req) =>
      studentLedger(
        actor as Actor,
        requiredParam(req, 'studentId'),
        requiredParam(req, 'termId'),
      ),
  },
  {
    method: 'GET',
    path: '/dues',
    handler: (actor, req) => duesReport(actor as Actor, requiredParam(req, 'termId')),
  },

  {
    method: 'GET',
    path: '/receipt.pdf',
    raw: true,
    handler: async (actor, req) => {
      const payment = await paymentForReceipt(
        actor as Actor,
        requiredParam(req, 'paymentId'),
      )

      // institutions carries no RLS policy -- it is the control plane every
      // tenant is resolved from -- so this reads without a tenant transaction.
      const [inst] = await db
        .select({ name: institutions.name })
        .from(institutions)
        .where(eq(institutions.id, actor.institutionId!))

      const bytes = await receiptPdf({
        ...payment,
        institutionName: inst?.name ?? 'Institution',
      })

      return new Response(bytes as unknown as BodyInit, {
        headers: {
          'content-type': 'application/pdf',
          'content-disposition': `inline; filename="receipt-${payment.receiptNo}.pdf"`,
          // A receipt gains a reconciliation stamp later, so never cache it.
          'cache-control': 'no-store',
        },
      })
    },
  },
]
