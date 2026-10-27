/**
 * The role-by-route matrix (SEC-16, decision 192).
 *
 * Every module's routes, and which roles the host lets call each, written out as
 * docs/route-roles.matrix.txt and compared with the committed copy: a change to
 * who may call what is a visible line in a reviewed diff. `UPDATE_MATRIX=1`
 * rewrites it.
 *
 * The last column says whether the operation itself refuses every role the
 * route does not declare (`op`), or whether the gate is that route's only role
 * check (`gate`): its operation checks only the tenant, or checks after reading
 * input it was not given here. A route moving from `op` to `gate` means an
 * operation lost its own check.
 *
 * Needs the test database (it renders pages and calls handlers in a throwaway
 * institution, deleted afterwards):
 *   node --import ./packages/db/node_modules/tsx/dist/loader.mjs --test scripts/route-matrix.test.ts
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { eq } from '../packages/db/node_modules/drizzle-orm/index.js'
import { authDb, institutions, users } from '../packages/db/src/index'
import { ROLES, authorizeRoute, type Plugin, type PluginActor, type PluginSection, type Role } from '../packages/module-framework/src/index'

const root = resolve(import.meta.dirname, '..')
const matrixFile = join(root, 'docs/route-roles.matrix.txt')
const COLUMNS: [Role, string][] = [
  ['super_admin', 'S'], ['institution_admin', 'I'], ['hod', 'H'], ['faculty', 'F'], ['accounts_staff', 'A'],
  ['library_staff', 'L'], ['hostel_staff', 'O'], ['student', 's'], ['parent', 'p'], ['pending', 'n'],
]

/**
 * What the mobile app calls, by role, with no page in between
 * (campusos-mobile lib/api.dart). The gate must keep these open.
 */
const MOBILE: [Role, string, string][] = [
  ['student', 'POST', '/api/v1/modules/attendance/scan'],
  ['student', 'POST', '/api/v1/modules/attendance/scan/signed'],
  ['student', 'GET', '/api/v1/modules/attendance/devices/mine'],
  ['student', 'POST', '/api/v1/modules/attendance/devices'],
  ['student', 'GET', '/api/v1/modules/attendance/me'],
  ['student', 'GET', '/api/v1/modules/examinations/transcript'],
  ['student', 'GET', '/api/v1/modules/library/status'],
  ['student', 'GET', '/api/v1/modules/academic/timetable'],
  ['student', 'GET', '/api/v1/modules/notices/inbox'],
  ['faculty', 'POST', '/api/v1/modules/attendance/sessions/prepare'],
  ['faculty', 'POST', '/api/v1/modules/attendance/sessions/held'],
  ['faculty', 'POST', '/api/v1/modules/attendance/sessions/prepare/revoke'],
]

const plugins: Plugin[] = []
let inst: string
const actors = new Map<Role, PluginActor>()

before(async () => {
  const directory = join(root, 'packages/modules')
  for (const id of readdirSync(directory).filter((n) => existsSync(join(directory, n, 'plugin.ts'))).sort()) {
    plugins.push((await import(pathToFileURL(join(directory, id, 'plugin.ts')).href)).plugin)
  }
  await authDb.delete(institutions).where(eq(institutions.slug, 'route-matrix'))
  const [row] = await authDb.insert(institutions).values({ slug: 'route-matrix', name: 'Route matrix', allowedEmailDomains: [] }).returning()
  inst = row!.id
  const people = await authDb.insert(users).values(ROLES.map((role) => ({ institutionId: inst, email: `${role}@route-matrix.test`, role }))).returning()
  for (const p of people) actors.set(p.role, { id: p.id, email: p.email, role: p.role, institutionId: inst })
})
after(async () => {
  if (inst) await authDb.delete(institutions).where(eq(institutions.id, inst))
})

const url = (plugin: Plugin, path: string) => `http://localhost${plugin.manifest.apiBasePath}${path === '/' ? '' : path}`

/** Does the operation refuse this role on its own, given nothing? */
async function refuses(plugin: Plugin, route: Plugin['routes'][number], role: Role): Promise<boolean> {
  const req = new Request(url(plugin, route.path), route.method === 'GET'
    ? { method: 'GET' }
    : { method: route.method, body: '{}', headers: { 'content-type': 'application/json' } })
  try {
    await route.handler(actors.get(role)!, req)
    return false
  } catch (e) {
    return (e as { status?: number }).status === 403
  }
}

test('every route declares its roles, and the gate refuses every other role and pending', () => {
  for (const plugin of plugins) {
    assert.equal(plugin.manifest.routeRoles, true, `${plugin.manifest.id} does not set routeRoles`)
    for (const route of plugin.routes) {
      assert.ok(route.roles?.length, `${plugin.manifest.id} ${route.method} ${route.path} declares no roles`)
      for (const [role] of COLUMNS) {
        const want = role !== 'pending' && route.roles!.includes(role) ? 'allow' : 'deny'
        assert.equal(authorizeRoute(plugin.manifest, route, role), want, `${plugin.manifest.id} ${route.method} ${route.path} ${role}`)
      }
    }
  }
})

test('the matrix matches docs/route-roles.matrix.txt', async () => {
  const lines = [
    '# Who may call each module route (decision 192). Generated by scripts/route-matrix.test.ts;',
    '# rewrite with UPDATE_MATRIX=1. Columns: ' + COLUMNS.map(([r, c]) => `${c}=${r}`).join(' ') + '.',
    '# Last column: op = the operation also refuses every undeclared role; gate = the gate is its only role check.',
  ]
  for (const plugin of plugins) {
    lines.push('', `## ${plugin.manifest.id} ${plugin.manifest.version}`)
    for (const route of plugin.routes) {
      const cells = COLUMNS.map(([role, c]) => (authorizeRoute(plugin.manifest, route, role) === 'allow' ? c : '.')).join('')
      let own = 'op'
      for (const [role] of COLUMNS) {
        if (route.roles!.includes(role)) continue
        if (!(await refuses(plugin, route, role))) { own = 'gate'; break }
      }
      lines.push(`${`${route.method} ${plugin.manifest.apiBasePath}${route.path === '/' ? '' : route.path}`.padEnd(72)} ${cells} ${own}`)
    }
  }
  const text = `${lines.join('\n')}\n`
  if (process.env.UPDATE_MATRIX === '1') writeFileSync(matrixFile, text)
  assert.equal(text, existsSync(matrixFile) ? readFileSync(matrixFile, 'utf8').replaceAll('\r\n', '\n') : '', 'the route matrix changed: review, then UPDATE_MATRIX=1')
})

test('the mobile app’s calls stay open to the roles that make them', () => {
  for (const [role, method, path] of MOBILE) {
    const plugin = plugins.find((p) => path.startsWith(`${p.manifest.apiBasePath}/`))!
    const route = plugin.routes.find((r) => r.method === method && plugin.manifest.apiBasePath + r.path === path)
    assert.ok(route, `${method} ${path} no longer exists`)
    assert.equal(authorizeRoute(plugin.manifest, route, role), 'allow', `${role} ${method} ${path}`)
  }
})

/**
 * A page that offers a button the gate would refuse is a broken screen. Each
 * page is rendered as each of its roles, in the empty institution, and every
 * form, bulk action, document-status button and link into the module's API it
 * shows that role must be a route that admits the role. Controls that appear
 * only with data are not seen here; the operations' own tests cover those.
 */
test('no page offers a role a control whose route refuses that role', async () => {
  const problems: string[] = []
  for (const plugin of plugins) {
    const base = plugin.manifest.apiBasePath
    const check = (page: string, role: Role, method: string, path: string) => {
      const route = plugin.routes.find((r) => r.method === method && r.path === path)
      if (route && authorizeRoute(plugin.manifest, route, role) === 'deny') problems.push(`${plugin.manifest.id} page ${page} offers ${role} ${method} ${path}`)
    }
    for (const page of plugin.pages ?? []) {
      for (const role of page.roles) {
        if (role === 'pending') continue
        let sections: PluginSection[]
        let data: Record<string, unknown>
        try {
          data = await page.load(actors.get(role)!, new Request(`http://localhost/m/${plugin.manifest.id}${page.path}`))
          sections = page.sections(data)
        } catch {
          continue
        }
        const shows = (roles?: Role[]) => !roles || roles.includes(role)
        const hrefs: string[] = []
        for (const s of sections) {
          if (s.kind === 'form' && s.method !== 'GET' && shows(s.roles)) check(page.path, role, s.method ?? 'POST', s.path)
          if (s.kind === 'table') {
            for (const b of s.bulk ?? []) if (shows(b.roles)) check(page.path, role, 'POST', b.path)
            for (const c of s.columns) if (c.href) hrefs.push(c.href)
          }
          if (s.kind === 'links') hrefs.push(...s.links.map((l) => l.href))
          if (s.kind === 'shortcuts') hrefs.push(...s.items.map((l) => l.href))
        }
        const doc = page.record?.(data)?.docStatus
        if (doc && shows(doc.roles)) for (const p of [doc.submit, doc.cancel, doc.amend]) if (p) check(page.path, role, 'POST', p)
        for (const h of hrefs) if (h.startsWith(`${base}/`)) check(page.path, role, 'GET', h.slice(base.length).split('?')[0]!)
      }
    }
  }
  assert.deepEqual(problems, [])
})
