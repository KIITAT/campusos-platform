import type { ModuleManifest } from '@campusos/module-framework'

export const manifest: ModuleManifest = {
  id: 'notices',
  name: 'Communication & Notices',
  description:
    'Notice board and circulars scoped by role and department, plus the in-app notification centre every other module writes into. Email delivery when a provider is configured; SMS and WhatsApp are a separately priced channel module later.',
  version: '0.1.1',
  // An institution with no way to tell its students anything is not a working
  // install, so this is part of the base product rather than an upsell.
  alwaysEnabled: true,
  dependsOn: ['academic'],
  pricing: { model: 'included_in_base', priceINR: null },

  rolesWithAccess: [
    'super_admin',
    'institution_admin',
    'hod',
    'faculty',
    'accounts_staff',
    'library_staff',
    'hostel_staff',
    'student',
    'parent',
  ],

  navEntries: [
    { label: 'Notices', href: '/m/notices', roles: ['super_admin', 'institution_admin', 'hod', 'faculty', 'accounts_staff', 'library_staff', 'hostel_staff', 'student', 'parent'] },
    { label: 'Inbox', href: '/m/notices/inbox', roles: ['super_admin', 'institution_admin', 'hod', 'faculty', 'accounts_staff', 'library_staff', 'hostel_staff', 'student', 'parent'] },
  ],

  apiBasePath: '/api/v1/modules/notices',

  notifications: { route: '/inbox?unread=1', href: '/m/notices/inbox' },
}
