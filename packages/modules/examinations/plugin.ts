import { validatePlugin, type Plugin } from '@campusos/module-framework'
import { manifest } from './manifest'
import { paths as openapiPaths } from './api/openapi'
import { routes } from './routes'

/**
 * The single entry point the host imports after installing this package.
 *
 * Validated at module scope, so a plugin that declares something the host
 * cannot honour -- a route outside its own base path, a duplicate, an
 * apiBasePath that does not match its id -- fails on load rather than on the
 * first request in a corridor.
 */
export const plugin: Plugin = { manifest, routes, openapiPaths }
validatePlugin(plugin)

export default plugin
