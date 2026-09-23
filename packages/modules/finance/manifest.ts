import type { ModuleManifest } from '@campusos/module-framework'

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
    'Double-entry accounting: a chart of accounts, a journal every other module posts to, and a trial balance.',
  version: '0.3.0',
  alwaysEnabled: false,
  dependsOn: [],
  pricing: { model: 'flat_monthly', priceINR: 2000 },

  rolesWithAccess: ['super_admin', 'institution_admin', 'accounts_staff'],

  navEntries: [
    { label: 'Periods', href: '/m/finance/periods', roles: ['institution_admin'] },
    { label: 'Budgets', href: '/m/finance/budgets', roles: ['institution_admin'] },
    {
      label: 'Books',
      href: '/m/finance',
      roles: ['institution_admin', 'accounts_staff'],
    },
  ],

  apiBasePath: '/api/v1/modules/finance',
}
