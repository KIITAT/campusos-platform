import { test } from 'node:test'
import assert from 'node:assert/strict'
import { roleEnum } from '@campusos/db'
import { coreDocument, documentWith } from './openapi'
import {
  assignRoleSchema,
  createInstitutionSchema,
  emailDomainSchema,
  slugSchema,
} from './schemas'

test('a slug must be usable as a DNS label', () => {
  for (const ok of ['xyzcollege', 'x-y-z', 'college2']) {
    assert.equal(slugSchema.safeParse(ok).success, true, ok)
  }
  for (const bad of ['-lead', 'trail-', 'Upper', 'has_underscore', 'a', 'a b', 'dots.here']) {
    assert.equal(slugSchema.safeParse(bad).success, false, bad)
  }
})

test('an email domain is a bare domain, not an address', () => {
  assert.equal(emailDomainSchema.safeParse('xyzcollege.edu.in').success, true)
  assert.equal(emailDomainSchema.safeParse('XYZCollege.EDU.in').data, 'xyzcollege.edu.in')
  for (const bad of ['@xyz.edu.in', 'someone@xyz.edu.in', 'nodot', 'has space.com']) {
    assert.equal(emailDomainSchema.safeParse(bad).success, false, bad)
  }
})

test('an institution cannot be created with zero allowed domains', () => {
  const base = { slug: 'ok-slug', name: 'OK' }
  assert.equal(createInstitutionSchema.safeParse({ ...base, allowedEmailDomains: [] }).success, false)
  assert.equal(
    createInstitutionSchema.safeParse({ ...base, allowedEmailDomains: ['a.edu.in'] }).success,
    true,
  )
})

test('pending cannot be assigned as a role', () => {
  assert.equal(assignRoleSchema.safeParse({ userId: 'u', role: 'pending' }).success, false)
  assert.equal(assignRoleSchema.safeParse({ userId: 'u', role: 'faculty' }).success, true)
})

test('the role schema tracks the database enum exactly', () => {
  const spec = coreDocument.components?.schemas?.Role
  assert.deepEqual(
    (spec as { enum?: string[] } | undefined)?.enum,
    [...roleEnum.enumValues],
  )
})

test('the core platform routes are all declared', () => {
  const paths = Object.keys(coreDocument.paths ?? {})
  // Asserted as a set rather than an exhaustive list: this document is what the
  // host answers before any plugin is installed, and it should not need editing
  // when one is.
  for (const core of [
    '/api/v1/institutions',
    '/api/v1/me',
    '/api/v1/modules/toggle',
    '/api/v1/users/role',
  ]) {
    assert.ok(paths.includes(core), core)
  }
})

test('the core document describes no module, because none is installed yet', () => {
  const paths = Object.keys(coreDocument.paths ?? {})
  assert.ok(
    !paths.some((p) => p.startsWith('/api/v1/modules/') && p !== '/api/v1/modules/toggle'),
    'a module path is baked into the core document',
  )
  // Nothing may escape the versioned prefix: the Flutter client codegens off it.
  assert.ok(paths.every((p) => p.startsWith('/api/v1/')), paths.join(', '))
})

test('an installed plugin merges its fragment into the document it is served', () => {
  const fragment = {
    '/api/v1/modules/library/titles': { get: { summary: 'Search the catalogue' } },
  }
  const merged = documentWith([fragment])

  assert.ok(Object.keys(merged.paths ?? {}).includes('/api/v1/modules/library/titles'))
  // ...and the core paths are still there, which is the point of merging
  // rather than replacing.
  assert.ok(Object.keys(merged.paths ?? {}).includes('/api/v1/me'))
  // The core document itself is untouched: a request that merges must not
  // leave the next one describing a plugin this institution does not have.
  assert.ok(!Object.keys(coreDocument.paths ?? {}).includes('/api/v1/modules/library/titles'))
})
