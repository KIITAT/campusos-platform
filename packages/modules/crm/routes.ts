import * as z from 'zod'
import { type PluginRoute } from '@campusos/module-framework'

export interface RouteSpec extends PluginRoute { summary: string; body?: z.ZodType }
export const specs: RouteSpec[] = []
export const routes: PluginRoute[] = specs
