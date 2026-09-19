import type { ModuleManifest } from '@campusos/module-framework'

export const manifest: ModuleManifest = {
  id: 'fees',
  name: 'Fees & Finance',
  description:
    'Fee structures per programme and term, scholarships and waivers, payment recording with manual reconciliation, receipts and defaulter reporting.',
  version: '0.2.0',
  alwaysEnabled: false,
  /**
   * finance, because every charge, payment, waiver and refund posts a balanced
   * journal entry as it happens. Fees kept its own running balance before and
   * it was never double entry; two sets of books that can disagree are worse
   * than one.
   */
  dependsOn: ['academic', 'finance'],
  pricing: { model: 'not_priced_yet', priceINR: null },

  rolesWithAccess: [
    'super_admin',
    'institution_admin',
    'accounts_staff',
    'hod',
    'student',
  ],

  navEntries: [
    { label: 'Fees', href: '/m/fees', roles: ['institution_admin', 'accounts_staff'] },
    { label: 'Dues', href: '/m/fees/dues', roles: ['institution_admin', 'accounts_staff', 'hod'] },
    { label: 'My fees', href: '/m/fees/me', roles: ['student'] },
  ],

  apiBasePath: '/api/v1/modules/fees',
}
