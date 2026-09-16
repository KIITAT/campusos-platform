import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'
import { audit, auditLog, users, withTenant } from '@campusos/db'
import { viewsOnBehalf, type Role, type ViewerScope } from '@campusos/module-framework'
import { copies, loans, settings, titles } from '../schema'
import {
  DEFAULT_RULES,
  daysOverdue,
  dueDate,
  fineFor,
  refusalToBorrow,
  refusalToRenew,
  renewedDueDate,
  type LoanRules,
} from './rules'
import {
  addCopiesSchema,
  createTitleSchema,
  issueSchema,
  librarySettingsSchema,
  renewSchema,
  returnSchema,
  setCopyStatusSchema,
  settleFineSchema,
  waiveFineSchema,
  type BorrowerStatus,
  type CatalogueRow,
  type LoanRow,
  type OverdueReport,
} from './schemas'

const MODULE = 'library'

export interface Actor extends ViewerScope {
  id: string
  email?: string | null
  role: Role
  institutionId: string | null
}

export class LibraryError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]

const tenantOf = (actor: Actor): string => {
  if (!actor.institutionId) {
    throw new LibraryError(400, 'no_institution', 'no institution for this session')
  }
  return actor.institutionId
}

/** The desk. Everything that moves a book across it. */
const isDesk = (r: Role) =>
  r === 'library_staff' || r === 'institution_admin' || r === 'super_admin'

/** Cataloguing is the librarian's own job, not a general staff one. */
const requireDesk = (actor: Actor) => {
  const tenant = tenantOf(actor)
  if (!isDesk(actor.role)) throw new LibraryError(403, 'forbidden', 'not permitted')
  return tenant
}

/** Anyone inside the institution may read the catalogue; that is the point. */
const requireReader = (actor: Actor) => tenantOf(actor)

// --- settings --------------------------------------------------------------

/**
 * The institution's circulation rules, or the defaults. Never throws for a
 * missing row: a library that has just been enabled should lend a book, not
 * demand a settings form first.
 */
async function rulesFor(tx: Tx, tenant: string): Promise<LoanRules> {
  const [row] = await tx
    .select()
    .from(settings)
    .where(eq(settings.institutionId, tenant))
  if (!row) return DEFAULT_RULES
  return {
    loanDays: row.loanDays,
    graceDays: row.graceDays,
    finePerDayPaise: row.finePerDayPaise,
    maxConcurrentLoans: row.maxConcurrentLoans,
    maxRenewals: row.maxRenewals,
    maxFinePaise: row.maxFinePaise,
    blockAtOutstandingPaise: row.blockAtOutstandingPaise,
  }
}

export async function getSettings(actor: Actor): Promise<LoanRules> {
  const tenant = requireReader(actor)
  return withTenant(tenant, (tx) => rulesFor(tx, tenant))
}

export async function setSettings(actor: Actor, input: unknown) {
  const tenant = requireDesk(actor)
  const d = librarySettingsSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const values = {
      institutionId: tenant,
      loanDays: d.loanDays,
      graceDays: d.graceDays,
      finePerDayPaise: d.finePerDay,
      maxConcurrentLoans: d.maxConcurrentLoans,
      maxRenewals: d.maxRenewals,
      maxFinePaise: d.maxFine ?? null,
      blockAtOutstandingPaise: d.blockAtOutstanding,
      updatedAt: new Date(),
    }
    const [row] = await tx
      .insert(settings)
      .values(values)
      .onConflictDoUpdate({ target: settings.institutionId, set: values })
      .returning()
    return row!
  })
}

// --- catalogue -------------------------------------------------------------

export async function createTitle(actor: Actor, input: unknown) {
  const tenant = requireDesk(actor)
  const d = createTitleSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const [row] = await tx
      .insert(titles)
      .values({
        institutionId: tenant,
        isbn: d.isbn ?? null,
        title: d.title,
        author: d.author,
        publisher: d.publisher ?? null,
        year: d.year ?? null,
        category: d.category ?? null,
      })
      .onConflictDoNothing()
      .returning()
    if (!row) {
      throw new LibraryError(409, 'isbn_exists', 'that ISBN is already catalogued')
    }
    return row
  })
}

/**
 * Copies are added in a batch because that is how books arrive -- a carton of
 * eight, each with its own accession number written inside the cover.
 */
export async function addCopies(actor: Actor, input: unknown) {
  const tenant = requireDesk(actor)
  const d = addCopiesSchema.parse(input)

  const unique = [...new Set(d.accessionNos)]
  if (unique.length !== d.accessionNos.length) {
    throw new LibraryError(400, 'duplicate_accession', 'that list repeats an accession number')
  }

  return withTenant(tenant, async (tx) => {
    const [title] = await tx.select().from(titles).where(eq(titles.id, d.titleId))
    if (!title) throw new LibraryError(404, 'no_such_title', 'no such title')

    const rows = await tx
      .insert(copies)
      .values(
        unique.map((accessionNo) => ({
          institutionId: tenant,
          titleId: d.titleId,
          accessionNo,
          shelf: d.shelf ?? null,
          replacementPaise: d.replacement ?? null,
        })),
      )
      .onConflictDoNothing()
      .returning()

    if (rows.length !== unique.length) {
      // Partial success would leave the librarian guessing which ones landed.
      throw new LibraryError(
        409,
        'accession_exists',
        'one of those accession numbers is already in the catalogue',
      )
    }
    return rows
  })
}

/**
 * Withdraw a copy, write one off as lost, or bring it back into service. The
 * database refuses the transitions that would strand an open loan; this records
 * why, because writing off an asset is a decision.
 */
export async function setCopyStatus(actor: Actor, input: unknown) {
  const tenant = requireDesk(actor)
  const d = setCopyStatusSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const [copy] = await tx.select().from(copies).where(eq(copies.id, d.copyId))
    if (!copy) throw new LibraryError(404, 'no_such_copy', 'no such copy')
    if (copy.status === d.status) return copy

    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: `library.copy_${d.status}`,
      entity: 'library_copies',
      entityId: copy.id,
      reason: d.reason,
      detail: { accessionNo: copy.accessionNo, from: copy.status, to: d.status },
    })

    const [row] = await tx
      .update(copies)
      .set({ status: d.status })
      .where(eq(copies.id, d.copyId))
      .returning()
    return row!
  })
}

export async function catalogue(actor: Actor, q?: string): Promise<CatalogueRow[]> {
  const tenant = requireReader(actor)
  const needle = q?.trim()

  return withTenant(tenant, (tx) =>
    tx
      .select({
        titleId: titles.id,
        isbn: titles.isbn,
        title: titles.title,
        author: titles.author,
        publisher: titles.publisher,
        year: titles.year,
        category: titles.category,
        copies: sql<number>`count(${copies.id})`.mapWith(Number),
        available: sql<number>`count(*) filter (where ${copies.status} = 'available')`.mapWith(
          Number,
        ),
      })
      .from(titles)
      .leftJoin(copies, eq(copies.titleId, titles.id))
      .where(
        needle
          ? sql`(${titles.title} ilike ${'%' + needle + '%'}
                 or ${titles.author} ilike ${'%' + needle + '%'}
                 or ${titles.isbn} = ${needle.replace(/[\s-]/g, '')})`
          : undefined,
      )
      .groupBy(titles.id)
      .orderBy(asc(titles.title))
      .limit(200),
  )
}

export async function copiesOf(actor: Actor, titleId: string) {
  const tenant = requireReader(actor)
  return withTenant(tenant, (tx) =>
    tx
      .select({
        id: copies.id,
        accessionNo: copies.accessionNo,
        status: copies.status,
        shelf: copies.shelf,
        replacementPaise: copies.replacementPaise,
        dueOn: loans.dueOn,
        borrowerName: users.name,
      })
      .from(copies)
      // Only the open loan, if any: a copy back on the shelf has a history, and
      // joining all of it would return one row per past borrower.
      .leftJoin(loans, and(eq(loans.copyId, copies.id), isNull(loans.returnedAt)))
      .leftJoin(users, eq(users.id, loans.borrowerId))
      .where(eq(copies.titleId, titleId))
      .orderBy(asc(copies.accessionNo)),
  )
}

// --- circulation -----------------------------------------------------------

async function findCopy(tx: Tx, by: { copyId?: string; accessionNo?: string }) {
  const [copy] = await tx
    .select()
    .from(copies)
    .where(by.copyId ? eq(copies.id, by.copyId) : eq(copies.accessionNo, by.accessionNo!))
  if (!copy) throw new LibraryError(404, 'no_such_copy', 'no such copy')
  return copy
}

/** What this borrower still owes across every loan, waivers deducted. */
async function outstandingFine(tx: Tx, borrowerId: string): Promise<number> {
  const [row] = await tx
    .select({
      owed: sql<number>`coalesce(sum(${loans.finePaise} - ${loans.fineWaivedPaise}), 0)`.mapWith(
        Number,
      ),
    })
    .from(loans)
    .where(and(eq(loans.borrowerId, borrowerId), isNull(loans.finePaidAt)))
  return row?.owed ?? 0
}

export async function issue(actor: Actor, input: unknown) {
  const tenant = requireDesk(actor)
  const d = issueSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const [borrower] = await tx
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, d.borrowerId))
    if (!borrower) throw new LibraryError(404, 'no_such_borrower', 'no such borrower')
    if (borrower.role === 'pending') {
      throw new LibraryError(400, 'borrower_pending', 'that account is not approved yet')
    }

    const copy = await findCopy(tx, d)
    if (copy.status !== 'available') {
      throw new LibraryError(409, 'copy_not_available', `that copy is ${copy.status}`)
    }

    const rules = await rulesFor(tx, tenant)
    const [counted] = await tx
      .select({ open: sql<number>`count(*)`.mapWith(Number) })
      .from(loans)
      .where(and(eq(loans.borrowerId, d.borrowerId), isNull(loans.returnedAt)))

    const refusal = refusalToBorrow(
      {
        openLoans: counted?.open ?? 0,
        outstandingFinePaise: await outstandingFine(tx, d.borrowerId),
      },
      rules,
    )
    if (refusal) {
      throw new LibraryError(409, refusal, refusalMessage(refusal, rules))
    }

    const issuedAt = new Date()
    const [row] = await tx
      .insert(loans)
      .values({
        institutionId: tenant,
        copyId: copy.id,
        borrowerId: d.borrowerId,
        issuedAt,
        dueOn: dueDate(issuedAt, rules.loanDays),
        issuedBy: actor.id,
      })
      .returning()
    return row!
  })
}

const refusalMessage = (code: string, rules: LoanRules) =>
  code === 'loan_limit_reached'
    ? `that borrower already has ${rules.maxConcurrentLoans} books out`
    : code === 'fines_outstanding'
      ? 'that borrower has unpaid fines above the limit'
      : 'that copy cannot be issued'

/**
 * Return at the desk. The fine is computed once, here, and stored: it is what
 * the borrower was told to pay, and next term's rules must not silently restate
 * a settled loan.
 */
export async function returnCopy(actor: Actor, input: unknown) {
  const tenant = requireDesk(actor)
  const d = returnSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const copy = await findCopy(tx, d)
    const [loan] = await tx
      .select()
      .from(loans)
      .where(and(eq(loans.copyId, copy.id), isNull(loans.returnedAt)))
    if (!loan) throw new LibraryError(409, 'not_on_loan', 'that copy is not out on loan')

    const rules = await rulesFor(tx, tenant)
    const at = new Date()
    const fine = fineFor({
      dueOn: loan.dueOn,
      at,
      rules,
      replacementPaise: copy.replacementPaise,
    })

    const [row] = await tx
      .update(loans)
      .set({
        returnedAt: at,
        returnedBy: actor.id,
        finePaise: fine,
        // Nothing owed is nothing to chase: settle it in the same breath.
        finePaidAt: fine === 0 ? at : null,
      })
      .where(eq(loans.id, loan.id))
      .returning()

    if (d.markLost) {
      await audit(tx, {
        institutionId: tenant,
        actorId: actor.id,
        actorEmail: actor.email ?? null,
        moduleId: MODULE,
        action: 'library.copy_lost',
        entity: 'library_copies',
        entityId: copy.id,
        reason: 'reported lost or damaged beyond use on return',
        detail: { accessionNo: copy.accessionNo, loanId: loan.id },
      })
      // The return trigger has already shelved it; this takes it back out.
      await tx.update(copies).set({ status: 'lost' }).where(eq(copies.id, copy.id))
    }

    return { loan: row!, finePaise: fine, daysOverdue: daysOverdue(loan.dueOn, at) }
  })
}

export async function renew(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  const d = renewSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const [loan] = await tx.select().from(loans).where(eq(loans.id, d.loanId))
    if (!loan) throw new LibraryError(404, 'no_such_loan', 'no such loan')

    // A borrower may renew their own; the desk may renew anybody's.
    if (!isDesk(actor.role) && loan.borrowerId !== actor.id) {
      throw new LibraryError(403, 'forbidden', 'not permitted')
    }

    const rules = await rulesFor(tx, tenant)
    const refusal = refusalToRenew(loan, rules, new Date())
    if (refusal) {
      throw new LibraryError(
        409,
        refusal,
        refusal === 'overdue'
          ? 'that loan is already overdue; return it and pay the fine'
          : refusal === 'already_returned'
            ? 'that loan is closed'
            : `that loan has already been renewed ${rules.maxRenewals} time(s)`,
      )
    }

    const [row] = await tx
      .update(loans)
      .set({
        dueOn: renewedDueDate(loan.dueOn, rules.loanDays),
        renewals: loan.renewals + 1,
      })
      .where(eq(loans.id, d.loanId))
      .returning()
    return row!
  })
}

// --- fines -----------------------------------------------------------------

export async function waiveFine(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  if (actor.role !== 'institution_admin' && actor.role !== 'super_admin') {
    throw new LibraryError(403, 'forbidden', 'only an administrator may waive a fine')
  }
  const d = waiveFineSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const [loan] = await tx.select().from(loans).where(eq(loans.id, d.loanId))
    if (!loan) throw new LibraryError(404, 'no_such_loan', 'no such loan')
    if (d.amount > loan.finePaise) {
      throw new LibraryError(400, 'waiver_exceeds_fine', 'a waiver cannot exceed the fine')
    }

    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: 'library.fine_waived',
      entity: 'library_loans',
      entityId: loan.id,
      reason: d.reason,
      detail: {
        borrowerId: loan.borrowerId,
        finePaise: loan.finePaise,
        fromPaise: loan.fineWaivedPaise,
        toPaise: d.amount,
      },
    })

    const [row] = await tx
      .update(loans)
      .set({
        fineWaivedPaise: d.amount,
        fineWaiverReason: d.reason,
        finePaidAt: d.amount >= loan.finePaise ? new Date() : loan.finePaidAt,
      })
      .where(eq(loans.id, d.loanId))
      .returning()
    return row!
  })
}

/**
 * The fine has been paid at the desk. Deliberately not a Fees charge: Fees is
 * an optional module, and a library that cannot take a five-rupee fine because
 * the institution did not buy the finance module is a library that stops
 * working. If both are enabled, posting fines to the ledger is a later join.
 */
export async function settleFine(actor: Actor, input: unknown) {
  const tenant = requireDesk(actor)
  const d = settleFineSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const [loan] = await tx.select().from(loans).where(eq(loans.id, d.loanId))
    if (!loan) throw new LibraryError(404, 'no_such_loan', 'no such loan')
    if (loan.finePaidAt) throw new LibraryError(409, 'already_settled', 'that fine is settled')

    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: 'library.fine_settled',
      entity: 'library_loans',
      entityId: loan.id,
      reason: `fine of ${loan.finePaise - loan.fineWaivedPaise} paise taken at the desk`,
      detail: { borrowerId: loan.borrowerId, finePaise: loan.finePaise },
    })

    const [row] = await tx
      .update(loans)
      .set({ finePaidAt: new Date() })
      .where(eq(loans.id, d.loanId))
      .returning()
    return row!
  })
}

// --- reads -----------------------------------------------------------------

const loanColumns = {
  id: loans.id,
  copyId: loans.copyId,
  accessionNo: copies.accessionNo,
  title: titles.title,
  author: titles.author,
  borrowerId: loans.borrowerId,
  borrowerName: users.name,
  borrowerEmail: users.email,
  issuedAt: loans.issuedAt,
  dueOn: loans.dueOn,
  returnedAt: loans.returnedAt,
  renewals: loans.renewals,
  finePaise: loans.finePaise,
  fineWaivedPaise: loans.fineWaivedPaise,
  finePaidAt: loans.finePaidAt,
  replacementPaise: copies.replacementPaise,
}

type RawLoan = {
  [K in keyof typeof loanColumns]: unknown
}

/**
 * An open loan's fine is what it would be if the book came back now, so the
 * student sees it growing rather than discovering it at the desk. A closed
 * loan's fine is what was actually charged, and is never recomputed.
 */
function toLoanRow(r: RawLoan, rules: LoanRules, at: Date): LoanRow {
  const dueOn = r.dueOn as Date
  const returnedAt = r.returnedAt as Date | null
  const late = daysOverdue(dueOn, returnedAt ?? at)
  const accrued = returnedAt
    ? (r.finePaise as number)
    : fineFor({ dueOn, at, rules, replacementPaise: r.replacementPaise as number | null })

  return {
    id: r.id as string,
    copyId: r.copyId as string,
    accessionNo: r.accessionNo as string,
    title: r.title as string,
    author: r.author as string,
    borrowerId: r.borrowerId as string,
    borrowerName: r.borrowerName as string | null,
    borrowerEmail: r.borrowerEmail as string | null,
    issuedAt: (r.issuedAt as Date).toISOString(),
    dueOn: dueOn.toISOString(),
    returnedAt: returnedAt?.toISOString() ?? null,
    renewals: r.renewals as number,
    finePaise: accrued,
    fineWaivedPaise: r.fineWaivedPaise as number,
    finePaidAt: (r.finePaidAt as Date | null)?.toISOString() ?? null,
    daysOverdue: late,
  }
}

const loanQuery = (tx: Tx) =>
  tx
    .select(loanColumns)
    .from(loans)
    .innerJoin(copies, eq(copies.id, loans.copyId))
    .innerJoin(titles, eq(titles.id, copies.titleId))
    .innerJoin(users, eq(users.id, loans.borrowerId))

export async function borrowerStatus(actor: Actor, borrowerId: string): Promise<BorrowerStatus> {
  const tenant = tenantOf(actor)
  // A borrower may read their own; the desk may read anybody's.
  if (!viewsOnBehalf(actor, borrowerId) && !isDesk(actor.role) && borrowerId !== actor.id) {
    throw new LibraryError(403, 'forbidden', 'not permitted')
  }

  return withTenant(tenant, async (tx): Promise<BorrowerStatus> => {
    const [person] = await tx
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, borrowerId))
    if (!person) throw new LibraryError(404, 'no_such_borrower', 'no such borrower')

    const rules = await rulesFor(tx, tenant)
    const at = new Date()
    const rows = await loanQuery(tx)
      .where(eq(loans.borrowerId, borrowerId))
      .orderBy(desc(loans.issuedAt))
      .limit(100)

    const all = rows.map((r) => toLoanRow(r, rules, at))
    const open = all.filter((l) => !l.returnedAt)
    const outstandingFinePaise = await outstandingFine(tx, borrowerId)

    return {
      borrowerId,
      borrowerName: person.name,
      open,
      history: all.filter((l) => l.returnedAt),
      openCount: open.length,
      maxConcurrentLoans: rules.maxConcurrentLoans,
      outstandingFinePaise,
      blockedBy: refusalToBorrow({ openLoans: open.length, outstandingFinePaise }, rules),
    }
  })
}

export async function overdueReport(actor: Actor): Promise<OverdueReport> {
  const tenant = requireDesk(actor)

  return withTenant(tenant, async (tx): Promise<OverdueReport> => {
    const rules = await rulesFor(tx, tenant)
    const at = new Date()
    const rows = await loanQuery(tx)
      .where(and(isNull(loans.returnedAt), sql`${loans.dueOn} < now()`))
      .orderBy(asc(loans.dueOn))
      .limit(500)

    const out = rows.map((r) => toLoanRow(r, rules, at))
    return {
      rows: out,
      totalAccruedPaise: out.reduce((n, l) => n + l.finePaise - l.fineWaivedPaise, 0),
    }
  })
}

/** Everything currently out, for the desk's own view. */
export async function openLoans(actor: Actor): Promise<LoanRow[]> {
  const tenant = requireDesk(actor)
  return withTenant(tenant, async (tx) => {
    const rules = await rulesFor(tx, tenant)
    const at = new Date()
    const rows = await loanQuery(tx)
      .where(isNull(loans.returnedAt))
      .orderBy(asc(loans.dueOn))
      .limit(500)
    return rows.map((r) => toLoanRow(r, rules, at))
  })
}

export async function loanTrail(actor: Actor, loanId: string) {
  const tenant = requireDesk(actor)
  return withTenant(tenant, (tx) =>
    tx
      .select({
        action: auditLog.action,
        reason: auditLog.reason,
        actorEmail: auditLog.actorEmail,
        at: auditLog.at,
        detail: auditLog.detail,
      })
      .from(auditLog)
      .where(and(eq(auditLog.entity, 'library_loans'), eq(auditLog.entityId, loanId)))
      .orderBy(asc(auditLog.at)),
  )
}

/** Titles with no copy on the shelf, so the desk knows what to chase. */
export async function unavailableTitles(actor: Actor) {
  const tenant = requireDesk(actor)
  return withTenant(tenant, (tx) =>
    tx
      .select({ titleId: titles.id, title: titles.title, author: titles.author })
      .from(titles)
      .where(
        sql`not exists (select 1 from ${copies} c
                        where c.title_id = ${titles.id} and c.status = 'available')`,
      )
      .orderBy(asc(titles.title))
      .limit(200),
  )
}
