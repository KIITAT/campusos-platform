import type { ModuleManifest } from '@campusos/module-framework'
import { MEMBERS } from './api/core'
export const manifest: ModuleManifest = {
  id: 'alumni', name: 'Alumni and events', description: 'Alumni and events workflows for this institution.', version: '0.1.0', alwaysEnabled: false, dependsOn: [],
  pricing: { model: 'not_priced_yet', priceINR: null }, rolesWithAccess: MEMBERS,
  navEntries: [{ label: 'Alumni and events', href: '/m/alumni', roles: MEMBERS }], apiBasePath: '/api/v1/modules/alumni',
}
