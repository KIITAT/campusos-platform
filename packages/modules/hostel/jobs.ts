import type { PluginJob } from '@campusos/module-framework'
import { consumeLibraryEvents } from './api/consume'
import { curfewSweep } from './api/curfew'

/**
 * The hostel's minute jobs (P2-22a). Each checks its own entitlement on the
 * job's transaction and does nothing for an institution without the module.
 */
const roles: PluginJob['roles'] = ['institution_admin', 'super_admin', 'hostel_staff']

export const jobs: PluginJob[] = [
  {
    kind: 'hostel.consume-library-events',
    roles,
    everyMinutes: 1,
    run: async (actor, tx) => consumeLibraryEvents(tx, actor.institutionId!),
  },
  {
    kind: 'hostel.curfew-sweep',
    roles,
    everyMinutes: 1,
    run: async (actor, tx) => curfewSweep(tx, actor.institutionId!),
  },
]
