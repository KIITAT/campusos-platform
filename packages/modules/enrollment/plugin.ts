import { validatePlugin, type Plugin } from '@campusos/module-framework'
import { manifest } from './manifest'
import { paths as openapiPaths } from './api/openapi'
import { routes } from './routes'
import { pages } from './pages'

/**
 * The single entry point the host imports after installing this package.
 *
 * Validated at module scope, so a plugin that declares something the host
 * cannot honour fails on load rather than on the first request in a corridor.
 */
export const plugin: Plugin = { manifest, routes, openapiPaths, pages }
validatePlugin(plugin)

export default plugin
