import { Buffer } from 'node:buffer'
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * Signing the package index (SEC-03, OPS-02, decision 205).
 *
 * registry.json carries the sha256 of every archive, so it is what a host has
 * to trust; this signs its exact bytes with Ed25519 into registry.json.sig.
 * The release workflow signs with the release key (CAMPUSOS_REGISTRY_SIGNING_KEY);
 * anything else -- a developer, CI, the hub kit's image -- signs with a local
 * key kept in dist/local-signing, which a host trusts only when told to
 * (CAMPUSOS_REGISTRY_KEYS_FILE).
 *
 *   node scripts/registry-sign.mjs generate <dir> [--force]
 *   node scripts/registry-sign.mjs sign <registry.json> [--require-key]
 *   node scripts/registry-sign.mjs verify <registry.json> [<public key>]
 */

const ROOT = resolve(import.meta.dirname, '..')
const LOCAL = process.env.CAMPUSOS_REGISTRY_LOCAL_KEY_DIR || join(ROOT, 'dist', 'local-signing')
const USAGE = 'usage: registry-sign.mjs generate <dir> [--force] | sign <registry.json> [--require-key] | verify <registry.json> [<public key>]'

const fail = (message) => {
  console.error(message)
  process.exit(1)
}
// Node 24's createPublicKey refuses a key object that is already public.
const spki = (key) => (key.type === 'public' ? key : createPublicKey(key)).export({ format: 'der', type: 'spki' }).toString('base64')
const keyId = (publicKey) => createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex').slice(0, 16)

function generate(dir, force = false) {
  if (!force && existsSync(join(dir, 'private.pem'))) {
    fail(`${join(dir, 'private.pem')} already exists; generate would destroy that key. Pass --force to replace it.`)
  }
  mkdirSync(dir, { recursive: true })
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  writeFileSync(join(dir, 'private.pem'), privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 })
  writeFileSync(join(dir, 'public.txt'), spki(publicKey) + '\n')
  return spki(publicKey)
}

function signingKey(requireKey) {
  const pem = process.env.CAMPUSOS_REGISTRY_SIGNING_KEY
  if (pem) return { key: createPrivateKey(pem), local: false }
  if (requireKey) fail('CAMPUSOS_REGISTRY_SIGNING_KEY is not set; a release is never signed with a local key.')
  if (!existsSync(join(LOCAL, 'private.pem'))) generate(LOCAL)
  return { key: createPrivateKey(readFileSync(join(LOCAL, 'private.pem'))), local: true }
}

const [command, file, ...rest] = process.argv.slice(2)
if (!file) fail(USAGE)

if (command === 'generate') {
  const publicKey = generate(file, rest.includes('--force'))
  console.log(`public key: ${publicKey}`)
  console.log(`key id: ${keyId(publicKey)}`)
  console.log(`private key: ${join(file, 'private.pem')} -- keep it off this machine's repositories; it is the CAMPUSOS_REGISTRY_SIGNING_KEY secret`)
} else if (command === 'sign') {
  const { key, local } = signingKey(rest.includes('--require-key'))
  const publicKey = spki(key)
  const signature = sign(null, readFileSync(file), key).toString('base64')
  writeFileSync(`${file}.sig`, JSON.stringify({ alg: 'ed25519', keyId: keyId(publicKey), signature }) + '\n')
  console.log(`signed ${file} with ${local ? `the local key (${join(LOCAL, 'public.txt')})` : 'the release key'}, key ${keyId(publicKey)}`)
} else if (command === 'verify') {
  const releaseKey = process.env.CAMPUSOS_REGISTRY_SIGNING_KEY
  const publicKey = rest[0] ?? (releaseKey ? spki(createPrivateKey(releaseKey)) : fail('verify needs a public key, or CAMPUSOS_REGISTRY_SIGNING_KEY'))
  if (!existsSync(`${file}.sig`)) fail(`${file} is not signed`)
  const sig = JSON.parse(readFileSync(`${file}.sig`, 'utf8'))
  const ok =
    sig.alg === 'ed25519' &&
    sig.keyId === keyId(publicKey) &&
    verify(null, readFileSync(file), createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' }), Buffer.from(String(sig.signature), 'base64'))
  if (!ok) fail(`${file}: the signature does not verify against key ${keyId(publicKey)}`)
  console.log(`${file}: signed by key ${keyId(publicKey)}`)
} else {
  fail(USAGE)
}
