import { validatePlugin, withImports, type Plugin } from '@campusos/module-framework'
import { withTenantBatch } from '@campusos/db'
import { manifest } from './manifest'
import { paths as openapiPaths } from './api/openapi'
import { routes } from './routes'
import { pages } from './pages'
import { imports } from './imports'

/** The single entry point the host imports after installing this package. */
export const plugin: Plugin = withImports({ manifest, routes, openapiPaths, pages }, imports, withTenantBatch)
validatePlugin(plugin)

export default plugin
