import type { PluginJob } from '@campusos/module-framework'
import { consumeLibraryEvents } from './api/consume'

/**
 * The hostel's minute jobs (P2-22a). Each checks its own entitlement on the
 * job's transaction and does nothing for an institution without the module.
 * The curfew sweep joins this list in the next step.
 */
const roles: PluginJob['roles'] = ['institution_admin', 'super_admin', 'hostel_staff']

export const jobs: PluginJob[] = [
  {
    kind: 'hostel.consume-library-events',
    roles,
    everyMinutes: 1,
    run: async (actor, tx) => consumeLibraryEvents(tx, actor.institutionId!),
  },
]
