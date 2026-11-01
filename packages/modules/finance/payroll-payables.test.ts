import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, like } from 'drizzle-orm'
import { authDb, institutions, withTenant } from '@campusos/db'
import { accountFor, postWithin, purposeBalance, type AccountPurpose } from './api'
import { accounts } from './schema'

/** A payable account per statutory payroll head (P1-06a, ACC-24). */

const SLUG = 'fin-pp-'

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

test('an institution whose chart predates P1-06a gets the four payroll payables on first use', async () => {
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: `${SLUG}1`, name: 'Old Chart College', allowedEmailDomains: [`${SLUG}1.test`] })
    .returning({ id: institutions.id })
  const id = i!.id
  await withTenant(id, (tx) => accountFor(tx, id, 'salaries_payable'))
  const purposes = ['pf_payable', 'esi_payable', 'pt_payable', 'salary_tds_payable'] as const
  for (const p of purposes) await withTenant(id, (tx) => accountFor(tx, id, p as AccountPurpose))
  const rows = await withTenant(id, (tx) =>
    tx.select({ code: accounts.code, purpose: accounts.purpose }).from(accounts).where(eq(accounts.institutionId, id)),
  )
  const got = rows.filter((r) => (purposes as readonly string[]).includes(r.purpose ?? '')).sort((a, b) => a.code.localeCompare(b.code))
  assert.deepEqual(got.map((r) => [r.code, r.purpose]), [
    ['2210', 'pf_payable'], ['2220', 'esi_payable'], ['2230', 'pt_payable'], ['2240', 'salary_tds_payable'],
  ])
})

test('the gratuity provision account appears on first use and purposeBalance reads it by date', async () => {
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: `${SLUG}2`, name: 'Provision College', allowedEmailDomains: [`${SLUG}2.test`] })
    .returning({ id: institutions.id })
  const id = i!.id
  await withTenant(id, async (tx) => {
    await accountFor(tx, id, 'gratuity_provision' as AccountPurpose)
    await postWithin(tx, id, null, {
      postingDate: '2026-09-30',
      memo: 'provision',
      sourceModule: 'test',
      sourceRef: 'p1',
      lines: [{ purpose: 'employer_cost', debitPaise: 100_000 }, { purpose: 'gratuity_provision', creditPaise: 100_000 }],
    })
    await postWithin(tx, id, null, {
      postingDate: '2026-10-15',
      memo: 'payout',
      sourceModule: 'test',
      sourceRef: 'p2',
      lines: [{ purpose: 'gratuity_provision', debitPaise: 30_000 }, { purpose: 'bank', creditPaise: 30_000 }],
    })
  })
  const [acct] = await withTenant(id, (tx) =>
    tx
      .select({ code: accounts.code, type: accounts.type, subtype: accounts.subtype })
      .from(accounts)
      .where(eq(accounts.purpose, 'gratuity_provision' as AccountPurpose)),
  )
  assert.deepEqual(acct, { code: '2250', type: 'liability', subtype: 'provision' })
  const bal = (p: AccountPurpose, on: string) => withTenant(id, (tx) => purposeBalance(tx, p, on))
  assert.equal(await bal('gratuity_provision', '2026-09-29'), 0)
  assert.equal(await bal('gratuity_provision', '2026-09-30'), 100_000)
  assert.equal(await bal('gratuity_provision', '2026-10-31'), 70_000)
  assert.equal(await bal('employer_cost', '2026-10-31'), 100_000)
  assert.equal(await bal('bank', '2026-10-31'), -30_000)
})
