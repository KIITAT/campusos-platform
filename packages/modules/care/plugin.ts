import { validatePlugin, withRouteRoles, type Plugin } from '@campusos/module-framework'
import { routeRoles } from './route-roles'
import { manifest } from './manifest'
import { paths as openapiPaths } from './api/openapi'
import { routes } from './routes'
import { pages } from './pages'

/** The single entry point the host imports after installing this package. */
export const plugin: Plugin = withRouteRoles({ manifest, routes, openapiPaths, pages }, routeRoles)
validatePlugin(plugin)

export default plugin
