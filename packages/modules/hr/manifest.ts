import type { ModuleManifest } from '@campusos/module-framework'

export const manifest: ModuleManifest = {
  id: 'hr',
  name: 'HR & Payroll',
  description:
    'Staff records independent of the academic roster, leave types with an approval workflow, dated pay components, and generated payslips. No statutory filing: the figures are produced and the institution files them.',
  version: '0.2.0',
  alwaysEnabled: false,
  /**
   * finance, and nothing else. No academic module: a cook needs a payslip and
   * never teaches a section. The books are different -- a payroll that does not
   * reach them is a cost the institution cannot see, and an institution running
   * payroll has books whether or not it has students.
   */
  dependsOn: ['finance'],
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
