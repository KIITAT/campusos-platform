import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { like, sql } from 'drizzle-orm'
import { authDb, institutions, users } from '@campusos/db'
import { createStaff, type Actor } from './api'

/**
 * A payroll run as a whole (P0-08): one person cannot stop it, part months
 * are paid by the day, and a payment cannot slip in beside it. A fresh
 * institution per test, as in books.test.ts: the journal is append-only.
 */

let n = 0
const SLUG = 'hr-run-'

interface College { id: string; admin: Actor; clerk: Actor }

async function college(): Promise<College> {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Run College', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: i!.id, role: 'institution_admin', name: 'Adm' },
      { email: `clerk@${tag}.test`, institutionId: i!.id, role: 'accounts_staff', name: 'Clerk' },
    ])
    .returning({ id: users.id })
  return {
    id: i!.id,
    admin: { id: people[0]!.id, email: `adm@${tag}.test`, role: 'institution_admin', institutionId: i!.id },
    clerk: { id: people[1]!.id, email: `clerk@${tag}.test`, role: 'accounts_staff', institutionId: i!.id },
  }
}

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

const hire = (c: College, over: Record<string, unknown> = {}) =>
  createStaff(c.admin, { employeeCode: 'E-1', name: 'A Lecturer', designation: 'Lecturer', joinedOn: '2026-01-01', ...over })

const saysDb = (re: RegExp) => (e: unknown) => {
  let text = ''
  for (let x: unknown = e; x instanceof Error; x = (x as { cause?: unknown }).cause) text += x.message + '\n'
  return re.test(text)
}

test('hr 0011 refuses to upgrade over a payslip with a negative net (ACC-14)', async () => {
  const c = await college()
  const s = await hire(c)
  const file = readFileSync(new URL('./migrations/0011_payroll_runs_whole.sql', import.meta.url), 'utf8')
  const preflight = file.split('--> statement-breakpoint')[0]!
  await assert.rejects(
    () =>
      authDb.transaction(async (tx) => {
        await tx.execute(sql`alter table hr_payslips drop constraint hr_payslips_net_not_negative`)
        await tx.execute(sql`insert into hr_payslips (institution_id, staff_id, period, gross_paise, deductions_paise, net_paise, lines)
          values (${c.id}, ${s.id}, '2026-03-01', 0, 100, -100, '[]'::jsonb)`)
        await tx.execute(sql.raw(preflight))
      }),
    saysDb(/hr 0011: 1 payslip\(s\) have a negative net/),
  )
})
