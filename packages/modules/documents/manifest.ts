import { MEMBERS, type ModuleManifest } from '@campusos/module-framework'

export const manifest: ModuleManifest = {
  id: 'documents',
  name: 'Documents',
  description: 'Store institutional files and record electronic assent.',
  version: '0.1.0',
  alwaysEnabled: false,
  dependsOn: [],
  pricing: { model: 'not_priced_yet', priceINR: null },
  rolesWithAccess: MEMBERS,
  navEntries: [{ label: 'Documents', href: '/m/documents', roles: MEMBERS }],
  routeRoles: true,
  apiBasePath: '/api/v1/modules/documents',
}
