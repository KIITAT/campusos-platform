import { ADMIN, OFFICE, type Role } from '@campusos/module-framework'

/**
 * Who may call each route (decision 192). The host refuses every other role
 * before the handler runs; the operation keeps its own check, because page
 * loaders and other modules call it in-process. A new route without an entry
 * here fails at load (`withRouteRoles`).
 */
export const routeRoles: Record<string, readonly Role[]> = {
  'GET /bank-accounts': [...OFFICE, 'student'],
  'POST /bank-accounts': ADMIN,
  'POST /bank-accounts/retire': ADMIN,
  'POST /transfers': ['student'],
  'GET /transfers/mine': ['student'],
  'GET /transfers': OFFICE,
  'POST /transfers/verify': OFFICE,
  'POST /transfers/reject': OFFICE,
  'GET /letters/settings': OFFICE,
  'POST /letters/settings': ADMIN,
  'POST /letters': [...OFFICE, 'student'],
  'GET /letters': [...OFFICE, 'student'],
  'GET /letters/verify': OFFICE,
  'GET /demand-letter.pdf': [...OFFICE, 'student'],
  'GET /charges': OFFICE,
  'POST /charges': OFFICE,
  'POST /charges/cancel': OFFICE,
  'GET /scholarships': ADMIN,
  'POST /scholarships': ADMIN,
  'GET /aid': ADMIN,
  'POST /aid/award': ADMIN,
  'POST /aid/revoke': ADMIN,
  'GET /aid/awards': ADMIN,
  'GET /refund-rules': ADMIN,
  'POST /refund-rules': ADMIN,
  'GET /drops': ADMIN,
  'POST /drops/prorate': ADMIN,
  'GET /items': OFFICE,
  'POST /items': ADMIN,
  'POST /waivers': ADMIN,
  'POST /waivers/revoke': ADMIN,
  'POST /payments': OFFICE,
  'POST /payments/reconcile': OFFICE,
  'GET /invoices': OFFICE,
  'POST /invoices': ADMIN,
  'POST /refunds': ADMIN,
  'GET /ledger': [...OFFICE, 'hod', 'student'],
  'GET /dues': OFFICE,
  'GET /receipt.pdf': [...OFFICE, 'student'],
}
