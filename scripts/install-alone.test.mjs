import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { after, before, test } from 'node:test'

/**
 * Every module installs on a fresh database holding core and its declared
 * dependencies -- and nothing else.
 *
 * CI's own migration step applies every module at once, so a module that
 * silently leans on something only an *undeclared* module provides passes
 * there and fails at an institution that does not install that module. That is
 * exactly what DATA-03 was: finance needs the btree_gist extension, which only
 * academic created, so a company installing finance and hr without academic
 * could not install at all.
 *
 * Through the driver, not psql, so it runs wherever the tests do.
 */

const ROOT = resolve(import.meta.dirname, '..')
const MODULES = join(ROOT, 'packages', 'modules')
const require = createRequire(join(ROOT, 'packages', 'db', 'package.json'))
const pg = require('pg')
const { drizzle } = require('drizzle-orm/node-postgres')
const { migrate } = require('drizzle-orm/node-postgres/migrator')

const url = process.env.MIGRATION_DATABASE_URL
const at = (name) => {
  const u = new URL(url)
  u.pathname = `/${name}`
  return u.toString()
}
const base = decodeURIComponent(new URL(url).pathname.slice(1))
const CORE = `${base}_alone_core`

const dependsOn = (id) => {
  const match = readFileSync(join(MODULES, id, 'manifest.ts'), 'utf8').match(/dependsOn:\s*\[([^\]]*)\]/)
  return match ? [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : []
}
/** The module and everything it declares, dependencies first. */
const closure = (id, out = []) => {
  for (const d of dependsOn(id)) closure(d, out)
  if (!out.includes(id)) out.push(id)
  return out
}
const modules = readdirSync(MODULES).filter((d) => existsSync(join(MODULES, d, 'package.json'))).sort()

async function withClient(connectionString, fn) {
  const client = new pg.Client({ connectionString })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}
const admin = (fn) => withClient(at('postgres'), fn)

before(async () => {
  if (!url) return
  await admin(async (c) => {
    await c.query(`drop database if exists "${CORE}"`)
    await c.query(`create database "${CORE}"`)
  })
  await withClient(at(CORE), (c) =>
    migrate(drizzle(c), { migrationsFolder: join(ROOT, 'packages', 'db', 'migrations') }),
  )
})

after(async () => {
  if (!url) return
  await admin((c) => c.query(`drop database if exists "${CORE}"`))
})

test('every module installs on core plus only its declared dependencies (DATA-03)', { skip: !url && 'MIGRATION_DATABASE_URL is not set' }, async () => {
  const failures = []
  for (const [n, id] of modules.entries()) {
    const name = `${base}_alone_${n}`
    await admin(async (c) => {
      await c.query(`drop database if exists "${name}"`)
      await c.query(`create database "${name}" template "${CORE}"`)
    })
    try {
      await withClient(at(name), async (c) => {
        for (const m of closure(id)) {
          const dir = join(MODULES, m, 'migrations')
          if (!existsSync(dir)) continue
          for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
            try {
              await c.query(readFileSync(join(dir, file), 'utf8').replaceAll('--> statement-breakpoint', ''))
            } catch (e) {
              failures.push(`${id} [${closure(id).join(' > ')}] at ${m}/${file}: ${e.message}`)
              return
            }
          }
        }
      })
    } finally {
      await admin((c) => c.query(`drop database if exists "${name}"`))
    }
  }
  assert.deepEqual(failures, [])
})
