import { validatePlugin, withRouteRoles, type Plugin } from '@campusos/module-framework'
import { routeRoles } from './route-roles'
import { manifest } from './manifest'
import { paths as openapiPaths } from './api/openapi'
import { routes } from './routes'
import { pages } from './pages'
import { jobs } from './jobs'

export const plugin: Plugin = withRouteRoles({ manifest, routes, openapiPaths, pages, jobs }, routeRoles)
validatePlugin(plugin)
export default plugin
