import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { URL } from 'node:url'

/**
 * The P0-01 migrations applied as an upgrade, not only on a fresh database.
 *
 * CI's fresh path runs core first and every module after it. An institution
 * upgrading runs the new core migrations on a database that already holds
 * every module's tables, and then the new module migrations. That order is
 * where a revoke, a trigger or a foreign-key rewrite that finds its target by
 * name would fail -- so it is run here: core to 0004 and every module file
 * that existed before, then the rest.
 */

const ROOT = resolve(import.meta.dirname, '..')
const MODULES = join(ROOT, 'packages', 'modules')
const require = createRequire(join(ROOT, 'packages', 'db', 'package.json'))
const pg = require('pg')
const { drizzle } = require('drizzle-orm/node-postgres')
const { migrate } = require('drizzle-orm/node-postgres/migrator')

/** The files P0-01 added. Everything else is the previous level. */
const NEW_FILES = new Set([
  'fees/0006_money_outlives_the_person.sql',
  'hr/0010_money_outlives_the_person.sql',
  'library/0002_loans_outlive_the_borrower.sql',
])
const NEW_CORE_FROM = 5

const url = process.env.MIGRATION_DATABASE_URL
const base = url ? decodeURIComponent(new URL(url).pathname.slice(1)) : ''
const DB = `${base}_upgrade`
const at = (name) => {
  const u = new URL(url)
  u.pathname = `/${name}`
  return u.toString()
}

async function withClient(connectionString, fn) {
  const client = new pg.Client({ connectionString })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

const dependsOn = (id) => {
  const match = readFileSync(join(MODULES, id, 'manifest.ts'), 'utf8').match(/dependsOn:\s*\[([^\]]*)\]/)
  return match ? [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : []
}
const ordered = (() => {
  const ids = readdirSync(MODULES).filter((d) => existsSync(join(MODULES, d, 'package.json'))).sort()
  const out = []
  const visit = (id) => {
    if (out.includes(id)) return
    for (const d of dependsOn(id)) if (ids.includes(d)) visit(d)
    out.push(id)
  }
  ids.forEach(visit)
  return out
})()

async function applyModules(client, which) {
  for (const id of ordered) {
    const dir = join(MODULES, id, 'migrations')
    if (!existsSync(dir)) continue
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (!which(`${id}/${file}`)) continue
      await client.query(readFileSync(join(dir, file), 'utf8').replaceAll('--> statement-breakpoint', ''))
    }
  }
}

async function migrateCore(client, upTo) {
  const folder = mkdtempSync(join(tmpdir(), 'campusos-core-'))
  try {
    cpSync(join(ROOT, 'packages', 'db', 'migrations'), folder, { recursive: true })
    const journal = JSON.parse(readFileSync(join(folder, 'meta', '_journal.json'), 'utf8'))
    for (const entry of journal.entries.filter((e) => e.idx > upTo)) rmSync(join(folder, `${entry.tag}.sql`))
    journal.entries = journal.entries.filter((e) => e.idx <= upTo)
    writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify(journal))
    await migrate(drizzle(client), { migrationsFolder: folder })
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
}

before(async () => {
  if (!url) return
  await withClient(at('postgres'), async (c) => {
    await c.query(`drop database if exists "${DB}"`)
    await c.query(`create database "${DB}"`)
  })
  await withClient(at(DB), async (c) => {
    // The previous level...
    await migrateCore(c, NEW_CORE_FROM - 1)
    await applyModules(c, (f) => !NEW_FILES.has(f))
    // with the grants every earlier install ended with (docker/init.sql).
    await c.query('grant select, insert, update, delete on all tables in schema public to campusos_app')
    // ...then the upgrade, in the order an installation runs it.
    await migrateCore(c, Number.MAX_SAFE_INTEGER)
    await applyModules(c, (f) => NEW_FILES.has(f))
  })
})

after(async () => {
  if (!url) return
  await withClient(at('postgres'), (c) => c.query(`drop database if exists "${DB}"`))
})

test('the P0-01 migrations apply as an upgrade over every module (DATA-03, AUD-01, SEC-05, DATA-09)', { skip: !url && 'MIGRATION_DATABASE_URL is not set' }, async () => {
  await withClient(at(DB), async (c) => {
    const { rows } = await c.query(`
      select
        (select count(*)::int from pg_extension where extname = 'btree_gist') as gist,
        (select count(*)::int from pg_trigger where tgrelid = 'audit_log'::regclass and not tgisinternal) as triggers,
        (select count(*)::int from pg_proc where proname in ('campusos_job_gate', 'campusos_end_sessions')) as gates,
        has_table_privilege('campusos_app', 'sessions', 'SELECT') as app_reads_sessions,
        has_table_privilege('campusos_app', 'audit_log', 'UPDATE') as app_updates_audit,
        (select count(*)::int
           from pg_constraint con
           join pg_class t on t.oid = con.conrelid
           join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
          where con.contype = 'f' and con.confdeltype = 'a'
            and ((t.relname like 'fee\\_%' and a.attname = 'student_id')
              or (t.relname like 'hr\\_%' and a.attname = 'staff_id' and t.relname in (
                    'hr_payslips', 'hr_salary_assignments', 'hr_pay_components', 'hr_salary_withholdings',
                    'hr_leave_encashments', 'hr_tax_elections', 'hr_separations'))
              or (t.relname = 'library_loans' and a.attname = 'borrower_id'))) as no_action`)
    assert.deepEqual(rows[0], {
      gist: 1, triggers: 2, gates: 2,
      app_reads_sessions: false, app_updates_audit: false,
      no_action: 16,
    })
  })
})
