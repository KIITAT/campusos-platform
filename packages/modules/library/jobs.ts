import type { PluginJob } from '@campusos/module-framework'
import { closingSweep } from './api/closing'

/**
 * The library's one minute sweep (P2-22a): closing reminders, the unconfirmed
 * report and the clock's own check-out. It checks its own entitlement on the
 * job's transaction and does nothing for an institution without the module.
 */
export const jobs: PluginJob[] = [
  {
    kind: 'library.closing-sweep',
    roles: ['institution_admin', 'super_admin', 'library_staff'],
    everyMinutes: 1,
    run: async (actor, tx) => closingSweep(tx, actor.institutionId!),
  },
]
