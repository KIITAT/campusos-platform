import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

// Signing the package index (SEC-03, OPS-02, decision 205).

const ROOT = resolve(import.meta.dirname, '..')

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'registry-sign-'))
  const file = join(dir, 'registry.json')
  writeFileSync(file, '{"schema":1}\n')
  return { dir, file }
}

function run(dir, args, extraEnv = {}) {
  const env = { ...process.env, CAMPUSOS_REGISTRY_LOCAL_KEY_DIR: join(dir, 'local'), ...extraEnv }
  if (!('CAMPUSOS_REGISTRY_SIGNING_KEY' in extraEnv)) delete env.CAMPUSOS_REGISTRY_SIGNING_KEY
  return execFileSync(process.execPath, ['scripts/registry-sign.mjs', ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

test('sign with no release key uses a local key, and verify accepts it (OPS-02)', () => {
  const { dir, file } = setup()
  run(dir, ['sign', file])
  assert.ok(existsSync(join(dir, 'local', 'private.pem')))
  assert.ok(existsSync(join(dir, 'local', 'public.txt')))
  const sig = JSON.parse(readFileSync(`${file}.sig`, 'utf8'))
  assert.equal(sig.alg, 'ed25519')
  assert.match(sig.keyId, /^[0-9a-f]{16}$/)
  const publicKey = readFileSync(join(dir, 'local', 'public.txt'), 'utf8').trim()
  assert.match(run(dir, ['verify', file, publicKey]), /signed by key/)
})

test('a changed index no longer verifies (SEC-03)', () => {
  const { dir, file } = setup()
  run(dir, ['sign', file])
  writeFileSync(file, '{"schema":2}\n')
  const publicKey = readFileSync(join(dir, 'local', 'public.txt'), 'utf8').trim()
  assert.throws(
    () => run(dir, ['verify', file, publicKey]),
    (e) => /does not verify/.test(String(e.stderr)),
  )
})

test('--require-key refuses to sign without the release key (OPS-02)', () => {
  const { dir, file } = setup()
  assert.throws(
    () => run(dir, ['sign', file, '--require-key']),
    (e) => /CAMPUSOS_REGISTRY_SIGNING_KEY is not set/.test(String(e.stderr)),
  )
  assert.ok(!existsSync(`${file}.sig`))
})

test('the release key signs, and verify derives its public half (OPS-02)', () => {
  const { dir, file } = setup()
  assert.match(run(dir, ['generate', join(dir, 'release')]), /public key: MCowBQYDK2VwAyEA/)
  const pem = readFileSync(join(dir, 'release', 'private.pem'), 'utf8')
  run(dir, ['sign', file, '--require-key'], { CAMPUSOS_REGISTRY_SIGNING_KEY: pem })
  run(dir, ['verify', file], { CAMPUSOS_REGISTRY_SIGNING_KEY: pem })
  const releaseId = JSON.parse(readFileSync(`${file}.sig`, 'utf8')).keyId
  run(dir, ['sign', file]) // local key
  assert.notEqual(JSON.parse(readFileSync(`${file}.sig`, 'utf8')).keyId, releaseId)
})
