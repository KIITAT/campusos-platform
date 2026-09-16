import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { authDb, db } from './client'
import {
  PAIRING_TTL_MS,
  claimPairing,
  deviceTokens,
  listDevices,
  revokeDevice,
  startPairing,
  userForToken,
} from './device-tokens'
import { institutions, users } from './schema'

const SLUG = 'device-test'
let inst: string
let student: string

before(async () => {
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: SLUG, name: 'Device College', allowedEmailDomains: ['device.test'] })
    .returning({ id: institutions.id })
  inst = i!.id

  const [u] = await authDb
    .insert(users)
    .values({ email: 's@device.test', institutionId: inst, role: 'student', name: 'S' })
    .returning({ id: users.id })
  student = u!.id
})

beforeEach(async () => {
  await db.delete(deviceTokens).where(eq(deviceTokens.userId, student))
})

after(async () => {
  await authDb.delete(institutions).where(eq(institutions.slug, SLUG))
})

test('a pairing code is short, typable, and free of ambiguous characters', async () => {
  const { code, expiresAt } = await startPairing(inst, student, 'a phone')
  assert.equal(code.length, 6)
  assert.match(code, /^[A-HJ-NP-Z2-9]+$/, 'no 0/O or 1/I to mistype')
  assert.ok(expiresAt.getTime() - Date.now() <= PAIRING_TTL_MS)
})

test('the pairing code is never stored, only its hash', async () => {
  const { code } = await startPairing(inst, student)
  const [row] = await db
    .select()
    .from(deviceTokens)
    .where(eq(deviceTokens.userId, student))
  assert.ok(row)
  assert.ok(!JSON.stringify(row).includes(code), 'the code itself is in the database')
})

test('claiming a code yields a token that resolves to the user', async () => {
  const { code } = await startPairing(inst, student, 'a phone')
  const claimed = await claimPairing(code, 'a phone')
  assert.ok(claimed)
  assert.equal(claimed!.userId, student)
  assert.ok(claimed!.token.length >= 32)
  assert.equal(await userForToken(claimed!.token), student)
})

test('the token itself is not stored either', async () => {
  const { code } = await startPairing(inst, student)
  const claimed = await claimPairing(code, null)
  const [row] = await db
    .select()
    .from(deviceTokens)
    .where(eq(deviceTokens.userId, student))
  assert.ok(!JSON.stringify(row).includes(claimed!.token))
})

test('a pairing code is single use', async () => {
  const { code } = await startPairing(inst, student)
  assert.ok(await claimPairing(code, null))
  assert.equal(await claimPairing(code, null), null, 'the second claim must fail')
})

test('case and surrounding space do not stop a person typing it correctly', async () => {
  const { code } = await startPairing(inst, student)
  assert.ok(await claimPairing(`  ${code.toLowerCase()} `, null))
})

test('an expired code is refused and cleaned up', async () => {
  const { code } = await startPairing(inst, student)
  await db
    .update(deviceTokens)
    .set({ pairingExpiresAt: new Date(Date.now() - 1000) })
    .where(eq(deviceTokens.userId, student))

  assert.equal(await claimPairing(code, null), null)
  const left = await db.select().from(deviceTokens).where(eq(deviceTokens.userId, student))
  assert.equal(left.length, 0, 'a dead pairing does not linger')
})

test('asking twice does not leave two live codes', async () => {
  const first = await startPairing(inst, student)
  const second = await startPairing(inst, student)
  assert.equal(await claimPairing(first.code, null), null, 'the first is superseded')
  assert.ok(await claimPairing(second.code, null))
})

test('a wrong or malformed token resolves to nobody', async () => {
  for (const bad of ['', 'short', 'x'.repeat(43), 'not-a-real-token-but-long-enough-here']) {
    assert.equal(await userForToken(bad), null, bad.slice(0, 12))
  }
})

test('an unclaimed pairing row is not itself a usable token', async () => {
  const { code } = await startPairing(inst, student)
  // The placeholder in token_hash must not be presentable as a credential.
  assert.equal(await userForToken(code), null)
  assert.equal(await userForToken(`unclaimed:${code}`), null)
})

test('revoking takes effect immediately and keeps the record', async () => {
  const { code } = await startPairing(inst, student, 'the lost phone')
  const claimed = await claimPairing(code, 'the lost phone')
  const [device] = await listDevices(student)

  assert.equal(await revokeDevice(student, device!.id), true)
  assert.equal(await userForToken(claimed!.token), null)

  const after = await listDevices(student)
  assert.equal(after.length, 1, 'which phone it was is still answerable')
  assert.ok(after[0]!.revokedAt)
})

test('somebody cannot revoke another person’s device', async () => {
  const [other] = await authDb
    .insert(users)
    .values({ email: 'other@device.test', institutionId: inst, role: 'student' })
    .returning({ id: users.id })
  try {
    const { code } = await startPairing(inst, student)
    await claimPairing(code, null)
    const [device] = await listDevices(student)
    assert.equal(await revokeDevice(other!.id, device!.id), false)
  } finally {
    await authDb.delete(users).where(eq(users.id, other!.id))
  }
})

test('the device list shows a pending pairing as pending', async () => {
  await startPairing(inst, student, 'not yet paired')
  const [row] = await listDevices(student)
  assert.equal(row!.pending, true)
  assert.equal(row!.lastUsedAt, null)
})
