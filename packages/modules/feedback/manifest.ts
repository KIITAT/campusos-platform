import type { ModuleManifest } from '@campusos/module-framework'

export const manifest: ModuleManifest = {
  id: 'feedback',
  name: 'Feedback',
  description:
    'Questionnaires the institution writes, opened to students in windows each term: on every class and its teacher, before the mid-semester and at the end, and on facilities and the curriculum. Anonymous by construction; results shown only once enough have answered.',
  version: '0.1.0',
  alwaysEnabled: false,
  dependsOn: ['academic'],
  softDependsOn: [],
  pricing: { model: 'not_priced_yet', priceINR: null },

  rolesWithAccess: ['super_admin', 'institution_admin', 'hod', 'faculty', 'student'],

  navEntries: [
    { label: 'Feedback', href: '/m/feedback', roles: ['institution_admin', 'super_admin', 'hod'] },
    { label: 'Questionnaires', href: '/m/feedback/forms', roles: ['institution_admin', 'super_admin', 'hod'] },
    { label: 'Feedback on my classes', href: '/m/feedback/results', roles: ['faculty'] },
    { label: 'Give feedback', href: '/m/feedback/me', roles: ['student'] },
  ],

  apiBasePath: '/api/v1/modules/feedback',
}
