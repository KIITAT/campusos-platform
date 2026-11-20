import { and, eq, sql } from 'drizzle-orm'
import * as z from 'zod'
import { withTenant } from '@campusos/db'
import { cursorColumn, finishPage, keyset, orderKeys, readPage, searchAny, type SortSpec } from '@campusos/module-framework'
import { accountFor } from '@campusos/module-finance/api'
import { formatPaise } from '@campusos/money'
import { transferClaims } from '../schema'
import { FeeError, lockTermIssue, recordPaymentWithin, requireFinance, type Actor } from './operations'
import { drawerAccount, drawerIfsc } from './schemas'
import { PAY_REFERENCE, payReferenceSql } from './upi'
import { paymentReceived, reconcileFound, verifyWithin } from './transfers'

/**
 * Clearing the bank statement (P1-03c): the statement finance imports is read
 * for credits that name a reported payment, or the payment reference on our UPI
 * QR, and each such credit becomes a receipted, reconciled payment with its
 * statement line marked matched, in one act. What cannot be told apart is left
 * for a person, who receipts it line by line.
 */

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]

export const MATCH_LIMIT = 500
const IST = (d: string) => new Date(`${d}T00:00:00+05:30`)
const tokens = (s: string) => new Set(s.toUpperCase().split(/[^A-Z0-9]+/).filter((t) => t.length >= 6))
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
/**
 * A reference strong enough to match a claim to a credit with nobody looking
 * (P1-03c review): a UPI reference is the 12-digit RRN; anything else needs a
 * digit and 10 or more characters, or must be the line's own reference column.
 * A word like TRANSFER, or a 6-digit date or cheque number, is left to a person.
 */
const strongRef = (c: { mode: string; utr: string }, l: { reference: string | null }) => {
  const u = c.utr.toUpperCase()
  if (c.mode === 'upi') return /^[0-9]{12}$/.test(u)
  return (/[0-9]/.test(u) && u.length >= 10) || l.reference?.trim().toUpperCase() === u
}
const literal = (ids: string[]) => `{${ids.join(',')}}`

/** The finance bank account fees are banked in (the books' account of purpose bank). */
async function feeBank(tx: Tx, tenant: string): Promise<{ id: string; glId: string; bankName: string; accountNumber: string }> {
  const glId = await accountFor(tx, tenant, 'bank')
  const [row] = (
    await tx.execute(sql`select id, bank_name, account_number from finance_bank_accounts where account_id = ${glId} and archived_at is null`)
  ).rows as { id: string; bank_name: string; account_number: string }[]
  if (!row) {
    throw new FeeError(
      409,
      'no_statement_account',
      "fees are banked in the books' bank account, which has no bank account with statements in finance; add it under Finance, Bank accounts, and import a statement",
    )
  }
  return { id: row.id, glId, bankName: row.bank_name, accountNumber: row.account_number }
}

/** One matcher or receipter at a time per bank account: the second finds the lines already matched. */
const lockBank = (tx: Tx, id: string) => tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'fees.statement:' + id}, 0))`)

/**
 * Mark the statement line matched to the payment's debit on the bank account:
 * the update finance's own matcher makes, written here so the receipt and the
 * match commit together.
 */
async function linkLine(tx: Tx, actorId: string, lineId: string, paymentId: string, glId: string) {
  const res = await tx.execute(sql`
    update finance_bank_statement_lines
       set status = 'matched', matched_by = ${actorId}, matched_at = now(),
           matched_line_id = (select l.id from finance_journal_lines l join finance_journal_entries e on e.id = l.entry_id
                               where e.source_ref = ${'payment:' + paymentId} and l.account_id = ${glId} and l.debit_paise > 0
                               order by l.id limit 1)
     where id = ${lineId} and status = 'unmatched'
     returning id`)
  if (res.rows.length !== 1) throw new Error('statement line changed under its lock')
}

interface Owner {
  studentId: string
  termId: string
  name: string
  termCode: string
}

/** Payment-reference codes that name exactly one student and term; an ambiguous code is dropped. */
async function codesToStudents(tx: Tx, codes: string[]): Promise<Map<string, Owner>> {
  const out = new Map<string, Owner>()
  if (!codes.length) return out
  const rows = (
    await tx.execute(sql`
      select distinct ${payReferenceSql(sql`i.id`)} as code, i.student_id, i.term_id, coalesce(u.name, u.email, i.student_id) as name, t.code as term_code
        from fee_invoices i join users u on u.id = i.student_id join academic_terms t on t.id = i.term_id
       where ${payReferenceSql(sql`i.id`)} = any(${literal(codes)}::text[])`)
  ).rows as { code: string; student_id: string; term_id: string; name: string; term_code: string }[]
  const seen = new Map<string, Owner[]>()
  for (const r of rows) {
    const list = seen.get(r.code) ?? []
    list.push({ studentId: r.student_id, termId: r.term_id, name: r.name, termCode: r.term_code })
    seen.set(r.code, list)
  }
  for (const [code, list] of seen) if (list.length === 1) out.set(code, list[0]!)
  return out
}

/** Each receipt in its own savepoint: a line the books refuse is skipped, the rest go on. */
async function attempt(tx: Tx, fn: (sp: Tx) => Promise<void>): Promise<string | null> {
  try {
    await tx.transaction(fn)
    return null
  } catch (e) {
    const s = (e as { status?: number }).status
    if (s === 400 || s === 409) return (e as Error).message
    throw e
  }
}

interface StatementLine {
  id: string
  txnDate: string
  description: string
  reference: string | null
  depositPaise: number
}

export async function matchStatement(actor: Actor) {
  const tenant = requireFinance(actor)
  return withTenant(tenant, async (tx) => {
    const bank = await feeBank(tx, tenant)
    await lockBank(tx, bank.id)
    const lines = (
      await tx.execute(sql`
        select id, txn_date::text as "txnDate", description, reference, deposit_paise::bigint as "depositPaise"
          from finance_bank_statement_lines
         where bank_account_id = ${bank.id} and status = 'unmatched' and deposit_paise > 0
         order by txn_date, seq for update`)
    ).rows.map((r) => ({ ...(r as unknown as StatementLine), depositPaise: Number((r as { depositPaise: string | number }).depositPaise) }))
    // Read without a lock: verifyWithin takes the term's lock, then the claim's row, in that order.
    const claims = await tx.select().from(transferClaims).where(eq(transferClaims.status, 'pending'))
    const byUtr = new Map<string, typeof claims>()
    for (const c of claims) byUtr.set(c.utr.toUpperCase(), [...(byUtr.get(c.utr.toUpperCase()) ?? []), c])
    const tokensOf = new Map(lines.map((l) => [l.id, tokens(`${l.description} ${l.reference ?? ''}`)]))
    const fitsLine = new Map<string, typeof claims>()
    const fitsClaim = new Map<string, Set<string>>()
    for (const l of lines) {
      const fit = [...new Set([...tokensOf.get(l.id)!].flatMap((k) => byUtr.get(k) ?? []))].filter(
        (c) => c.amountPaise === l.depositPaise && l.txnDate >= c.transferredOn && l.txnDate <= addDays(c.transferredOn, 30),
      )
      fitsLine.set(l.id, fit)
      for (const c of fit) {
        const set = fitsClaim.get(c.id) ?? new Set<string>()
        set.add(l.id)
        fitsClaim.set(c.id, set)
      }
    }
    const pendingRefs = new Set(claims.map((c) => c.utr.toUpperCase()))
    const codes = await codesToStudents(
      tx,
      [...new Set([...tokensOf.values()].flatMap((t) => [...t].filter((k) => PAY_REFERENCE.test(k))))],
    )

    // Every term lock up front, in id order, as P1-03e's charge runs take theirs: no lock cycle.
    const termIds = new Set<string>([...fitsLine.values()].flatMap((f) => f.map((c) => c.termId)))
    for (const o of codes.values()) termIds.add(o.termId)
    for (const t of [...termIds].sort()) await lockTermIssue(tx, t)

    let verified = 0
    let receipted = 0
    let done = 0
    let more = false
    const skipped: { lineId: string; reason: string }[] = []
    const skip = (lineId: string, reason: string) => {
      if (skipped.length < 20) skipped.push({ lineId, reason })
    }
    for (const l of lines) {
      if (done >= MATCH_LIMIT) {
        more = true
        break
      }
      const fit = fitsLine.get(l.id)!
      // A claim and a line that fit only each other: the payer's reference and the amount agree.
      if (fit.length === 1 && fitsClaim.get(fit[0]!.id)!.size === 1 && strongRef(fit[0]!, l)) {
        const c = fit[0]!
        const why = await attempt(tx, async (sp) => {
          const { payment } = await verifyWithin(sp, tenant, actor, c.id, c.termId, `found on the bank statement of ${l.txnDate}`, { statementLineId: l.id }, IST(l.txnDate))
          await linkLine(sp, actor.id, l.id, payment.id, bank.glId)
        })
        if (why) skip(l.id, why)
        else verified++
        done++
        continue
      }
      if (fit.length > 0) continue
      // No claim: our reference and the bank's own UTR.
      const mine = [...tokensOf.get(l.id)!].filter((k) => PAY_REFERENCE.test(k) && codes.has(k))
      if (mine.length !== 1) continue
      const utrs = [...tokensOf.get(l.id)!].filter((k) => /^[0-9]{12}$/.test(k))
      const own = l.reference?.trim().toUpperCase()
      const ref = utrs.length === 1 ? utrs[0]! : own && /^[A-Z0-9]{6,30}$/.test(own) ? own : null
      if (!ref || pendingRefs.has(ref)) continue
      const who = codes.get(mine[0]!)!
      const why = await attempt(tx, async (sp) => {
        await lockTermIssue(sp, who.termId)
        const p = await recordPaymentWithin(sp, tenant, actor, {
          studentId: who.studentId,
          termId: who.termId,
          amountPaise: l.depositPaise,
          method: 'upi',
          reference: ref,
          receivedAt: IST(l.txnDate),
          notes: `Found on the bank statement of ${l.txnDate}: ${l.description.slice(0, 120)}`,
        })
        await reconcileFound(sp, tenant, actor, p.id, `found on the bank statement of ${l.txnDate}`, { statementLineId: l.id })
        await linkLine(sp, actor.id, l.id, p.id, bank.glId)
        await paymentReceived(sp, tenant, p)
      })
      if (why) skip(l.id, why)
      else receipted++
      done++
    }
    const [left] = (
      await tx.execute(sql`select count(*)::int as n from finance_bank_statement_lines where bank_account_id = ${bank.id} and status = 'unmatched' and deposit_paise > 0`)
    ).rows as { n: number }[]
    return {
      verified,
      receipted,
      skipped,
      left: Number(left!.n),
      more,
      notice: `${verified} reported payment(s) verified and ${receipted} receipted by their payment reference; ${left!.n} credit(s) left for you.${more ? ' More remain: match again.' : ''}`,
      next: '/m/fees/statement',
    }
  })
}

export const receiptLineSchema = z
  .object({
    lineId: z.uuid(),
    studentId: z.string().min(1),
    termId: z.uuid(),
    method: z.enum(['upi', 'bank_transfer', 'cheque']),
    reference: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9]{6,30}$/, '6 to 30 letters and digits, as the statement shows it'),
    drawerIfsc,
    drawerAccount,
  })
  .meta({ id: 'FeeStatementReceipt' })

/** Staff receipt one credit that matching left: amount and date come from the statement, not from typing. */
export async function receiptLine(actor: Actor, input: unknown) {
  const tenant = requireFinance(actor)
  const d = receiptLineSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const bank = await feeBank(tx, tenant)
    await lockBank(tx, bank.id)
    const [line] = (
      await tx.execute(sql`
        select id, bank_account_id, status, txn_date::text as "txnDate", description, deposit_paise::bigint as "depositPaise"
          from finance_bank_statement_lines where id = ${d.lineId} for update`)
    ).rows as { id: string; bank_account_id: string; status: string; txnDate: string; description: string; depositPaise: string | number }[]
    if (!line) throw new FeeError(404, 'no_such_line', 'no such statement line')
    if (line.bank_account_id !== bank.id) throw new FeeError(409, 'wrong_account', 'that line is not on the account fees are banked in')
    if (line.status !== 'unmatched') throw new FeeError(409, 'line_taken', 'that statement line is already matched or set aside')
    if (Number(line.depositPaise) <= 0) throw new FeeError(400, 'not_a_credit', 'that line is money going out, not a fee coming in')
    const reference = d.reference.toUpperCase()
    const [waiting] = await tx
      .select({ id: transferClaims.id })
      .from(transferClaims)
      .where(and(eq(transferClaims.status, 'pending'), sql`upper(${transferClaims.utr}) = ${reference}`))
    if (waiting) {
      throw new FeeError(409, 'claim_waiting', `a reported payment with reference ${reference} is waiting; verify it under Reported payments instead`)
    }
    await lockTermIssue(tx, d.termId)
    const p = await recordPaymentWithin(tx, tenant, actor, {
      studentId: d.studentId,
      termId: d.termId,
      amountPaise: Number(line.depositPaise),
      method: d.method,
      reference,
      receivedAt: IST(line.txnDate),
      notes: `Found on the bank statement of ${line.txnDate}: ${line.description.slice(0, 120)}`,
      drawerIfsc: d.drawerIfsc ?? null,
      drawerAccount: d.drawerAccount ?? null,
    })
    await reconcileFound(tx, tenant, actor, p.id, `found on the bank statement of ${line.txnDate}`, { statementLineId: line.id })
    await linkLine(tx, actor.id, line.id, p.id, bank.glId)
    await paymentReceived(tx, tenant, p)
    return { id: p.id, receiptNo: p.receiptNo, notice: `Receipt ${p.receiptNo} made and matched to the statement.` }
  })
}

const STATEMENT_SORTS: SortSpec = {
  date: {
    dir: 'asc',
    keys: [
      { sql: sql`s.txn_date`, type: 'date' },
      { sql: sql`s.seq::bigint`, type: 'bigint' },
      { sql: sql`s.id`, type: 'uuid' },
    ],
  },
}
export const statementPage = (req: Request, prefix: string) => readPage(req, prefix, STATEMENT_SORTS, 'date', 50)

/** The credits still unmatched, a page at a time, with a suggestion where our reference names one student; or `{ account: null }`. */
export async function statementView(actor: Actor, page = statementPage(new Request('https://x/'), '')) {
  const tenant = requireFinance(actor)
  return withTenant(tenant, async (tx) => {
    let bank
    try {
      bank = await feeBank(tx, tenant)
    } catch (e) {
      if (e instanceof FeeError && e.code === 'no_statement_account') return { account: null, message: e.message }
      throw e
    }
    const unmatched = sql`s.bank_account_id = ${bank.id} and s.status = 'unmatched' and s.deposit_paise > 0`
    const search = searchAny(page.q, [sql`s.description`, sql`coalesce(s.reference, '')`])
    const where = search ? sql`${unmatched} and ${search}` : unmatched
    const keys = STATEMENT_SORTS[page.sort]!.keys
    const after = keyset(keys, page)
    const rows = (
      await tx.execute(sql`
        select s.id, s.txn_date::text as "txnDate", s.description, s.reference, s.deposit_paise::bigint as "depositPaise", ${cursorColumn(keys)} as _cursor
          from finance_bank_statement_lines s
         where ${where}${after ? sql` and ${after}` : sql``}
         order by ${sql.join(orderKeys(keys, page.dir), sql`, `)}
         limit ${page.limit + 1}`)
    ).rows as { id: string; txnDate: string; description: string; reference: string | null; depositPaise: string | number; _cursor: string[] }[]
    const [sum] = (
      await tx.execute(sql`select count(*)::int as n, coalesce(sum(s.deposit_paise), 0)::bigint as paise from finance_bank_statement_lines s where ${where}`)
    ).rows as { n: number; paise: string | number }[]
    const [all] = (
      await tx.execute(sql`select count(*)::int as n, coalesce(sum(s.deposit_paise), 0)::bigint as paise from finance_bank_statement_lines s where ${unmatched}`)
    ).rows as { n: number; paise: string | number }[]
    const codes = await codesToStudents(
      tx,
      [...new Set(rows.flatMap((r) => [...tokens(`${r.description} ${r.reference ?? ''}`)].filter((k) => PAY_REFERENCE.test(k))))],
    )
    const shaped = rows.map((r) => {
      const code = [...tokens(`${r.description} ${r.reference ?? ''}`)].filter((k) => codes.has(k))
      const who = code.length === 1 ? codes.get(code[0]!)! : null
      return {
        id: r.id,
        txnDate: r.txnDate,
        description: r.description,
        reference: r.reference,
        depositPaise: Number(r.depositPaise),
        suggested: who ? `${code[0]} → ${who.name} (${who.termCode})` : '',
        _cursor: r._cursor,
      }
    })
    const options = (
      await tx.execute(sql`
        select s.id, s.txn_date::text as "txnDate", s.description, s.deposit_paise::bigint as "depositPaise"
          from finance_bank_statement_lines s where ${unmatched} order by s.txn_date, s.seq limit 200`)
    ).rows as { id: string; txnDate: string; description: string; depositPaise: string | number }[]
    return {
      account: { bankName: bank.bankName, accountNumber: bank.accountNumber },
      totals: { count: Number(all!.n), amountPaise: Number(all!.paise) },
      // ponytail: the 200 oldest credits until P1-09's searchable picker; the table itself is complete.
      lineOptions: options.map((o) => ({ value: o.id, label: `${o.txnDate} ${formatPaise(Number(o.depositPaise))} ${o.description.slice(0, 40)}` })),
      ...finishPage(shaped, page, Number(sum!.n)),
    }
  })
}
