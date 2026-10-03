import {
  jsonBody,
  param,
  requiredParam,
  type PluginRoute,
} from '@campusos/module-framework'
import { eq } from 'drizzle-orm'
import { db, institutions } from '@campusos/db'
import {
  addBankAccount,
  claimQueue,
  claimTransfer,
  demandLetter,
  demandLetterPdf,
  issueDemandLetter,
  letterSettingsOf,
  listBankAccounts,
  listDemandLetters,
  myClaims,
  rejectClaim,
  retireBankAccount,
  setLetterSettings,
  verifyClaim,
  verifyDemandLetter,
  cancelStudentCharge,
  chargeStudent,
  listStudentCharges,
  assessAid,
  awardScholarship,
  createFeeItem,
  createScholarship,
  duesReport,
  listAwards,
  listDropCredits,
  listRefundRules,
  listScholarships,
  prorateDrops,
  revokeAward,
  setRefundRules,
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
  { method: 'GET', path: '/bank-accounts', handler: (actor) => listBankAccounts(actor as Actor) },
  { method: 'POST', path: '/bank-accounts', handler: async (actor, req) => addBankAccount(actor as Actor, await jsonBody(req)) },
  { method: 'POST', path: '/bank-accounts/retire', handler: async (actor, req) => retireBankAccount(actor as Actor, await jsonBody(req)) },
  { method: 'POST', path: '/transfers', handler: async (actor, req) => claimTransfer(actor as Actor, await jsonBody(req)) },
  { method: 'GET', path: '/transfers/mine', handler: (actor) => myClaims(actor as Actor) },
  { method: 'GET', path: '/transfers', handler: (actor, req) => claimQueue(actor as Actor, param(req, 'status')) },
  { method: 'POST', path: '/transfers/verify', handler: async (actor, req) => verifyClaim(actor as Actor, await jsonBody(req)) },
  { method: 'POST', path: '/transfers/reject', handler: async (actor, req) => rejectClaim(actor as Actor, await jsonBody(req)) },
  { method: 'GET', path: '/letters/settings', handler: (actor) => letterSettingsOf(actor as Actor) },
  { method: 'POST', path: '/letters/settings', handler: async (actor, req) => setLetterSettings(actor as Actor, await jsonBody(req)) },
  { method: 'POST', path: '/letters', handler: async (actor, req) => issueDemandLetter(actor as Actor, await jsonBody(req)) },
  { method: 'GET', path: '/letters', handler: (actor) => listDemandLetters(actor as Actor) },
  { method: 'GET', path: '/letters/verify', handler: (actor, req) => verifyDemandLetter(actor as Actor, requiredParam(req, 'number')) },
  {
    // Bytes, not JSON.
    method: 'GET',
    path: '/demand-letter.pdf',
    raw: true,
    handler: async (actor, req) => {
      const v = await demandLetter(actor as Actor, requiredParam(req, 'letterId'))
      const bytes = await demandLetterPdf(v)
      return new Response(bytes as unknown as BodyInit, {
        headers: {
          'content-type': 'application/pdf',
          'content-disposition': `inline; filename="demand-letter-${v.number.replace(/[^a-zA-Z0-9._-]/g, '_')}.pdf"`,
          'cache-control': 'no-store',
        },
      })
    },
  },
  {
    method: 'GET',
    path: '/charges',
    handler: (actor, req) => listStudentCharges(actor as Actor, param(req, 'termId') ?? undefined),
  },
  {
    method: 'POST',
    path: '/charges',
    handler: async (actor, req) => chargeStudent(actor as Actor, await jsonBody(req)),
  },
  {
    method: 'POST',
    path: '/charges/cancel',
    handler: async (actor, req) => cancelStudentCharge(actor as Actor, await jsonBody(req)),
  },
  {
    method: 'GET',
    path: '/scholarships',
    handler: (actor) => listScholarships(actor as Actor),
  },
  {
    method: 'POST',
    path: '/scholarships',
    handler: async (actor, req) => createScholarship(actor as Actor, await jsonBody(req)),
  },
  {
    method: 'GET',
    path: '/aid',
    handler: (actor, req) =>
      assessAid(actor as Actor, {
        studentId: requiredParam(req, 'studentId'),
        termId: requiredParam(req, 'termId'),
      }),
  },
  {
    method: 'POST',
    path: '/aid/award',
    handler: async (actor, req) => awardScholarship(actor as Actor, await jsonBody(req)),
  },
  {
    method: 'POST',
    path: '/aid/revoke',
    handler: async (actor, req) => revokeAward(actor as Actor, await jsonBody(req)),
  },
  {
    method: 'GET',
    path: '/aid/awards',
    handler: (actor, req) =>
      listAwards(actor as Actor, {
        termId: requiredParam(req, 'termId'),
        studentId: param(req, 'studentId'),
      }),
  },

  {
    method: 'GET',
    path: '/refund-rules',
    handler: (actor, req) => listRefundRules(actor as Actor, requiredParam(req, 'termId')),
  },
  {
    method: 'POST',
    path: '/refund-rules',
    handler: async (actor, req) => setRefundRules(actor as Actor, await jsonBody(req)),
  },
  {
    method: 'GET',
    path: '/drops',
    handler: (actor, req) => listDropCredits(actor as Actor, requiredParam(req, 'termId')),
  },
  {
    method: 'POST',
    path: '/drops/prorate',
    handler: async (actor, req) => prorateDrops(actor as Actor, await jsonBody(req)),
  },

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
