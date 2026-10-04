import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { test } from 'node:test'
import * as token from './api/token'

test('device signatures bind exact bytes to a P-256 public key', () => {
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  const payload = Buffer.from('{"version":1,"nonce":"once"}')
  const signature = sign('sha256', payload, keys.privateKey).toString('base64url')
  assert.equal(typeof token.verifyDeviceSignature, 'function')
  assert.equal(token.verifyDeviceSignature(publicKey, payload, signature), true)
  assert.equal(token.verifyDeviceSignature(publicKey, Buffer.from('changed'), signature), false)
  assert.equal(token.verifyDeviceSignature(publicKey, payload, 'invalid'), false)
  const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  assert.equal(token.verifyDeviceSignature(other.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), payload, signature), false)
})

test('other curves and malformed public keys fail closed', () => {
  const keys = generateKeyPairSync('ec', { namedCurve: 'secp384r1' })
  const payload = Buffer.from('scan')
  const signature = sign('sha256', payload, keys.privateKey).toString('base64url')
  assert.equal(token.verifyDeviceSignature(keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), payload, signature), false)
  assert.equal(token.verifyDeviceSignature('not a key', payload, signature), false)
})
