import { STAFF, type ModuleManifest } from '@campusos/module-framework'

export const manifest: ModuleManifest = {
  id: 'reports',
  name: 'Reports',
  description: 'Reports built without code over the datasets other modules publish: columns, filters, groups and totals, a chart, a schedule, and a dashboard for each role. Queries read the reporting replica when one is configured. Any report exports to CSV and, for administrators, to Parquet.',
  version: '0.1.0',
  alwaysEnabled: false,
  dependsOn: ['notices'],
  pricing: { model: 'not_priced_yet', priceINR: null },
  rolesWithAccess: [...STAFF],
  navEntries: [
    { label: 'Dashboard', href: '/m/reports', roles: [...STAFF] },
    { label: 'Reports', href: '/m/reports/reports', roles: [...STAFF] },
  ],
  routeRoles: true,
  apiBasePath: '/api/v1/modules/reports',
}
