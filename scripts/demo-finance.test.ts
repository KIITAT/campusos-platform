import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { authDb, users } from '../packages/db/src/index'
import { invoiceDetail, listEntries, listFiscalYears } from '../packages/modules/finance/api/index'
import { CONFIRMATION, DEMO_SLUG, createDemoTenant, populateDemoBooks, validateDemoEnvironment } from './demo-finance'

const safe = {
  DATABASE_URL: 'postgresql://campusos_app:app-secret@127.0.0.1:55433/campusos_demo',
  MIGRATION_DATABASE_URL: 'postgresql://postgres:owner-secret@127.0.0.1:55433/campusos_demo',
  CONFIRM_FINANCE_DEMO: 'CREATE_SYNTHETIC_FINANCE_DEMO',
}

test('finance demo requires explicit confirmation and a disposable matching database target', () => {
  assert.equal(CONFIRMATION, safe.CONFIRM_FINANCE_DEMO)
  assert.equal(validateDemoEnvironment(safe), 'campusos_demo')
  assert.equal(validateDemoEnvironment({ ...safe, DATABASE_URL: safe.DATABASE_URL.replace('_demo', '_test'), MIGRATION_DATABASE_URL: safe.MIGRATION_DATABASE_URL.replace('_demo', '_test') }), 'campusos_test')
  for (const change of [
    { CONFIRM_FINANCE_DEMO: undefined }, { CONFIRM_FINANCE_DEMO: 'yes' }, { NODE_ENV: 'production' },
    { DATABASE_URL: undefined }, { MIGRATION_DATABASE_URL: undefined },
    { DATABASE_URL: safe.DATABASE_URL.replace('_demo', '') },
    { MIGRATION_DATABASE_URL: safe.MIGRATION_DATABASE_URL.replace('_demo', '_test') },
    { MIGRATION_DATABASE_URL: safe.MIGRATION_DATABASE_URL.replace('127.0.0.1', 'db.example.invalid') },
    { MIGRATION_DATABASE_URL: safe.MIGRATION_DATABASE_URL.replace('55433', '5432') },
    { AUTH_DATABASE_URL: safe.MIGRATION_DATABASE_URL },
    { DATABASE_URL: safe.DATABASE_URL + '?host=production.example.invalid' },
    { MIGRATION_DATABASE_URL: safe.MIGRATION_DATABASE_URL + '?port=6432' },
    { DATABASE_URL: safe.DATABASE_URL.replace('campusos_app:app-secret@', '') },
  ]) assert.throws(() => validateDemoEnvironment({ ...safe, ...change }))
})

test('standalone CLI refuses before any database work without confirmation', () => {
  const child = spawnSync(process.execPath, ['--import', resolve('packages/db/node_modules/tsx/dist/loader.mjs'), resolve('scripts/demo-finance.ts')], {
    encoding: 'utf8', env: { ...process.env, ...safe, NODE_ENV: 'test', CONFIRM_FINANCE_DEMO: '', AUTH_DATABASE_URL: '' }, timeout: 10000,
  })
  assert.equal(child.status, 1)
  assert.match(child.stderr, /CONFIRM_FINANCE_DEMO/)
  assert.ok(!child.stderr.includes('owner-secret'))
  assert.equal(child.stdout, '')
})

test('finance demo rejects malformed URLs without reporting credentials', () => {
  for (const url of ['https://operator:private-secret@example.test/campusos_demo', 'not-a-database', 'postgresql://operator:private-secret@example.test/']) {
    assert.throws(() => validateDemoEnvironment({ ...safe, DATABASE_URL: url }), error => error instanceof Error && !error.message.includes('private-secret'))
  }
})

let createdInstitution: string | undefined
after(async () => {
  if (createdInstitution) await authDb.$client.query('DELETE FROM institutions WHERE id = $1', [createdInstitution])
})

test('a colliding synthetic identity rolls back new tenant provisioning', async () => {
  const [existing] = await authDb.insert(users).values({ email: `administrator@${DEMO_SLUG}.invalid`, name: 'Collision fixture', role: 'pending' }).onConflictDoNothing().returning()
  assert.ok(existing, 'Refusing to touch a pre-existing collision fixture')
  try {
    await assert.rejects(() => createDemoTenant(), /collision/i)
    const result = await authDb.$client.query('SELECT id FROM institutions WHERE slug = $1', [DEMO_SLUG])
    assert.equal(result.rows.length, 0)
  } finally {
    await authDb.$client.query('DELETE FROM users WHERE id = $1', [existing.id])
  }
})

test('synthetic finance demo posts a paid invoice, bank receipt and balanced expense journal; reruns refuse collisions', async () => {
  const tenant = await createDemoTenant()
  createdInstitution = tenant.institutionId
  const demo = await populateDemoBooks(tenant)
  assert.equal(demo.invoiceStatus, 'paid')
  assert.equal(demo.invoicePaise, 2_000_000)
  assert.equal(demo.outstandingPaise, 0)
  assert.equal(demo.bankPaise, 1_500_000)
  assert.equal(demo.surplusPaise, 1_500_000)
  assert.equal(demo.trialBalanceDifferencePaise, 0)
  assert.equal(demo.balanceSheetDifferencePaise, 0)
  assert.equal((await invoiceDetail(tenant.accounts, demo.invoiceId)).invoice.docstatus, 'submitted')
  assert.equal((await listFiscalYears(tenant.admin)).length, 1)
  const before = await listEntries(tenant.accounts)
  await assert.rejects(() => createDemoTenant(), /already exists|collision/i)
  await assert.rejects(() => populateDemoBooks(tenant), /already contain postings/i)
  assert.equal((await listEntries(tenant.accounts)).length, before.length)
})
