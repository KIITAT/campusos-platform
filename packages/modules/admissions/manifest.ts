import type { ModuleManifest } from '@campusos/module-framework'
import { ADMIN } from './api/core'
export const manifest: ModuleManifest = {
  id: 'admissions', name: 'Admissions', description: 'Admissions workflows for this institution.', version: '0.2.0', alwaysEnabled: false, dependsOn: ['academic'],
  pricing: { model: 'not_priced_yet', priceINR: null }, rolesWithAccess: ADMIN,
  navEntries: [{ label: 'Admissions', href: '/m/admissions', roles: ADMIN }], routeRoles: true, apiBasePath: '/api/v1/modules/admissions',
}
