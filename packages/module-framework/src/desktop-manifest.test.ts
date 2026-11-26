import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validatePlugin, type Plugin } from './plugin'
import type { ModuleManifest } from './types'

/**
 * P2-23 (F1 to F3, W5, W9, W11): optional manifest fields the desktop client
 * reads. Absent, nothing changes; present, they are checked at install.
 */

const base: ModuleManifest = {
  id: 'demo',
  name: 'Demo',
  description: '',
  version: '1.0.0',
  alwaysEnabled: false,
  dependsOn: [],
  pricing: { model: 'not_priced_yet', priceINR: null },
  rolesWithAccess: ['institution_admin'],
  navEntries: [],
  apiBasePath: '/api/v1/modules/demo',
  routeRoles: true,
}
const get = (path: string) => ({ method: 'GET' as const, path, roles: ['institution_admin' as const], handler: async () => ({}) })
const plugin = (over: Partial<ModuleManifest>, paths: string[] = ['/years', '/feed']): Plugin => ({
  manifest: { ...base, ...over },
  routes: paths.map(get),
  openapiPaths: {},
})

test('a manifest without the optional fields still validates', () => {
  validatePlugin(plugin({}))
})

test('desktop metadata is checked', () => {
  validatePlugin(plugin({ desktop: { icon: 'wallet', accent: '#0f766e', codes: ['FIN', 'GL1'], queues: [{ label: 'Approvals', href: '/m/demo/approvals' }] } }))
  for (const bad of [
    { icon: 'Not An Icon' },
    { icon: '' },
    { accent: 'red' },
    { accent: '#12345' },
    { codes: ['lower'] },
    { codes: Array.from({ length: 9 }, (_, i) => `C${i}`) },
    { queues: [{ label: 'x', href: '/m/other/approvals' }] },
    { queues: [{ label: 'x', href: 'https://evil.example/m/demo' }] },
    { queues: Array.from({ length: 9 }, () => ({ label: 'x', href: '/m/demo' })) },
  ])
    assert.throws(() => validatePlugin(plugin({ desktop: bad })), /desktop/, JSON.stringify(bad))
})

test('academicYears and approvals must name a declared GET route', () => {
  validatePlugin(plugin({ academicYears: { route: '/years' }, approvals: { route: '/feed', href: '/m/demo/approvals' } }))
  assert.throws(() => validatePlugin(plugin({ academicYears: { route: '/nope' } })), /academicYears/)
  assert.throws(() => validatePlugin(plugin({ approvals: { route: '/nope', href: '/m/demo/approvals' } })), /approvals/)
  assert.throws(() => validatePlugin(plugin({ approvals: { route: '/feed', href: '/m/other/x' } })), /approvals/)
  const post = { ...plugin({ academicYears: { route: '/years' } }), routes: [{ ...get('/years'), method: 'POST' as const }] }
  assert.throws(() => validatePlugin(post), /academicYears/)
})

test('auditEntities need an entity name and roles, once each', () => {
  validatePlugin(plugin({ auditEntities: [{ entity: 'demo_party', roles: ['institution_admin'] }] }))
  assert.throws(() => validatePlugin(plugin({ auditEntities: [{ entity: 'demo_party', roles: [] }] })), /auditEntities/)
  assert.throws(() => validatePlugin(plugin({ auditEntities: [{ entity: '', roles: ['institution_admin'] }] })), /auditEntities/)
  assert.throws(() => validatePlugin(plugin({ auditEntities: [{ entity: 'a', roles: ['pending'] }] })), /auditEntities/)
  assert.throws(
    () => validatePlugin(plugin({ auditEntities: [{ entity: 'a', roles: ['institution_admin'] }, { entity: 'a', roles: ['hod'] }] })),
    /auditEntities/,
  )
})
