import { z } from 'zod'
import { audit } from '@campusos/db'
import type { PluginJob } from '@campusos/module-framework'
import { requireOperate } from './api/core'
import { runRecurringWithin } from './api/trade'
import { postDue } from './api/assets'
import { localToday } from './api/years'

export const jobs: PluginJob[] = [
  { kind: 'finance.recurring', roles: ['institution_admin', 'accounts_staff', 'super_admin'], daily: true,
    run: async (actor, tx, payload) => {
      const tenant = requireOperate(actor)
      const on = z.iso.date().optional().parse(payload.on) ?? await localToday(tx, tenant)
      const result = await runRecurringWithin(tx, actor, on)
      await audit(tx, { institutionId: tenant, actorId: actor.id, moduleId: 'finance', action: 'job.recurring', entity: 'institution', entityId: tenant, reason: 'Scheduled recurring invoices', detail: { on } })
      return result
    },
  },
  { kind: 'finance.depreciation', roles: ['institution_admin', 'accounts_staff', 'super_admin'], daily: true,
    run: async (actor, tx, payload) => {
      const tenant = requireOperate(actor)
      const upTo = z.iso.date().optional().parse(payload.upTo) ?? await localToday(tx, tenant)
      const rows = await postDue(tx, actor, upTo)
      await audit(tx, { institutionId: tenant, actorId: actor.id, moduleId: 'finance', action: 'job.depreciation', entity: 'institution', entityId: tenant, reason: 'Scheduled depreciation', detail: { upTo, rows } })
      return { rows }
    },
  },
]
