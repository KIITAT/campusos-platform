import { validatePlugin, withRouteRoles, type Plugin } from '@campusos/module-framework'
import { issueAssentChallenge, markChallengeDeliveryFailed } from './api'
import { manifest } from './manifest'

/**
 * What the web host may call to mail a confirmation code. The module issues
 * the code and keeps its digest; only the host holds the mail server
 * (decision D854). Read-only: nothing here is a route a browser can reach.
 */
export interface AssentMailer {
  readonly issue: typeof issueAssentChallenge
  readonly deliveryFailed: typeof markChallengeDeliveryFailed
}
export type DocumentsPlugin = Plugin & { readonly assentMailer: AssentMailer }

const base = withRouteRoles({ manifest, routes: [], openapiPaths: {} }, {})
export const plugin: DocumentsPlugin = Object.freeze({
  ...base,
  assentMailer: Object.freeze({ issue: issueAssentChallenge, deliveryFailed: markChallengeDeliveryFailed }),
})
validatePlugin(plugin)
export default plugin
