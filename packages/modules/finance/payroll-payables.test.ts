import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, like } from 'drizzle-orm'
import { authDb, institutions, withTenant } from '@campusos/db'
import { accountFor, type AccountPurpose } from './api'
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
