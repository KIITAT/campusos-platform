import { test } from 'node:test'
import assert from 'node:assert/strict'
import { authorizeRoute, validatePlugin, type Plugin, type PluginRoute } from './plugin'
import { ADMIN, MEMBERS, OFFICE, ROLES, STAFF, TEACHING, hasRole } from './roles'
import type { ModuleManifest, Role } from './types'

const manifest = (over: Partial<ModuleManifest> = {}): ModuleManifest => ({
  id: 'example',
  name: 'Example',
  description: '',
  version: '1.0.0',
  alwaysEnabled: false,
  dependsOn: [],
  pricing: { model: 'not_priced_yet', priceINR: null },
  rolesWithAccess: ['institution_admin', 'faculty'],
  navEntries: [],
  apiBasePath: '/api/v1/modules/example',
  ...over,
})
const route = (roles?: Role[]): PluginRoute => ({ method: 'GET', path: '/x', handler: async () => null, ...(roles ? { roles } : {}) })
const plugin = (m: ModuleManifest, routes: PluginRoute[]): Plugin => ({ manifest: m, routes, openapiPaths: {} })

test('a route that declares its roles admits exactly those roles', () => {
  const m = manifest({ routeRoles: true })
  const r = route(['faculty', 'student'])
  for (const role of ROLES) {
    assert.equal(authorizeRoute(m, r, role), role === 'faculty' || role === 'student' ? 'allow' : 'deny', role)
  }
})

test('a route may admit a role the manifest does not list: rolesWithAccess governs menus', () => {
  assert.equal(authorizeRoute(manifest({ routeRoles: true }), route(['hostel_staff']), 'hostel_staff'), 'allow')
})

test('pending is refused on every route, declared or legacy', () => {
  assert.equal(authorizeRoute(manifest({ routeRoles: true }), route(['pending' as Role]), 'pending'), 'deny')
  assert.equal(authorizeRoute(manifest({ rolesWithAccess: ['pending' as Role] }), route(), 'pending'), 'deny')
})

test('a legacy plugin (no routeRoles) is gated by rolesWithAccess: deny by default', () => {
  const m = manifest()
  assert.equal(authorizeRoute(m, route(), 'faculty'), 'allow')
  assert.equal(authorizeRoute(m, route(), 'student'), 'deny')
  assert.equal(authorizeRoute(m, route(), 'parent'), 'deny')
  // A legacy plugin's route roles are not trusted to widen access.
  assert.equal(authorizeRoute(m, route(['student']), 'student'), 'deny')
})

test('a routeRoles module whose route lost its roles refuses everyone', () => {
  for (const role of ROLES) assert.equal(authorizeRoute(manifest({ routeRoles: true }), route(), role), 'deny')
})

test('validatePlugin refuses a routeRoles module with an undeclared, empty, unknown or pending route', () => {
  const m = manifest({ routeRoles: true })
  assert.throws(() => validatePlugin(plugin(m, [route()])), /declares no roles/)
  assert.throws(() => validatePlugin(plugin(m, [route([])])), /declares no roles/)
  assert.throws(() => validatePlugin(plugin(m, [route(['dean' as Role])])), /unknown role dean/)
  assert.throws(() => validatePlugin(plugin(m, [route(['pending' as Role])])), /pending/)
  assert.doesNotThrow(() => validatePlugin(plugin(m, [route(['faculty'])])))
  // A legacy plugin still loads without roles.
  assert.doesNotThrow(() => validatePlugin(plugin(manifest(), [route()])))
})

test('the shared role groups nest as their names say, and none admits pending', () => {
  for (const g of [ADMIN, OFFICE, TEACHING, STAFF, MEMBERS]) assert.ok(!g.includes('pending' as Role))
  for (const r of ADMIN) assert.ok(OFFICE.includes(r) && TEACHING.includes(r) && STAFF.includes(r))
  for (const r of [...OFFICE, ...TEACHING]) assert.ok(STAFF.includes(r))
  for (const r of STAFF) assert.ok(MEMBERS.includes(r))
  assert.ok(!STAFF.includes('student') && !STAFF.includes('parent'))
  assert.deepEqual([...MEMBERS].sort(), ROLES.filter((r) => r !== 'pending').sort())
  assert.equal(hasRole('accounts_staff', OFFICE), true)
  assert.equal(hasRole('faculty', OFFICE), false)
})
