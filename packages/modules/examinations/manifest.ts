import type { ModuleManifest } from '@campusos/module-framework'

export const manifest: ModuleManifest = {
  id: 'examinations',
  name: 'Examinations & Grading',
  description:
    'Exam scheduling, marks entry with publish-locking, configurable grade scales and transcripts; the examination cycle -- enrolment, admit cards, backlog booking, semester grade reports, sealed question papers -- and statistics.',
  version: '0.3.2',
  alwaysEnabled: false,
  dependsOn: ['academic'],
  softDependsOn: ['feedback', 'fees'],
  pricing: { model: 'not_priced_yet', priceINR: null },

  rolesWithAccess: [
    'super_admin',
    'institution_admin',
    'hod',
    'faculty',
    'student',
  ],

  navEntries: [
    { label: 'Examinations', href: '/m/examinations', roles: ['institution_admin', 'hod', 'faculty'] },
    { label: 'Exam cycle', href: '/m/examinations/cycle', roles: ['institution_admin', 'hod'] },
    { label: 'Exam booking', href: '/m/examinations/booking', roles: ['student'] },
    { label: 'My results', href: '/m/examinations/me', roles: ['student'] },
    { label: 'My performance', href: '/m/examinations/performance', roles: ['student'] },
    { label: 'Grade scales', href: '/m/examinations/scales', roles: ['institution_admin'] },
  ],

  apiBasePath: '/api/v1/modules/examinations',
}
