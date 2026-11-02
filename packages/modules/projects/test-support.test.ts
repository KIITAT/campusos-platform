import { after } from 'node:test'
import { randomUUID } from 'node:crypto'
import { inArray, sql } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import type { PluginActor, Role } from '@campusos/module-framework'
import { createCostCenter, createParty, localToday } from '@campusos/module-finance/api'

export type Actor = PluginActor & { institutionId: string; email: string; role: Role }
export type Office = Awaited<ReturnType<typeof office>>

const created: string[] = []
after(async () => { if (created.length) await authDb.delete(institutions).where(inArray(institutions.id, created)) })

const pad = (n: number) => String(n).padStart(2, '0')

/** An institution with an administrator, the accounts office, a manager, a worker, an outsider and a student. */
export async function office() {
  const slug = `projects-test-${randomUUID()}`
  const [institution] = await authDb.insert(institutions).values({ slug, name: 'Projects test college', allowedEmailDomains: [`${slug}.test`] }).returning()
  const id = institution!.id
  created.push(id)
  const roles = ['institution_admin', 'accounts_staff', 'faculty', 'faculty', 'faculty', 'student'] as const
  const names = ['Admin', 'Accounts', 'Manager', 'Worker', 'Outsider', 'Student']
  const people = await authDb.insert(users).values(roles.map((role, i) => ({ role, institutionId: id, email: `${names[i]!.toLowerCase()}@${slug}.test`, name: names[i] }))).returning()
  const actor = (i: number): Actor => ({ id: people[i]!.id, role: roles[i]!, institutionId: id, email: people[i]!.email ?? '' })
  const [admin, accounts, manager, worker, outsider, student] = [0, 1, 2, 3, 4, 5].map(actor) as [Actor, Actor, Actor, Actor, Actor, Actor]
  await createCostCenter(admin, { code: 'PRJ', name: 'Project' })
  const customer = ((await createParty(accounts, { code: 'C1', name: 'Client One', isCustomer: true })) as { id: string }).id
  const supplier = ((await createParty(accounts, { code: 'S1', name: 'Supplier One', isSupplier: true })) as { id: string }).id
  const today = await withTenant(id, (tx) => localToday(tx, id))
  const [year, month] = today.split('-').map(Number) as [number, number]
  const prev = month === 1 ? { y: year - 1, m: 12 } : { y: year, m: month - 1 }
  const first = `${prev.y}-${pad(prev.m)}-01`
  const lastDay = new Date(Date.UTC(prev.y, prev.m, 0)).getUTCDate()
  const last = {
    first,
    days: [1, 2, 3, 4, 5].map((d) => `${prev.y}-${pad(prev.m)}-${pad(d)}`),
    end: `${prev.y}-${pad(prev.m)}-${pad(lastDay)}`,
    period: `${prev.y}-${pad(prev.m)}`,
    year: prev.y,
    month: prev.m,
  }
  return { id, admin, accounts, manager, worker, outsider, student, customer, supplier, today, last }
}

/** Until `n` sessions are waiting on a lock in a statement that matches. */
export async function waitingOn(pattern: string, n = 1) {
  const deadline = Date.now() + 10_000
  for (;;) {
    const r = await authDb.execute<{ n: number }>(sql`
      select count(*)::int as n from pg_stat_activity
       where wait_event_type = 'Lock' and query ilike ${pattern}`)
    if (r.rows[0]!.n >= n) return
    if (Date.now() > deadline) throw new Error(`nobody is waiting on ${pattern}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** The database's clock, as text, for `actions`. */
export async function since() {
  const r = await authDb.execute<{ at: string }>(sql`select clock_timestamp()::text as at`)
  return r.rows[0]!.at
}

/** The module's audit actions from a moment on, in order. */
export async function actions(o: Office, from: string) {
  const r = await authDb.execute<{ action: string }>(sql`
    select action from audit_log
     where institution_id = ${o.id} and module_id = 'projects' and at >= ${from}::timestamptz
     order by at, id`)
  return r.rows.map((x) => x.action)
}
