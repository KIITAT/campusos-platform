import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { URL } from 'node:url'

/**
 * The P0-01, P0-02, P0-03, P0-04, P0-06 and P0-08 migrations applied as an upgrade, not only on a
 * fresh database.
 *
 * CI's fresh path runs core first and every module after it. An institution
 * upgrading runs the new core migrations on a database that already holds
 * every module's tables, and then the new module migrations. That order is
 * where a revoke, a trigger or a foreign-key rewrite that finds its target by
 * name would fail -- so it is run here: core to 0004 and every module file
 * that existed before, then the rest.
 *
 * The previous level also holds an audit trail in two institutions, because
 * P0-02's 0008 seals the rows it finds into their chains (AUD-01).
 */

const ROOT = resolve(import.meta.dirname, '..')
const MODULES = join(ROOT, 'packages', 'modules')
const require = createRequire(join(ROOT, 'packages', 'db', 'package.json'))
const pg = require('pg')
const { drizzle } = require('drizzle-orm/node-postgres')
const { migrate } = require('drizzle-orm/node-postgres/migrator')

/** The module files P0-01, P0-06 and P0-08 added. Everything else is the previous level. */
const NEW_FILES = new Set([
  'fees/0006_money_outlives_the_person.sql',
  'fees/0007_idempotency_and_references.sql',
  'hr/0010_money_outlives_the_person.sql',
  'hr/0011_payroll_runs_whole.sql',
  'library/0002_loans_outlive_the_borrower.sql',
  'academic/0007_student_relations.sql',
  'academic/0008_gpa_policy.sql',
  'enrollment/0001_student_relations.sql',
  'mentoring/0001_student_relations.sql',
  'timetable/0001_solves_off_the_request.sql',
  'hr/0012_dpdp_subject.sql',
  'hr/0013_hr_about_anonymous_feedback.sql',
  'enrollment/0002_dpdp_subject.sql',
  'notices/0002_dpdp_subject.sql',
  'parents/0002_dpdp_subject.sql',
  'academic/0009_dpdp_subject.sql',
  'admissions/0001_dpdp_subject.sql',
  'helpdesk/0001_dpdp_subject.sql',
  'placement/0001_dpdp_subject.sql',
  'alumni/0001_dpdp_subject.sql',
  'skills/0001_dpdp_subject.sql',
  'hostel/0002_dpdp_subject.sql',
  'attendance/0003_dpdp_subject.sql',
  'mentoring/0002_dpdp_subject.sql',
  'care/0001_dpdp_subject.sql',
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
    // An audit trail written before the chain existed: two rows share a
    // timestamp, so the (at, id) order is exercised, and the content is awkward.
    await c.query(`
      with i as (
        insert into institutions (slug, name) values ('upgrade-one', 'One'), ('upgrade-two', 'Two') returning id, slug
      )
      insert into audit_log (institution_id, actor_email, module_id, action, entity, entity_id, reason, detail, at)
      select i.id, v.email, 'core', v.action, 'x', v.n, v.reason, v.detail::jsonb, v.at::timestamptz
        from i join (values
          ('upgrade-one', 'legacy.1', '1', 'a@example.in', 'कारण', '{"ଅ": [1, 2], "big": 123456789012345678901234567890}', '2026-01-01T10:00:00.123456Z'),
          ('upgrade-one', 'legacy.2', '2', null, '', null, '2026-01-01T10:00:01Z'),
          ('upgrade-one', 'legacy.3', '3', null, 'same instant', '{"b": 1, "a": 1.50}', '2026-01-01T10:00:01Z'),
          ('upgrade-two', 'legacy.4', '4', 'b@example.in', 'other tenant', null, '2026-01-02T00:00:00Z')
        ) as v(slug, action, n, email, reason, detail, at) on v.slug = i.slug`)
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
      // P0-01's two guards, then P0-02's salt and seal.
      gist: 1, triggers: 4, gates: 2,
      app_reads_sessions: false, app_updates_audit: false,
      no_action: 16,
    })
  })
})

test('the upgrade seals the existing trail per institution, in (at, id) order, and keeps sealing after it (AUD-01)', { skip: !url && 'MIGRATION_DATABASE_URL is not set' }, async () => {
  await withClient(at(DB), async (c) => {
    const links = await c.query(`
      select i.slug, c.seq::int, a.action, a.salt is null as unsalted,
             c.prev_hash = coalesce(lag(c.hash) over (partition by c.institution_id order by c.seq),
                                    campusos_audit_genesis(c.institution_id::text)) as linked,
             c.hash = campusos_audit_hash(c.prev_hash, c.institution_id::text, c.seq, a.id, a.at, a.institution_id,
                        a.actor_id, a.module_id, a.action, a.entity, a.entity_id, a.actor_email, a.reason, a.detail, a.salt) as hashed
        from audit_chain c join audit_log a on a.id = c.audit_id join institutions i on i.id = c.institution_id
       where i.slug like 'upgrade-%'
       order by i.slug, c.seq`)
    const tie = await c.query(`
      select array_agg(action order by id) as by_id from audit_log where entity_id in ('2', '3') and action like 'legacy.%'`)
    assert.deepEqual(
      links.rows.map((r) => [r.slug, r.seq, r.action]),
      [['upgrade-one', 1, 'legacy.1'], ['upgrade-one', 2, tie.rows[0].by_id[0]], ['upgrade-one', 3, tie.rows[0].by_id[1]], ['upgrade-two', 1, 'legacy.4']],
    )
    assert.ok(links.rows.every((r) => r.unsalted && r.linked && r.hashed), 'every legacy row is linked and hashed, without a salt')

    // After the upgrade, a new row joins the end of its institution's chain.
    await c.query('begin')
    await c.query(`
      insert into audit_log (institution_id, module_id, action, entity, entity_id, reason)
      select id, 'core', 'after.upgrade', 'x', '5', 'new' from institutions where slug = 'upgrade-one'`)
    await c.query('commit')
    const next = await c.query(`
      select c.seq::int, a.salt is not null as salted from audit_chain c join audit_log a on a.id = c.audit_id
       where a.action = 'after.upgrade'`)
    assert.deepEqual(next.rows, [{ seq: 4, salted: true }])
  })
})

test('fees 0007 applies as an upgrade: the claim table under RLS, the reference index (ACC-18)', { skip: !url && 'MIGRATION_DATABASE_URL is not set' }, async () => {
  await withClient(at(DB), async (c) => {
    const { rows } = await c.query(`
      select
        (select relrowsecurity from pg_class where oid = 'fee_idempotency_keys'::regclass) as rls,
        (select count(*)::int from pg_policy where polrelid = 'fee_idempotency_keys'::regclass) as policies,
        (select count(*)::int from pg_constraint
          where conrelid = 'fee_idempotency_keys'::regclass and contype = 'f' and confdeltype = 'c') as cascades,
        (select indisunique from pg_index where indexrelid = 'fee_payments_reference'::regclass) as unique_reference`)
    assert.deepEqual(rows[0], { rls: true, policies: 1, cascades: 2, unique_reference: true })
  })
})

test('P0-03 applies as an upgrade: the relation views, readable by the app role only, through one function (SEC-07)', { skip: !url && 'MIGRATION_DATABASE_URL is not set' }, async () => {
  await withClient(at(DB), async (c) => {
    const { rows } = await c.query(`
      select
        (select array_agg(c.relname::text order by c.relname) from pg_class c
          where c.relnamespace = 'student_relations'::regnamespace and c.relkind = 'v') as views,
        (select bool_and(coalesce(c.reloptions, '{}') @> array['security_invoker=true']) from pg_class c
          where c.relnamespace = 'student_relations'::regnamespace and c.relkind = 'v') as invoker,
        (select bool_and(has_table_privilege('campusos_app', c.oid, 'SELECT')) from pg_class c
          where c.relnamespace = 'student_relations'::regnamespace and c.relkind = 'v') as app_reads,
        has_function_privilege('campusos_app', 'public.campusos_student_relation(text, text, text)', 'EXECUTE') as app_asks,
        has_function_privilege('public', 'public.campusos_student_relation(text, text, text)', 'EXECUTE') as public_asks,
        (select count(*)::int from information_schema.columns
          where table_name = 'academic_sections' and column_name = 'class_teacher_id') as class_teacher`)
    assert.deepEqual(rows[0], {
      views: ['academic_class_teacher', 'academic_hod', 'academic_teaches', 'enrollment_teaches', 'mentoring_mentor'],
      invoker: true, app_reads: true, app_asks: true, public_asks: false, class_teacher: 1,
    })
  })
})

test('P0-04 applies as an upgrade: the counter table and its definer function, callable by no role but the owner by default (SEC-02)', { skip: !url && 'MIGRATION_DATABASE_URL is not set' }, async () => {
  await withClient(at(DB), async (c) => {
    const { rows } = await c.query(`
      select
        to_regclass('public.rate_limit_counters') is not null as t,
        (select relrowsecurity from pg_class where oid = 'public.rate_limit_counters'::regclass) as rls,
        has_function_privilege('campusos_app', 'public.campusos_rate_limit(text,text,integer,integer)', 'EXECUTE') as app,
        has_function_privilege('public', 'public.campusos_rate_limit(text,text,integer,integer)', 'EXECUTE') as pub,
        has_table_privilege('campusos_app', 'public.rate_limit_counters', 'SELECT') as app_reads`)
    assert.deepEqual(rows[0], { t: true, rls: true, app: false, pub: false, app_reads: false })
  })
})

test('core 0012 applies as an upgrade: the subject schema and four functions, executable by the app role only (AUD-03, NEW-02)', { skip: !url && 'MIGRATION_DATABASE_URL is not set' }, async () => {
  await withClient(at(DB), async (c) => {
    const sigs = [
      'public.campusos_erasure_allows(text, jsonb, jsonb, text[])',
      'public.campusos_erase_subject(text)',
      'public.campusos_subject_about(text)',
      'public.campusos_forget_credentials(text)',
    ]
    const { rows } = await c.query(`
      select
        to_regnamespace('dpdp_subject') is not null as schema,
        has_schema_privilege('campusos_app', 'dpdp_subject', 'USAGE') as app_uses,
        has_schema_privilege('public', 'dpdp_subject', 'USAGE') as public_uses,
        (select array_agg(has_function_privilege('campusos_app', s, 'EXECUTE') order by s) from unnest($1::text[]) s) as app,
        (select array_agg(has_function_privilege('campusos_auth', s, 'EXECUTE') order by s) from unnest($1::text[]) s) as auth,
        (select array_agg(p.prosecdef order by s) from unnest($1::text[]) s join pg_proc p on p.oid = s::regprocedure) as definer`, [sigs])
    assert.deepEqual(rows[0], {
      schema: true, app_uses: true, public_uses: false,
      app: [true, true, true, true], auth: [false, false, false, false],
      // sorted by signature: erase_subject, erasure_allows, forget_credentials, subject_about
      definer: [false, false, true, false],
    })
  })
})

test('hr 0011 applies as an upgrade: arrears and settings under RLS, a payslip never negative (ACC-14, ACC-15)', { skip: !url && 'MIGRATION_DATABASE_URL is not set' }, async () => {
  await withClient(at(DB), async (c) => {
    const { rows } = await c.query(`
      select
        (select relrowsecurity from pg_class where oid = to_regclass('public.hr_payroll_arrears')) as arrears_rls,
        (select count(*)::int from pg_policy where polrelid = to_regclass('public.hr_payroll_arrears')) as arrears_policies,
        (select relrowsecurity from pg_class where oid = to_regclass('public.hr_payroll_settings')) as settings_rls,
        (select count(*)::int from pg_policy where polrelid = to_regclass('public.hr_payroll_settings')) as settings_policies,
        (select count(*)::int from pg_constraint where conname = 'hr_payslips_net_not_negative') as net_check,
        (select count(*)::int from information_schema.columns
          where table_name = 'hr_payroll_runs' and column_name = 'failures') as failures`)
    assert.deepEqual(rows[0], {
      arrears_rls: true, arrears_policies: 1, settings_rls: true, settings_policies: 1, net_check: 1, failures: 1,
    })
  })
})

test('academic 0008 applies as an upgrade: GPA rules under RLS (FUNC-03)', { skip: !url && 'MIGRATION_DATABASE_URL is not set' }, async () => {
  await withClient(at(DB), async (c) => {
    const { rows } = await c.query(`
      select
        (select relrowsecurity from pg_class where oid = to_regclass('public.academic_gpa_policies')) as rls,
        (select count(*)::int from pg_policy where polrelid = to_regclass('public.academic_gpa_policies')) as policies,
        (select count(*)::int from pg_indexes where indexname = 'academic_gpa_policies_from') as idx`)
    assert.deepEqual(rows[0], { rls: true, policies: 1, idx: 1 })
  })
})

test('timetable 0001 applies as an upgrade: one solve per institution, a 120-second cap (REL-01)', { skip: !url && 'MIGRATION_DATABASE_URL is not set' }, async () => {
  await withClient(at(DB), async (c) => {
    const { rows } = await c.query(`
      select
        (select count(*)::int from pg_indexes where indexname = 'timetable_runs_one_solving') as idx,
        (select pg_get_constraintdef(oid) from pg_constraint where conname = 'timetable_settings_time') as cap`)
    assert.equal(rows[0].idx, 1)
    assert.match(rows[0].cap, /120/)
  })
})
