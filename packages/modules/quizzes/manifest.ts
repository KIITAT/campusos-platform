import type { ModuleManifest } from '@campusos/module-framework'

export const manifest: ModuleManifest = {
  id: 'quizzes',
  name: 'Quizzes',
  description:
    "A question bank per course; quizzes set from it for a class, with a window, a time limit and attempts; answers scored by the machine the moment they are submitted, with item analysis for the teacher. Practice and feedback, kept apart from grades: nothing here writes a mark.",
  version: '0.1.2',
  alwaysEnabled: false,
  dependsOn: ['academic'],
  softDependsOn: [],
  pricing: { model: 'not_priced_yet', priceINR: null },

  rolesWithAccess: ['super_admin', 'institution_admin', 'hod', 'faculty', 'student'],

  navEntries: [
    { label: 'Quizzes', href: '/m/quizzes', roles: ['institution_admin', 'super_admin', 'hod', 'faculty'] },
    { label: 'Question bank', href: '/m/quizzes/bank', roles: ['institution_admin', 'super_admin', 'hod', 'faculty'] },
    { label: 'My quizzes', href: '/m/quizzes/me', roles: ['student'] },
  ],

  apiBasePath: '/api/v1/modules/quizzes',
}
