import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { and, eq, like, sql } from 'drizzle-orm'
import { auditLog, authDb, institutions, users, withTenant } from '@campusos/db'
import type { Role } from '@campusos/module-framework'
import {
  FinanceError,
  accountFor,
  createParty,
  decideApproval,
  listSodUses,
  loadIndiaPreset,
  pendingApprovals,
  saveInvoice,
  saveJournal,
  savePayment,
  setApprovalRule,
  setSingleOfficer,
  sodStatus,
  submitJournal,
  type Actor,
} from './api'
import { sodSettings } from './schema'

/**
 * Segregation of duties (P0-07, ACC-01): the person who made a supplier bill,
 * a supplier payment or a voucher does not approve it or submit it, in the
 * service and in the database; single-officer mode lifts that, and leaves a
 * trail of every use.
 */

let n = 0
const SLUG = 'fin-sod-'
const DAY = '2026-10-01'
const APPROVE = 'you made this document, so someone else must approve it'
const SUBMIT = 'you made this document, so someone else must submit it'

interface Books {
  id: string
  admin: Actor
  admin2: Actor
  clerk: Actor
  clerk2: Actor
}

async function books(): Promise<Books> {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Sod College', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const id = i!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Adm' },
      { email: `adm2@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Adm Two' },
      { email: `acc@${tag}.test`, institutionId: id, role: 'accounts_staff', name: 'Acc' },
      { email: `acc2@${tag}.test`, institutionId: id, role: 'accounts_staff', name: 'Acc Two' },
    ])
    .returning({ id: users.id })
  const who = (at: number, role: Role): Actor => ({ id: people[at]!.id, email: `${at}@${tag}.test`, role, institutionId: id })
  const b = {
    id,
    admin: who(0, 'institution_admin'),
    admin2: who(1, 'institution_admin'),
    clerk: who(2, 'accounts_staff'),
    clerk2: who(3, 'accounts_staff'),
  }
  await loadIndiaPreset(b.admin)
  return b
}

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

async function refused(p: Promise<unknown>, code: string, message?: string, status?: number) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof FinanceError, `expected a FinanceError, got ${String(e)}`)
    assert.equal(e.code, code)
    if (message) assert.equal(e.message, message)
    if (status) assert.equal(e.status, status)
    return true
  })
}

const saysDb = (re: RegExp) => (e: unknown) => {
  let text = ''
  for (let x: unknown = e; x instanceof Error; x = (x as { cause?: unknown }).cause) {
    text += x.message + '\n' + String((x as { constraint?: unknown }).constraint ?? '') + '\n'
  }
  return re.test(text)
}

const supplier = (b: Books) =>
  createParty(b.clerk, { code: `S${++n}`, name: `Supplier ${n}`, isSupplier: true, stateCode: '21' }).then((r) => r.id)
const customer = (b: Books) =>
  createParty(b.clerk, { code: `C${++n}`, name: `Customer ${n}`, isCustomer: true, stateCode: '21' }).then((r) => r.id)

async function draftJournal(by: Actor, b: Books, extra: Record<string, unknown> = {}) {
  const [bank, charges] = await withTenant(b.id, async (tx) => [await accountFor(tx, b.id, 'bank'), await accountFor(tx, b.id, 'bank_charges')])
  return (await saveJournal(by, {
    memo: 'Bank charges',
    postingDate: DAY,
    lines: [{ accountId: charges, debit: '100' }, { accountId: bank, credit: '100' }],
    ...extra,
  })) as { id: string }
}

const uses = (b: Books, action: string) =>
  withTenant(b.id, (tx) => tx.select().from(auditLog).where(and(eq(auditLog.institutionId, b.id), eq(auditLog.action, action))))

test('the creator cannot approve their own journal; someone else can', async () => {
  const b = await books()
  await setApprovalRule(b.admin, { docType: 'journal', minAmount: '1', approver: 'institution_admin' })
  const j = await draftJournal(b.admin, b)
  await refused(decideApproval(b.admin, { docType: 'journal', docId: j.id, decision: 'approved' }), 'separation_of_duties', APPROVE, 403)
  await decideApproval(b.admin2, { docType: 'journal', docId: j.id, decision: 'approved' })
  const rows = await withTenant(b.id, (tx) => tx.execute(sql`select 1 from finance_approvals where doc_id = ${j.id}`))
  assert.equal(rows.rows.length, 1)
})

test('the database refuses a creator’s approval whatever the code does', async () => {
  const b = await books()
  const j = await draftJournal(b.admin, b)
  await assert.rejects(
    withTenant(b.id, (tx) =>
      tx.execute(sql`insert into finance_approvals (institution_id, doc_type, doc_id, fingerprint, decision, decided_by)
        values (${b.id}, 'journal', ${j.id}, 'x', 'approved', ${b.admin.id})`),
    ),
    saysDb(/finance_sod_approver_is_creator/),
  )
})

test('the creator cannot submit a journal, a supplier bill or a supplier payment', async () => {
  const b = await books()
  const s = await supplier(b)
  const [bank] = await withTenant(b.id, async (tx) => [await accountFor(tx, b.id, 'bank')])
  const bill = { kind: 'purchase', partyId: s, postingDate: DAY, billNo: 'B-1', lines: [{ description: 'Paper', qty: '1', rate: '500' }] }
  const pay = { kind: 'pay', partyId: s, postingDate: DAY, accountId: bank, amount: '100' }
  await refused(draftJournal(b.clerk, b, { submit: true }), 'separation_of_duties', SUBMIT, 403)
  await refused(saveInvoice(b.clerk, { ...bill, submit: true }), 'separation_of_duties', SUBMIT, 403)
  await refused(savePayment(b.clerk, { ...pay, submit: true }), 'separation_of_duties', SUBMIT, 403)

  const j = await draftJournal(b.clerk, b)
  const submitted = (await submitJournal(b.clerk2, { journalId: j.id })) as { number?: string }
  assert.ok(submitted.number, 'a second clerk submits the first one’s journal')
})

test('the database refuses a creator’s submission', async () => {
  const b = await books()
  const j = await draftJournal(b.clerk, b)
  await assert.rejects(
    withTenant(b.id, (tx) =>
      tx.execute(sql`update finance_journals set docstatus = 'submitted', submitted_by = created_by where id = ${j.id}`),
    ),
    saysDb(/finance_sod_submitter_is_creator/),
  )
})

test('system and non-supplier documents are exempt', async () => {
  const b = await books()
  const c = await customer(b)
  const [bank] = await withTenant(b.id, async (tx) => [await accountFor(tx, b.id, 'bank')])
  await saveJournal(b.clerk, { kind: 'opening', postingDate: '2026-04-01', memo: 'Bank at the start', lines: [{ accountId: bank, debit: '500' }], submit: true })
  await saveInvoice(b.clerk, { kind: 'sales', partyId: c, postingDate: DAY, lines: [{ description: 'Hire', qty: '1', rate: '100' }], submit: true })
  await savePayment(b.clerk, { kind: 'receive', partyId: c, postingDate: DAY, accountId: bank, amount: '50', submit: true })
})

test('single-officer mode: only an administrator turns it on, and every use is on the trail', async () => {
  const b = await books()
  await setApprovalRule(b.admin, { docType: 'journal', minAmount: '1', approver: 'institution_admin' })
  await refused(setSingleOfficer(b.clerk, { enabled: true, reason: 'one accountant only' }), 'forbidden')
  await assert.rejects(setSingleOfficer(b.admin, { enabled: true, reason: 'too short' }), (e: unknown) => (e as { status?: number }).status === 400 || /too_small|at least/i.test(String(e)))
  await setSingleOfficer(b.admin, { enabled: true, reason: 'one accountant only' })
  assert.equal((await sodStatus(b.admin)).enabled, true)

  const j = await draftJournal(b.admin, b)
  await decideApproval(b.admin, { docType: 'journal', docId: j.id, decision: 'approved' })
  await submitJournal(b.admin, { journalId: j.id })

  assert.equal((await uses(b, 'sod.single_officer_enabled')).length, 1)
  const used = await uses(b, 'sod.single_officer_used')
  assert.deepEqual(used.map((r) => (r.detail as { act: string }).act).sort(), ['approve', 'submit'])
  for (const r of [...used, ...(await uses(b, 'sod.single_officer_enabled'))]) {
    assert.equal(r.institutionId, b.id)
    assert.equal(r.actorId, b.admin.id)
  }
  const listed = await listSodUses(b.admin, {})
  assert.deepEqual(listed.map((r) => r.act).sort(), ['approve', 'submit'])

  await setSingleOfficer(b.admin, { enabled: false, reason: 'a second accountant joined' })
  assert.equal((await uses(b, 'sod.single_officer_disabled')).length, 1)
  await refused(draftJournal(b.admin, b, { submit: true }), 'separation_of_duties', SUBMIT)
})

test('a draft already approved by its creator is not approved (existing data)', async () => {
  const b = await books()
  await setApprovalRule(b.admin, { docType: 'journal', minAmount: '1', approver: 'institution_admin' })
  await setSingleOfficer(b.admin, { enabled: true, reason: 'one accountant only' })
  const j = await draftJournal(b.admin, b)
  await decideApproval(b.admin, { docType: 'journal', docId: j.id, decision: 'approved' })
  await setSingleOfficer(b.admin, { enabled: false, reason: 'a second accountant joined' })
  await refused(submitJournal(b.admin2, { journalId: j.id }), 'needs_approval')
  const pending = async (a: Actor) => JSON.stringify(await pendingApprovals(a))
  assert.ok((await pending(b.admin2)).includes(j.id), 'the second administrator is asked')
  assert.ok(!(await pending(b.admin)).includes(j.id), 'the creator is not asked')
})

const settle = <T>(p: Promise<T>) =>
  p.then(() => ({ ok: true as const, error: null as unknown }), (error: unknown) => ({ ok: false as const, error }))

test('two approvers at once give one approval', async () => {
  const b = await books()
  await setApprovalRule(b.admin, { docType: 'journal', minAmount: '1', approver: 'institution_admin' })
  const j = await draftJournal(b.clerk, b)
  const { Client } = createRequire(new URL('../../db/package.json', import.meta.url))('pg') as { Client: new (o: { connectionString?: string }) => { connect(): Promise<void>; query(q: string, v?: unknown[]): Promise<unknown>; end(): Promise<void> } }
  const owner = new Client({ connectionString: process.env.MIGRATION_DATABASE_URL })
  await owner.connect()
  try {
    await owner.query('begin')
    await owner.query('select 1 from finance_journals where id = $1 for update', [j.id])
    const one = settle(decideApproval(b.admin, { docType: 'journal', docId: j.id, decision: 'approved' }))
    const two = settle(decideApproval(b.admin2, { docType: 'journal', docId: j.id, decision: 'approved' }))
    const deadline = Date.now() + 10_000
    for (;;) {
      const r = await authDb.execute<{ n: number }>(
        sql`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and query ilike '%finance_journals%for update%'`,
      )
      if (r.rows[0]!.n >= 2) break
      if (Date.now() > deadline) throw new Error('timed out waiting')
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    await owner.query('commit')
    const results = await Promise.all([one, two])
    assert.equal(results.filter((r) => r.ok).length, 1)
    const failed = results.find((r) => !r.ok)!.error as FinanceError
    assert.equal(failed.code, 'already_approved')
    assert.equal(failed.status, 409)
  } finally {
    await owner.query('rollback').catch(() => {})
    await owner.end()
  }
  const rows = await withTenant(b.id, (tx) => tx.execute(sql`select 1 from finance_approvals where doc_id = ${j.id} and decision = 'approved'`))
  assert.equal(rows.rows.length, 1)
  await refused(decideApproval(b.admin, { docType: 'journal', docId: j.id, decision: 'approved' }), 'already_approved', undefined, 409)
})

test('the settings table is tenant-isolated', async () => {
  const a = await books()
  const other = await books()
  await setSingleOfficer(a.admin, { enabled: true, reason: 'one accountant only' })
  assert.equal((await withTenant(other.id, (tx) => tx.select().from(sodSettings))).length, 0)
  await assert.rejects(
    withTenant(other.id, (tx) => tx.insert(sodSettings).values({ institutionId: a.id, singleOfficer: true })),
  )
})
