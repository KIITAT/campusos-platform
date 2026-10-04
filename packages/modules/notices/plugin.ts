import { validatePlugin, type Plugin } from '@campusos/module-framework'
import { manifest } from './manifest'
import { paths as openapiPaths } from './api/openapi'
import { routes } from './routes'
import { pages } from './pages'
import { jobs } from './jobs'

/**
 * The single entry point the host imports after installing this package.
 *
 * Validated at module scope, so a plugin that declares something the host
 * cannot honour -- a route outside its own base path, a duplicate, an
 * apiBasePath that does not match its id -- fails on load rather than on the
 * first request in a corridor.
 */
export const plugin: Plugin = { manifest, routes, openapiPaths, pages, jobs }
validatePlugin(plugin)

export default plugin
