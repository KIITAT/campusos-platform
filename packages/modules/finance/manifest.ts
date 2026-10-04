import type { ModuleManifest } from '@campusos/module-framework'
import { ADMIN, OFFICE, STAFF } from './screens/roles'

/**
 * The books, as a module rather than as core.
 *
 * Fees and HR both post here and neither can own it. Core was the other
 * candidate and was rejected: an institution that bought neither would still
 * carry a chart of accounts, and the whole claim of the plugin boundary is that
 * it does not.
 *
 * No dependsOn of its own. The ledger knows about debits and credits and
 * nothing about students, which is what lets payroll use it too.
 */
export const manifest: ModuleManifest = {
  id: 'finance',
  name: 'Finance & Books',
  description:
    'Double-entry books for the whole institution: ledger, receivables and payables, GST and TDS, bank import and reconciliation, stock with batches and serials, purchasing and selling, fixed assets, funds and grants, and statements.',
  version: '0.5.0',
  alwaysEnabled: false,
  dependsOn: [],
  pricing: { model: 'flat_monthly', priceINR: 2000 },

  rolesWithAccess: STAFF,

  navEntries: [
    { label: 'Books', href: '/m/finance', roles: OFFICE },
    { label: 'Selling', href: '/m/finance/invoices?kind=sales', roles: OFFICE },
    { label: 'Buying', href: '/m/finance/orders?kind=purchase_order', roles: OFFICE },
    { label: 'Money', href: '/m/finance/payments', roles: OFFICE },
    { label: 'Stock', href: '/m/finance/stock-entries', roles: OFFICE },
    { label: 'Assets', href: '/m/finance/assets', roles: OFFICE },
    { label: 'Reports', href: '/m/finance/reports', roles: OFFICE },
    { label: 'Setup', href: '/m/finance/settings', roles: ADMIN },
    { label: 'My requests', href: '/m/finance/my', roles: STAFF },
    { label: 'Approvals', href: '/m/finance/approvals', roles: STAFF },
  ],

  apiBasePath: '/api/v1/modules/finance',
}
