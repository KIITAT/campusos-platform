import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { authDb, institutionModules, institutions } from '@campusos/db'
import {
  ModuleDeniedError,
  assertDependenciesEnabled,
  getEnabledModules,
  requireModule,
} from './entitlements'
import { buildNav } from './nav'
import { validateRegistry } from './registry'
import type { ModuleManifest } from './types'

/** A registry local to this file: the framework no longer owns one. */
const registry: ModuleManifest[] = []

const manifest = (over: Partial<ModuleManifest> & { id: string }): ModuleManifest => ({
  name: over.id,
  description: '',
  version: '0.0.0',
  alwaysEnabled: false,
  dependsOn: [],
  pricing: { model: 'not_priced_yet', priceINR: null },
  rolesWithAccess: ['institution_admin'],
  navEntries: [{ label: over.id, href: `/${over.id}`, roles: ['institution_admin'] }],
  apiBasePath: `/api/v1/modules/${over.id}`,
  ...over,
})

let inst: string

before(async () => {
  const [row] = await authDb
    .insert(institutions)
    .values({ slug: 'mf-test', name: 'MF', allowedEmailDomains: ['mf.test'] })
    .returning({ id: institutions.id })
  inst = row!.id
})

after(async () => {
  await authDb.delete(institutions).where(eq(institutions.slug, 'mf-test'))
})

// --- registry validation ---------------------------------------------------

test('an empty registry is valid', () => {
  validateRegistry([])
})

test('duplicate ids are rejected', () => {
  assert.throws(
    () => validateRegistry([manifest({ id: 'a' }), manifest({ id: 'a' })]),
    /duplicate module id: a/,
  )
})

test('a dependency on an unregistered module is rejected', () => {
  assert.throws(
    () => validateRegistry([manifest({ id: 'a', dependsOn: ['ghost'] })]),
    /depends on unknown module: ghost/,
  )
})

test('a soft dependency that is not installed is fine: that is what soft means', () => {
  validateRegistry([manifest({ id: 'library', softDependsOn: ['finance'] })])
})

test('a dependsOn cycle is rejected', () => {
  assert.throws(
    () =>
      validateRegistry([
        manifest({ id: 'a', dependsOn: ['b'] }),
        manifest({ id: 'b', dependsOn: ['a'] }),
      ]),
    /cycle/,
  )
})

// --- entitlement gate ------------------------------------------------------

test('an unregistered module id is a programming error, not a 403', async () => {
  await assert.rejects(() => requireModule(registry, 'nope', inst), /unregistered module/)
})

test('a module with no entitlement row is denied with an upsell payload', async () => {
  registry.push(manifest({ id: 'paid', name: 'Paid Thing' }))
  try {
    await requireModule(registry, 'paid', inst)
    assert.fail('expected denial')
  } catch (e) {
    assert.ok(e instanceof ModuleDeniedError)
    assert.deepEqual(e.payload, {
      moduleId: 'paid',
      name: 'Paid Thing',
      pricing: { model: 'not_priced_yet', priceINR: null },
    })
  }
})

test('enabled = false is still denied', async () => {
  await authDb
    .insert(institutionModules)
    .values({ institutionId: inst, moduleId: 'paid', enabled: false })
  await assert.rejects(() => requireModule(registry, 'paid', inst), ModuleDeniedError)
})

test('flipping enabled to true allows it', async () => {
  await authDb
    .update(institutionModules)
    .set({ enabled: true })
    .where(eq(institutionModules.institutionId, inst))
  await requireModule(registry, 'paid', inst)
  assert.deepEqual(await getEnabledModules(registry, inst), ['paid'])
})

test('alwaysEnabled skips the entitlement table entirely', async () => {
  registry.push(manifest({ id: 'bundled', alwaysEnabled: true }))
  await requireModule(registry, 'bundled', inst)
  assert.ok((await getEnabledModules(registry, inst)).includes('bundled'))
})

test('a module cannot be enabled before its dependencies', async () => {
  registry.push(manifest({ id: 'dependent', dependsOn: ['absent'] }))
  registry.push(manifest({ id: 'absent' }))
  await assert.rejects(
    () => assertDependenciesEnabled(registry, 'dependent', inst),
    /requires absent to be enabled first/,
  )
})

// --- nav -------------------------------------------------------------------

test('a disabled module contributes no nav entry', () => {
  const ms = [manifest({ id: 'off' }), manifest({ id: 'on' })]
  assert.deepEqual(
    buildNav(ms, ['on'], 'institution_admin').map((e) => e.moduleId),
    ['on'],
  )
})

test('nav is filtered by role, not just by entitlement', () => {
  const ms = [
    manifest({
      id: 'finance',
      rolesWithAccess: ['accounts_staff', 'institution_admin'],
      navEntries: [{ label: 'Fees', href: '/fees', roles: ['accounts_staff'] }],
    }),
  ]
  assert.deepEqual(buildNav(ms, ['finance'], 'accounts_staff').length, 1)
  assert.deepEqual(buildNav(ms, ['finance'], 'institution_admin').length, 0)
  assert.deepEqual(buildNav(ms, ['finance'], 'student').length, 0)
})
