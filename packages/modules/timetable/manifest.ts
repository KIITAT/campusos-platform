import type { ModuleManifest } from '@campusos/module-framework'

/**
 * The timetable solver, as a module of its own on top of the academic core.
 *
 * The academic core keeps the live weekly slots and is always on; this module
 * is how an office builds them -- periods, who may teach what, each class's
 * weekly need, pins -- and runs a local solver that drafts the whole week,
 * teachers and rooms included, for the office to review and apply. Nothing
 * leaves the server: no API key, no service.
 */
export const manifest: ModuleManifest = {
  id: 'timetable',
  name: 'Timetable',
  description:
    'Builds the whole week locally: who teaches each class (by course, programme and year, with preferences) and when and where every period meets, around pins, unavailability and labs, with each cohort’s and each teacher’s timetable to read and print.',
  version: '0.1.0',
  alwaysEnabled: false,
  dependsOn: ['academic'],
  softDependsOn: ['attendance'],
  pricing: { model: 'not_priced_yet', priceINR: null },

  rolesWithAccess: ['super_admin', 'institution_admin', 'hod', 'faculty'],

  // The screens are specified in SCREENS.md and not built yet: nothing to link.
  navEntries: [],

  apiBasePath: '/api/v1/modules/timetable',
}
