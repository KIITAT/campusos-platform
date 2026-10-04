import type { ModuleManifest } from '@campusos/module-framework'
import { MEMBERS } from './api/core'
export const manifest: ModuleManifest = {
  id: 'transport', name: 'Transport', description: 'Transport workflows for this institution.', version: '0.1.0', alwaysEnabled: false, dependsOn: [],
  pricing: { model: 'not_priced_yet', priceINR: null }, rolesWithAccess: MEMBERS,
  navEntries: [{ label: 'Transport', href: '/m/transport', roles: MEMBERS }], apiBasePath: '/api/v1/modules/transport',
}
