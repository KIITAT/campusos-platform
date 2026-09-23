import type { ModuleManifest } from '@campusos/module-framework'

export const manifest: ModuleManifest = {
  id: 'skills',
  name: 'Skills',
  description:
    'What students can do, judged against a scale the institution writes: by the student themselves and by their teachers, with the evidence, as a history that shows a skill growing. Kept apart from grades; depends on no other module.',
  version: '0.1.2',
  alwaysEnabled: false,
  dependsOn: [],
  softDependsOn: [],
  pricing: { model: 'not_priced_yet', priceINR: null },

  rolesWithAccess: ['super_admin', 'institution_admin', 'hod', 'faculty', 'student'],

  navEntries: [
    { label: 'Skills', href: '/m/skills', roles: ['institution_admin', 'super_admin', 'hod', 'faculty'] },
    { label: 'Students', href: '/m/skills/students', roles: ['institution_admin', 'super_admin', 'hod', 'faculty'] },
    { label: 'My skills', href: '/m/skills/me', roles: ['student'] },
  ],

  apiBasePath: '/api/v1/modules/skills',
}
