import type { ModuleManifest } from '@campusos/module-framework'

export const manifest: ModuleManifest = {
  id: 'library',
  name: 'Library',
  description:
    'Catalogue of titles and physical copies, issue and return at the desk, overdue fines with configurable rules, and a borrowing status view for students.',
  version: '0.1.0',
  alwaysEnabled: false,
  dependsOn: ['academic'],
  pricing: { model: 'not_priced_yet', priceINR: null },

  rolesWithAccess: [
    'super_admin',
    'institution_admin',
    'library_staff',
    'faculty',
    'student',
  ],

  navEntries: [
    { label: 'Library desk', href: '/m/library', roles: ['institution_admin', 'library_staff'] },
    { label: 'Catalogue', href: '/m/library/catalogue', roles: ['institution_admin', 'library_staff', 'faculty', 'student'] },
    { label: 'Overdue', href: '/m/library/overdue', roles: ['institution_admin', 'library_staff'] },
    { label: 'My library', href: '/m/library/me', roles: ['student', 'faculty'] },
  ],

  apiBasePath: '/api/v1/modules/library',
}
