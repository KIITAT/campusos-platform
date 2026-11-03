import type { PluginJob } from '@campusos/module-framework'
import { eligibilityWithin, type Actor } from './api'

/**
 * The degree audit for a ceremony's graduands, run off the request (REL-04):
 * a university audits thousands, one cross-module audit each.
 */
export const jobs: PluginJob[] = [{
  kind: 'ceremonies.eligibility',
  roles: ['institution_admin', 'super_admin'],
  run: (actor, tx, payload) => eligibilityWithin(tx, actor as Actor, String(payload.ceremonyId)),
}]
