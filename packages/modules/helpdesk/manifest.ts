import type { ModuleManifest } from '@campusos/module-framework'
import { MEMBERS } from './api/core'
export const manifest: ModuleManifest = {
  id: 'helpdesk', name: 'Helpdesk and grievance', description: 'Helpdesk and grievance workflows for this institution.', version: '0.3.0', alwaysEnabled: false, dependsOn: [],
  pricing: { model: 'not_priced_yet', priceINR: null }, rolesWithAccess: MEMBERS,
  navEntries: [{ label: 'Helpdesk and grievance', href: '/m/helpdesk', roles: MEMBERS }], routeRoles: true, apiBasePath: '/api/v1/modules/helpdesk',
}
