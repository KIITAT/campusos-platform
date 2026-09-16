import type { ModuleManifest } from '@campusos/module-framework'

export const manifest: ModuleManifest = {
  id: 'hostel',
  name: 'Hostel',
  description:
    'Blocks and rooms, allocation with occupancy limits, nightly roll call, leave records and the visitor register. Uses the Attendance module for scan-based roll call when it is enabled, and a manual register when it is not.',
  version: '0.1.0',
  alwaysEnabled: false,
  dependsOn: ['academic'],
  // Not a hard dependency: roll call degrades to a manual register without it.
  softDependsOn: ['attendance'],
  pricing: { model: 'not_priced_yet', priceINR: null },

  rolesWithAccess: [
    'super_admin',
    'institution_admin',
    'hostel_staff',
    'student',
  ],

  navEntries: [
    { label: 'Hostel', href: '/m/hostel', roles: ['institution_admin', 'hostel_staff'] },
    { label: 'Roll call', href: '/m/hostel/rollcall', roles: ['institution_admin', 'hostel_staff'] },
    { label: 'Visitors', href: '/m/hostel/visitors', roles: ['institution_admin', 'hostel_staff'] },
    { label: 'My hostel', href: '/m/hostel/me', roles: ['student'] },
  ],

  apiBasePath: '/api/v1/modules/hostel',
}
