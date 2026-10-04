import type { ModuleManifest } from '@campusos/module-framework'
import { ADMIN, MEMBERS } from './api/core'

export const manifest: ModuleManifest = {
  id: 'placement', name: 'Placement', version: '0.1.0',
  description: 'Employer drives, academic eligibility, student applications, selection rounds and audited offers.',
  alwaysEnabled: false, dependsOn: ['academic'], pricing: { model: 'not_priced_yet', priceINR: null },
  rolesWithAccess: MEMBERS, apiBasePath: '/api/v1/modules/placement',
  navEntries: [
    { label: 'Placements', href: '/m/placement', roles: MEMBERS },
    { label: 'Placement officers', href: '/m/placement/officers', roles: ADMIN },
  ],
}
