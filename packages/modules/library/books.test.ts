import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { like, sql } from 'drizzle-orm'
import {
  authDb,
  db,
  institutionModules,
  institutions,
  users,
  withTenant,
} from '@campusos/db'
import { listEntries, trialBalance, type Actor as Books } from '@campusos/module-finance/api'
import {
  addCopies,
  createTitle,
  issue,
  returnCopy,
  setSettings,
  settleFine,
  waiveFine,
  type Actor,
} from './api'

/**
 * Library fines, and the books they sometimes reach.
 *
 * A fresh institution per test: the journal is append-only, and the whole point
 * of half of these is what is and is not in it.
 */

let n = 0
const SLUG = 'lib-books-'

interface Desk {
  id: string
  admin: Actor
  desk: Actor
  studentId: string
}

async function library(): Promise<Desk> {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Books College', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const id = i!.id

  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Adm' },
      { email: `desk@${tag}.test`, institutionId: id, role: 'library_staff', name: 'Desk' },
      { email: `s1@${tag}.test`, institutionId: id, role: 'student', name: 'One Student' },
    ])
    .returning({ id: users.id })

  return {
    id,
    admin: {
      id: people[0]!.id,
      email: `adm@${tag}.test`,
      role: 'institution_admin',
      institutionId: id,
    },
    desk: {
      id: people[1]!.id,
      email: `desk@${tag}.test`,
      role: 'library_staff',
      institutionId: id,
    },
    studentId: people[2]!.id,
  }
}

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

/** Turn the books on or off for this institution, as the console would. */
async function setFinance(d: Desk, on: boolean) {
  await db
    .insert(institutionModules)
    .values({ institutionId: d.id, moduleId: 'finance', enabled: on })
    .onConflictDoUpdate({
      target: [institutionModules.institutionId, institutionModules.moduleId],
      set: { enabled: on },
    })
}

/** A book, lent, returned `days` late, with the fine standing on the loan. */
async function overdueLoan(d: Desk, days: number) {
  await setSettings(d.desk, {
    loanDays: 14,
    maxConcurrentLoans: 3,
    maxRenewals: 1,
    finePerDay: '2',
    graceDays: 0,
    blockAtOutstanding: '0',
  })
  const title = await createTitle(d.desk, {
    isbn: '978-0-262-03384-8',
    title: 'Introduction to Algorithms',
    author: 'Cormen',
    year: 2009,
  })
  const [copy] = await addCopies(d.desk, { titleId: title.id, accessionNos: ['A-1'] })
  const loan = await issue(d.desk, { copyId: copy!.id, borrowerId: d.studentId })

  await withTenant(d.id, async (tx) => {
    await tx.execute(sql`select set_config('app.audit_reason', 'test backdate', true)`)
    await tx.execute(
      sql`update library_loans
             set issued_at = now() - make_interval(days => ${14 + days}),
                 due_on    = date_trunc('day', now() - make_interval(days => ${days}))
                             + interval '23:59:59.999'
           where id = ${loan.id}`,
    )
  })

  const back = await returnCopy(d.desk, { copyId: copy!.id })
  return { loanId: loan.id, finePaise: back.finePaise }
}

const books = (d: Desk): Books => d.admin as unknown as Books

async function balance(d: Desk, code: string): Promise<number> {
  const tb = await trialBalance(books(d))
  return tb.rows.find((r) => r.code === code)?.balancePaise ?? 0
}

const CASH = '1000'
const FINES = '4100'

// ---------------------------------------------------------------------------

test('a fine taken at the desk is income when the institution keeps books', async () => {
  const d = await library()
  await setFinance(d, true)
  const { loanId, finePaise } = await overdueLoan(d, 5)
  assert.equal(finePaise, 1000)

  await settleFine(d.desk, { loanId })

  assert.equal(await balance(d, CASH), 1000)
  assert.equal(await balance(d, FINES), 1000)
  assert.equal((await trialBalance(books(d))).differencePaise, 0)
})

test('a fine is its own income, not tuition', async () => {
  const d = await library()
  await setFinance(d, true)
  const { loanId } = await overdueLoan(d, 3)
  await settleFine(d.desk, { loanId })

  // 4000 is where fees land. An overdue book is not a fee.
  assert.equal(await balance(d, '4000'), 0)
  const [entry] = await listEntries(books(d))
  assert.equal(entry!.sourceModule, 'library')
  assert.match(entry!.memo, /Library fine/)
})

test('a library without the books still takes the money', async () => {
  const d = await library()
  await setFinance(d, false)
  const { loanId, finePaise } = await overdueLoan(d, 5)

  const settled = await settleFine(d.desk, { loanId })

  // The desk works, the loan is the record, and the journal is untouched.
  assert.ok(settled.finePaidAt)
  assert.equal(finePaise, 1000)
  assert.equal((await listEntries(books(d))).length, 0)
})

test('only what was actually taken is posted, not what was owed', async () => {
  const d = await library()
  await setFinance(d, true)
  const { loanId } = await overdueLoan(d, 5)

  await waiveFine(d.admin, { loanId, amount: '4', reason: 'the book was misshelved' })
  await settleFine(d.desk, { loanId })

  // Ten rupees owed, four forgiven, six across the desk.
  assert.equal(await balance(d, CASH), 600)
  assert.equal(await balance(d, FINES), 600)
})

test('a fine forgiven in full posts nothing at all', async () => {
  const d = await library()
  await setFinance(d, true)
  const { loanId, finePaise } = await overdueLoan(d, 5)

  await waiveFine(d.admin, {
    loanId,
    amount: String(finePaise / 100),
    reason: 'the library was shut that week',
  })

  // Waiving settles it outright, and income never recognised cannot be forgone.
  assert.equal((await listEntries(books(d))).length, 0)
})

test('a fine is settled once, and so is its entry', async () => {
  const d = await library()
  await setFinance(d, true)
  const { loanId } = await overdueLoan(d, 5)

  await settleFine(d.desk, { loanId })
  await assert.rejects(() => settleFine(d.desk, { loanId }))

  assert.equal((await listEntries(books(d))).length, 1)
  assert.equal(await balance(d, CASH), 1000)
})

test('a book returned on time owes nothing and says nothing', async () => {
  const d = await library()
  await setFinance(d, true)
  const { loanId, finePaise } = await overdueLoan(d, 0)

  // Nothing owed is settled on return, so there is nothing left to take --
  // and nothing for the books to hear about either way.
  assert.equal(finePaise, 0)
  await assert.rejects(
    () => settleFine(d.desk, { loanId }),
    (e: unknown) => (e as { code?: string }).code === 'already_settled',
  )
  assert.equal((await listEntries(books(d))).length, 0)
})
