import { validatePlugin, type Plugin } from '@campusos/module-framework'
import { manifest } from './manifest'
import { paths as openapiPaths } from './api/openapi'
import { routes } from './routes'
import { pages } from './pages'

export const plugin: Plugin = { manifest, routes, openapiPaths, pages }
validatePlugin(plugin)

export default plugin
