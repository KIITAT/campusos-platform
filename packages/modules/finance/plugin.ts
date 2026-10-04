import { validatePlugin, type Plugin } from '@campusos/module-framework'
import { manifest } from './manifest'
import { paths as openapiPaths } from './api/openapi'
import { routes } from './routes'
import { pages } from './pages'
import { jobs } from './jobs'

export const plugin: Plugin = { manifest, routes, openapiPaths, pages, jobs }
validatePlugin(plugin)

export default plugin
