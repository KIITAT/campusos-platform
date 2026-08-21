import type { ModuleManifest } from '@campusos/module-framework'

export const manifest: ModuleManifest = {
  id: 'examinations',
  name: 'Examinations & Grading',
  description:
    'Exam scheduling, marks entry with publish-locking, configurable grade scales, and transcripts.',
  version: '0.1.0',
  alwaysEnabled: false,
  dependsOn: ['academic'],
  pricing: { model: 'not_priced_yet', priceINR: null },

  rolesWithAccess: [
    'super_admin',
    'institution_admin',
    'hod',
    'faculty',
    'student',
  ],

  navEntries: [
    { label: 'Examinations', href: '/examinations', roles: ['institution_admin', 'hod', 'faculty'] },
    { label: 'My results', href: '/examinations/me', roles: ['student'] },
    { label: 'Grade scales', href: '/examinations/scales', roles: ['institution_admin'] },
  ],

  apiBasePath: '/api/v1/modules/examinations',
}
