import { and, asc, desc, eq, lte, sql } from 'drizzle-orm'
import { withTenant } from '@campusos/db'
import { readUpload } from '@campusos/module-framework'
import * as z from 'zod'
import {
  accounts,
  bankAccounts,
  bankRules,
  bankStatementLines,
  bankStatements,
  entries,
  lines as glLines,
} from '../schema'
import { FinanceError, named, requireConfigure, requireOperate, requireRead, type Actor, type Tx } from './core'
import { daysBetween } from './numbers'
import { postWithin } from './operations'
import { parseStatement, StatementError, type ColumnMapping } from './statements'

/**
 * Bank accounts, their statements, and reconciling the two.
 *
 * A statement is imported as the bank sent it and never edited. Each of its
 * lines is matched to the one posting on the bank's account that moved the
 * same money the same way -- automatically where only one could be meant,
 * by hand where several could -- or posted from the line itself when it is
 * something only the bank knew about (its charges, the interest it paid), by
 * a rule or by hand. What is left unmatched on either side is the bank
 * reconciliation statement.
 */

const MODULE = 'finance'
const optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined))
const optionalId = z
  .uuid()
  .optional()
  .or(z.literal('').transform(() => undefined))

// --- bank accounts ------------------------------------------------------------------

export const bankAccountSchema = z
  .object({
    /** The account in the books; left out, one is made under current assets. */
    accountId: optionalId,
    bankName: z.string().trim().min(2).max(120),
    branch: optional(120),
    ifsc: optional(11).transform((v) => v?.toUpperCase()),
    accountNumber: z.string().trim().min(4).max(40),
    currency: optional(3).transform((v) => v?.toUpperCase()),
  })
  .meta({ id: 'FinanceBankAccount' })

export async function createBankAccount(actor: Actor, input: unknown) {
  const tenant = requireConfigure(actor)
  const data = bankAccountSchema.parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      let accountId = data.accountId
      if (!accountId) {
        const all = await tx.select({ id: accounts.id, code: accounts.code }).from(accounts)
        const taken = new Set(all.map((a) => a.code))
        let code = 1011
        while (taken.has(String(code))) code++
        const parent = all.find((a) => a.code === '11')?.id ?? null
        const [made] = await tx
          .insert(accounts)
          .values({
            institutionId: tenant,
            code: String(code),
            name: `${data.bankName} ${data.accountNumber.slice(-4)}`,
            type: 'asset',
            subtype: 'bank',
            parentId: parent,
            currency: data.currency ?? null,
          })
          .returning({ id: accounts.id })
        accountId = made!.id
      } else {
        const [a] = await tx.select().from(accounts).where(eq(accounts.id, accountId))
        if (!a || a.type !== 'asset' || a.isGroup) throw new FinanceError(400, 'not_bank', 'a bank account stands for an asset account')
        if (a.subtype !== 'bank') await tx.update(accounts).set({ subtype: 'bank' }).where(eq(accounts.id, a.id))
      }
      const [row] = await tx
        .insert(bankAccounts)
        .values({
          institutionId: tenant,
          accountId,
          bankName: data.bankName,
          branch: data.branch ?? null,
          ifsc: data.ifsc ?? null,
          accountNumber: data.accountNumber,
        })
        .returning({ id: bankAccounts.id })
      return { ...row!, notice: `${data.bankName} added.`, next: `/m/finance/bank-account?id=${row!.id}` }
    }),
  )
}

export async function listBankAccounts(actor: Actor) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) => {
    const rows = await tx
      .select({
        b: bankAccounts,
        code: accounts.code,
        name: accounts.name,
        currency: accounts.currency,
        booksPaise: sql<number>`(select coalesce(sum(l.debit_paise - l.credit_paise), 0) from finance_journal_lines l where l.account_id = "finance_bank_accounts"."account_id")::bigint`,
        unmatched: sql<number>`(select count(*) from finance_bank_statement_lines s where s.bank_account_id = "finance_bank_accounts"."id" and s.status = 'unmatched')::int`,
        lastStatement: sql<string | null>`(select max(s.to_date)::text from finance_bank_statements s where s.bank_account_id = "finance_bank_accounts"."id")`,
      })
      .from(bankAccounts)
      .innerJoin(accounts, eq(accounts.id, bankAccounts.accountId))
      .orderBy(asc(accounts.code))
    return rows.map((r) => ({ ...r.b, code: r.code, name: r.name, currency: r.currency, booksPaise: Number(r.booksPaise), unmatched: r.unmatched, lastStatement: r.lastStatement }))
  })
}

async function bankWithin(tx: Tx, bankAccountId: string) {
  const [b] = await tx.select().from(bankAccounts).where(eq(bankAccounts.id, bankAccountId))
  if (!b) throw new FinanceError(404, 'no_such_bank_account', 'no such bank account')
  return b
}

export const mappingSchema = z
  .object({
    bankAccountId: z.uuid(),
    date: z.string().trim().min(1).max(80),
    valueDate: optional(80),
    description: z.string().trim().min(1).max(80),
    reference: optional(80),
    withdrawal: optional(80),
    deposit: optional(80),
    amount: optional(80),
    drCr: optional(80),
    balance: optional(80),
    dateOrder: z.enum(['dmy', 'mdy', 'ymd']).default('dmy'),
  })
  .refine((m) => m.amount || m.withdrawal || m.deposit, { message: 'name the amount column, or the withdrawal and deposit ones' })
  .meta({ id: 'FinanceBankCsvMapping' })

/** Which column of this bank's downloads is which, when guessing gets it wrong. */
export async function setMapping(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const { bankAccountId, ...mapping } = mappingSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    await tx
      .update(bankAccounts)
      .set({ csvMapping: Object.fromEntries(Object.entries(mapping).filter(([, v]) => v)) as Record<string, string> })
      .where(eq(bankAccounts.id, bankAccountId))
    return { notice: 'Columns saved for this bank.' }
  })
}

// --- importing ----------------------------------------------------------------------

export async function importStatement(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const data = z.object({ bankAccountId: z.uuid(), file: z.unknown() }).parse(input)
  const file = readUpload(data.file, { what: 'the statement', maxBytes: 5 * 1024 * 1024 })
  return withTenant(tenant, (tx) =>
    named(async () => {
      const bank = await bankWithin(tx, data.bankAccountId)
      let parsed
      try {
        parsed = parseStatement(file.bytes, file.name, (bank.csvMapping as ColumnMapping | null) ?? null)
      } catch (e) {
        if (e instanceof StatementError) throw new FinanceError(400, 'bad_statement', e.message)
        throw e
      }
      const [st] = await tx
        .insert(bankStatements)
        .values({
          institutionId: tenant,
          bankAccountId: bank.id,
          fileName: file.name,
          fileSha256: file.sha256,
          format: parsed.format,
          fromDate: parsed.fromDate ?? null,
          toDate: parsed.toDate ?? null,
          openingPaise: parsed.openingPaise ?? null,
          closingPaise: parsed.closingPaise ?? (parsed.lines.at(-1)?.balancePaise ?? null),
          lineCount: parsed.lines.length,
          importedBy: actor.id,
        })
        .returning({ id: bankStatements.id })
      await tx.insert(bankStatementLines).values(
        parsed.lines.map((l, i) => ({
          institutionId: tenant,
          statementId: st!.id,
          bankAccountId: bank.id,
          seq: i + 1,
          txnDate: l.txnDate,
          valueDate: l.valueDate ?? null,
          description: l.description.slice(0, 500),
          reference: l.reference?.slice(0, 120) ?? null,
          withdrawalPaise: l.withdrawalPaise,
          depositPaise: l.depositPaise,
          balancePaise: l.balancePaise ?? null,
        })),
      )
      // A guess that read the file is kept, so the next file from this bank is read the same way.
      if (!bank.csvMapping && parsed.mapping) {
        await tx.update(bankAccounts).set({ csvMapping: parsed.mapping as unknown as Record<string, string> }).where(eq(bankAccounts.id, bank.id))
      }
      const matched = await autoMatchWithin(tx, actor, bank.id)
      return {
        id: st!.id,
        lines: parsed.lines.length,
        matched,
        notice: `${parsed.lines.length} line(s) imported, ${matched} matched to the books.`,
        next: `/m/finance/bank-account?id=${bank.id}`,
      }
    }),
  )
}

export async function deleteStatement(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const { statementId } = z.object({ statementId: z.uuid() }).parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      await tx.delete(bankStatements).where(eq(bankStatements.id, statementId))
      return { notice: 'Statement removed.' }
    }),
  )
}

// --- matching -----------------------------------------------------------------------

/** Postings on a bank's account that no statement line has claimed yet. */
async function unclaimed(tx: Tx, accountId: string, opts: { on?: string } = {}) {
  return tx
    .select({
      id: glLines.id,
      debitPaise: glLines.debitPaise,
      creditPaise: glLines.creditPaise,
      memo: entries.memo,
      lineMemo: glLines.memo,
      postingDate: entries.postingDate,
      sourceRef: entries.sourceRef,
    })
    .from(glLines)
    .innerJoin(entries, eq(entries.id, glLines.entryId))
    .where(
      and(
        eq(glLines.accountId, accountId),
        opts.on ? lte(entries.postingDate, opts.on) : undefined,
        sql`not exists (select 1 from finance_bank_statement_lines s where s.matched_line_id = "finance_journal_lines"."id")`,
      ),
    )
    .orderBy(asc(entries.postingDate))
}

/** Words of a narration that could be a reference: cheque numbers, UTRs, invoice numbers. */
const tokens = (s: string | null | undefined) =>
  new Set(
    (s ?? '')
      .toUpperCase()
      .split(/[^A-Z0-9/-]+/)
      .filter((t) => t.length >= 4 && /\d/.test(t)),
  )

/**
 * Match what can only mean one thing: a statement line and a posting of the
 * same amount the same way, within a week of each other. Where several
 * postings fit, a reference both share decides; otherwise the nearest date,
 * if only one is nearest. Anything still ambiguous is left for a person.
 */
async function autoMatchWithin(tx: Tx, actor: Actor, bankAccountId: string): Promise<number> {
  const bank = await bankWithin(tx, bankAccountId)
  const open = await tx
    .select()
    .from(bankStatementLines)
    .where(and(eq(bankStatementLines.bankAccountId, bankAccountId), eq(bankStatementLines.status, 'unmatched')))
    .orderBy(asc(bankStatementLines.txnDate), asc(bankStatementLines.seq))
  if (open.length === 0) return 0
  const postings = await unclaimed(tx, bank.accountId)
  // Payment references (cheque and UTR numbers) live on the payment, not the line.
  const refs = await tx.execute(sql`
    select 'payment:' || p.id as ref, coalesce(p.instrument_no, '') || ' ' || coalesce(p.reference, '') || ' ' || coalesce(p.number, '') as words
      from finance_payments p where p.docstatus = 'submitted'`)
  const wordsOf = new Map((refs.rows as { ref: string; words: string }[]).map((r) => [r.ref, r.words]))
  const used = new Set<string>()
  let matched = 0
  for (const line of open) {
    const deposit = line.depositPaise > 0
    const amount = deposit ? line.depositPaise : line.withdrawalPaise
    const fits = postings.filter(
      (p) =>
        !used.has(p.id) &&
        (deposit ? p.debitPaise === amount : p.creditPaise === amount) &&
        Math.abs(daysBetween(p.postingDate!, line.txnDate)) <= 7,
    )
    if (fits.length === 0) continue
    let pick = fits.length === 1 ? fits[0] : undefined
    if (!pick) {
      const lineWords = tokens(`${line.description} ${line.reference ?? ''}`)
      const shared = fits.filter((p) => {
        const theirs = tokens(`${p.memo} ${p.lineMemo ?? ''} ${wordsOf.get(p.sourceRef ?? '') ?? ''}`)
        return [...theirs].some((t) => lineWords.has(t))
      })
      if (shared.length === 1) pick = shared[0]
      else {
        const distance = (p: (typeof fits)[number]) => Math.abs(daysBetween(p.postingDate!, line.txnDate))
        const best = Math.min(...fits.map(distance))
        const nearest = fits.filter((p) => distance(p) === best)
        if (nearest.length === 1) pick = nearest[0]
      }
    }
    if (!pick) continue
    used.add(pick.id)
    await tx
      .update(bankStatementLines)
      .set({ status: 'matched', matchedLineId: pick.id, matchedBy: actor.id, matchedAt: new Date() })
      .where(eq(bankStatementLines.id, line.id))
    matched++
  }
  return matched
}

export async function autoMatch(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const { bankAccountId } = z.object({ bankAccountId: z.uuid() }).parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      const matched = await autoMatchWithin(tx, actor, bankAccountId)
      return { matched, notice: `${matched} line(s) matched.` }
    }),
  )
}

/** The postings a statement line could be, nearest first. */
export async function candidatesFor(actor: Actor, lineId: string) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) => {
    const [line] = await tx.select().from(bankStatementLines).where(eq(bankStatementLines.id, lineId))
    if (!line) throw new FinanceError(404, 'no_such_line', 'no such statement line')
    const bank = await bankWithin(tx, line.bankAccountId)
    const deposit = line.depositPaise > 0
    const amount = deposit ? line.depositPaise : line.withdrawalPaise
    const all = await unclaimed(tx, bank.accountId)
    return all
      .filter((p) => (deposit ? p.debitPaise === amount : p.creditPaise === amount))
      .map((p) => ({ ...p, days: Math.abs(daysBetween(p.postingDate!, line.txnDate)) }))
      .sort((a, b) => a.days - b.days)
      .slice(0, 20)
  })
}

export async function matchLine(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const data = z.object({ lineId: z.uuid(), glLineId: z.uuid() }).parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      const [line] = await tx.select().from(bankStatementLines).where(eq(bankStatementLines.id, data.lineId)).for('update')
      if (!line) throw new FinanceError(404, 'no_such_line', 'no such statement line')
      if (line.status === 'matched') throw new FinanceError(409, 'already_matched', 'that line is already matched')
      await tx
        .update(bankStatementLines)
        .set({ status: 'matched', matchedLineId: data.glLineId, matchedBy: actor.id, matchedAt: new Date() })
        .where(eq(bankStatementLines.id, data.lineId))
      return { notice: 'Matched.' }
    }),
  )
}

export async function unmatchLine(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const { lineId } = z.object({ lineId: z.uuid() }).parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      await tx
        .update(bankStatementLines)
        .set({ status: 'unmatched', matchedLineId: null, matchedBy: null, matchedAt: null })
        .where(eq(bankStatementLines.id, lineId))
      return { notice: 'Unmatched.' }
    }),
  )
}

export async function ignoreLine(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const data = z.object({ lineId: z.uuid(), note: z.string().trim().min(3).max(200) }).parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      await tx
        .update(bankStatementLines)
        .set({ status: 'ignored', note: data.note, matchedBy: actor.id, matchedAt: new Date() })
        .where(and(eq(bankStatementLines.id, data.lineId), eq(bankStatementLines.status, 'unmatched')))
      return { notice: 'Set aside.' }
    }),
  )
}

/**
 * Post what only the bank knew about -- its charges, interest it paid, a
 * direct debit -- straight from the statement line, and match the two.
 */
async function postFromLineWithin(
  tx: Tx,
  actor: Actor,
  line: typeof bankStatementLines.$inferSelect,
  other: { accountId: string; costCenter?: string | null; partyId?: string | null; memo?: string | null },
) {
  const tenant = actor.institutionId!
  const bank = await bankWithin(tx, line.bankAccountId)
  const amount = line.depositPaise || line.withdrawalPaise
  const deposit = line.depositPaise > 0
  const posted = await postWithin(tx, tenant, actor.id, {
    postingDate: line.txnDate,
    memo: (other.memo ?? line.description).slice(0, 200),
    sourceModule: MODULE,
    sourceRef: `bank-line:${line.id}`,
    lines: [
      { accountId: bank.accountId, debitPaise: deposit ? amount : 0, creditPaise: deposit ? 0 : amount },
      {
        accountId: other.accountId,
        debitPaise: deposit ? 0 : amount,
        creditPaise: deposit ? amount : 0,
        costCenter: other.costCenter ?? null,
        partyId: other.partyId ?? null,
      },
    ],
  })
  const [bankLine] = await tx
    .select({ id: glLines.id })
    .from(glLines)
    .where(and(eq(glLines.entryId, posted.id), eq(glLines.accountId, bank.accountId)))
  await tx
    .update(bankStatementLines)
    .set({ status: 'matched', matchedLineId: bankLine!.id, matchedBy: actor.id, matchedAt: new Date() })
    .where(eq(bankStatementLines.id, line.id))
  return posted.id
}

export async function postFromLine(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const data = z
    .object({ lineId: z.uuid(), accountId: z.uuid(), costCenter: optional(80), memo: optional(200) })
    .parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      const [line] = await tx.select().from(bankStatementLines).where(eq(bankStatementLines.id, data.lineId)).for('update')
      if (!line) throw new FinanceError(404, 'no_such_line', 'no such statement line')
      if (line.status !== 'unmatched') throw new FinanceError(409, 'already_matched', 'that line is already dealt with')
      const [acct] = await tx.select().from(accounts).where(eq(accounts.id, data.accountId))
      if (acct?.subtype === 'receivable' || acct?.subtype === 'payable') {
        throw new FinanceError(400, 'use_payment', 'money from or to a party is a receipt or a payment; record one and match it')
      }
      const id = await postFromLineWithin(tx, actor, line, data)
      return { id, notice: 'Posted and matched.' }
    }),
  )
}

// --- rules --------------------------------------------------------------------------

export const bankRuleSchema = z
  .object({
    bankAccountId: optionalId,
    contains: z.string().trim().min(2).max(120),
    direction: z.enum(['in', 'out', 'any']).default('any'),
    accountId: z.uuid(),
    costCenter: optional(80),
    priority: z.coerce.number().int().min(1).max(1000).default(100),
  })
  .meta({ id: 'FinanceBankRule' })

export async function listBankRules(actor: Actor) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) =>
    tx
      .select({ rule: bankRules, accountName: accounts.name, accountCode: accounts.code })
      .from(bankRules)
      .innerJoin(accounts, eq(accounts.id, bankRules.accountId))
      .orderBy(asc(bankRules.priority), asc(bankRules.contains))
      .then((rows) => rows.map((r) => ({ ...r.rule, accountName: r.accountName, accountCode: r.accountCode }))),
  )
}

export async function createBankRule(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const data = bankRuleSchema.parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      const [row] = await tx
        .insert(bankRules)
        .values({ institutionId: tenant, ...data, bankAccountId: data.bankAccountId ?? null, costCenter: data.costCenter ?? null })
        .returning({ id: bankRules.id })
      return { ...row!, notice: `Lines containing “${data.contains}” will be posted by this rule.` }
    }),
  )
}

export async function deleteBankRule(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const { ruleId } = z.object({ ruleId: z.uuid() }).parse(input)
  return withTenant(tenant, async (tx) => {
    await tx.delete(bankRules).where(eq(bankRules.id, ruleId))
    return { notice: 'Rule removed.' }
  })
}

/** Post and match every unmatched line a rule recognises: bank charges, interest, standing orders. */
export async function applyRules(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const { bankAccountId } = z.object({ bankAccountId: z.uuid() }).parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      const rules = await tx
        .select()
        .from(bankRules)
        .where(sql`${bankRules.bankAccountId} is null or ${bankRules.bankAccountId} = ${bankAccountId}`)
        .orderBy(asc(bankRules.priority))
      const open = await tx
        .select()
        .from(bankStatementLines)
        .where(and(eq(bankStatementLines.bankAccountId, bankAccountId), eq(bankStatementLines.status, 'unmatched')))
      let posted = 0
      for (const line of open) {
        const text = `${line.description} ${line.reference ?? ''}`.toLowerCase()
        const rule = rules.find(
          (r) =>
            text.includes(r.contains.toLowerCase()) &&
            (r.direction === 'any' || (r.direction === 'in') === line.depositPaise > 0),
        )
        if (!rule) continue
        await postFromLineWithin(tx, actor, line, { accountId: rule.accountId, costCenter: rule.costCenter })
        posted++
      }
      return { posted, notice: `${posted} line(s) posted by rule.` }
    }),
  )
}

// --- reading ------------------------------------------------------------------------

export async function statementLines(actor: Actor, input: { bankAccountId: string; status?: string; statementId?: string }) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) =>
    tx
      .select()
      .from(bankStatementLines)
      .where(
        and(
          eq(bankStatementLines.bankAccountId, input.bankAccountId),
          input.status ? eq(bankStatementLines.status, input.status as 'unmatched') : undefined,
          input.statementId ? eq(bankStatementLines.statementId, input.statementId) : undefined,
        ),
      )
      .orderBy(desc(bankStatementLines.txnDate), desc(bankStatementLines.seq))
      .limit(2000),
  )
}

export async function listStatements(actor: Actor, bankAccountId: string) {
  const tenant = requireRead(actor)
  return withTenant(tenant, (tx) =>
    tx.select().from(bankStatements).where(eq(bankStatements.bankAccountId, bankAccountId)).orderBy(desc(bankStatements.createdAt)),
  )
}

/**
 * The bank reconciliation statement on a day: the balance in the books, what
 * the books have that the bank has not yet shown (cheques issued and not
 * presented, deposits not yet credited), what the bank has shown that the
 * books do not have yet, and the balance the bank should be showing.
 */
export async function reconciliation(actor: Actor, input: { bankAccountId: string; on: string }) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) => {
    const bank = await bankWithin(tx, input.bankAccountId)
    const [books] = await tx
      .select({ v: sql<number>`coalesce(sum(${glLines.debitPaise} - ${glLines.creditPaise}), 0)::bigint` })
      .from(glLines)
      .innerJoin(entries, eq(entries.id, glLines.entryId))
      .where(and(eq(glLines.accountId, bank.accountId), lte(entries.postingDate, input.on)))
    const booksPaise = Number(books?.v ?? 0)

    // In the books by the day, and not cleared by a statement line dated by then.
    const notCleared = (
      await tx
        .select({
          id: glLines.id,
          debitPaise: glLines.debitPaise,
          creditPaise: glLines.creditPaise,
          memo: entries.memo,
          postingDate: entries.postingDate,
          clearedOn: sql<string | null>`(select s.txn_date::text from finance_bank_statement_lines s where s.matched_line_id = "finance_journal_lines"."id")`,
        })
        .from(glLines)
        .innerJoin(entries, eq(entries.id, glLines.entryId))
        .where(and(eq(glLines.accountId, bank.accountId), lte(entries.postingDate, input.on)))
    ).filter((p) => !p.clearedOn || p.clearedOn > input.on)
    const notPresented = notCleared.filter((p) => p.creditPaise > 0)
    const notCredited = notCleared.filter((p) => p.debitPaise > 0)

    // On the statement by the day, and in the books not at all (or only later).
    const bankOnly = (
      await tx
        .select({ line: bankStatementLines, bookedOn: entries.postingDate })
        .from(bankStatementLines)
        .leftJoin(glLines, eq(glLines.id, bankStatementLines.matchedLineId))
        .leftJoin(entries, eq(entries.id, glLines.entryId))
        .where(
          and(
            eq(bankStatementLines.bankAccountId, bank.id),
            lte(bankStatementLines.txnDate, input.on),
            sql`${bankStatementLines.status} <> 'ignored'`,
          ),
        )
    )
      .filter((r) => !r.bookedOn || r.bookedOn > input.on)
      .map((r) => r.line)

    const sum = (xs: { debitPaise?: number; creditPaise?: number }[], k: 'debitPaise' | 'creditPaise') =>
      xs.reduce((n, x) => n + (x[k] ?? 0), 0)
    const expectedPaise =
      booksPaise +
      sum(notPresented, 'creditPaise') -
      sum(notCredited, 'debitPaise') +
      bankOnly.reduce((n, l) => n + l.depositPaise - l.withdrawalPaise, 0)

    const [last] = await tx
      .select({ balance: bankStatementLines.balancePaise, txnDate: bankStatementLines.txnDate })
      .from(bankStatementLines)
      .where(
        and(
          eq(bankStatementLines.bankAccountId, bank.id),
          lte(bankStatementLines.txnDate, input.on),
          sql`${bankStatementLines.balancePaise} is not null`,
        ),
      )
      .orderBy(desc(bankStatementLines.txnDate), desc(bankStatementLines.seq))
      .limit(1)

    return {
      on: input.on,
      booksPaise,
      notPresented,
      notCredited,
      bankOnly,
      expectedBankPaise: expectedPaise,
      statementPaise: last?.balance ?? null,
      differencePaise: last?.balance === undefined || last?.balance === null ? null : last.balance - expectedPaise,
    }
  })
}

