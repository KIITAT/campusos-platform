import { and, asc, eq, gte, isNull, lte, sql } from 'drizzle-orm'
import { audit, withTenant } from '@campusos/db'
import type { Role, ViewerScope } from '@campusos/module-framework'
import { accounts, budgets, entries, lines } from '../schema'
import { DEFAULT_CHART, normalSide } from './chart'
import { spentSoFar } from './periods'
import {
  archiveAccountSchema,
  createAccountSchema,
  postEntrySchema,
  reverseEntrySchema,
  trialBalanceSchema,
  type AccountPurpose,
} from './schemas'

export interface Actor extends ViewerScope {
  id: string
  email?: string | null
  role: Role
  institutionId: string | null
}

export class FinanceError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    readonly code: string,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message)
  }
}

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]

function tenantOf(actor: Actor): string {
  if (!actor.institutionId) {
    throw new FinanceError(400, 'no_institution', 'no institution for this session')
  }
  return actor.institutionId
}

/**
 * Reading the books and changing them are different rights.
 *
 * The accounts office reads: chasing an unreconciled payment means looking at
 * where it landed. Opening an account or posting a free-hand entry is the
 * institution's own decision and stays with an administrator. Faculty are out
 * of both -- a lecturer has no business in the trial balance.
 */
const canRead = (r: Role) =>
  r === 'institution_admin' || r === 'super_admin' || r === 'accounts_staff'
const canPost = (r: Role) => r === 'institution_admin' || r === 'super_admin'

// --- the chart -------------------------------------------------------------

/**
 * The default chart, written once, idempotently.
 *
 * Called when a purpose cannot be resolved rather than on every post: an
 * institution that has built its own chart never touches this, and one that has
 * not gets working books the first time a payment is recorded instead of an
 * error telling it to go and press a button somewhere else.
 */
export async function ensureDefaultChart(tx: Tx, institutionId: string): Promise<void> {
  await tx
    .insert(accounts)
    .values(
      DEFAULT_CHART.map((a) => ({
        institutionId,
        code: a.code,
        name: a.name,
        type: a.type,
        purpose: a.purpose,
      })),
    )
    .onConflictDoNothing()
}

export async function listAccounts(actor: Actor) {
  const tenant = tenantOf(actor)
  if (!canRead(actor.role)) throw new FinanceError(403, 'forbidden', 'not permitted')

  return withTenant(tenant, async (tx) => {
    const rows = await tx.select().from(accounts).orderBy(asc(accounts.code))
    if (rows.length > 0) return rows
    // First look at the screen is also the first chance to have a chart.
    await ensureDefaultChart(tx, tenant)
    return tx.select().from(accounts).orderBy(asc(accounts.code))
  })
}

export async function createAccount(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  if (!canPost(actor.role)) throw new FinanceError(403, 'forbidden', 'not permitted')
  const data = createAccountSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    try {
      const [row] = await tx
        .insert(accounts)
        .values({
          institutionId: tenant,
          code: data.code,
          name: data.name,
          type: data.type,
          purpose: data.purpose ?? null,
        })
        .returning({ id: accounts.id })
      return row!
    } catch (e) {
      if ((e as { cause?: { code?: string } }).cause?.code === '23505') {
        throw new FinanceError(
          409,
          'account_exists',
          'that code is already in this chart, or another account already serves that purpose',
        )
      }
      throw e
    }
  })
}

export async function archiveAccount(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  if (!canPost(actor.role)) throw new FinanceError(403, 'forbidden', 'not permitted')
  const { accountId, archived } = archiveAccountSchema.parse(input)

  await withTenant(tenant, async (tx) => {
    const [row] = await tx
      .update(accounts)
      .set({ archivedAt: archived ? new Date() : null })
      .where(eq(accounts.id, accountId))
      .returning({ id: accounts.id })
    if (!row) throw new FinanceError(404, 'no_such_account', 'no such account')
  })
}

// --- posting ---------------------------------------------------------------

type ResolvedLine = {
  accountId: string
  debitPaise: number
  creditPaise: number
  costCenter: string | null
  memo: string | null
}

/** Codes and purposes to account ids, seeding the default chart if it has to. */
async function resolveAccounts(
  tx: Tx,
  institutionId: string,
  wanted: { accountCode?: string; purpose?: AccountPurpose }[],
): Promise<Map<string, string>> {
  const key = (w: { accountCode?: string; purpose?: string }) =>
    w.accountCode ? `code:${w.accountCode}` : `purpose:${w.purpose}`

  const load = async () => {
    const rows = await tx
      .select({
        id: accounts.id,
        code: accounts.code,
        purpose: accounts.purpose,
        archivedAt: accounts.archivedAt,
      })
      .from(accounts)
    const byKey = new Map<string, { id: string; archivedAt: Date | null }>()
    for (const r of rows) {
      byKey.set(`code:${r.code}`, { id: r.id, archivedAt: r.archivedAt })
      if (r.purpose) byKey.set(`purpose:${r.purpose}`, { id: r.id, archivedAt: r.archivedAt })
    }
    return byKey
  }

  let byKey = await load()
  if (wanted.some((w) => !byKey.has(key(w)))) {
    await ensureDefaultChart(tx, institutionId)
    byKey = await load()
  }

  const out = new Map<string, string>()
  for (const w of wanted) {
    const k = key(w)
    const found = byKey.get(k)
    if (!found) {
      throw new FinanceError(400, 'no_such_account', `no account for ${k.replace(':', ' ')}`, {
        wanted: k,
      })
    }
    // An archived account still has history to read; it just takes no new
    // postings, which is the whole difference between archiving and deleting.
    if (found.archivedAt) {
      throw new FinanceError(409, 'account_archived', `account ${k.replace(':', ' ')} is closed`)
    }
    out.set(k, found.id)
  }
  return out
}

/**
 * Write one balanced entry.
 *
 * The balance is asserted here and again by a deferred constraint trigger at
 * commit. Twice on purpose: this path gives a caller a readable error, and the
 * trigger is what makes the guarantee true for every path, including the one
 * somebody writes next year.
 */
export async function postEntry(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  if (!canPost(actor.role)) throw new FinanceError(403, 'forbidden', 'not permitted')
  const data = postEntrySchema.parse(input)

  return withTenant(tenant, (tx) => postWithin(tx, tenant, actor.id, data))
}

/**
 * The same posting, inside a transaction somebody else opened.
 *
 * Fees calls this: recording a payment and posting it have to be one atomic
 * act, or a crash between them leaves money received and books that never heard
 * about it.
 */
export async function postWithin(
  tx: Tx,
  institutionId: string,
  postedBy: string | null,
  input: unknown,
) {
  const data = postEntrySchema.parse(input)

  const debit = data.lines.reduce((n, l) => n + l.debitPaise, 0)
  const credit = data.lines.reduce((n, l) => n + l.creditPaise, 0)
  if (debit !== credit) {
    throw new FinanceError(400, 'unbalanced', 'the two sides of an entry must agree', {
      debitPaise: debit,
      creditPaise: credit,
    })
  }
  if (debit === 0) {
    throw new FinanceError(400, 'empty_entry', 'an entry of nothing is not an entry')
  }

  const ids = await resolveAccounts(tx, institutionId, data.lines)

  let entryId: string
  try {
    const [row] = await tx
      .insert(entries)
      .values({
        institutionId,
        occurredAt: data.occurredAt ?? new Date(),
        memo: data.memo,
        sourceModule: data.sourceModule,
        sourceRef: data.sourceRef,
        postedBy,
      })
      .returning({ id: entries.id })
    entryId = row!.id
  } catch (e) {
    if ((e as { cause?: { code?: string } }).cause?.code === '23505') {
      throw new FinanceError(
        409,
        'already_posted',
        'that source reference is already in the journal',
        { sourceModule: data.sourceModule, sourceRef: data.sourceRef },
      )
    }
    throw e
  }

  const resolved: ResolvedLine[] = data.lines.map((l) => ({
    accountId: ids.get(l.accountCode ? `code:${l.accountCode}` : `purpose:${l.purpose}`)!,
    debitPaise: l.debitPaise,
    creditPaise: l.creditPaise,
    costCenter: l.costCenter ?? null,
    memo: l.memo ?? null,
  }))

  await tx.insert(lines).values(resolved.map((l) => ({ institutionId, entryId, ...l })))
  await assertWithinBudget(tx, institutionId, data.occurredAt ?? new Date(), resolved)

  return { id: entryId, totalPaise: debit }
}

/**
 * Refuse an entry that would take a cost centre past a budget it was told not
 * to pass.
 *
 * Only for budget lines explicitly marked as hard limits, and checked after the
 * lines are written so the sum includes this entry. The budget row is locked
 * first, which is what stops two entries racing for the last of it and both
 * finding room.
 *
 * Off by default everywhere, because a ledger that refuses to record what
 * happened is worse than one that records an overspend somebody has to explain.
 */
async function assertWithinBudget(
  tx: Tx,
  institutionId: string,
  occurredAt: Date,
  resolved: ResolvedLine[],
): Promise<void> {
  const spending = resolved.filter((l) => l.costCenter !== null && l.debitPaise > 0)
  if (spending.length === 0) return

  const year = occurredAt.getUTCFullYear()
  for (const line of spending) {
    const [budget] = await tx
      .select({ amountPaise: budgets.amountPaise, costCenter: budgets.costCenter })
      .from(budgets)
      .where(
        and(
          eq(budgets.year, year),
          eq(budgets.accountId, line.accountId),
          eq(budgets.costCenter, line.costCenter!),
          eq(budgets.hardLimit, true),
        ),
      )
      .for('update')
    if (!budget) continue

    const spent = await spentSoFar(tx, year, line.accountId, line.costCenter!)
    if (spent > budget.amountPaise) {
      throw new FinanceError(409, 'over_budget', 'that would take a cost centre past its budget', {
        costCenter: budget.costCenter,
        budgetPaise: budget.amountPaise,
        wouldBePaise: spent,
      })
    }
  }
}

/**
 * A posted entry is never edited. It is reversed by its mirror image, which is
 * how the error and the correction both stay visible -- an auditor asking "what
 * happened here" gets an answer rather than a gap.
 */
export async function reverseEntry(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  if (!canPost(actor.role)) throw new FinanceError(403, 'forbidden', 'not permitted')
  const { entryId, reason } = reverseEntrySchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const [original] = await tx.select().from(entries).where(eq(entries.id, entryId))
    if (!original) throw new FinanceError(404, 'no_such_entry', 'no such journal entry')
    if (original.reversalOf) {
      throw new FinanceError(409, 'already_a_reversal', 'a reversal is not itself reversed')
    }

    const originalLines = await tx.select().from(lines).where(eq(lines.entryId, entryId))

    let reversalId: string
    try {
      const [row] = await tx
        .insert(entries)
        .values({
          institutionId: tenant,
          occurredAt: new Date(),
          memo: `Reversal of ${original.memo}: ${reason}`,
          sourceModule: original.sourceModule,
          sourceRef: `reversal:${entryId}`,
          reversalOf: entryId,
          postedBy: actor.id,
        })
        .returning({ id: entries.id })
      reversalId = row!.id
    } catch (e) {
      if ((e as { cause?: { code?: string } }).cause?.code === '23505') {
        throw new FinanceError(409, 'already_reversed', 'that entry has already been reversed')
      }
      throw e
    }

    await tx.insert(lines).values(
      originalLines.map((l) => ({
        institutionId: tenant,
        entryId: reversalId,
        accountId: l.accountId,
        // The mirror: every debit becomes a credit of the same size.
        debitPaise: l.creditPaise,
        creditPaise: l.debitPaise,
        costCenter: l.costCenter,
        memo: l.memo,
      })),
    )

    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: 'finance',
      action: 'journal.reverse',
      entity: 'finance_journal_entries',
      entityId: entryId,
      reason,
    })

    return { id: reversalId }
  })
}

// --- reading ---------------------------------------------------------------

export async function listEntries(actor: Actor, limit = 100) {
  const tenant = tenantOf(actor)
  if (!canRead(actor.role)) throw new FinanceError(403, 'forbidden', 'not permitted')

  return withTenant(tenant, (tx) =>
    tx
      .select({
        id: entries.id,
        occurredAt: entries.occurredAt,
        memo: entries.memo,
        sourceModule: entries.sourceModule,
        sourceRef: entries.sourceRef,
        reversalOf: entries.reversalOf,
        totalPaise: sql<number>`coalesce(sum(${lines.debitPaise}), 0)::bigint`,
      })
      .from(entries)
      .leftJoin(lines, eq(lines.entryId, entries.id))
      .groupBy(entries.id)
      .orderBy(sql`${entries.occurredAt} desc`)
      .limit(Math.min(limit, 500)),
  )
}

export async function entryLines(actor: Actor, entryId: string) {
  const tenant = tenantOf(actor)
  if (!canRead(actor.role)) throw new FinanceError(403, 'forbidden', 'not permitted')

  return withTenant(tenant, (tx) =>
    tx
      .select({
        code: accounts.code,
        name: accounts.name,
        debitPaise: lines.debitPaise,
        creditPaise: lines.creditPaise,
        costCenter: lines.costCenter,
        memo: lines.memo,
      })
      .from(lines)
      .innerJoin(accounts, eq(accounts.id, lines.accountId))
      .where(eq(lines.entryId, entryId))
      .orderBy(asc(accounts.code)),
  )
}

/**
 * Every account, its two totals, and a balance already on the side a reader
 * expects. A trial balance whose own columns do not agree means a bug in this
 * module rather than in anyone's bookkeeping, so the caller gets the difference
 * rather than a silent report.
 */
export async function trialBalance(actor: Actor, input: unknown = {}) {
  const tenant = tenantOf(actor)
  if (!canRead(actor.role)) throw new FinanceError(403, 'forbidden', 'not permitted')
  const { from, to } = trialBalanceSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const where = [
      from ? gte(entries.occurredAt, from) : undefined,
      to ? lte(entries.occurredAt, to) : undefined,
    ].filter(Boolean)

    const rows = await tx
      .select({
        code: accounts.code,
        name: accounts.name,
        type: accounts.type,
        debitPaise: sql<number>`coalesce(sum(${lines.debitPaise}), 0)::bigint`,
        creditPaise: sql<number>`coalesce(sum(${lines.creditPaise}), 0)::bigint`,
      })
      .from(accounts)
      .leftJoin(lines, eq(lines.accountId, accounts.id))
      .leftJoin(entries, eq(entries.id, lines.entryId))
      .where(where.length ? and(...where) : undefined)
      .groupBy(accounts.id, accounts.code, accounts.name, accounts.type)
      .orderBy(asc(accounts.code))

    const accountRows = rows.map((r) => ({
      ...r,
      debitPaise: Number(r.debitPaise),
      creditPaise: Number(r.creditPaise),
      balancePaise:
        normalSide(r.type) === 'debit'
          ? Number(r.debitPaise) - Number(r.creditPaise)
          : Number(r.creditPaise) - Number(r.debitPaise),
    }))

    const debitPaise = accountRows.reduce((n, r) => n + r.debitPaise, 0)
    const creditPaise = accountRows.reduce((n, r) => n + r.creditPaise, 0)
    return { rows: accountRows, debitPaise, creditPaise, differencePaise: debitPaise - creditPaise }
  })
}

/** Whether a source reference has already been posted. Cheap idempotency check. */
export async function isPosted(tx: Tx, sourceModule: string, sourceRef: string) {
  const [row] = await tx
    .select({ id: entries.id })
    .from(entries)
    .where(
      and(
        eq(entries.sourceModule, sourceModule),
        eq(entries.sourceRef, sourceRef),
        isNull(entries.reversalOf),
      ),
    )
  return row?.id ?? null
}
