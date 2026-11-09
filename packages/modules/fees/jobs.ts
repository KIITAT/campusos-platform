import type { PluginJob } from '@campusos/module-framework'
import { checkReceivable, type Actor } from './api/operations'

/** Σ student ledgers against the fees receivable, every night (ACC-20). */
export const jobs: PluginJob[] = [{
  kind: 'fees.check-receivable',
  roles: ['institution_admin', 'accounts_staff', 'super_admin'],
  daily: true,
  run: (actor, tx) => checkReceivable(actor as unknown as Actor, tx),
}]
