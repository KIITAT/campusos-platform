import type { PluginJob } from '@campusos/module-framework'
import { runDue } from './api/due'

/** Scheduled reports, three at a time, every five minutes (decision 496). Row locks make a second worker skip what the first holds. */
export const jobs: PluginJob[] = [{
  kind: 'reports.run-due',
  roles: ['institution_admin', 'accounts_staff', 'super_admin'],
  everyMinutes: 5,
  run: (actor, tx) => runDue(actor, tx),
}]
