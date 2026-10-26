import { test } from 'node:test'
import assert from 'node:assert/strict'
import { IDEMPOTENCY_KEY, requestHash } from './idempotency'

test('a request hash ignores key order, and absent and null alike', () => {
  const a = requestHash({ studentId: 's', amount: 100, method: 'cash', reference: null })
  const b = requestHash({ method: 'cash', amount: 100, studentId: 's' })
  assert.equal(a, b)
  assert.notEqual(a, requestHash({ studentId: 's', amount: 101, method: 'cash' }))
  assert.equal(
    requestHash({ at: new Date('2026-07-01T00:00:00Z'), lines: [{ b: 1, a: 2 }] }),
    requestHash({ lines: [{ a: 2, b: 1 }], at: '2026-07-01T00:00:00.000Z' }),
  )
  assert.match(a, /^[0-9a-f]{64}$/)
})

test('a key is 8 to 128 of letters, digits and . _ : -', () => {
  for (const ok of ['3f2c1a9e-0b4d-4c1e-9a77-1d2e3f4a5b6c', 'abcdefgh', 'mobile:retry.1_x', 'x'.repeat(128)])
    assert.ok(IDEMPOTENCY_KEY.test(ok), ok)
  for (const bad of ['short', 'has space1', 'x'.repeat(129), 'émoji-key-1', 'a/b/c/d/e', ''])
    assert.ok(!IDEMPOTENCY_KEY.test(bad), bad)
})
