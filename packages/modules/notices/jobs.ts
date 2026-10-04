import { z } from 'zod'
import type { PluginJob } from '@campusos/module-framework'
import { publishWithin } from './api/operations'

export const jobs: PluginJob[] = [{
  kind: 'notices.publish',
  roles: ['institution_admin', 'super_admin', 'hod', 'faculty', 'accounts_staff', 'library_staff', 'hostel_staff'],
  run: (actor, tx, payload) => publishWithin(tx, actor, z.uuid().parse(payload.noticeId)),
}]
