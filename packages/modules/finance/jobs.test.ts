import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { eq, isNotNull } from 'drizzle-orm'
import { authDb, claimJob, enqueueJob, institutions, institutionModules, jobActor, runClaimedJob, users, withTenant } from '@campusos/db'
import { createAssetCategory, createItem, createParty, makeRecurring, saveAsset, saveInvoice, type Actor } from './api'
import { depreciationSchedule, invoices } from './schema'
import { jobs } from './jobs'

let actor: Actor
before(async () => {
  const [tenant] = await authDb.insert(institutions).values({ slug: 'finance-worker-test', name: 'Finance jobs', allowedEmailDomains: [] }).returning()
  const [user] = await authDb.insert(users).values({ institutionId: tenant!.id, email: 'finance-worker@example.test', role: 'accounts_staff' }).returning()
  actor = { id: user!.id, institutionId: tenant!.id, role: 'accounts_staff' }
  await authDb.insert(institutionModules).values({ institutionId: tenant!.id, moduleId: 'finance', enabled: true })
})
after(async () => { await authDb.delete(institutions).where(eq(institutions.slug, 'finance-worker-test')) })

async function crashThenCommit(kind: string, payload: Record<string, unknown>, inspect: () => Promise<number>, before: number, after: number) {
  await withTenant(actor.institutionId!, (tx) => enqueueJob(tx, { institutionId: actor.institutionId!, actorId: actor.id, kind, dedupeKey: kind, payload }))
  const claimed = await claimJob(actor.institutionId!, 'finance-worker')
  const handler = jobs.find((job) => job.kind === kind)!
  const run = (crash: boolean) => runClaimedJob(actor.institutionId!, claimed!.id, claimed!.leaseToken!, async (tx, job) => {
    const current = await jobActor(tx, actor.institutionId!, job.actorId, 'finance', handler.roles)
    const result = await handler.run(current, tx, job.payload)
    if (crash) throw new Error('connection lost before commit')
    return result
  })
  await assert.rejects(run(true), /connection lost/)
  assert.equal(await inspect(), before)
  await run(false)
  assert.equal(await inspect(), after)
  await assert.rejects(run(false), /lease/)
  assert.equal(await inspect(), after)
}

test('recurring financial effects commit atomically with acknowledgement', async () => {
  const party = await createParty(actor, { code: 'JOB-CUSTOMER', name: 'Customer', isCustomer: true })
  const item = await createItem(actor, { code: 'JOB-SERVICE', name: 'Tuition service', nature: 'service' })
  const invoice = await saveInvoice(actor, { kind: 'sales', partyId: party.id, postingDate: '2026-04-01', lines: [{ itemId: item.id, qty: '1', rate: '100' }], submit: true }) as { id: string }
  await makeRecurring(actor, { invoiceId: invoice.id, every: 'month', nextOn: '2026-05-01', autoSubmit: true })
  const count = () => withTenant(actor.institutionId!, async (tx) => (await tx.select().from(invoices)).length)
  await crashThenCommit('finance.recurring', { on: '2026-05-01' }, count, 1, 2)
})

test('depreciation financial effects commit atomically with acknowledgement', async () => {
  const category = await createAssetCategory({ ...actor, role: 'institution_admin' }, { name: 'Job computers', method: 'slm', lifeYears: '3', residualPercent: '0', frequency: 'month' }) as { id: string }
  await saveAsset(actor, { name: 'Existing computer', categoryId: category.id, purchasedOn: '2025-04-01', gross: '36000', existing: true, openingAccumulated: '12000', depreciateFrom: '2026-04-01', submit: true })
  const count = () => withTenant(actor.institutionId!, async (tx) => (await tx.select().from(depreciationSchedule).where(isNotNull(depreciationSchedule.entryId))).length)
  await crashThenCommit('finance.depreciation', { upTo: '2026-04-30' }, count, 0, 1)
})
