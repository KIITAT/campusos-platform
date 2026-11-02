import type { ModuleManifest } from '@campusos/module-framework'
import { STAFF } from './api/core'

export const manifest: ModuleManifest = {
  id: 'crm', name: 'Sales CRM', description: 'Leads, opportunities, a sales pipeline and conversion to a finance customer and quotation.', version: '0.2.0', alwaysEnabled: false, dependsOn: ['finance', 'notices'],
  pricing: { model: 'not_priced_yet', priceINR: null }, rolesWithAccess: [...STAFF],
  navEntries: [{ label: 'Sales CRM', href: '/m/crm', roles: [...STAFF] }], routeRoles: true, apiBasePath: '/api/v1/modules/crm',
}
