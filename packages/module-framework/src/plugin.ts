import type { ModuleManifest, Role, ViewerScope } from './types'

/**
 * What a module hands the host when it is installed as a plugin.
 *
 * Until now a module contributed its API as files on disk in the host
 * application -- ninety-odd three-line mounts that had to be written, reviewed
 * and kept in step by hand. A module that arrives from the package repository
 * at runtime cannot do that: nobody is there to add files and rebuild.
 *
 * So a module declares its routes instead of mounting them, and the host
 * dispatches. The authorisation story is unchanged: the handler is the same
 * operation it always was, it checks its own permissions, and the host applies
 * the session and the entitlement gate around it exactly as `moduleRoute` did.
 */

/** The caller, as every module already models it. */
export interface PluginActor extends ViewerScope {
  id: string
  email?: string | null
  role: Role
  institutionId: string | null
}

export type PluginMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

export interface PluginRoute {
  method: PluginMethod
  /**
   * Relative to the manifest's `apiBasePath`, leading slash, no trailing one.
   * `/` is the base path itself.
   */
  path: string
  /**
   * Returns a value to be sent as JSON, or `undefined` for 204.
   *
   * A handler that needs to return bytes -- a transcript, a receipt -- sets
   * `raw` and returns a Response itself. That is rare enough to be an opt-in
   * rather than the shape everything pays for.
   */
  handler: (actor: PluginActor, req: Request) => Promise<unknown>
  raw?: boolean
}

/** The whole of a plugin's public surface. */
export interface Plugin {
  manifest: ModuleManifest
  routes: PluginRoute[]
  /** This module's fragment of the OpenAPI document, merged by the host. */
  openapiPaths: Record<string, unknown>
}

/**
 * Match a request path against a route table.
 *
 * Longest match wins, so `/sessions/close` is never swallowed by `/sessions`.
 * No parameter segments: every module reads its identifiers from the query
 * string or the body already, and adding a path-parameter syntax would be a
 * router nobody asked for.
 */
export function matchRoute(
  routes: PluginRoute[],
  method: string,
  path: string,
): PluginRoute | null {
  const wanted = path === '' ? '/' : path.startsWith('/') ? path : `/${path}`
  const candidates = routes.filter(
    (r) => r.method === method && (r.path === wanted || (r.path === '/' && wanted === '/')),
  )
  return candidates[0] ?? null
}

/** Every route a plugin declares, absolute, for logging and documentation. */
export const pluginPaths = (plugin: Plugin): string[] =>
  plugin.routes.map(
    (r) => `${r.method} ${plugin.manifest.apiBasePath}${r.path === '/' ? '' : r.path}`,
  )

/**
 * A plugin is rejected at install time rather than at first request if it
 * declares something the host cannot honour. Cheap, and the alternative is a
 * module that installs cleanly and 404s in a corridor.
 */
export function validatePlugin(plugin: Plugin): void {
  const { manifest, routes } = plugin
  if (!manifest?.id) throw new Error('plugin has no manifest id')
  if (manifest.apiBasePath !== `/api/v1/modules/${manifest.id}`) {
    throw new Error(
      `${manifest.id}: apiBasePath must be /api/v1/modules/${manifest.id}`,
    )
  }

  const seen = new Set<string>()
  for (const r of routes) {
    if (!r.path.startsWith('/')) {
      throw new Error(`${manifest.id}: route ${r.path} must start with a slash`)
    }
    if (r.path !== '/' && r.path.endsWith('/')) {
      throw new Error(`${manifest.id}: route ${r.path} must not end with a slash`)
    }
    const key = `${r.method} ${r.path}`
    if (seen.has(key)) throw new Error(`${manifest.id}: duplicate route ${key}`)
    seen.add(key)
  }

  for (const path of Object.keys(plugin.openapiPaths ?? {})) {
    if (!path.startsWith(manifest.apiBasePath)) {
      throw new Error(`${manifest.id}: documents ${path}, outside its own base path`)
    }
  }
}

// --- the little bits every route needs -------------------------------------

/**
 * Errors shaped the way the host's envelope already recognises: a numeric
 * `status` and a string `code`. Each module has its own error class of exactly
 * this shape, and the host matches structurally rather than by class, so a
 * plugin compiled separately still maps onto the right response.
 */
export class PluginError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/** A body that is absent or unparseable is an empty object, never a 500. */
export const jsonBody = (req: Request): Promise<unknown> =>
  req.json().catch(() => ({}))

export const param = (req: Request, name: string): string | undefined =>
  new URL(req.url).searchParams.get(name) ?? undefined

export function requiredParam(req: Request, name: string): string {
  const v = param(req, name)
  if (!v) throw new PluginError(400, 'missing_param', `${name} is required`)
  return v
}

export const flag = (req: Request, name: string): boolean =>
  new URL(req.url).searchParams.get(name) === '1'
