import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  currentQr,
  decodeQr,
  distanceM,
  encodeQr,
  newSessionSecret,
  tokenFor,
  verifyToken,
  windowFor,
} from './api/token'

const SECRET = 'test-secret-not-random-on-purpose'
const SID = '11111111-1111-1111-1111-111111111111'
const W = 7
const T0 = 1_800_000_000_000 // a fixed instant; nothing here reads the clock

test('a secret is long enough to be unguessable', () => {
  const a = newSessionSecret()
  const b = newSessionSecret()
  assert.ok(a.length >= 40, `${a.length}`)
  assert.notEqual(a, b)
})

test('the token changes every window and is stable within one', () => {
  const w = windowFor(W, T0)
  assert.equal(tokenFor(SECRET, SID, w), tokenFor(SECRET, SID, w))
  assert.notEqual(tokenFor(SECRET, SID, w), tokenFor(SECRET, SID, w + 1))
})

test('the token is 12 base64url characters', () => {
  const t = tokenFor(SECRET, SID, windowFor(W, T0))
  assert.equal(t.length, 12)
  assert.match(t, /^[A-Za-z0-9_-]{12}$/)
})

test('a different session or secret yields a different token in the same window', () => {
  const w = windowFor(W, T0)
  assert.notEqual(tokenFor(SECRET, SID, w), tokenFor(SECRET, 'other-session', w))
  assert.notEqual(tokenFor(SECRET, SID, w), tokenFor('other-secret', SID, w))
})

test('the current token verifies', () => {
  const qr = currentQr(SECRET, SID, W, T0)
  assert.equal(verifyToken(SECRET, SID, W, qr, T0), 'ok')
})

test('the previous window is accepted as boundary grace', () => {
  const previous = currentQr(SECRET, SID, W, T0 - W * 1000)
  assert.equal(verifyToken(SECRET, SID, W, previous, T0), 'ok')
})

test('two windows old is stale', () => {
  const old = currentQr(SECRET, SID, W, T0 - 2 * W * 1000)
  assert.equal(verifyToken(SECRET, SID, W, old, T0), 'stale')
})

test('a screenshot is useless after the grace window', () => {
  const shot = currentQr(SECRET, SID, W, T0)
  // 15 seconds later, which is the worst case for a 7s window plus grace.
  assert.equal(verifyToken(SECRET, SID, W, shot, T0 + 15_000), 'stale')
})

test('a future window is stale, so a client cannot pre-compute', () => {
  const ahead = currentQr(SECRET, SID, W, T0 + 5 * W * 1000)
  assert.equal(verifyToken(SECRET, SID, W, ahead, T0), 'stale')
})

test('a forged token in a valid window is invalid, not accepted', () => {
  const w = windowFor(W, T0)
  assert.equal(verifyToken(SECRET, SID, W, { window: w, token: 'AAAAAAAAAAAA' }, T0), 'invalid')
  // a token minted for another session must not work here
  const other = tokenFor(SECRET, 'other-session', w)
  assert.equal(verifyToken(SECRET, SID, W, { window: w, token: other }, T0), 'invalid')
})

test('a length mismatch is rejected without throwing', () => {
  const w = windowFor(W, T0)
  for (const token of ['', 'short', 'x'.repeat(200)]) {
    assert.equal(verifyToken(SECRET, SID, W, { window: w, token }, T0), 'invalid', `${token.length}`)
  }
})

test('encode and decode round-trip', () => {
  const qr = currentQr(SECRET, SID, W, T0)
  const decoded = decodeQr(encodeQr(qr))
  assert.deepEqual(decoded, { sessionId: SID, window: qr.window, token: qr.token })
})

test('junk does not decode', () => {
  for (const bad of ['', 'nope', 'a.b', 'a.b.c.d', 'a.notanumber.c', 'a.-1.c', null, 42, {}]) {
    assert.equal(decodeQr(bad), null, JSON.stringify(bad))
  }
})

test('expiresInMs counts down within the window and never exceeds it', () => {
  for (const offset of [0, 1000, 3000, 6999]) {
    const qr = currentQr(SECRET, SID, W, T0 + offset)
    assert.ok(qr.expiresInMs > 0 && qr.expiresInMs <= W * 1000, `${offset}: ${qr.expiresInMs}`)
  }
})

// --- geodesy ---------------------------------------------------------------

test('distance is zero for the same point', () => {
  const p = { latitude: 20.2961, longitude: 85.8245 }
  assert.equal(Math.round(distanceM(p, p)), 0)
})

test('distance is plausible at classroom scale', () => {
  const room = { latitude: 20.2961, longitude: 85.8245 }
  // ~0.0009 degrees of latitude is about 100 m
  const away = { latitude: 20.2961 + 0.0009, longitude: 85.8245 }
  const d = distanceM(room, away)
  assert.ok(d > 90 && d < 110, `${d}`)
})

test('distance is symmetric and grows with separation', () => {
  const a = { latitude: 20.2961, longitude: 85.8245 }
  const b = { latitude: 20.3061, longitude: 85.8245 }
  assert.equal(Math.round(distanceM(a, b)), Math.round(distanceM(b, a)))
  const c = { latitude: 20.3161, longitude: 85.8245 }
  assert.ok(distanceM(a, c) > distanceM(a, b))
})

test('distance handles the antimeridian without blowing up', () => {
  const a = { latitude: 0, longitude: 179.999 }
  const b = { latitude: 0, longitude: -179.999 }
  // ~222 m apart, not most of the way round the planet
  assert.ok(distanceM(a, b) < 1000, `${distanceM(a, b)}`)
})
