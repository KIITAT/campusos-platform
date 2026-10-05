import { validatePlugin, withImports, type Plugin } from '@campusos/module-framework'
import { withTenantBatch } from '@campusos/db'
import { manifest } from './manifest'
import { paths as openapiPaths } from './api/openapi'
import { routes } from './routes'
import { pages } from './pages'
import { imports } from './imports'
import { jobs } from './jobs'

export const plugin: Plugin = withImports({ manifest, routes, openapiPaths, pages, jobs }, imports, withTenantBatch)
validatePlugin(plugin)

export default plugin
