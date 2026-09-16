import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, sql } from 'drizzle-orm'
import { auditLog, authDb, db, institutions, users, withTenant } from '@campusos/db'
import {
  LibraryError,
  addCopies,
  borrowerStatus,
  catalogue,
  copiesOf,
  createTitle,
  getSettings,
  issue,
  loanTrail,
  openLoans,
  overdueReport,
  renew,
  returnCopy,
  setCopyStatus,
  setSettings,
  settleFine,
  waiveFine,
  type Actor,
} from './api'
import { copies, loans, settings, titles } from './schema'

const SLUG = 'lib-test'
const OTHER = 'lib-other'
let inst: string
let other: string
const ids = { desk: '', adm: '', fac: '', s1: '', s2: '', pending: '' }

const A = (over: Partial<Actor>): Actor => ({
  id: ids.desk,
  email: 'desk@lib.test',
  role: 'library_staff',
  institutionId: inst,
  ...over,
})
const desk = () => A({})
const admin = () => A({ id: ids.adm, email: 'adm@lib.test', role: 'institution_admin' })
const student = (id: string) => A({ id, role: 'student' })
const code = (e: unknown) => (e as LibraryError).code
const status = (e: unknown) => (e as LibraryError).status

/** Drizzle hangs the real Postgres message off .cause; look down the chain. */
const saysDb = (re: RegExp) => (e: unknown) => {
  let text = ''
  for (let x: unknown = e; x instanceof Error; x = (x as { cause?: unknown }).cause) {
    text += x.message + String.fromCharCode(10)
  }
  return re.test(text)
}

const mkTitle = (over: Record<string, unknown> = {}) =>
  createTitle(desk(), {
    isbn: '978-0-262-03384-8',
    title: 'Introduction to Algorithms',
    author: 'Cormen',
    year: 2009,
    ...over,
  })

async function stocked(n = 1, over: Record<string, unknown> = {}) {
  const t = await mkTitle(over)
  const c = await addCopies(desk(), {
    titleId: t.id,
    accessionNos: Array.from({ length: n }, (_, i) => `ACC-${t.id.slice(0, 6)}-${i}`),
  })
  return { title: t, copies: c }
}

before(async () => {
  const rows = await authDb
    .insert(institutions)
    .values([
      { slug: SLUG, name: 'Library College', allowedEmailDomains: ['lib.test'] },
      { slug: OTHER, name: 'Other College', allowedEmailDomains: ['libother.test'] },
    ])
    .returning({ id: institutions.id })
  inst = rows[0]!.id
  other = rows[1]!.id

  const people = await authDb
    .insert(users)
    .values([
      { email: 'desk@lib.test', institutionId: inst, role: 'library_staff', name: 'Desk' },
      { email: 'adm@lib.test', institutionId: inst, role: 'institution_admin', name: 'Adm' },
      { email: 'fac@lib.test', institutionId: inst, role: 'faculty', name: 'Fac' },
      { email: 's1@lib.test', institutionId: inst, role: 'student', name: 'One Student' },
      { email: 's2@lib.test', institutionId: inst, role: 'student', name: 'Two Student' },
      { email: 'new@lib.test', institutionId: inst, role: 'pending', name: 'Not Approved' },
    ])
    .returning({ id: users.id })
  ids.desk = people[0]!.id
  ids.adm = people[1]!.id
  ids.fac = people[2]!.id
  ids.s1 = people[3]!.id
  ids.s2 = people[4]!.id
  ids.pending = people[5]!.id
})

beforeEach(async () => {
  await withTenant(inst, async (tx) => {
    // The guards refuse a silent reopen, so the reset states its reason.
    await tx.execute(sql`select set_config('app.audit_reason', 'test reset', true)`)
    await tx.delete(loans)
    await tx.delete(copies)
    await tx.delete(titles)
    await tx.delete(settings)
    await tx.delete(auditLog)
  })
})

after(async () => {
  await authDb.delete(institutions).where(eq(institutions.slug, SLUG))
  await authDb.delete(institutions).where(eq(institutions.slug, OTHER))
})

// --- who may do what -------------------------------------------------------

test('a student cannot catalogue a book', async () => {
  await assert.rejects(
    () => createTitle(student(ids.s1), { title: 'X', author: 'Y' }),
    (e: unknown) => status(e) === 403,
  )
})

test('a student can search the catalogue -- one nobody can search is a cupboard', async () => {
  await stocked(2)
  const rows = await catalogue(student(ids.s1))
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.copies, 2)
  assert.equal(rows[0]!.available, 2)
})

test('only the desk issues and returns', async () => {
  const { copies: c } = await stocked()
  await assert.rejects(
    () => issue(student(ids.s1), { copyId: c[0]!.id, borrowerId: ids.s1 }),
    (e: unknown) => status(e) === 403,
  )
})

test('only an administrator waives a fine, not the desk', async () => {
  const { copies: c } = await stocked()
  const loan = await issue(desk(), { copyId: c[0]!.id, borrowerId: ids.s1 })
  await overdueBy(loan.id, 10)
  const back = await returnCopy(desk(), { copyId: c[0]!.id })
  assert.ok(back.finePaise > 0)

  await assert.rejects(
    () => waiveFine(desk(), { loanId: loan.id, amount: '1', reason: 'goodwill gesture' }),
    (e: unknown) => status(e) === 403,
  )
  const waived = await waiveFine(admin(), {
    loanId: loan.id,
    amount: '1',
    reason: 'goodwill gesture',
  })
  assert.equal(waived.fineWaivedPaise, 100)
})

// --- catalogue -------------------------------------------------------------

test('the same ISBN cannot be catalogued twice', async () => {
  await mkTitle()
  await assert.rejects(() => mkTitle(), (e: unknown) => code(e) === 'isbn_exists')
})

test('two books without an ISBN do not collide', async () => {
  await mkTitle({ isbn: null, title: 'Bound Thesis 48' })
  await mkTitle({ isbn: null, title: 'Bound Thesis 49' })
  assert.equal((await catalogue(desk())).length, 2)
})

test('a malformed ISBN is refused before it reaches the shelf', async () => {
  await assert.rejects(() => mkTitle({ isbn: '12345' }))
})

test('an accession number is unique within the institution', async () => {
  const t = await mkTitle()
  await addCopies(desk(), { titleId: t.id, accessionNos: ['A-1'] })
  await assert.rejects(
    () => addCopies(desk(), { titleId: t.id, accessionNos: ['A-1'] }),
    (e: unknown) => code(e) === 'accession_exists',
  )
})

test('a batch that repeats a number is refused whole, not half-applied', async () => {
  const t = await mkTitle()
  await assert.rejects(
    () => addCopies(desk(), { titleId: t.id, accessionNos: ['B-1', 'B-1'] }),
    (e: unknown) => code(e) === 'duplicate_accession',
  )
  assert.equal((await copiesOf(desk(), t.id)).length, 0)
})

test('search matches title, author and a hyphenated ISBN alike', async () => {
  await stocked(1)
  assert.equal((await catalogue(desk(), 'algor')).length, 1)
  assert.equal((await catalogue(desk(), 'cormen')).length, 1)
  assert.equal((await catalogue(desk(), '978-0-262-03384-8')).length, 1)
  assert.equal((await catalogue(desk(), 'sipser')).length, 0)
})

// --- issue and return ------------------------------------------------------

test('issuing takes the copy off the shelf', async () => {
  const { title, copies: c } = await stocked()
  await issue(desk(), { copyId: c[0]!.id, borrowerId: ids.s1 })

  const [copy] = await copiesOf(desk(), title.id)
  assert.equal(copy!.status, 'on_loan')
  assert.equal(copy!.borrowerName, 'One Student')
  assert.equal((await catalogue(desk()))[0]!.available, 0)
})

test('the desk can issue by the number stamped inside the cover', async () => {
  const { copies: c } = await stocked()
  const loan = await issue(desk(), { accessionNo: c[0]!.accessionNo, borrowerId: ids.s1 })
  assert.equal(loan.copyId, c[0]!.id)
})

test('the same copy cannot be issued twice, and the database says so', async () => {
  const { copies: c } = await stocked()
  await issue(desk(), { copyId: c[0]!.id, borrowerId: ids.s1 })
  await assert.rejects(
    () => issue(desk(), { copyId: c[0]!.id, borrowerId: ids.s2 }),
    (e: unknown) => code(e) === 'copy_not_available',
  )
  // ...and again with the application check bypassed entirely
  await assert.rejects(
    () =>
      withTenant(inst, (tx) =>
        tx.insert(loans).values({
          institutionId: inst,
          copyId: c[0]!.id,
          borrowerId: ids.s2,
          dueOn: new Date(Date.now() + 86_400_000),
        }),
      ),
    saysDb(/cannot be issued|library_loans_one_open/),
  )
})

test('an unapproved account cannot borrow', async () => {
  const { copies: c } = await stocked()
  await assert.rejects(
    () => issue(desk(), { copyId: c[0]!.id, borrowerId: ids.pending }),
    (e: unknown) => code(e) === 'borrower_pending',
  )
})

test('returning puts the copy back and closes the loan', async () => {
  const { title, copies: c } = await stocked()
  await issue(desk(), { copyId: c[0]!.id, borrowerId: ids.s1 })
  const back = await returnCopy(desk(), { copyId: c[0]!.id })

  assert.equal(back.finePaise, 0)
  assert.ok(back.loan.returnedAt)
  assert.equal((await copiesOf(desk(), title.id))[0]!.status, 'available')
  assert.equal((await catalogue(desk()))[0]!.available, 1)
})

test('returning something nobody borrowed is refused', async () => {
  const { copies: c } = await stocked()
  await assert.rejects(
    () => returnCopy(desk(), { copyId: c[0]!.id }),
    (e: unknown) => code(e) === 'not_on_loan',
  )
})

test('a copy that came back destroyed is written off, not shelved', async () => {
  const { title, copies: c } = await stocked()
  await issue(desk(), { copyId: c[0]!.id, borrowerId: ids.s1 })
  await returnCopy(desk(), { copyId: c[0]!.id, markLost: true })
  assert.equal((await copiesOf(desk(), title.id))[0]!.status, 'lost')
  assert.equal((await catalogue(desk()))[0]!.available, 0)
})

test('the same copy circulates again after coming back', async () => {
  const { copies: c } = await stocked()
  await issue(desk(), { copyId: c[0]!.id, borrowerId: ids.s1 })
  await returnCopy(desk(), { copyId: c[0]!.id })
  const second = await issue(desk(), { copyId: c[0]!.id, borrowerId: ids.s2 })
  assert.equal(second.borrowerId, ids.s2)
})

// --- limits ----------------------------------------------------------------

test('a borrower cannot exceed the loan limit, and hears which rule said no', async () => {
  await setSettings(desk(), baseSettings({ maxConcurrentLoans: 2 }))
  const { copies: c } = await stocked(3)
  await issue(desk(), { copyId: c[0]!.id, borrowerId: ids.s1 })
  await issue(desk(), { copyId: c[1]!.id, borrowerId: ids.s1 })
  await assert.rejects(
    () => issue(desk(), { copyId: c[2]!.id, borrowerId: ids.s1 }),
    (e: unknown) => code(e) === 'loan_limit_reached',
  )
  // Another borrower is unaffected: the limit is per person.
  const ok = await issue(desk(), { copyId: c[2]!.id, borrowerId: ids.s2 })
  assert.ok(ok.id)
})

test('unpaid fines above the threshold block borrowing', async () => {
  await setSettings(desk(), baseSettings({ blockAtOutstanding: '2' }))
  const { copies: c } = await stocked(2)
  const loan = await issue(desk(), { copyId: c[0]!.id, borrowerId: ids.s1 })
  await overdueBy(loan.id, 10)
  await returnCopy(desk(), { copyId: c[0]!.id })

  await assert.rejects(
    () => issue(desk(), { copyId: c[1]!.id, borrowerId: ids.s1 }),
    (e: unknown) => code(e) === 'fines_outstanding',
  )

  await settleFine(desk(), { loanId: loan.id })
  const ok = await issue(desk(), { copyId: c[1]!.id, borrowerId: ids.s1 })
  assert.ok(ok.id)
})

// --- renewal ---------------------------------------------------------------

test('a loan in good standing renews from its due date', async () => {
  const { copies: c } = await stocked()
  const loan = await issue(desk(), { copyId: c[0]!.id, borrowerId: ids.s1 })
  const renewed = await renew(desk(), { loanId: loan.id })
  assert.equal(renewed.renewals, 1)
  assert.ok(renewed.dueOn.getTime() > loan.dueOn.getTime())
})

test('a borrower may renew their own loan but not somebody else s', async () => {
  const { copies: c } = await stocked(2)
  const mine = await issue(desk(), { copyId: c[0]!.id, borrowerId: ids.s1 })
  const theirs = await issue(desk(), { copyId: c[1]!.id, borrowerId: ids.s2 })
  await renew(student(ids.s1), { loanId: mine.id })
  await assert.rejects(
    () => renew(student(ids.s1), { loanId: theirs.id }),
    (e: unknown) => status(e) === 403,
  )
})

test('an overdue loan cannot be renewed', async () => {
  const { copies: c } = await stocked()
  const loan = await issue(desk(), { copyId: c[0]!.id, borrowerId: ids.s1 })
  await overdueBy(loan.id, 3)
  await assert.rejects(
    () => renew(desk(), { loanId: loan.id }),
    (e: unknown) => code(e) === 'overdue',
  )
})

// --- fines -----------------------------------------------------------------

test('a fine accrues at the configured rate and is stored on return', async () => {
  await setSettings(desk(), baseSettings({ finePerDay: '2' }))
  const { copies: c } = await stocked()
  const loan = await issue(desk(), { copyId: c[0]!.id, borrowerId: ids.s1 })
  await overdueBy(loan.id, 5)

  const back = await returnCopy(desk(), { copyId: c[0]!.id })
  assert.equal(back.daysOverdue, 5)
  assert.equal(back.finePaise, 1000)
  assert.equal(back.loan.finePaise, 1000)
  assert.equal(back.loan.finePaidAt, null)
})

test('a returned loan keeps the fine it was charged when the rules later change', async () => {
  await setSettings(desk(), baseSettings({ finePerDay: '2' }))
  const { copies: c } = await stocked()
  const loan = await issue(desk(), { copyId: c[0]!.id, borrowerId: ids.s1 })
  await overdueBy(loan.id, 5)
  await returnCopy(desk(), { copyId: c[0]!.id })

  await setSettings(desk(), baseSettings({ finePerDay: '50' }))
  const s = await borrowerStatus(desk(), ids.s1)
  assert.equal(s.history[0]!.finePaise, 1000)
})

test('an open loan shows the fine growing rather than hiding it until the desk', async () => {
  await setSettings(desk(), baseSettings({ finePerDay: '2' }))
  const { copies: c } = await stocked()
  const loan = await issue(desk(), { copyId: c[0]!.id, borrowerId: ids.s1 })
  await overdueBy(loan.id, 4)

  const s = await borrowerStatus(student(ids.s1), ids.s1)
  assert.equal(s.open[0]!.daysOverdue, 4)
  assert.equal(s.open[0]!.finePaise, 800)
})

test('a fine never exceeds what the copy is worth', async () => {
  await setSettings(desk(), baseSettings({ finePerDay: '50' }))
  const t = await mkTitle()
  const [copy] = await addCopies(desk(), {
    titleId: t.id,
    accessionNos: ['CAP-1'],
    replacement: '300',
  })
  const loan = await issue(desk(), { copyId: copy!.id, borrowerId: ids.s1 })
  await overdueBy(loan.id, 40)

  const back = await returnCopy(desk(), { copyId: copy!.id })
  assert.equal(back.finePaise, 30_000)
})

test('waiving a fine is audited and cannot exceed it', async () => {
  const { copies: c } = await stocked()
  const loan = await issue(desk(), { copyId: c[0]!.id, borrowerId: ids.s1 })
  await overdueBy(loan.id, 10)
  await returnCopy(desk(), { copyId: c[0]!.id })

  await assert.rejects(
    () => waiveFine(admin(), { loanId: loan.id, amount: '500', reason: 'far too generous' }),
    (e: unknown) => code(e) === 'waiver_exceeds_fine',
  )

  await waiveFine(admin(), { loanId: loan.id, amount: '10', reason: 'library was shut that week' })
  const trail = await loanTrail(desk(), loan.id)
  assert.equal(trail[0]!.action, 'library.fine_waived')
  assert.match(trail[0]!.reason!, /shut that week/)
})

test('a fully waived fine settles the loan', async () => {
  const { copies: c } = await stocked()
  const loan = await issue(desk(), { copyId: c[0]!.id, borrowerId: ids.s1 })
  await overdueBy(loan.id, 10)
  await returnCopy(desk(), { copyId: c[0]!.id })
  const waived = await waiveFine(admin(), {
    loanId: loan.id,
    amount: '10',
    reason: 'library was shut that week',
  })
  assert.ok(waived.finePaidAt)
  assert.equal((await borrowerStatus(desk(), ids.s1)).outstandingFinePaise, 0)
})

test('the database refuses a fine waiver with no reason in scope', async () => {
  const { copies: c } = await stocked()
  const loan = await issue(desk(), { copyId: c[0]!.id, borrowerId: ids.s1 })
  await overdueBy(loan.id, 10)
  await returnCopy(desk(), { copyId: c[0]!.id })

  await assert.rejects(
    () =>
      withTenant(inst, (tx) =>
        tx
          .update(loans)
          .set({ fineWaivedPaise: 100, fineWaiverReason: 'quietly forgiven' })
          .where(eq(loans.id, loan.id)),
      ),
    saysDb(/requires an audited reason/),
  )
})

test('settling twice is refused', async () => {
  const { copies: c } = await stocked()
  const loan = await issue(desk(), { copyId: c[0]!.id, borrowerId: ids.s1 })
  await overdueBy(loan.id, 10)
  await returnCopy(desk(), { copyId: c[0]!.id })
  await settleFine(desk(), { loanId: loan.id })
  await assert.rejects(
    () => settleFine(desk(), { loanId: loan.id }),
    (e: unknown) => code(e) === 'already_settled',
  )
})

// --- what the database refuses regardless of the application ---------------

test('a loan cannot be re-pointed at another copy or borrower', async () => {
  const { copies: c } = await stocked(2)
  const loan = await issue(desk(), { copyId: c[0]!.id, borrowerId: ids.s1 })
  await assert.rejects(
    () =>
      withTenant(inst, (tx) =>
        tx.update(loans).set({ borrowerId: ids.s2 }).where(eq(loans.id, loan.id)),
      ),
    saysDb(/cannot be reassigned/),
  )
})

test('reopening a returned loan needs an audited reason', async () => {
  const { copies: c } = await stocked()
  const loan = await issue(desk(), { copyId: c[0]!.id, borrowerId: ids.s1 })
  await returnCopy(desk(), { copyId: c[0]!.id })

  await assert.rejects(
    () =>
      withTenant(inst, (tx) =>
        tx.update(loans).set({ returnedAt: null }).where(eq(loans.id, loan.id)),
      ),
    saysDb(/requires an audited reason/),
  )

  // With a reason, it goes through and the copy comes back off the shelf.
  await withTenant(inst, async (tx) => {
    await tx.execute(sql`select set_config('app.audit_reason', 'scanned back in error', true)`)
    await tx.update(loans).set({ returnedAt: null }).where(eq(loans.id, loan.id))
  })
  const [copy] = await withTenant(inst, (tx) =>
    tx.select({ status: copies.status }).from(copies).where(eq(copies.id, c[0]!.id)),
  )
  assert.equal(copy!.status, 'on_loan')
})

test('a copy out on loan cannot be withdrawn underneath its borrower', async () => {
  const { copies: c } = await stocked()
  await issue(desk(), { copyId: c[0]!.id, borrowerId: ids.s1 })
  await assert.rejects(
    () =>
      setCopyStatus(desk(), {
        copyId: c[0]!.id,
        status: 'withdrawn',
        reason: 'weeding the shelves',
      }),
    saysDb(/out on loan/),
  )
})

test('a copy cannot be marked on loan without a loan to say so', async () => {
  const { copies: c } = await stocked()
  await assert.rejects(
    () =>
      setCopyStatus(desk(), {
        copyId: c[0]!.id,
        status: 'on_loan',
        reason: 'pretending it is out',
      }),
    saysDb(/only because a loan says so/),
  )
})

test('a withdrawn copy cannot be lent', async () => {
  const { copies: c } = await stocked()
  await setCopyStatus(desk(), {
    copyId: c[0]!.id,
    status: 'withdrawn',
    reason: 'falling apart at the spine',
  })
  await assert.rejects(
    () => issue(desk(), { copyId: c[0]!.id, borrowerId: ids.s1 }),
    (e: unknown) => code(e) === 'copy_not_available',
  )
})

// --- reports ---------------------------------------------------------------

test('the overdue report lists the late and totals what is owed', async () => {
  await setSettings(desk(), baseSettings({ finePerDay: '2' }))
  const { copies: c } = await stocked(3)
  const a = await issue(desk(), { copyId: c[0]!.id, borrowerId: ids.s1 })
  const b = await issue(desk(), { copyId: c[1]!.id, borrowerId: ids.s2 })
  await issue(desk(), { copyId: c[2]!.id, borrowerId: ids.s1 })
  await overdueBy(a.id, 5)
  await overdueBy(b.id, 2)

  const r = await overdueReport(desk())
  assert.equal(r.rows.length, 2)
  assert.equal(r.rows[0]!.borrowerId, ids.s1, 'longest overdue first')
  assert.equal(r.totalAccruedPaise, 1000 + 400)
})

test('a student cannot read the overdue report or another borrower s status', async () => {
  await assert.rejects(() => overdueReport(student(ids.s1)), (e: unknown) => status(e) === 403)
  await assert.rejects(
    () => borrowerStatus(student(ids.s1), ids.s2),
    (e: unknown) => status(e) === 403,
  )
  const own = await borrowerStatus(student(ids.s1), ids.s1)
  assert.equal(own.borrowerId, ids.s1)
})

test('the desk sees everything currently out', async () => {
  const { copies: c } = await stocked(2)
  await issue(desk(), { copyId: c[0]!.id, borrowerId: ids.s1 })
  await issue(desk(), { copyId: c[1]!.id, borrowerId: ids.s2 })
  assert.equal((await openLoans(desk())).length, 2)
})

test('status reports the rule blocking a borrower, not merely that they are blocked', async () => {
  await setSettings(desk(), baseSettings({ maxConcurrentLoans: 1 }))
  const { copies: c } = await stocked(2)
  await issue(desk(), { copyId: c[0]!.id, borrowerId: ids.s1 })
  const s = await borrowerStatus(desk(), ids.s1)
  assert.equal(s.blockedBy, 'loan_limit_reached')
  assert.equal(s.maxConcurrentLoans, 1)
})

// --- settings --------------------------------------------------------------

test('a library with no settings row still lends, on the defaults', async () => {
  const r = await getSettings(desk())
  assert.equal(r.loanDays, 14)
  const { copies: c } = await stocked()
  const loan = await issue(desk(), { copyId: c[0]!.id, borrowerId: ids.s1 })
  const days = Math.round((loan.dueOn.getTime() - loan.issuedAt.getTime()) / 86_400_000)
  assert.equal(days, 14)
})

test('settings are per institution and the desk can change them', async () => {
  await setSettings(desk(), baseSettings({ loanDays: 7 }))
  assert.equal((await getSettings(desk())).loanDays, 7)
  await assert.rejects(
    () => setSettings(student(ids.s1), baseSettings({ loanDays: 90 })),
    (e: unknown) => status(e) === 403,
  )
})

// --- tenancy ---------------------------------------------------------------

test('another institution sees none of this, and RLS not the query says so', async () => {
  await stocked(2)
  const seen = await withTenant(other, async (tx) => ({
    titles: await tx.select().from(titles),
    copies: await tx.select().from(copies),
  }))
  assert.deepEqual([seen.titles.length, seen.copies.length], [0, 0])
})

test('a session with no tenant set reads nothing rather than erroring', async () => {
  await stocked()
  assert.equal((await db.select().from(titles)).length, 0)
})

test('a librarian of another institution cannot reach into this one', async () => {
  const { copies: c } = await stocked()
  await assert.rejects(
    () => issue(A({ institutionId: other }), { copyId: c[0]!.id, borrowerId: ids.s1 }),
    (e: unknown) => code(e) === 'no_such_borrower' || code(e) === 'no_such_copy',
  )
})

// --- helpers ---------------------------------------------------------------

function baseSettings(over: Record<string, unknown> = {}) {
  return {
    loanDays: 14,
    graceDays: 0,
    finePerDay: '1',
    maxConcurrentLoans: 3,
    maxRenewals: 1,
    maxFine: null,
    blockAtOutstanding: '0',
    ...over,
  }
}

/**
 * Backdate a loan so it is `days` past due. Clock manipulation in the test
 * rather than in the code: the rules take `at` as an argument precisely so the
 * production path never needs a fake clock.
 */
async function overdueBy(loanId: string, days: number) {
  await withTenant(inst, async (tx) => {
    await tx.execute(sql`select set_config('app.audit_reason', 'test backdate', true)`)
    await tx.execute(
      sql`update library_loans
             set issued_at = now() - make_interval(days => ${14 + days}),
                 due_on    = date_trunc('day', now() - make_interval(days => ${days}))
                             + interval '23:59:59.999'
           where id = ${loanId}`,
    )
  })
}
