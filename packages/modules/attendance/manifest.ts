import type { ModuleManifest } from '@campusos/module-framework'

/**
 * The wedge feature, and the first module with a real dependency. Priced
 * included_in_base for now, which is a one-word change because the entitlement
 * system already treats it as an ordinary add-on.
 */
export const manifest: ModuleManifest = {
  id: 'attendance',
  name: 'Attendance & QR',
  description:
    'Rotating-QR attendance with GPS geofencing and one-device-per-student binding.',
  version: '0.1.0',
  alwaysEnabled: false,
  dependsOn: ['academic'],
  pricing: { model: 'included_in_base', priceINR: null },

  rolesWithAccess: [
    'super_admin',
    'institution_admin',
    'hod',
    'faculty',
    'student',
  ],

  navEntries: [
    {
      label: 'Attendance',
      href: '/attendance',
      roles: ['institution_admin', 'hod', 'faculty'],
    },
    { label: 'My attendance', href: '/attendance/me', roles: ['student'] },
    {
      label: 'Devices',
      href: '/attendance/devices',
      roles: ['institution_admin'],
    },
  ],

  apiBasePath: '/api/v1/modules/attendance',
}
