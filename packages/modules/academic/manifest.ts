import type { ModuleManifest } from '@campusos/module-framework'

/**
 * Bundled base, not a paid add-on -- but structured as an ordinary module so
 * "what if we bundle differently later" stays a config change rather than a
 * refactor. alwaysEnabled means the entitlement table is never consulted for
 * it, so it needs no row per institution.
 */
export const manifest: ModuleManifest = {
  id: 'academic',
  name: 'Academic Core',
  description:
    'Departments, programmes, courses, terms, cohorts, rooms and the weekly timetable.',
  version: '0.1.0',
  alwaysEnabled: true,
  dependsOn: [],
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
      label: 'Timetable',
      href: '/m/academic',
      roles: ['institution_admin', 'hod', 'faculty', 'student'],
    },
    {
      label: 'Structure',
      href: '/m/academic/structure',
      roles: ['institution_admin', 'hod'],
    },
    {
      label: 'Cohorts',
      href: '/m/academic/cohorts',
      roles: ['institution_admin', 'hod'],
    },
  ],

  apiBasePath: '/api/v1/modules/academic',
}
