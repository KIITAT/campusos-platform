import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { amendDocument, cancelDocument, submitDocument, withTenant } from '@campusos/db'
import * as z from 'zod'
import { ticked } from '@campusos/module-framework'
import {
  accounts,
  invoices,
  lines as glLines,
  parties,
  partyLedger,
  paymentAllocations,
  payments,
  tdsSections,
} from '../schema'
import { FinanceError, named, requireOperate, requireRead, without, type Actor, type Tx } from './core'
import { outstandingOf, partyAccountOf } from './invoices'
import { parseDecimal, toBase } from './numbers'
import { accountFor, postWithin, reverseWithin } from './operations'
import { partyWithin, unapplyAdvances } from './parties'
import { approvalsFor, assertApproved, minorUnitsOf, nextNumber, rateOn } from './setup'
import { localToday, settingsWithin } from './years'

/**
 * Money in, money out, and money moved between the institution's own
 * accounts.
 *
 * A receipt or a payment names a party and, optionally, the invoices it
 * settles; whatever it does not settle stands to the party's account as an
 * advance, to be set against their next invoice. What a payer deducts as tax
 * (TDS) settles the bill as surely as money does; what the bank keeps as
 * charges is an expense.
 *
 *   receive   Dr bank (what arrived)  Dr bank charges  Dr TDS receivable  Cr the customer
 *   pay       Dr the supplier          Cr bank (what left)  Cr TDS payable (what was withheld)
 *   transfer  Dr the other account     Cr this one
 *
 * In a foreign currency, an invoice is settled at the rate it was booked at
 * and the bank at the rate of the day; the difference is an exchange gain or
 * loss, realised as it is settled.
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
const optionalDate = z.iso
  .date()
  .optional()
  .or(z.literal('').transform(() => undefined))

export const MODES = ['cash', 'cheque', 'dd', 'neft', 'rtgs', 'imps', 'upi', 'card', 'wire', 'other'] as const

export const paymentSchema = z
  .object({
    paymentId: optionalId,
    kind: z.enum(['receive', 'pay', 'transfer']),
    partyId: optionalId,
    /** Whose account it moves; by default a receipt is a customer's and a payment a supplier's. */
    side: z.enum(['receivable', 'payable', '']).optional().transform((v) => (v ? v : undefined)),
    postingDate: optionalDate,
    /** The cash or bank account it goes into or out of. */
    accountId: z.uuid(),
    toAccountId: optionalId,
    currency: optional(3).transform((v) => v?.toUpperCase()),
    exchangeRate: optional(24),
    amount: z.string().trim().min(1).max(24),
    tds: optional(24),
    tdsSectionId: optionalId,
    bankCharges: optional(24),
    mode: z.enum(MODES).default('neft'),
    instrumentNo: optional(40),
    instrumentDate: optionalDate,
    reference: optional(120),
    memo: optional(500),
    costCenter: optional(80),
    fundId: optionalId,
    /** Invoices it settles, and how much of each; left out, the oldest open ones first. */
    allocations: z
      .array(z.object({ invoiceId: optionalId, amount: optional(24) }))
      .max(300)
      .default([]),
    autoAllocate: z.preprocess(ticked, z.boolean()).default(false),
    submit: z.preprocess(ticked, z.boolean()).default(false),
  })
  .meta({ id: 'FinancePayment' })

const seriesOf = (kind: 'receive' | 'pay' | 'transfer') => `payment_${kind}`

function amountOf(v: string | undefined, what: string, places = 2): number {
  if (!v) return 0
  const n = parseDecimal(v, places)
  if (n === null || n < 0) throw new FinanceError(400, 'bad_amount', `${what} is not an amount`)
  return n
}

async function bankAccountWithin(tx: Tx, accountId: string, what: string) {
  const [a] = await tx.select().from(accounts).where(eq(accounts.id, accountId))
  if (!a) throw new FinanceError(404, 'no_such_account', `no such account for ${what}`)
  if (a.isGroup) throw new FinanceError(400, 'group_account', `${a.name} is a group; choose one of its accounts`)
  if (a.archivedAt) throw new FinanceError(409, 'account_archived', `${a.name} is closed`)
  if (a.subtype !== 'cash' && a.subtype !== 'bank' && a.purpose !== 'cash' && a.purpose !== 'bank') {
    throw new FinanceError(400, 'not_cash_or_bank', `${a.name} is not a cash or bank account`)
  }
  return a
}

/** The oldest open invoices of a party on a side, in a currency: what an unallocated payment settles. */
export async function openInvoices(tx: Tx, partyId: string, side: 'receivable' | 'payable', currency?: string) {
  const rows = await tx
    .select({
      id: invoices.id,
      number: invoices.number,
      postingDate: invoices.postingDate,
      dueDate: invoices.dueDate,
      currency: invoices.currency,
      exchangeRate: invoices.exchangeRate,
      totalFc: invoices.totalFc,
      outstandingFc: sql<number>`(select coalesce(sum(p.amount_fc), 0) from finance_party_ledger p where p.against_id = "finance_invoices"."id")::bigint`,
      outstandingPaise: sql<number>`(select coalesce(sum(p.amount_paise), 0) from finance_party_ledger p where p.against_id = "finance_invoices"."id")::bigint`,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.partyId, partyId),
        eq(invoices.kind, side === 'receivable' ? 'sales' : 'purchase'),
        eq(invoices.docstatus, 'submitted'),
        eq(invoices.isReturn, false),
        currency ? eq(invoices.currency, currency) : undefined,
      ),
    )
    .orderBy(asc(invoices.dueDate), asc(invoices.postingDate))
  return rows
    .map((r) => ({ ...r, outstandingFc: Number(r.outstandingFc), outstandingPaise: Number(r.outstandingPaise) }))
    .filter((r) => r.outstandingFc > 0)
}

export async function savePayment(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const data = paymentSchema.parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      const settings = await settingsWithin(tx, tenant)
      const postingDate = data.postingDate ?? (await localToday(tx, tenant))
      const bank = await bankAccountWithin(tx, data.accountId, 'the payment')
      let party: Awaited<ReturnType<typeof partyWithin>> | null = null
      let side: 'receivable' | 'payable' | null = null
      if (data.kind === 'transfer') {
        if (!data.toAccountId) throw new FinanceError(400, 'no_destination', 'say which account it goes to')
        await bankAccountWithin(tx, data.toAccountId, 'the transfer')
        if (data.toAccountId === data.accountId) throw new FinanceError(400, 'same_account', 'a transfer goes to another account')
      } else {
        if (!data.partyId) throw new FinanceError(400, 'no_party', 'say who it is from or to')
        party = await partyWithin(tx, data.partyId)
        side = data.side ?? (data.kind === 'receive' ? 'receivable' : 'payable')
      }

      const currency = data.currency ?? bank.currency ?? party?.currency ?? settings.baseCurrency
      if (bank.currency && bank.currency !== currency) {
        throw new FinanceError(400, 'bank_currency', `${bank.name} is kept in ${bank.currency}`)
      }
      const foreign = currency !== settings.baseCurrency
      const fcMinor = await minorUnitsOf(tx, tenant, currency)
      const baseMinor = await minorUnitsOf(tx, tenant, settings.baseCurrency)
      const exchangeRate = foreign ? (data.exchangeRate ?? (await rateOn(tx, tenant, currency, postingDate))) : '1'
      const amountFc = amountOf(data.amount, 'the amount', fcMinor)
      if (amountFc <= 0) throw new FinanceError(400, 'bad_amount', 'the amount is more than nothing')
      const amountPaise = foreign ? toBase(amountFc, exchangeRate, fcMinor, baseMinor) : amountFc
      const tdsPaise = amountOf(data.tds, 'the tax deducted')
      const bankChargesPaise = amountOf(data.bankCharges, 'the bank charges')
      if (tdsPaise && foreign) throw new FinanceError(400, 'tds_foreign', 'tax is deducted at source in the base currency only')
      if (tdsPaise && data.kind === 'transfer') throw new FinanceError(400, 'tds_transfer', 'a transfer deducts no tax')

      // Allocations: as typed, or the oldest open invoices first.
      const allocations: { invoiceId: string; amountFc: number }[] = []
      if (party && side) {
        const typed = data.allocations.filter((a) => a.invoiceId && a.amount)
        if (typed.length) {
          for (const a of typed) allocations.push({ invoiceId: a.invoiceId!, amountFc: amountOf(a.amount, 'an allocation', fcMinor) })
        } else if (data.autoAllocate) {
          let left = amountFc + tdsPaise
          for (const o of await openInvoices(tx, party.id, side, currency)) {
            if (left <= 0) break
            const take = Math.min(left, o.outstandingFc)
            allocations.push({ invoiceId: o.id, amountFc: take })
            left -= take
          }
        }
      }

      const header = {
        kind: data.kind,
        partyId: party?.id ?? null,
        side,
        postingDate,
        accountId: bank.id,
        toAccountId: data.kind === 'transfer' ? data.toAccountId! : null,
        currency,
        exchangeRate,
        amountFc,
        amountPaise,
        tdsPaise,
        tdsSectionId: data.tdsSectionId ?? null,
        bankChargesPaise,
        mode: data.mode,
        instrumentNo: data.instrumentNo ?? null,
        instrumentDate: data.instrumentDate ?? null,
        reference: data.reference ?? null,
        memo: data.memo ?? (side === 'receivable' && data.kind === 'pay' ? 'Refund' : null),
        costCenter: data.costCenter ?? null,
        fundId: data.fundId ?? null,
      }
      let id = data.paymentId
      if (id) {
        const [row] = await tx.select().from(payments).where(eq(payments.id, id)).for('update')
        if (!row) throw new FinanceError(404, 'no_such_payment', 'no such payment')
        if (row.docstatus !== 'draft') throw new FinanceError(409, 'not_a_draft', 'only a draft is edited')
        await tx.update(payments).set(header).where(eq(payments.id, id))
        await tx.delete(paymentAllocations).where(eq(paymentAllocations.paymentId, id))
      } else {
        const [row] = await tx
          .insert(payments)
          .values({ ...header, institutionId: tenant, createdBy: actor.id })
          .returning({ id: payments.id })
        id = row!.id
      }
      if (allocations.length) {
        await tx.insert(paymentAllocations).values(allocations.map((a) => ({ ...a, institutionId: tenant, paymentId: id! })))
      }
      if (data.submit) return submitPaymentWithin(tx, actor, id!)
      return { id, notice: 'Saved as a draft.', next: `/m/finance/payment?id=${id}` }
    }),
  )
}

export async function submitPayment(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const data = z.object({ paymentId: z.uuid() }).parse(input)
  return withTenant(tenant, (tx) => named(() => submitPaymentWithin(tx, actor, data.paymentId)))
}

export function approvalViewOfPayment(p: typeof payments.$inferSelect, allocs: { invoiceId: string; amountFc: number }[]) {
  return {
    kind: p.kind,
    partyId: p.partyId,
    accountId: p.accountId,
    currency: p.currency,
    amountFc: p.amountFc,
    tdsPaise: p.tdsPaise,
    allocations: allocs.map((a) => ({ invoiceId: a.invoiceId, amountFc: a.amountFc })),
  }
}

async function submitPaymentWithin(tx: Tx, actor: Actor, paymentId: string) {
  const tenant = actor.institutionId!
  const [p] = await tx.select().from(payments).where(eq(payments.id, paymentId)).for('update')
  if (!p) throw new FinanceError(404, 'no_such_payment', 'no such payment')
  if (p.docstatus !== 'draft') throw new FinanceError(409, 'not_a_draft', 'that payment is not a draft')
  const allocs = await tx.select().from(paymentAllocations).where(eq(paymentAllocations.paymentId, paymentId))
  if (p.kind === 'pay') {
    await assertApproved(tx, 'payment_pay', paymentId, approvalViewOfPayment(p, allocs), p.amountPaise)
  }
  const settings = await settingsWithin(tx, tenant)
  const fcMinor = await minorUnitsOf(tx, tenant, p.currency)
  const baseMinor = await minorUnitsOf(tx, tenant, settings.baseCurrency)
  const foreign = p.currency !== settings.baseCurrency
  const number = await nextNumber(tx, tenant, seriesOf(p.kind), p.postingDate)
  const [bank] = await tx.select().from(accounts).where(eq(accounts.id, p.accountId))
  const bankFc = bank?.currency ? { currency: p.currency, exchangeRate: p.exchangeRate } : {}
  const lines: {
    accountId: string
    debitPaise: number
    creditPaise: number
    partyId?: string | null
    currency?: string | null
    amountFc?: number | null
    exchangeRate?: string | null
    costCenter?: string | null
    fundId?: string | null
    memo?: string | null
  }[] = []
  const line = (accountId: string, v: number, extra: Omit<(typeof lines)[number], 'accountId' | 'debitPaise' | 'creditPaise'> = {}) => {
    if (v !== 0) lines.push({ accountId, debitPaise: v > 0 ? v : 0, creditPaise: v < 0 ? -v : 0, ...extra })
  }
  const charges = p.bankChargesPaise
  const chargesAccount = charges ? await accountFor(tx, tenant, 'bank_charges') : null
  let memo: string

  if (p.kind === 'transfer') {
    const [to] = await tx.select().from(accounts).where(eq(accounts.id, p.toAccountId!))
    line(p.toAccountId!, p.amountPaise, to?.currency ? { currency: p.currency, amountFc: p.amountFc, exchangeRate: p.exchangeRate } : {})
    line(p.accountId, -p.amountPaise, bank?.currency ? { ...bankFc, amountFc: p.amountFc } : {})
    if (charges) {
      line(chargesAccount!, charges, { costCenter: p.costCenter, fundId: p.fundId })
      line(p.accountId, -charges)
    }
    memo = `${number} transfer`
  } else {
    const party = await partyWithin(tx, p.partyId!)
    const side = p.side ?? (p.kind === 'receive' ? 'receivable' : 'payable')
    const partyAccount = await partyAccountOf(tx, tenant, party.id, side)
    // Money in settles a receivable and refunds a payable; money out the reverse.
    const settling = (p.kind === 'receive') === (side === 'receivable')
    if (allocs.length && !settling) {
      throw new FinanceError(400, 'refund_allocated', 'a refund settles no invoice; it stands to the party’s account')
    }
    memo = `${number} ${party.name}`.slice(0, 200)

    // Each allocation, checked and valued at the rate its invoice was booked at.
    let bookedPaise = 0
    let allocatedFc = 0
    const ledgerRows: { againstId: string | null; amountFc: number; amountPaise: number; dueDate: string | null }[] = []
    if (allocs.length) {
      const invs = await tx.select().from(invoices).where(inArray(invoices.id, allocs.map((a) => a.invoiceId)))
      const byId = new Map(invs.map((i) => [i.id, i]))
      for (const a of allocs) {
        const inv = byId.get(a.invoiceId)
        if (!inv || inv.docstatus !== 'submitted' || inv.isReturn) {
          throw new FinanceError(400, 'bad_allocation', 'a payment settles submitted invoices only')
        }
        if (inv.partyId !== party.id) throw new FinanceError(400, 'bad_allocation', `${inv.number} is another party’s`)
        if (inv.kind !== (side === 'receivable' ? 'sales' : 'purchase')) {
          throw new FinanceError(400, 'bad_allocation', `${inv.number} is on the other side of the books`)
        }
        if (inv.currency !== p.currency) throw new FinanceError(400, 'bad_allocation', `${inv.number} is in ${inv.currency}`)
        const open = await outstandingOf(tx, inv.id)
        if (a.amountFc > open.fc) {
          throw new FinanceError(409, 'over_allocated', `only ${open.fc / 10 ** fcMinor} is open on ${inv.number}`)
        }
        const paise =
          a.amountFc === open.fc ? open.paise : foreign ? toBase(a.amountFc, inv.exchangeRate, fcMinor, baseMinor) : a.amountFc
        bookedPaise += paise
        allocatedFc += a.amountFc
        ledgerRows.push({ againstId: inv.id, amountFc: -a.amountFc, amountPaise: -paise, dueDate: null })
      }
    }
    const settledFc = p.amountFc + (foreign ? 0 : p.tdsPaise)
    if (allocatedFc > settledFc) throw new FinanceError(409, 'finance_payment_overallocated', 'a payment settles no more than it brought')
    const restFc = settledFc - allocatedFc
    const restPaise = foreign ? toBase(restFc, p.exchangeRate, fcMinor, baseMinor) : restFc
    if (restFc > 0) ledgerRows.push({ againstId: null, amountFc: -restFc, amountPaise: -restPaise, dueDate: null })
    const partyPaise = bookedPaise + restPaise
    const partyFc = foreign ? { currency: p.currency, exchangeRate: p.exchangeRate, amountFc: settledFc } : {}
    // What the bank moved, at the day's rate, against what the party's account
    // moves, at the invoices' rates: the difference is realised exchange.
    const exchange = p.amountPaise + (foreign ? 0 : p.tdsPaise) - partyPaise

    let tdsAccount: string | null = null
    if (p.tdsPaise) {
      if (p.kind === 'receive') tdsAccount = await accountFor(tx, tenant, 'tds_receivable')
      else {
        const [section] = p.tdsSectionId ? await tx.select().from(tdsSections).where(eq(tdsSections.id, p.tdsSectionId)) : []
        tdsAccount = section?.payableAccountId ?? (await accountFor(tx, tenant, 'tds_payable'))
      }
    }
    const dims = { costCenter: p.costCenter, fundId: p.fundId }
    const s = p.kind === 'receive' ? 1 : -1
    line(p.accountId, s * p.amountPaise - charges, bank?.currency ? { ...bankFc, amountFc: p.amountFc } : {})
    if (charges) line(chargesAccount!, charges, dims)
    if (p.tdsPaise) line(tdsAccount!, s * p.tdsPaise, { partyId: party.id })
    line(partyAccount, -s * partyPaise, { partyId: party.id, ...partyFc })
    if (exchange) line(await accountFor(tx, tenant, 'exchange_gain_loss'), -s * exchange, dims)

    // Money in on a receivable lowers what is owed; a refund raises it again.
    const sign = settling ? 1 : -1
    await tx.insert(partyLedger).values(
      ledgerRows.map((r) => ({
        institutionId: tenant,
        partyId: party.id,
        side,
        accountId: partyAccount,
        voucherType: p.kind === 'receive' ? 'payment_receive' : 'payment_pay',
        voucherId: paymentId,
        againstId: r.againstId,
        postingDate: p.postingDate,
        dueDate: r.dueDate,
        currency: p.currency,
        amountFc: sign * r.amountFc,
        amountPaise: sign * r.amountPaise,
      })),
    )
  }

  const posted = await postWithin(tx, tenant, actor.id, {
    postingDate: p.postingDate,
    memo: p.memo ? `${memo}: ${p.memo}`.slice(0, 200) : memo,
    sourceModule: MODULE,
    sourceRef: `payment:${paymentId}`,
    lines,
  })
  await tx.update(payments).set({ number, entryId: posted.id }).where(eq(payments.id, paymentId))
  await submitDocument(tx, payments, paymentId, {
    institutionId: tenant,
    actorId: actor.id,
    actorEmail: actor.email,
    moduleId: MODULE,
  })
  return { id: paymentId, number, notice: `${number} submitted.`, next: `/m/finance/payment?id=${paymentId}` }
}

export async function cancelPayment(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const data = z.object({ paymentId: z.uuid(), reason: z.string().trim().min(5).max(300) }).parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      const [p] = await tx.select().from(payments).where(eq(payments.id, data.paymentId)).for('update')
      if (!p) throw new FinanceError(404, 'no_such_payment', 'no such payment')
      if (p.docstatus !== 'submitted') throw new FinanceError(409, 'not_submitted', 'only a submitted payment is cancelled')
      // What its advance was set against is opened again first.
      await unapplyAdvances(tx, tenant, actor.id, p.id)
      const own = await tx
        .select()
        .from(partyLedger)
        .where(and(eq(partyLedger.voucherId, p.id), sql`${partyLedger.voucherType} like 'payment_%'`))
      if (own.length) {
        await tx.insert(partyLedger).values(
          own.map((r) => ({ ...without(r, 'id', 'createdAt'), amountFc: -r.amountFc, amountPaise: -r.amountPaise })),
        )
      }
      if (p.entryId) await reverseWithin(tx, tenant, actor.id, p.entryId, data.reason)
      await cancelDocument(tx, payments, p.id, {
        institutionId: tenant,
        actorId: actor.id,
        actorEmail: actor.email,
        moduleId: MODULE,
        reason: data.reason,
      })
      return { notice: `${p.number} cancelled.` }
    }),
  )
}

export async function amendPayment(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const { paymentId } = z.object({ paymentId: z.uuid() }).parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      const copy = await amendDocument(
        tx,
        payments,
        paymentId,
        { institutionId: tenant, actorId: actor.id, actorEmail: actor.email, moduleId: MODULE },
        { number: null, entry_id: null, created_by: actor.id },
      )
      const newId = String(copy.id)
      const allocs = await tx.select().from(paymentAllocations).where(eq(paymentAllocations.paymentId, paymentId))
      if (allocs.length) {
        await tx.insert(paymentAllocations).values(allocs.map((a) => ({ ...without(a, 'id'), paymentId: newId })))
      }
      return { id: newId, notice: 'Amended into a new draft.', next: `/m/finance/payment?id=${newId}` }
    }),
  )
}

export async function deletePayment(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const { paymentId } = z.object({ paymentId: z.uuid() }).parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      await tx.delete(payments).where(eq(payments.id, paymentId))
      return { notice: 'Draft deleted.', next: '/m/finance/payments' }
    }),
  )
}

export async function listPayments(
  actor: Actor,
  input: { kind?: 'receive' | 'pay' | 'transfer'; partyId?: string; status?: string; from?: string; to?: string } = {},
) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) => {
    const rows = await tx
      .select({ p: payments, partyName: parties.name, accountName: accounts.name })
      .from(payments)
      .leftJoin(parties, eq(parties.id, payments.partyId))
      .innerJoin(accounts, eq(accounts.id, payments.accountId))
      .where(
        and(
          input.kind ? eq(payments.kind, input.kind) : undefined,
          input.partyId ? eq(payments.partyId, input.partyId) : undefined,
          input.status ? eq(payments.docstatus, input.status as 'draft') : undefined,
          input.from ? sql`${payments.postingDate} >= ${input.from}` : undefined,
          input.to ? sql`${payments.postingDate} <= ${input.to}` : undefined,
        ),
      )
      .orderBy(desc(payments.postingDate), desc(payments.createdAt))
      .limit(1000)
    return rows.map((r) => ({ ...r.p, partyName: r.partyName, accountName: r.accountName }))
  })
}

export async function paymentDetail(actor: Actor, paymentId: string) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) => {
    const [p] = await tx.select().from(payments).where(eq(payments.id, paymentId))
    if (!p) throw new FinanceError(404, 'no_such_payment', 'no such payment')
    const allocs = await tx
      .select({ a: paymentAllocations, number: invoices.number, totalFc: invoices.totalFc, postingDate: invoices.postingDate })
      .from(paymentAllocations)
      .innerJoin(invoices, eq(invoices.id, paymentAllocations.invoiceId))
      .where(eq(paymentAllocations.paymentId, paymentId))
    const party = p.partyId ? await partyWithin(tx, p.partyId) : null
    const open = party ? await openInvoices(tx, party.id, p.kind === 'receive' ? 'receivable' : 'payable', p.currency) : []
    const posting = p.entryId ? await tx.select().from(glLines).where(eq(glLines.entryId, p.entryId)) : []
    const applied = await tx
      .select()
      .from(partyLedger)
      .where(and(eq(partyLedger.voucherType, 'advance_applied'), eq(partyLedger.voucherId, paymentId)))
    return {
      payment: p,
      party,
      allocations: allocs.map((r) => ({ ...r.a, number: r.number, totalFc: r.totalFc, postingDate: r.postingDate })),
      open,
      posting,
      applied,
      approvals: await approvalsFor(tx, 'payment_pay', paymentId),
    }
  })
}

// --- foreign currency at the period end ----------------------------------------------

/**
 * Open foreign-currency invoices, valued at a day's rate: the gain or loss
 * not yet realised, posted on that day and reversed on the next, so the
 * balance sheet shows what is owed at today's rates and the eventual
 * settlement still realises the whole difference.
 */
export async function revalueForeign(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const data = z.object({ on: z.iso.date() }).parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      const settings = await settingsWithin(tx, tenant)
      const baseMinor = await minorUnitsOf(tx, tenant, settings.baseCurrency)
      const open = await tx
        .select({
          partyId: partyLedger.partyId,
          side: partyLedger.side,
          accountId: partyLedger.accountId,
          currency: partyLedger.currency,
          fc: sql<number>`sum(${partyLedger.amountFc})::bigint`,
          paise: sql<number>`sum(${partyLedger.amountPaise})::bigint`,
        })
        .from(partyLedger)
        .where(and(sql`${partyLedger.currency} <> ${settings.baseCurrency}`, sql`${partyLedger.postingDate} <= ${data.on}`))
        .groupBy(partyLedger.partyId, partyLedger.side, partyLedger.accountId, partyLedger.currency)
        .having(sql`sum(${partyLedger.amountFc}) <> 0`)
      if (open.length === 0) return { notice: 'Nothing is open in a foreign currency.' }

      const gainLoss = await accountFor(tx, tenant, 'exchange_gain_loss')
      const lines: { accountId: string; debitPaise: number; creditPaise: number; partyId?: string }[] = []
      let net = 0
      for (const o of open) {
        const rate = await rateOn(tx, tenant, o.currency, data.on)
        const minor = await minorUnitsOf(tx, tenant, o.currency)
        const now = toBase(Number(o.fc), rate, minor, baseMinor)
        // A receivable is a debit balance, a payable a credit one.
        const sign = o.side === 'receivable' ? 1 : -1
        const change = sign * (now - Number(o.paise))
        if (change === 0) continue
        lines.push({ accountId: o.accountId, partyId: o.partyId, debitPaise: Math.max(change, 0), creditPaise: Math.max(-change, 0) })
        net += change
      }
      if (lines.length === 0) return { notice: 'Open balances already stand at that day’s rates.' }
      lines.push({ accountId: gainLoss, debitPaise: Math.max(-net, 0), creditPaise: Math.max(net, 0) })
      const posted = await postWithin(tx, tenant, actor.id, {
        postingDate: data.on,
        memo: `Unrealised exchange gain or loss at ${data.on}`,
        sourceModule: MODULE,
        sourceRef: `revaluation:${data.on}:${Date.now()}`,
        lines,
      })
      const next = new Date(`${data.on}T12:00:00Z`)
      next.setUTCDate(next.getUTCDate() + 1)
      await reverseWithin(tx, tenant, actor.id, posted.id, 'reversed on the next day', next.toISOString().slice(0, 10))
      return { id: posted.id, notice: `Revalued ${lines.length - 1} balance(s) at ${data.on}, reversed on the next day.` }
    }),
  )
}

/** A party's open invoices, for a payment form choosing what to settle. */
export async function openInvoicesFor(actor: Actor, input: { partyId: string; side?: 'receivable' | 'payable'; currency?: string }) {
  const tenant = requireRead(actor)
  return withTenant(tenant, (tx) => openInvoices(tx, input.partyId, input.side ?? 'receivable', input.currency))
}
