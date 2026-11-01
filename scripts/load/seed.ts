import { resolve } from 'node:path'
import { authDb, corePool, institutionModules, institutions, users } from '../../packages/db/src/index'
import { listAccounts, saveJournal, setSingleOfficer, updateSettings, type Actor } from '../../packages/modules/finance/api/index'

/**
 * A synthetic data set for measuring reads at scale (P1-10a, decisions 376 to 381).
 * Never run against a real database: the guard below refuses anything that is not
 * a disposable `*_load` database named by both connections.
 */
export const CONFIRMATION = 'CREATE_SYNTHETIC_LOAD'

const SCALES = {
  full: { tenants: 50, bigLines: 10_000_000, smallLines: 20_000 },
  smoke: { tenants: 3, bigLines: 100_000, smallLines: 2_000 },
} as const
const CHUNK_ENTRIES = 500_000

class LoadSafetyError extends Error {}

export function validateLoadEnvironment(env: Record<string, string | undefined>): { database: string; scale: 'full' | 'smoke' } {
  if (env.NODE_ENV === 'production') throw new LoadSafetyError('Never run the load seed in production mode.')
  if (env.CONFIRM_LOAD_SEED !== CONFIRMATION) throw new LoadSafetyError(`Set CONFIRM_LOAD_SEED=${CONFIRMATION} explicitly.`)
  if (env.AUTH_DATABASE_URL) throw new LoadSafetyError('Unset AUTH_DATABASE_URL; the seed uses the explicit migration connection.')
  let application: URL
  let migration: URL
  try {
    application = new URL(env.DATABASE_URL ?? '')
    migration = new URL(env.MIGRATION_DATABASE_URL ?? '')
  } catch {
    throw new LoadSafetyError('Both application and migration PostgreSQL URLs are required.')
  }
  if (![application, migration].every((url) => ['postgres:', 'postgresql:'].includes(url.protocol))) throw new LoadSafetyError('Only PostgreSQL connection URLs are accepted.')
  const database = decodeURIComponent(application.pathname.slice(1))
  const migrationDatabase = decodeURIComponent(migration.pathname.slice(1))
  if (!/^[a-z][a-z0-9_]*_load$/.test(database)) throw new LoadSafetyError('The database must be disposable and end in _load.')
  if (database !== migrationDatabase || application.hostname !== migration.hostname || (application.port || '5432') !== (migration.port || '5432')) throw new LoadSafetyError('Application and migration connections must target the same load database.')
  const scale = env.LOAD_SCALE ?? 'smoke'
  if (scale !== 'full' && scale !== 'smoke') throw new LoadSafetyError('LOAD_SCALE must be full or smoke.')
  return { database, scale }
}

const log = (line: unknown) => process.stdout.write(`${JSON.stringify(line)}\n`)

const ACCOUNTS = `(select array_agg(id order by code) acc, count(*) n from finance_accounts
  where institution_id = $1 and archived_at is null and (subtype is null or subtype not in ('receivable', 'payable', 'stock'))) a`

async function createTenant(slug: string) {
  return authDb.transaction(async (tx) => {
    const [institution] = await tx.insert(institutions).values({ slug, name: `Load test ${slug}`, allowedEmailDomains: [] }).returning()
    const rows = [
      { local: 'adm', role: 'institution_admin' as const },
      ...[0, 1].map((i) => ({ local: `acc${i}`, role: 'accounts_staff' as const })),
      ...Array.from({ length: 8 }, (_, i) => ({ local: `stu${i}`, role: 'student' as const })),
    ]
    const created = await tx.insert(users).values(rows.map((r) => ({ institutionId: institution!.id, email: `${r.local}@${slug}.invalid`, name: `Load ${r.local}`, role: r.role }))).returning()
    await tx.insert(institutionModules).values(['finance', 'notices'].map((moduleId) => ({ institutionId: institution!.id, moduleId, enabled: true, enabledAt: new Date() })))
    const actor = (email: string): Actor => {
      const u = created.find((c) => c.email === email)!
      return { id: u.id, email: u.email, institutionId: institution!.id, role: u.role as Actor['role'] }
    }
    return { id: institution!.id, adm: actor(`adm@${slug}.invalid`), acc0: actor(`acc0@${slug}.invalid`) }
  })
}

async function main() {
  try {
    const { database, scale } = validateLoadEnvironment(process.env)
    const shape = SCALES[scale]
    if ((await authDb.$client.query("select 1 from institutions where slug like 'load-%' limit 1")).rowCount) {
      throw new LoadSafetyError('Load data already present; drop and recreate the database to reseed.')
    }
    const tenants: { slug: string; id: string }[] = []
    for (let k = 0; k < shape.tenants; k++) {
      const slug = `load-${String(k).padStart(2, '0')}`
      const t = await createTenant(slug)
      await updateSettings(t.adm, { legalName: `Load test ${slug}`, baseCurrency: 'INR', fiscalYearStartMonth: 4, timeZone: 'Asia/Kolkata', roundInvoices: true })
      await setSingleOfficer(t.adm, { enabled: true, reason: 'synthetic load institution' })
      const chart = await listAccounts(t.adm)
      const bank = chart.find((a) => a.purpose === 'bank')!
      const expense = chart.find((a) => a.purpose === 'purchase_expense')!
      await saveJournal(t.acc0, {
        kind: 'journal', postingDate: '2025-04-01', memo: 'Load opening', reference: 'LOAD-OPEN',
        lines: [{ accountId: bank.id, debit: '1000' }, { accountId: expense.id, credit: '1000' }], submit: true,
      })
      // The sessions table belongs to the owner; the application role has no grant on it.
      await authDb.$client.query(
        `insert into sessions ("sessionToken", "userId", expires)
         select 'load-' || $1::text || '-' || split_part(email, '@', 1), id, now() + interval '7 days'
           from users where institution_id = $2 and email not like 'adm@%'`,
        [slug, t.id],
      )
      tenants.push({ slug, id: t.id })
    }

    const owner = await authDb.$client.connect()
    try {
      for (const [index, { slug, id }] of tenants.entries()) {
        const entries = (index === 0 ? shape.bigLines : shape.smallLines) / 2
        const check = await owner.query(
          `select count(*)::int n from finance_accounts where institution_id = $1 and archived_at is null and (subtype is null or subtype not in ('receivable', 'payable', 'stock'))`,
          [id],
        )
        if (check.rows[0].n < 4) throw new LoadSafetyError(`${slug} has fewer than 4 non-control accounts.`)
        for (let from = 1; from <= entries; from += CHUNK_ENTRIES) {
          const to = Math.min(from + CHUNK_ENTRIES - 1, entries)
          await owner.query('begin')
          await owner.query('set local session_replication_role = replica')
          await owner.query(
            `insert into finance_journal_entries (id, institution_id, occurred_at, posting_date, memo, source_module, source_ref)
             select md5($1::uuid::text || ':' || i)::uuid, $1::uuid, (date '2021-04-01' + (i % 1826)::int)::timestamptz, date '2021-04-01' + (i % 1826)::int, 'Load entry', 'load', 'load:' || i
               from generate_series($2::bigint, $3::bigint) i`,
            [id, from, to],
          )
          await owner.query(
            `insert into finance_journal_lines (institution_id, entry_id, account_id, debit_paise, credit_paise)
             select $1::uuid, md5($1::uuid::text || ':' || i)::uuid, a.acc[1 + (i % a.n)::int], 100 + (i * 7919) % 1000000, 0
               from generate_series($2::bigint, $3::bigint) i, ${ACCOUNTS}
             union all
             select $1::uuid, md5($1::uuid::text || ':' || i)::uuid, a.acc[1 + ((i + 1 + i % 3) % a.n)::int], 0, 100 + (i * 7919) % 1000000
               from generate_series($2::bigint, $3::bigint) i, ${ACCOUNTS}`,
            [id, from, to],
          )
          await owner.query('commit')
          log({ slug, upTo: to })
        }
      }
      await owner.query('analyze finance_journal_entries, finance_journal_lines')
    } finally {
      owner.release()
    }
    log({ seeded: true, database, tenants: shape.tenants, lines: shape.bigLines + (shape.tenants - 1) * shape.smallLines })
  } catch (error) {
    process.stderr.write(`${error instanceof LoadSafetyError ? error.message : `Load seed failed: ${error instanceof Error ? error.message : String(error)}`}\n`)
    process.exitCode = 1
  } finally {
    await Promise.all([corePool.end(), authDb.$client.end()])
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve('scripts/load/seed.ts')) void main()
