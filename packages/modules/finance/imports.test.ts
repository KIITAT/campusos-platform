import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, like } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import type { PluginActor } from '@campusos/module-framework'
import { plugin } from './plugin'
import { trialBalance, updateSettings } from './api'
import { accounts, entries, items, parties } from './schema'

const SLUG = 'fin-import-'
let tenant: string
let admin: PluginActor
let accountant: PluginActor

const run = (actor: PluginActor, importId: string, csv: string, apply = true) =>
  plugin.routes
    .find((r) => r.path === '/imports/run')!
    .handler(actor, new Request('http://x', { method: 'POST', body: JSON.stringify({ importId, csv, apply }) })) as Promise<{ created: number; skipped: number }>

before(async () => {
  const [row] = await authDb.insert(institutions).values({ slug: `${SLUG}1`, name: 'Import Books', allowedEmailDomains: [] }).returning()
  tenant = row!.id
  const people = await authDb
    .insert(users)
    .values([
      { institutionId: tenant, email: 'adm@fin-import.test', role: 'institution_admin' },
      { institutionId: tenant, email: 'acc@fin-import.test', role: 'accounts_staff' },
    ])
    .returning()
  admin = { id: people[0]!.id, role: 'institution_admin', institutionId: tenant }
  accountant = { id: people[1]!.id, role: 'accounts_staff', institutionId: tenant }
  await updateSettings(admin, { legalName: 'Import Books', baseCurrency: 'INR', fiscalYearStartMonth: 4, timeZone: 'Asia/Kolkata' })
})

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

test('the chart, parties and items arrive from CSV, and the office cannot reshape the chart', async () => {
  const chart = 'code,name,type,parent_code,group,purpose\n9100,Imported bank accounts,asset,,yes,\n9110,Canara current account,asset,9100,no,bank\n9900,Opening balance equity,equity,,no,\n'
  assert.equal((await run(admin, 'accounts', chart)).created, 3)
  assert.equal((await run(admin, 'accounts', chart)).skipped, 3)
  await assert.rejects(run(accountant, 'accounts', chart), /cannot import/)

  const sheet = 'code,name,customer,supplier,payment_terms_days\nSUP-1,"Sharma Stationers, Bengaluru",no,yes,30\nCUS-1,Alumni Association,yes,,\n'
  assert.equal((await run(accountant, 'parties', sheet)).created, 2)
  const [sharma] = await withTenant(tenant, (tx) => tx.select().from(parties).where(eq(parties.code, 'SUP-1')))
  assert.equal(sharma!.name, 'Sharma Stationers, Bengaluru')

  assert.equal((await run(accountant, 'items', 'code,name,nature,uom,standard_rate\nPAPER-A4,A4 paper,stock,Ream,320\nAMC,Annual maintenance,service,,\n')).created, 2)
  assert.equal((await withTenant(tenant, (tx) => tx.select().from(items))).length, 2)
  const [group] = await withTenant(tenant, (tx) => tx.select({ isGroup: accounts.isGroup }).from(accounts).where(eq(accounts.code, '9100')))
  assert.equal(group!.isGroup, true)
})

test('opening balances become one voucher, and a file with a bad line posts nothing', async () => {
  const before = (await withTenant(tenant, (tx) => tx.select().from(entries))).length
  await assert.rejects(
    run(accountant, 'opening-balances', 'posting_date,account_code,debit,credit\n2026-03-31,9110,1000,\n2026-03-31,9100,,1000\n'),
    /9100 is a group/,
  )
  await assert.rejects(
    run(accountant, 'opening-balances', 'posting_date,account_code,debit,credit\n2026-03-31,9110,1000,\n2026-04-01,9110,,1000\n'),
    /same posting date/,
  )
  await assert.rejects(
    run(accountant, 'opening-balances', 'posting_date,account_code,debit,credit\n2026-03-31,9110,1000,5\n'),
    /either a debit or a credit/,
  )
  assert.equal((await withTenant(tenant, (tx) => tx.select().from(entries))).length, before)
  // A part of the balances, not yet balancing: the rest waits in the opening balance account.
  await run(accountant, 'opening-balances', 'posting_date,account_code,debit,credit,memo\n2026-03-31,9110,250000,,As per bank\n2026-03-31,9900,,200000,\n')
  assert.equal((await withTenant(tenant, (tx) => tx.select().from(entries))).length, before + 1)
  const trial = await trialBalance(accountant, { from: '2026-03-31', to: '2026-03-31' })
  assert.equal(trial.differencePaise, 0)
})
