import type { ModuleManifest } from '@campusos/module-framework'

/**
 * Registration, kept apart from the academic core on purpose.
 *
 * The core says what exists -- programmes, courses, terms, offerings. This says
 * what happened: who registered for what, when the window was open, who was
 * waitlisted behind whom, and who dropped on which day. An institution that
 * registers students on paper can leave it uninstalled and still keep a
 * timetable, and an institution that wants it does not have to take a change to
 * the bundled base to get it.
 *
 * The separation also keeps the add/drop record honest. Every change is an
 * event with a date on it, because the fee proration in Student Financials is
 * keyed to the day a course was dropped, not to the fact that it no longer
 * appears on a list.
 */
export const manifest: ModuleManifest = {
  id: 'enrollment',
  name: 'Enrollment',
  description:
    'Registration windows, prerequisite checking, seat limits and waitlists, and add/drop with a dated event for every change.',
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
    {
      label: 'Registration',
      href: '/m/enrollment',
      roles: ['student', 'institution_admin', 'hod'],
    },
    {
      label: 'Roster',
      href: '/m/enrollment/roster',
      roles: ['institution_admin', 'hod', 'faculty'],
    },
    {
      label: 'Seats',
      href: '/m/enrollment/seats',
      roles: ['institution_admin', 'hod'],
    },
  ],

  apiBasePath: '/api/v1/modules/enrollment',
}
