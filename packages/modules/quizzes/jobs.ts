import type { PluginJob } from '@campusos/module-framework'
import { finaliseExpired } from './api/operations'

/**
 * Attempts whose time and grace are spent, submitted by the clock (REL-07).
 * A view still finalises on read, so nobody sees a stale attempt between runs.
 */
export const jobs: PluginJob[] = [{
  kind: 'quizzes.finalise-expired',
  roles: ['institution_admin', 'accounts_staff', 'super_admin'],
  everyMinutes: 5,
  run: async (_actor, tx) => ({ finalised: await finaliseExpired(tx, {}) }),
}]
