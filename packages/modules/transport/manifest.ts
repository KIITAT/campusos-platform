import type { ModuleManifest } from '@campusos/module-framework'
import { MEMBERS } from './api/core'
export const manifest: ModuleManifest = {
  id: 'transport', name: 'Transport', description: 'Transport workflows for this institution.', version: '0.4.0', alwaysEnabled: false, dependsOn: [],
  // fees, softly: seats are charged to the fee account only where it runs (ACC-28).
  softDependsOn: ['fees'],
  pricing: { model: 'not_priced_yet', priceINR: null }, rolesWithAccess: MEMBERS,
  navEntries: [{ label: 'Transport', href: '/m/transport', roles: MEMBERS }], routeRoles: true, apiBasePath: '/api/v1/modules/transport',
}
