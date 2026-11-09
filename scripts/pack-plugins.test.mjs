// P1-10d (REL-06): a packed module takes the shared libraries from its host.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

const ROOT = resolve(import.meta.dirname, '..')

test('a packed module carries no copy of the shared libraries (REL-06)', async () => {
  execFileSync('pnpm', ['pack:plugins'], { cwd: ROOT, stdio: 'ignore', shell: true })
  const file = join(ROOT, 'dist', 'plugins', 'notices', 'server.mjs')
  const src = readFileSync(file, 'utf8')
  assert.ok(!src.includes('function drizzle('), 'drizzle is bundled')
  assert.ok(!src.includes('class PgDialect'), 'drizzle PgDialect is bundled')
  assert.ok(!/class ZodType|\$constructor\("ZodType"/.test(src), 'zod is bundled')
  assert.ok(src.includes('__campusosHost'), 'no host shim')

  delete globalThis.__campusosHost
  await assert.rejects(
    import(pathToFileURL(file).href + '?nohost'),
    /this module needs a CampusOS host that provides its libraries \(host API 1\)/,
  )
})
