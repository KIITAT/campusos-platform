import type { PluginJob } from '@campusos/module-framework'
import { sendDueReminders } from './api/activities'

/** Sales activities whose reminder time has come; at most 15 minutes late. */
export const jobs: PluginJob[] = [{
  kind: 'crm.activity-reminders',
  roles: ['institution_admin', 'accounts_staff', 'super_admin'],
  everyMinutes: 15,
  run: async (actor, tx) => ({ reminded: await sendDueReminders(tx, actor.institutionId!) }),
}]
