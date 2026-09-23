import type { ModuleManifest } from '@campusos/module-framework'

export const manifest: ModuleManifest = {
  id: 'ceremonies',
  name: 'Ceremonies',
  description:
    'Convocation: who may graduate, found by the degree audit rather than by a list somebody typed; replies and guests; office holds; check-in on the day; and degree certificates, issued only to a student the audit cleared, revoked with a reason and reissued under a new serial.',
  version: '0.1.0',
  alwaysEnabled: false,
  dependsOn: ['academic'],
  softDependsOn: [],
  pricing: { model: 'not_priced_yet', priceINR: null },

  rolesWithAccess: ['super_admin', 'institution_admin', 'hod', 'faculty', 'student'],

  navEntries: [
    { label: 'Ceremonies', href: '/m/ceremonies', roles: ['institution_admin', 'super_admin', 'hod'] },
    { label: 'Check-in', href: '/m/ceremonies/checkin', roles: ['institution_admin', 'super_admin', 'hod', 'faculty'] },
    { label: 'My graduation', href: '/m/ceremonies/me', roles: ['student'] },
  ],

  apiBasePath: '/api/v1/modules/ceremonies',
}
