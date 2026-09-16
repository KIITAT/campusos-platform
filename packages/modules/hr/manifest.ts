import type { ModuleManifest } from '@campusos/module-framework'

export const manifest: ModuleManifest = {
  id: 'hr',
  name: 'HR & Payroll',
  description:
    'Staff records independent of the academic roster, leave types with an approval workflow, dated pay components, and generated payslips. No statutory filing: the figures are produced and the institution files them.',
  version: '0.1.0',
  alwaysEnabled: false,
  // Nothing: an institution that has bought no other module should still be
  // able to run its payroll.
  dependsOn: [],
  pricing: { model: 'not_priced_yet', priceINR: null },

  rolesWithAccess: ['super_admin', 'institution_admin', 'accounts_staff', 'faculty'],

  navEntries: [
    { label: 'Staff', href: '/m/hr', roles: ['institution_admin', 'accounts_staff'] },
    { label: 'Leave', href: '/m/hr/leave', roles: ['institution_admin', 'accounts_staff'] },
    { label: 'Payroll', href: '/m/hr/payroll', roles: ['institution_admin', 'accounts_staff'] },
    { label: 'My employment', href: '/m/hr/me', roles: ['faculty'] },
  ],

  apiBasePath: '/api/v1/modules/hr',
}
