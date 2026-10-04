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
  version: '0.4.0',
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
      href: '/m/attendance',
      roles: ['institution_admin', 'hod', 'faculty'],
    },
    { label: 'My attendance', href: '/m/attendance/me', roles: ['student'] },
    { label: 'My device', href: '/m/attendance/device', roles: ['student'] },
    { label: 'Offline policy', href: '/m/attendance/offline-policy', roles: ['institution_admin', 'super_admin'] },
    { label: 'Absentees', href: '/m/attendance/absentees', roles: ['institution_admin', 'hod', 'faculty'] },
    { label: 'Excuses', href: '/m/attendance/excuses', roles: ['institution_admin', 'hod', 'faculty'] },
    {
      label: 'Devices',
      href: '/m/attendance/devices',
      roles: ['institution_admin'],
    },
  ],

  apiBasePath: '/api/v1/modules/attendance',
}
