import type { ModuleManifest } from '@campusos/module-framework'

export const manifest: ModuleManifest = {
  id: 'ceremonies',
  name: 'Ceremonies',
  description:
    'Convocation: who may graduate, found by the degree audit rather than by a list somebody typed; replies and guests; office holds; check-in on the day; and degree certificates, issued only to a student the audit cleared, revoked with a reason and reissued under a new serial; and numbered school transfer certificates (CBSE Annexure I), issued by the office once the pupil has left and the dues are clear.',
  version: '0.11.0',
  alwaysEnabled: false,
  dependsOn: ['academic'],
  softDependsOn: ['fees', 'library'],
  pricing: { model: 'not_priced_yet', priceINR: null },

  rolesWithAccess: ['super_admin', 'institution_admin', 'hod', 'faculty', 'student'],

  navEntries: [
    { label: 'Ceremonies', href: '/m/ceremonies', roles: ['institution_admin', 'super_admin', 'hod'] },
    { label: 'Transfer certificates', href: '/m/ceremonies/transfer-certificates', roles: ['institution_admin', 'super_admin'] },
    { label: 'Check-in', href: '/m/ceremonies/checkin', roles: ['institution_admin', 'super_admin', 'hod', 'faculty'] },
    { label: 'My graduation', href: '/m/ceremonies/me', roles: ['student'] },
  ],

  routeRoles: true,
  apiBasePath: '/api/v1/modules/ceremonies',
}
