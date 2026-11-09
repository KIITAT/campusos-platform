import { OFFICE, STAFF, type ModuleManifest } from '@campusos/module-framework'

export const manifest: ModuleManifest = {
  id: 'projects',
  name: 'Projects and timesheets',
  description: 'Projects with stages, milestones and tasks. Staff log time against tasks; the project manager approves it; the accounts office bills approved time through the books once and costs it to the project\'s cost centre; profitability is read from the ledger.',
  version: '0.2.0',
  alwaysEnabled: false,
  dependsOn: ['finance'],
  pricing: { model: 'not_priced_yet', priceINR: null },
  rolesWithAccess: [...STAFF],
  navEntries: [
    { label: 'Projects', href: '/m/projects', roles: [...STAFF] },
    { label: 'Timesheets', href: '/m/projects/timesheets', roles: [...STAFF] },
    { label: 'Billing and costs', href: '/m/projects/money', roles: [...OFFICE] },
    { label: 'Profitability', href: '/m/projects/profitability', roles: [...OFFICE] },
  ],
  routeRoles: true,
  apiBasePath: '/api/v1/modules/projects',
}
