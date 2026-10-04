import { and, asc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm'
import { audit, withTenant } from '@campusos/db'
import { accounts, budgets, entries, lines } from '../schema'
import { DEFAULT_CHART, normalSide } from './chart'
import { spentSoFar } from './periods'
import { fiscalYearStart, localToday } from './years'
import {
  FinanceError,
  canConfigure,
  canRead,
  named,
  refusal,
  requireConfigure,
  requireRead,
  tenantOf,
  type Actor,
  type Tx,
} from './core'
import {
  archiveAccountSchema,
  createAccountSchema,
  postEntrySchema,
  reverseEntrySchema,
  trialBalanceSchema,
  updateAccountSchema,
  type AccountPurpose,
} from './schemas'

export { FinanceError, type Actor } from './core'

/**
 * Reading the books and changing them are different rights (see core.ts).
 * Posting a raw entry by hand stays with an administrator; the accounts office
 * writes vouchers, which are documents with numbers and a lifecycle.
 */
const canPost = canConfigure

// --- the chart -------------------------------------------------------------

/**
 * The default chart, written once, idempotently, and grown in place.
 *
 * Called when a purpose cannot be resolved rather than on every post: an
 * institution that has built its own chart never touches this, and one that has
 * not gets working books the first time a payment is recorded instead of an
 * error telling it to go and press a button somewhere else.
 *
 * Groups are added where their codes are free; the default accounts are slotted
 * under them where they still sit at the top; and an account for a purpose
 * nobody serves yet is added -- under a free code if the institution has used
 * the default one for something else, rather than silently not at all, which is
 * what this used to do.
 */
export async function ensureDefaultChart(tx: Tx, institutionId: string): Promise<void> {
  const existing = await tx
    .select({ id: accounts.id, code: accounts.code, purpose: accounts.purpose, parentId: accounts.parentId })
    .from(accounts)
  const byCode = new Map(existing.map((a) => [a.code, a]))
  const purposes = new Set<string>(existing.map((a) => a.purpose).filter((p): p is AccountPurpose => !!p))

  for (const row of DEFAULT_CHART.filter((r) => r.group)) {
    if (byCode.has(row.code)) continue
    const parentId = row.parent ? (byCode.get(row.parent)?.id ?? null) : null
    const [made] = await tx
      .insert(accounts)
      .values({ institutionId, code: row.code, name: row.name, type: row.type, isGroup: true, parentId })
      .onConflictDoNothing()
      .returning({ id: accounts.id, code: accounts.code, purpose: accounts.purpose, parentId: accounts.parentId })
    if (made) byCode.set(made.code, made)
  }

  for (const row of DEFAULT_CHART.filter((r) => !r.group)) {
    const parent = row.parent ? byCode.get(row.parent) : undefined
    const have = byCode.get(row.code)
    if (have && have.purpose === row.purpose) {
      // An account from the old flat chart: give it a place in the tree and a
      // kind, without touching anything the institution chose itself.
      if (!have.parentId && parent) {
        await tx
          .update(accounts)
          .set({ parentId: parent.id, subtype: row.subtype ?? null, cashFlow: row.cashFlow ?? null })
          .where(and(eq(accounts.id, have.id), isNull(accounts.subtype)))
      }
      continue
    }
    if (row.purpose && purposes.has(row.purpose)) continue

    // The code is taken by something else: the next free one beside it.
    let code = row.code
    for (let i = 1; byCode.has(code); i++) code = `${row.code}-${i}`

    const [made] = await tx
      .insert(accounts)
      .values({
        institutionId,
        code,
        name: row.name,
        type: row.type,
        purpose: (row.purpose ?? null) as AccountPurpose | null,
        subtype: row.subtype ?? null,
        cashFlow: row.cashFlow ?? null,
        parentId: parent?.id ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: accounts.id, code: accounts.code, purpose: accounts.purpose, parentId: accounts.parentId })
    if (made) {
      byCode.set(made.code, made)
      if (made.purpose) purposes.add(made.purpose)
    }
  }
}

export interface ChartAccount {
  id: string
  code: string
  name: string
  type: 'asset' | 'liability' | 'equity' | 'income' | 'expense'
  purpose: string | null
  subtype: string | null
  isGroup: boolean
  parentId: string | null
  currency: string | null
  cashFlow: string | null
  description: string | null
  archivedAt: Date | null
  /** How deep in the tree: 0 at the top. */
  depth: number
}

/** Rows in tree order: each parent followed by what is under it, by code. */
export function treeOrder<T extends { id: string; parentId: string | null; code: string }>(
  rows: T[],
): (T & { depth: number })[] {
  const children = new Map<string | null, T[]>()
  const ids = new Set(rows.map((r) => r.id))
  for (const r of rows) {
    // A parent outside the set (archived, filtered) leaves the child at the top.
    const key = r.parentId && ids.has(r.parentId) ? r.parentId : null
    const list = children.get(key) ?? []
    list.push(r)
    children.set(key, list)
  }
  for (const list of children.values()) list.sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true }))
  const out: (T & { depth: number })[] = []
  const walk = (parent: string | null, depth: number) => {
    for (const r of children.get(parent) ?? []) {
      out.push({ ...r, depth })
      walk(r.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}

export async function chartWithin(tx: Tx): Promise<ChartAccount[]> {
  const rows = await tx.select().from(accounts)
  return treeOrder(rows) as ChartAccount[]
}

export async function listAccounts(actor: Actor) {
  const tenant = requireRead(actor)

  return withTenant(tenant, async (tx) => {
    const rows = await tx.select({ isGroup: accounts.isGroup }).from(accounts)
    // First look at the screen is also the first chance to have a chart. An old
    // flat chart grows its groups here too.
    if (rows.length === 0 || !rows.some((r) => r.isGroup)) await ensureDefaultChart(tx, tenant)
    return chartWithin(tx)
  })
}

async function accountIdByCode(tx: Tx, code: string | undefined): Promise<string | null> {
  if (!code) return null
  const [row] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.code, code))
  if (!row) throw new FinanceError(404, 'no_such_account', `no account with code ${code}`)
  return row.id
}

export async function createAccount(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  if (!canPost(actor.role)) throw new FinanceError(403, 'forbidden', 'not permitted')
  const data = createAccountSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const parentId = await accountIdByCode(tx, data.parentCode)
    try {
      const [row] = await tx
        .insert(accounts)
        .values({
          institutionId: tenant,
          code: data.code,
          name: data.name,
          type: data.type,
          purpose: data.isGroup ? null : (data.purpose ?? null),
          parentId,
          isGroup: data.isGroup,
          subtype: data.subtype ?? null,
          currency: data.currency ?? null,
          cashFlow: data.cashFlow ?? null,
          description: data.description ?? null,
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
      throw refusal(e)
    }
  })
}

/** Rename, move in the tree, or give an account a purpose. Its type and history stay. */
export async function updateAccount(actor: Actor, input: unknown) {
  const tenant = requireConfigure(actor)
  const data = updateAccountSchema.parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      const set: Partial<typeof accounts.$inferInsert> = {}
      if (data.name) set.name = data.name
      if (data.parentCode !== undefined) set.parentId = await accountIdByCode(tx, data.parentCode)
      if (data.subtype) set.subtype = data.subtype
      if (data.purpose !== undefined) set.purpose = data.purpose ?? null
      if (data.cashFlow) set.cashFlow = data.cashFlow
      if (data.description !== undefined) set.description = data.description ?? null
      if (Object.keys(set).length === 0) return { id: data.accountId, notice: 'Nothing to change.' }
      const [row] = await tx
        .update(accounts)
        .set(set)
        .where(eq(accounts.id, data.accountId))
        .returning({ id: accounts.id })
      if (!row) throw new FinanceError(404, 'no_such_account', 'no such account')
      return { ...row, notice: 'Account updated.' }
    }),
  )
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
  partyId: string | null
  fundId: string | null
  currency: string | null
  amountFc: number | null
  exchangeRate: string | null
}

type Wanted = { accountCode?: string; purpose?: AccountPurpose; accountId?: string }
const keyOf = (w: Wanted) =>
  w.accountId ? `id:${w.accountId}` : w.accountCode ? `code:${w.accountCode}` : `purpose:${w.purpose}`

/** Codes, purposes and ids to account ids, seeding the default chart if it has to. */
async function resolveAccounts(tx: Tx, institutionId: string, wanted: Wanted[]): Promise<Map<string, string>> {
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
      byKey.set(`id:${r.id}`, { id: r.id, archivedAt: r.archivedAt })
      byKey.set(`code:${r.code}`, { id: r.id, archivedAt: r.archivedAt })
      if (r.purpose) byKey.set(`purpose:${r.purpose}`, { id: r.id, archivedAt: r.archivedAt })
    }
    return byKey
  }

  let byKey = await load()
  if (wanted.some((w) => !byKey.has(keyOf(w)))) {
    await ensureDefaultChart(tx, institutionId)
    byKey = await load()
  }

  const out = new Map<string, string>()
  for (const w of wanted) {
    const k = keyOf(w)
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

/** The account a purpose names, seeding the chart if need be. */
export async function accountFor(tx: Tx, institutionId: string, purpose: AccountPurpose): Promise<string> {
  const ids = await resolveAccounts(tx, institutionId, [{ purpose }])
  return ids.get(`purpose:${purpose}`)!
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
 * about it. So do the books' own documents -- an invoice submitted and its
 * entry are one act for the same reason.
 */
export async function postWithin(tx: Tx, institutionId: string, postedBy: string | null, input: unknown) {
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

  // A document posts on its posting date: at noon UTC, which is the same
  // calendar day in every zone a college is in, and the day is also written
  // down outright so nothing has to work it out again.
  const occurredAt =
    data.occurredAt ?? (data.postingDate ? new Date(`${data.postingDate}T12:00:00Z`) : new Date())

  let entryId: string
  try {
    const [row] = await tx
      .insert(entries)
      .values({
        institutionId,
        occurredAt,
        postingDate: data.postingDate ?? null,
        memo: data.memo,
        sourceModule: data.sourceModule,
        sourceRef: data.sourceRef,
        postedBy,
      })
      .returning({ id: entries.id, postingDate: entries.postingDate })
    entryId = row!.id
  } catch (e) {
    const cause = (e as { cause?: { code?: string; message?: string } }).cause
    if (cause?.code === '23505') {
      throw new FinanceError(409, 'already_posted', 'that source reference is already in the journal', {
        sourceModule: data.sourceModule,
        sourceRef: data.sourceRef,
      })
    }
    // The close is enforced by a trigger, because a closed month that only some
    // code paths respect is not closed. That leaves the refusal arriving here as
    // a constraint violation, and a caller shown a raw query has been told
    // nothing -- so it is named on the way out.
    if (cause?.code === '23514' && /accounting period is closed/.test(cause.message ?? '')) {
      const on = data.postingDate ?? occurredAt.toISOString().slice(0, 10)
      throw new FinanceError(409, 'period_closed', 'that accounting period is closed', {
        year: Number(on.slice(0, 4)),
        month: Number(on.slice(5, 7)),
      })
    }
    if (cause?.code === '23514' && /fiscal year is closed/.test(cause.message ?? '')) {
      throw new FinanceError(409, 'fiscal_year_closed', 'that fiscal year is closed')
    }
    throw e
  }

  const resolved: ResolvedLine[] = data.lines.map((l) => ({
    accountId: ids.get(keyOf(l))!,
    debitPaise: l.debitPaise,
    creditPaise: l.creditPaise,
    costCenter: l.costCenter ?? null,
    memo: l.memo ?? null,
    partyId: l.partyId ?? null,
    fundId: l.fundId ?? null,
    currency: l.currency ?? null,
    amountFc: l.currency ? (l.amountFc ?? 0) : null,
    exchangeRate: l.currency ? (l.exchangeRate ?? '1') : null,
  }))

  await named(() => tx.insert(lines).values(resolved.map((l) => ({ institutionId, entryId, ...l }))))
  const [{ day }] = (await tx
    .select({ day: entries.postingDate })
    .from(entries)
    .where(eq(entries.id, entryId))) as [{ day: string }]
  await assertWithinBudget(tx, institutionId, day, resolved)

  return { id: entryId, totalPaise: debit }
}

/**
 * Refuse an entry that would take a cost centre past a budget it was told not
 * to pass.
 *
 * Only for budget lines explicitly marked as hard limits, and checked after the
 * lines are written so the sum includes this entry. The budget row is locked
 * first, which is what stops two entries racing for the last of it and both
 * finding room. Budgets are by fiscal year: the year an entry falls in is the
 * one whose budget it spends.
 *
 * Off by default everywhere, because a ledger that refuses to record what
 * happened is worse than one that records an overspend somebody has to explain.
 */
async function assertWithinBudget(tx: Tx, institutionId: string, postingDate: string, resolved: ResolvedLine[]) {
  const spending = resolved.filter((l) => l.costCenter !== null && l.debitPaise > 0)
  if (spending.length === 0) return

  const year = await fiscalYearStart(tx, institutionId, postingDate)
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
 * The mirror image of an entry, inside the caller's transaction: how a
 * document's cancellation undoes what its submission posted.
 *
 * Dated on the original's own day by default, so a cancelled document leaves
 * nothing behind in the period it was in -- which means a closed period refuses
 * the cancellation, and the correction is then a new document (a credit note,
 * a reversing voucher) in an open one.
 */
export async function reverseWithin(
  tx: Tx,
  institutionId: string,
  actorId: string | null,
  entryId: string,
  reason: string,
  postingDate?: string,
): Promise<string> {
  const [original] = await tx.select().from(entries).where(eq(entries.id, entryId))
  if (!original) throw new FinanceError(404, 'no_such_entry', 'no such journal entry')
  if (original.reversalOf) {
    throw new FinanceError(409, 'already_a_reversal', 'a reversal is not itself reversed')
  }
  const originalLines = await tx.select().from(lines).where(eq(lines.entryId, entryId))
  const on = postingDate ?? original.postingDate!

  let reversalId: string
  try {
    const [row] = await tx
      .insert(entries)
      .values({
        institutionId,
        occurredAt: new Date(`${on}T12:00:00Z`),
        postingDate: on,
        memo: `Reversal of ${original.memo}: ${reason}`.slice(0, 200),
        sourceModule: original.sourceModule,
        sourceRef: `reversal:${entryId}`,
        reversalOf: entryId,
        postedBy: actorId,
      })
      .returning({ id: entries.id })
    reversalId = row!.id
  } catch (e) {
    const cause = (e as { cause?: { code?: string; message?: string } }).cause
    if (cause?.code === '23505') {
      throw new FinanceError(409, 'already_reversed', 'that entry has already been reversed')
    }
    if (cause?.code === '23514' && /closed/.test(cause.message ?? '')) {
      throw new FinanceError(
        409,
        'period_closed',
        'the period it was posted in is closed; correct it with a new document in an open one instead',
      )
    }
    throw e
  }

  await tx.insert(lines).values(
    originalLines.map((l) => ({
      institutionId,
      entryId: reversalId,
      accountId: l.accountId,
      // The mirror: every debit becomes a credit of the same size.
      debitPaise: l.creditPaise,
      creditPaise: l.debitPaise,
      costCenter: l.costCenter,
      memo: l.memo,
      partyId: l.partyId,
      fundId: l.fundId,
      currency: l.currency,
      amountFc: l.amountFc,
      exchangeRate: l.exchangeRate,
    })),
  )
  return reversalId
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
    const [original] = await tx.select({ id: entries.id }).from(entries).where(eq(entries.id, entryId))
    if (!original) throw new FinanceError(404, 'no_such_entry', 'no such journal entry')
    // A free-hand reversal is a correction made now, so it is dated today.
    const reversalId = await reverseWithin(tx, tenant, actor.id, entryId, reason, await localToday(tx, tenant))

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
        postingDate: entries.postingDate,
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
        partyId: lines.partyId,
        fundId: lines.fundId,
        currency: lines.currency,
        amountFc: lines.amountFc,
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
 * rather than a silent report. Groups are left out: their balance is their
 * accounts', and listing both would count it twice.
 */
export async function trialBalance(actor: Actor, input: unknown = {}) {
  const tenant = tenantOf(actor)
  if (!canRead(actor.role)) throw new FinanceError(403, 'forbidden', 'not permitted')
  const { from, to } = trialBalanceSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const within = [
      // By the day each entry counts on, not the instant it was typed.
      from ? gte(entries.postingDate, from.toISOString().slice(0, 10)) : undefined,
      to ? lte(entries.postingDate, to.toISOString().slice(0, 10)) : undefined,
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
      .where(and(eq(accounts.isGroup, false), ...within))
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
    .where(and(eq(entries.sourceModule, sourceModule), eq(entries.sourceRef, sourceRef), isNull(entries.reversalOf)))
  return row?.id ?? null
}

/** Accounts by id, for the documents that name them. */
export async function accountsById(tx: Tx, ids: string[]) {
  if (ids.length === 0) return new Map<string, typeof accounts.$inferSelect>()
  const rows = await tx.select().from(accounts).where(inArray(accounts.id, [...new Set(ids)]))
  return new Map(rows.map((r) => [r.id, r]))
}
