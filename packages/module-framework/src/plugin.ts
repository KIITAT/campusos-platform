import type { ModuleManifest, Role, ViewerScope } from './types'
import { ROLES } from './roles'
import type { PluginPage } from './pages'
import type { JobTransaction } from '@campusos/db/jobs'

export interface PluginJob {
  kind: string
  roles: Role[]
  daily?: boolean
  run: (actor: PluginActor, tx: JobTransaction, payload: Record<string, unknown>) => Promise<unknown>
}

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
  /**
   * The caller's idempotency key, when it sent one: the `Idempotency-Key`
   * header, or the nonce in a portal form. An operation that promises "once per
   * key" passes it to `withIdempotencyKey` (@campusos/db); any other ignores it.
   * It names one act: a handler that runs a keyed operation several times for
   * one request (a bulk action, an import) must not pass this actor to each,
   * or every call after the first is refused as a reused key.
   */
  idempotencyKey?: string
  /**
   * Set by the host for a module an operator listed in
   * CAMPUSOS_AUTHZ_REPORT_ONLY: canAccessStudent logs what it would have
   * refused and allows it (decision 196). Plugins never read the environment.
   */
  authzReportOnly?: boolean
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
  /**
   * Who may call it (decision 192). The host refuses every other role before
   * the handler runs, when the manifest sets `routeRoles`. The operation keeps
   * its own check: page loaders and other modules call it in-process.
   */
  roles?: readonly Role[]
}

/** The whole of a plugin's public surface. */
export interface Plugin {
  manifest: ModuleManifest
  routes: PluginRoute[]
  /** This module's fragment of the OpenAPI document, merged by the host. */
  openapiPaths: Record<string, unknown>
  /**
   * The screens this module contributes, declared rather than drawn. Optional:
   * a module can be API-only, and one that ships no pages simply has no web
   * surface -- its mobile and integration surface is unaffected.
   */
  pages?: PluginPage[]
  jobs?: PluginJob[]
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

/**
 * May this role call this route at all? Deny by default: a module that
 * declares route roles admits only the roles each route names; a legacy one
 * (no `routeRoles`) only the roles its manifest names. `pending` never.
 */
export function authorizeRoute(manifest: ModuleManifest, route: PluginRoute, role: Role): 'allow' | 'deny' {
  if (role === 'pending') return 'deny'
  const admitted = manifest.routeRoles ? route.roles ?? [] : manifest.rolesWithAccess
  return admitted.includes(role) ? 'allow' : 'deny'
}

/**
 * Give each route its roles from one table keyed `METHOD /path`, kept beside
 * the module's routes (`route-roles.ts`). A route without an entry, or an
 * entry without a route, is an error at load: the table cannot drift from the
 * routes. Routes that already carry roles (`withImports`) keep them.
 */
export function withRouteRoles(plugin: Plugin, table: Record<string, readonly Role[]>): Plugin {
  const unused = new Set(Object.keys(table))
  const routes = plugin.routes.map((r) => {
    const key = `${r.method} ${r.path}`
    unused.delete(key)
    if (r.roles) return r
    const roles = table[key]
    if (!roles) throw new Error(`${plugin.manifest.id}: route ${key} has no entry in its role table`)
    return { ...r, roles }
  })
  if (unused.size) throw new Error(`${plugin.manifest.id}: role table names no such route: ${[...unused].join(', ')}`)
  return { ...plugin, routes }
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
  const jobKinds = new Set<string>()
  for (const job of plugin.jobs ?? []) {
    if (!job.kind.startsWith(`${manifest.id}.`) || jobKinds.has(job.kind) || !job.roles.length || typeof job.run !== 'function') throw new Error(`${manifest.id}: invalid or duplicate job ${job.kind}`)
    jobKinds.add(job.kind)
  }
  for (const r of routes) {
    if (!r.path.startsWith('/')) {
      throw new Error(`${manifest.id}: route ${r.path} must start with a slash`)
    }
    if (r.path !== '/' && r.path.endsWith('/')) {
      throw new Error(`${manifest.id}: route ${r.path} must not end with a slash`)
    }
    const key = `${r.method} ${r.path}`
    if (manifest.routeRoles) {
      if (!r.roles?.length) throw new Error(`${manifest.id}: route ${key} declares no roles`)
      for (const role of r.roles) {
        if (!ROLES.includes(role)) throw new Error(`${manifest.id}: route ${key} names unknown role ${role}`)
        if (role === 'pending') throw new Error(`${manifest.id}: route ${key} admits pending`)
      }
    }
    if (seen.has(key)) throw new Error(`${manifest.id}: duplicate route ${key}`)
    seen.add(key)
  }

  const pagePaths = new Set<string>()
  for (const page of plugin.pages ?? []) {
    if (!page.path.startsWith('/')) {
      throw new Error(`${manifest.id}: page ${page.path} must start with a slash`)
    }
    if (pagePaths.has(page.path)) {
      throw new Error(`${manifest.id}: duplicate page ${page.path}`)
    }
    pagePaths.add(page.path)
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
