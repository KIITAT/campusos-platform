import type { ModuleManifest } from '@campusos/module-framework'

export const manifest: ModuleManifest = {
  id: 'care',
  name: 'Student Care',
  description:
    'Confidential self-checks a student takes for themselves (PHQ-9, GAD-7, and the institution’s own), counselling they ask for, the counsellors’ cases and appointments, and statistics the office sees only as counts.',
  version: '0.1.2',
  alwaysEnabled: false,
  dependsOn: ['academic', 'notices'],
  pricing: { model: 'not_priced_yet', priceINR: null },

  rolesWithAccess: ['super_admin', 'institution_admin', 'hod', 'faculty', 'accounts_staff', 'library_staff', 'hostel_staff', 'student'],

  navEntries: [
    { label: 'Student care', href: '/m/care', roles: ['student'] },
    {
      label: 'Counselling',
      href: '/m/care/queue',
      roles: ['super_admin', 'institution_admin', 'hod', 'faculty', 'accounts_staff', 'library_staff', 'hostel_staff'],
    },
  ],

  apiBasePath: '/api/v1/modules/care',
}
