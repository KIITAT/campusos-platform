import type { ModuleManifest } from '@campusos/module-framework'

export const manifest: ModuleManifest = {
  id: 'mentoring',
  name: 'Mentoring',
  description:
    'A mentor and co-mentor for every student, who see the whole of them -- record, attendance, results, fees, where they live -- keep notes, talk with them, and decide their leave. Approved leave reaches the hostel roll call.',
  version: '0.1.0',
  alwaysEnabled: false,
  dependsOn: ['academic'],
  softDependsOn: ['attendance', 'examinations', 'fees', 'hostel'],
  pricing: { model: 'not_priced_yet', priceINR: null },

  rolesWithAccess: ['super_admin', 'institution_admin', 'hod', 'faculty', 'student'],

  navEntries: [
    { label: 'Mentors', href: '/m/mentoring', roles: ['institution_admin', 'super_admin', 'hod'] },
    { label: 'My mentees', href: '/m/mentoring/mentees', roles: ['faculty', 'hod'] },
    { label: 'Leave requests', href: '/m/mentoring/leave', roles: ['faculty', 'hod', 'institution_admin', 'super_admin'] },
    { label: 'My mentor and leave', href: '/m/mentoring/me', roles: ['student'] },
  ],

  apiBasePath: '/api/v1/modules/mentoring',
}
