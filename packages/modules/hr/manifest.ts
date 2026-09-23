import type { ModuleManifest } from '@campusos/module-framework'

export const manifest: ModuleManifest = {
  id: 'hr',
  name: 'HR & Payroll',
  description:
    'The whole of HR: staff records and their history (onboarding, transfers, promotions, separation and exit interviews), leave policies with allocation, carry-forward, earned and encashed days, shifts and rosters, recruitment from requisition to hire, appraisals with KRAs, goals and colleague feedback, expense claims and advances, and payroll from salary structures with configurable tax and gratuity, posting to the books. No statutory filing, and no statutory rate seeded: the institution enters its own.',
  version: '0.3.0',
  alwaysEnabled: false,
  /**
   * finance, and nothing else. No academic module: a cook needs a payslip and
   * never teaches a section. The books are different -- a payroll that does not
   * reach them is a cost the institution cannot see, and an institution running
   * payroll has books whether or not it has students.
   */
  dependsOn: ['finance'],
  pricing: { model: 'not_priced_yet', priceINR: null },

  rolesWithAccess: ['super_admin', 'institution_admin', 'accounts_staff', 'hod', 'faculty'],

  navEntries: [
    { label: 'Staff', href: '/m/hr', roles: ['institution_admin', 'accounts_staff'] },
    { label: 'Leave', href: '/m/hr/leave', roles: ['institution_admin', 'accounts_staff'] },
    { label: 'Payroll', href: '/m/hr/payroll', roles: ['institution_admin', 'accounts_staff'] },
    { label: 'Onboarding', href: '/m/hr/onboarding', roles: ['institution_admin', 'accounts_staff'] },
    { label: 'Employment history', href: '/m/hr/lifecycle', roles: ['institution_admin', 'accounts_staff'] },
    { label: 'Leave policy', href: '/m/hr/leave/policy', roles: ['institution_admin', 'accounts_staff'] },
    { label: 'Shifts', href: '/m/hr/shifts', roles: ['institution_admin', 'accounts_staff'] },
    { label: 'Recruitment', href: '/m/hr/recruitment', roles: ['institution_admin', 'accounts_staff'] },
    { label: 'Performance', href: '/m/hr/performance', roles: ['institution_admin', 'accounts_staff'] },
    { label: 'Pay setup', href: '/m/hr/payroll/setup', roles: ['institution_admin', 'accounts_staff'] },
    { label: 'My employment', href: '/m/hr/me', roles: ['faculty'] },
    { label: 'My interviews', href: '/m/hr/interviews', roles: ['faculty', 'hod'] },
    { label: 'My appraisals', href: '/m/hr/appraisal', roles: ['faculty', 'hod'] },
    { label: 'Claims', href: '/m/hr/claims', roles: ['institution_admin', 'accounts_staff', 'faculty', 'hod'] },
  ],

  apiBasePath: '/api/v1/modules/hr',
}
