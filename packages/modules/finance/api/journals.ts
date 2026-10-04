import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { amendDocument, cancelDocument, submitDocument, withTenant } from '@campusos/db'
import * as z from 'zod'
import { ticked } from '@campusos/module-framework'
import { accounts, journalLines, journals, lines as glLines, parties, partyLedger } from '../schema'
import { FinanceError, named, requireOperate, requireRead, without, type Actor, type Tx } from './core'
import { parseDecimal, toBase } from './numbers'
import { accountFor, postWithin, reverseWithin } from './operations'
import { unapplyAdvances } from './parties'
import { approvalsFor, assertApproved, minorUnitsOf, nextNumber } from './setup'
import { localToday, settingsWithin } from './years'

/**
 * Journal vouchers: the accounts office's own entries, as documents.
 *
 *   journal     anything the other documents do not cover -- an accrual, a
 *               correction, a provision, a transfer between funds;
 *   contra      between cash and bank accounts only: a deposit, a withdrawal;
 *   opening     the balances brought in when the books start, with whatever
 *               does not balance yet carried to the opening balance account
 *               until the last of them is in;
 *   adjustment  a year-end adjustment, kept apart so it can be read apart.
 *
 * A line on a receivable or payable account names its party, and moves that
 * party's account as an invoice or a payment would: an opening debtor, a
 * write-off, a set-off between a customer who is also a supplier.
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

export const journalSchema = z
  .object({
    journalId: optionalId,
    kind: z.enum(['journal', 'contra', 'opening', 'adjustment']).default('journal'),
    postingDate: z.iso.date().optional().or(z.literal('').transform(() => undefined)),
    memo: z.string().trim().min(2).max(200),
    reference: optional(120),
    lines: z
      .array(
        z.object({
          accountId: optionalId,
          partyId: optionalId,
          debit: optional(24),
          credit: optional(24),
          costCenter: optional(80),
          fundId: optionalId,
          currency: optional(3).transform((v) => v?.toUpperCase()),
          amountFc: optional(24),
          exchangeRate: optional(24),
          memo: optional(200),
        }),
      )
      .max(200)
      .default([]),
    submit: z.preprocess(ticked, z.boolean()).default(false),
  })
  .meta({ id: 'FinanceJournalVoucher' })

const amount = (v: string | undefined, at: string) => {
  if (!v) return 0
  const n = parseDecimal(v, 2)
  if (n === null || n < 0) throw new FinanceError(400, 'bad_amount', `${at}: not an amount`)
  return n
}

export async function saveJournal(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const data = journalSchema.parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      const settings = await settingsWithin(tx, tenant)
      const baseMinor = await minorUnitsOf(tx, tenant, settings.baseCurrency)
      const typed = data.lines.filter((l) => l.accountId && (l.debit || l.credit))
      if (typed.length < (data.kind === 'opening' ? 1 : 2)) {
        throw new FinanceError(400, 'no_lines', 'a journal voucher needs a debit and a credit')
      }
      const accountRows = await tx
        .select()
        .from(accounts)
        .where(inArray(accounts.id, typed.map((l) => l.accountId!)))
      const byId = new Map(accountRows.map((a) => [a.id, a]))
      const rows = []
      for (const [i, l] of typed.entries()) {
        const at = `line ${i + 1}`
        const a = byId.get(l.accountId!)
        if (!a) throw new FinanceError(400, 'no_such_account', `${at}: no such account`)
        const debit = amount(l.debit, at)
        const credit = amount(l.credit, at)
        if ((debit > 0) === (credit > 0)) throw new FinanceError(400, 'one_side', `${at}: a debit or a credit, not both`)
        if (data.kind === 'contra' && !['cash', 'bank'].includes(a.subtype ?? a.purpose ?? '')) {
          throw new FinanceError(400, 'contra_accounts', `${at}: a contra voucher moves money between cash and bank only`)
        }
        const partyNeeded = a.subtype === 'receivable' || a.subtype === 'payable'
        if (partyNeeded && !l.partyId && a.purpose !== 'fees_receivable') {
          throw new FinanceError(400, 'party_required', `${at}: ${a.name} needs the party it is for`)
        }
        let amountFc: number | null = null
        let exchangeRate: string | null = null
        const currency = l.currency && l.currency !== settings.baseCurrency ? l.currency : (a.currency ?? null)
        if (currency) {
          const minor = await minorUnitsOf(tx, tenant, currency)
          amountFc = l.amountFc ? parseDecimal(l.amountFc, minor) : null
          exchangeRate = l.exchangeRate ?? null
          if (amountFc === null || !exchangeRate) {
            throw new FinanceError(400, 'fc_required', `${at}: say how much ${currency} and at what rate`)
          }
          if (toBase(amountFc, exchangeRate, minor, baseMinor) !== debit + credit) {
            throw new FinanceError(400, 'fc_mismatch', `${at}: ${currency} at that rate is not that amount`)
          }
        }
        rows.push({
          institutionId: tenant,
          seq: i + 1,
          accountId: a.id,
          partyId: l.partyId ?? null,
          debitPaise: debit,
          creditPaise: credit,
          costCenter: l.costCenter ?? null,
          fundId: l.fundId ?? null,
          currency,
          amountFc,
          exchangeRate,
          memo: l.memo ?? null,
        })
      }
      const header = {
        kind: data.kind,
        postingDate: data.postingDate ?? (await localToday(tx, tenant)),
        memo: data.memo,
        reference: data.reference ?? null,
      }
      let id = data.journalId
      if (id) {
        const [row] = await tx.select().from(journals).where(eq(journals.id, id)).for('update')
        if (!row) throw new FinanceError(404, 'no_such_journal', 'no such journal voucher')
        if (row.docstatus !== 'draft') throw new FinanceError(409, 'not_a_draft', 'only a draft is edited')
        await tx.update(journals).set(header).where(eq(journals.id, id))
        await tx.delete(journalLines).where(eq(journalLines.journalId, id))
      } else {
        const [row] = await tx
          .insert(journals)
          .values({ ...header, institutionId: tenant, createdBy: actor.id })
          .returning({ id: journals.id })
        id = row!.id
      }
      await tx.insert(journalLines).values(rows.map((r) => ({ ...r, journalId: id! })))
      if (data.submit) return submitJournalWithin(tx, actor, id!)
      return { id, notice: 'Saved as a draft.', next: `/m/finance/voucher?id=${id}` }
    }),
  )
}

export async function submitJournal(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const { journalId } = z.object({ journalId: z.uuid() }).parse(input)
  return withTenant(tenant, (tx) => named(() => submitJournalWithin(tx, actor, journalId)))
}

export function approvalViewOfJournal(j: typeof journals.$inferSelect, ls: (typeof journalLines.$inferSelect)[]) {
  return {
    kind: j.kind,
    postingDate: j.postingDate,
    memo: j.memo,
    lines: ls.map((l) => ({ accountId: l.accountId, partyId: l.partyId, debitPaise: l.debitPaise, creditPaise: l.creditPaise })),
  }
}

async function submitJournalWithin(tx: Tx, actor: Actor, journalId: string) {
  const tenant = actor.institutionId!
  const [j] = await tx.select().from(journals).where(eq(journals.id, journalId)).for('update')
  if (!j) throw new FinanceError(404, 'no_such_journal', 'no such journal voucher')
  if (j.docstatus !== 'draft') throw new FinanceError(409, 'not_a_draft', 'that voucher is not a draft')
  const ls = await tx.select().from(journalLines).where(eq(journalLines.journalId, journalId)).orderBy(asc(journalLines.seq))
  const debit = ls.reduce((n, l) => n + l.debitPaise, 0)
  const credit = ls.reduce((n, l) => n + l.creditPaise, 0)
  await assertApproved(tx, 'journal', journalId, approvalViewOfJournal(j, ls), Math.max(debit, credit))

  const posting = ls.map((l) => ({
    accountId: l.accountId,
    partyId: l.partyId,
    debitPaise: l.debitPaise,
    creditPaise: l.creditPaise,
    costCenter: l.costCenter,
    fundId: l.fundId,
    currency: l.currency,
    amountFc: l.amountFc,
    exchangeRate: l.exchangeRate,
    memo: l.memo,
  }))
  if (debit !== credit) {
    if (j.kind !== 'opening') {
      throw new FinanceError(400, 'unbalanced', 'the debits and credits must agree', { debitPaise: debit, creditPaise: credit })
    }
    // Opening balances come in a few at a time; what does not balance yet waits
    // in the opening balance account, which is empty once the last is in.
    const diff = debit - credit
    posting.push({
      accountId: await accountFor(tx, tenant, 'opening_balance'),
      partyId: null,
      debitPaise: diff < 0 ? -diff : 0,
      creditPaise: diff > 0 ? diff : 0,
      costCenter: null,
      fundId: null,
      currency: null,
      amountFc: null,
      exchangeRate: null,
      memo: 'Opening balance difference',
    })
  }

  const number = await nextNumber(tx, tenant, 'journal', j.postingDate)
  const posted = await postWithin(tx, tenant, actor.id, {
    postingDate: j.postingDate,
    memo: `${number}: ${j.memo}`.slice(0, 200),
    sourceModule: MODULE,
    sourceRef: `journal:${journalId}`,
    lines: posting,
  })

  // Lines on a receivable or payable account move the party's account too.
  const partyAccounts = await tx
    .select({ id: accounts.id, subtype: accounts.subtype })
    .from(accounts)
    .where(inArray(accounts.id, ls.filter((l) => l.partyId).map((l) => l.accountId).concat(['00000000-0000-0000-0000-000000000000'])))
  const subtypeOf = new Map(partyAccounts.map((a) => [a.id, a.subtype]))
  const settings = await settingsWithin(tx, tenant)
  const rows = ls
    .filter((l) => l.partyId && (subtypeOf.get(l.accountId) === 'receivable' || subtypeOf.get(l.accountId) === 'payable'))
    .map((l) => {
      const side = subtypeOf.get(l.accountId) as 'receivable' | 'payable'
      const grows = side === 'receivable' ? l.debitPaise - l.creditPaise : l.creditPaise - l.debitPaise
      const fc = l.amountFc ?? Math.abs(grows)
      return {
        institutionId: tenant,
        partyId: l.partyId!,
        side,
        accountId: l.accountId,
        voucherType: 'journal',
        voucherId: journalId,
        againstId: null,
        postingDate: j.postingDate,
        currency: l.currency ?? settings.baseCurrency,
        amountFc: Math.sign(grows) * fc,
        amountPaise: grows,
      }
    })
  if (rows.length) await tx.insert(partyLedger).values(rows)

  await tx.update(journals).set({ number, entryId: posted.id }).where(eq(journals.id, journalId))
  await submitDocument(tx, journals, journalId, {
    institutionId: tenant,
    actorId: actor.id,
    actorEmail: actor.email,
    moduleId: MODULE,
  })
  return { id: journalId, number, notice: `${number} submitted.`, next: `/m/finance/voucher?id=${journalId}` }
}

export async function cancelJournal(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const data = z.object({ journalId: z.uuid(), reason: z.string().trim().min(5).max(300) }).parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      const [j] = await tx.select().from(journals).where(eq(journals.id, data.journalId)).for('update')
      if (!j) throw new FinanceError(404, 'no_such_journal', 'no such journal voucher')
      if (j.docstatus !== 'submitted') throw new FinanceError(409, 'not_submitted', 'only a submitted voucher is cancelled')
      await unapplyAdvances(tx, tenant, actor.id, j.id)
      const own = await tx
        .select()
        .from(partyLedger)
        .where(and(eq(partyLedger.voucherType, 'journal'), eq(partyLedger.voucherId, j.id)))
      if (own.length) {
        await tx.insert(partyLedger).values(
          own.map((r) => ({ ...without(r, 'id', 'createdAt'), amountFc: -r.amountFc, amountPaise: -r.amountPaise })),
        )
      }
      if (j.entryId) await reverseWithin(tx, tenant, actor.id, j.entryId, data.reason)
      await cancelDocument(tx, journals, j.id, {
        institutionId: tenant,
        actorId: actor.id,
        actorEmail: actor.email,
        moduleId: MODULE,
        reason: data.reason,
      })
      return { notice: `${j.number} cancelled.` }
    }),
  )
}

export async function amendJournal(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const { journalId } = z.object({ journalId: z.uuid() }).parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      const copy = await amendDocument(
        tx,
        journals,
        journalId,
        { institutionId: tenant, actorId: actor.id, actorEmail: actor.email, moduleId: MODULE },
        { number: null, entry_id: null, created_by: actor.id },
      )
      const newId = String(copy.id)
      const ls = await tx.select().from(journalLines).where(eq(journalLines.journalId, journalId))
      if (ls.length) await tx.insert(journalLines).values(ls.map((l) => ({ ...without(l, 'id'), journalId: newId })))
      return { id: newId, notice: 'Amended into a new draft.', next: `/m/finance/voucher?id=${newId}` }
    }),
  )
}

export async function deleteJournal(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const { journalId } = z.object({ journalId: z.uuid() }).parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      await tx.delete(journals).where(eq(journals.id, journalId))
      return { notice: 'Draft deleted.', next: '/m/finance/vouchers' }
    }),
  )
}

export async function listJournals(actor: Actor, input: { kind?: string; status?: string } = {}) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) => {
    const rows = await tx
      .select({
        j: journals,
        totalPaise: sql<number>`(select coalesce(sum(l.debit_paise), 0) from finance_journal_voucher_lines l where l.journal_id = "finance_journals"."id")::bigint`,
      })
      .from(journals)
      .where(
        and(
          input.kind ? eq(journals.kind, input.kind as 'journal') : undefined,
          input.status ? eq(journals.docstatus, input.status as 'draft') : undefined,
        ),
      )
      .orderBy(desc(journals.postingDate), desc(journals.createdAt))
      .limit(1000)
    return rows.map((r) => ({ ...r.j, totalPaise: Number(r.totalPaise) }))
  })
}

export async function journalDetail(actor: Actor, journalId: string) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) => {
    const [j] = await tx.select().from(journals).where(eq(journals.id, journalId))
    if (!j) throw new FinanceError(404, 'no_such_journal', 'no such journal voucher')
    const ls = await tx
      .select({ l: journalLines, code: accounts.code, name: accounts.name, partyName: parties.name })
      .from(journalLines)
      .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
      .leftJoin(parties, eq(parties.id, journalLines.partyId))
      .where(eq(journalLines.journalId, journalId))
      .orderBy(asc(journalLines.seq))
    const posting = j.entryId ? await tx.select().from(glLines).where(eq(glLines.entryId, j.entryId)) : []
    return {
      journal: j,
      lines: ls.map((r) => ({ ...r.l, code: r.code, accountName: r.name, partyName: r.partyName })),
      posting,
      approvals: await approvalsFor(tx, 'journal', journalId),
    }
  })
}
