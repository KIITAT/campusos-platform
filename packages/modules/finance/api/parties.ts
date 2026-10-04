import { and, asc, eq, ilike, isNotNull, isNull, or, sql } from 'drizzle-orm'
import { withTenant } from '@campusos/db'
import * as z from 'zod'
import { ticked } from '@campusos/module-framework'
import { entries, parties, partyLedger } from '../schema'
import { FinanceError, named, requireOperate, requireRead, type Actor, type Tx } from './core'
import { mulDiv, parseDecimal } from './numbers'
import { accountFor, postWithin, reverseWithin } from './operations'

/**
 * Customers and suppliers.
 *
 * A party's balance is not a column: it is the sum of its rows in the party
 * ledger, which every invoice, payment and voucher writes as it is submitted.
 */

const optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined))

export const partySchema = z
  .object({
    code: z.string().trim().min(1).max(40),
    name: z.string().trim().min(2).max(200),
    isCustomer: z.preprocess(ticked, z.boolean()).default(false),
    isSupplier: z.preprocess(ticked, z.boolean()).default(false),
    gstin: optional(15).transform((v) => v?.toUpperCase()),
    pan: optional(10).transform((v) => v?.toUpperCase()),
    stateCode: optional(2),
    gstCategory: z.enum(['registered', 'unregistered', 'composition', 'sez', 'overseas']).optional(),
    address: optional(500),
    email: optional(200),
    phone: optional(40),
    currency: optional(3).transform((v) => v?.toUpperCase()),
    paymentTermsDays: z.coerce.number().int().min(0).max(3650).default(0),
    creditLimit: optional(30),
    tdsSectionId: z.uuid().optional().or(z.literal('').transform(() => undefined)),
    msme: z.preprocess(ticked, z.boolean()).default(false),
    msmeNumber: optional(40),
    bankName: optional(120),
    bankAccount: optional(40),
    ifsc: optional(11).transform((v) => v?.toUpperCase()),
  })
  .meta({ id: 'FinanceParty' })

export const updatePartySchema = partySchema.partial().extend({ partyId: z.uuid() }).meta({ id: 'FinancePartyUpdate' })

function values(data: Partial<z.infer<typeof partySchema>>) {
  const creditLimitPaise =
    data.creditLimit === undefined ? undefined : data.creditLimit ? parseDecimal(data.creditLimit, 2) : null
  if (data.creditLimit && creditLimitPaise === null) {
    throw new FinanceError(400, 'bad_amount', 'the credit limit is not a number')
  }
  // A GSTIN starts with the state it is registered in, so the state need not be typed twice.
  const stateCode = data.stateCode ?? (data.gstin ? data.gstin.slice(0, 2) : undefined)
  const out: Partial<typeof parties.$inferInsert> = {
    ...(data.code !== undefined && { code: data.code }),
    ...(data.name !== undefined && { name: data.name }),
    ...(data.isCustomer !== undefined && { isCustomer: data.isCustomer }),
    ...(data.isSupplier !== undefined && { isSupplier: data.isSupplier }),
    ...(data.gstin !== undefined && { gstin: data.gstin ?? null }),
    ...(data.pan !== undefined && { pan: data.pan ?? null }),
    ...(stateCode !== undefined && { stateCode }),
    ...(data.gstCategory !== undefined
      ? { gstCategory: data.gstCategory }
      : data.gstin
        ? { gstCategory: 'registered' }
        : {}),
    ...(data.address !== undefined && { address: data.address ?? null }),
    ...(data.email !== undefined && { email: data.email ?? null }),
    ...(data.phone !== undefined && { phone: data.phone ?? null }),
    ...(data.currency !== undefined && { currency: data.currency ?? null }),
    ...(data.paymentTermsDays !== undefined && { paymentTermsDays: data.paymentTermsDays }),
    ...(creditLimitPaise !== undefined && { creditLimitPaise }),
    ...(data.tdsSectionId !== undefined && { tdsSectionId: data.tdsSectionId ?? null }),
    ...(data.msme !== undefined && { msme: data.msme }),
    ...(data.msmeNumber !== undefined && { msmeNumber: data.msmeNumber ?? null }),
    ...(data.bankName !== undefined && { bankName: data.bankName ?? null }),
    ...(data.bankAccount !== undefined && { bankAccount: data.bankAccount ?? null }),
    ...(data.ifsc !== undefined && { ifsc: data.ifsc ?? null }),
  }
  return out
}

export async function createParty(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const data = partySchema.parse(input)
  if (!data.isCustomer && !data.isSupplier) {
    throw new FinanceError(400, 'party_role', 'a party is a customer, a supplier, or both')
  }
  return withTenant(tenant, (tx) =>
    named(async () => {
      const [row] = await tx
        .insert(parties)
        .values({ ...(values(data) as typeof parties.$inferInsert), institutionId: tenant })
        .returning({ id: parties.id })
      return { ...row!, notice: `${data.name} added.`, next: `/m/finance/party?id=${row!.id}` }
    }),
  )
}

export async function updateParty(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const data = updatePartySchema.parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      const [row] = await tx
        .update(parties)
        .set(values(data))
        .where(eq(parties.id, data.partyId))
        .returning({ id: parties.id })
      if (!row) throw new FinanceError(404, 'no_such_party', 'no such party')
      return { ...row, notice: 'Saved.' }
    }),
  )
}

export async function archiveParty(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const data = z.object({ partyId: z.uuid(), archived: z.preprocess(ticked, z.boolean()).default(true) }).parse(input)
  return withTenant(tenant, async (tx) => {
    await tx
      .update(parties)
      .set({ archivedAt: data.archived ? new Date() : null })
      .where(eq(parties.id, data.partyId))
    return { notice: data.archived ? 'Archived.' : 'Restored.' }
  })
}

export async function partyWithin(tx: Tx, partyId: string) {
  const [row] = await tx.select().from(parties).where(eq(parties.id, partyId))
  if (!row) throw new FinanceError(404, 'no_such_party', 'no such party')
  return row
}

/** Each party with what it owes or is owed, by side. */
export async function listParties(
  actor: Actor,
  input: { side?: 'customer' | 'supplier'; q?: string; archived?: boolean } = {},
) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) => {
    const rows = await tx
      .select()
      .from(parties)
      .where(
        and(
          input.side === 'customer' ? eq(parties.isCustomer, true) : input.side === 'supplier' ? eq(parties.isSupplier, true) : undefined,
          input.archived ? undefined : isNull(parties.archivedAt),
          input.q ? or(ilike(parties.name, `%${input.q}%`), ilike(parties.code, `%${input.q}%`)) : undefined,
        ),
      )
      .orderBy(asc(parties.name))
    const balances = await tx
      .select({
        partyId: partyLedger.partyId,
        side: partyLedger.side,
        balance: sql<number>`sum(${partyLedger.amountPaise})::bigint`,
      })
      .from(partyLedger)
      .groupBy(partyLedger.partyId, partyLedger.side)
    const of = (id: string, side: string) =>
      Number(balances.find((b) => b.partyId === id && b.side === side)?.balance ?? 0)
    return rows.map((p) => ({ ...p, receivablePaise: of(p.id, 'receivable'), payablePaise: of(p.id, 'payable') }))
  })
}

/** Parties as choices, for a form. */
export async function partyChoices(tx: Tx, side?: 'customer' | 'supplier') {
  const rows = await tx
    .select({ id: parties.id, code: parties.code, name: parties.name })
    .from(parties)
    .where(
      and(
        isNull(parties.archivedAt),
        side === 'customer' ? eq(parties.isCustomer, true) : side === 'supplier' ? eq(parties.isSupplier, true) : undefined,
      ),
    )
    .orderBy(asc(parties.name))
  return rows.map((r) => ({ value: r.id, label: `${r.name} (${r.code})` }))
}

// --- advances ----------------------------------------------------------------------

/**
 * Money a party has paid ahead, or a credit note left over, set against their
 * open invoices -- oldest first, in the same currency.
 *
 * The party ledger records it as a pair of rows under the voucher whose credit
 * is used: one taking the credit off what stood against nothing, one setting
 * it against the invoice. The books move only when the two were booked at
 * different exchange rates, and then only by the difference.
 */
export async function applyAdvancesWithin(
  tx: Tx,
  institutionId: string,
  actorId: string | null,
  partyId: string,
  side: 'receivable' | 'payable',
  on: string,
): Promise<number> {
  const credits = await tx
    .select({
      voucherId: partyLedger.voucherId,
      currency: partyLedger.currency,
      accountId: partyLedger.accountId,
      fc: sql<number>`sum(${partyLedger.amountFc})::bigint`,
      paise: sql<number>`sum(${partyLedger.amountPaise})::bigint`,
    })
    .from(partyLedger)
    .where(and(eq(partyLedger.partyId, partyId), eq(partyLedger.side, side), isNull(partyLedger.againstId)))
    .groupBy(partyLedger.voucherId, partyLedger.currency, partyLedger.accountId)
    .having(sql`sum(${partyLedger.amountFc}) < 0`)
    .orderBy(sql`min(${partyLedger.postingDate})`)
  if (credits.length === 0) return 0

  const open = (
    await tx
      .select({
        againstId: partyLedger.againstId,
        currency: partyLedger.currency,
        fc: sql<number>`sum(${partyLedger.amountFc})::bigint`,
        paise: sql<number>`sum(${partyLedger.amountPaise})::bigint`,
      })
      .from(partyLedger)
      .where(and(eq(partyLedger.partyId, partyId), eq(partyLedger.side, side), isNotNull(partyLedger.againstId)))
      .groupBy(partyLedger.againstId, partyLedger.currency)
      .having(sql`sum(${partyLedger.amountFc}) > 0`)
      .orderBy(sql`min(${partyLedger.postingDate})`)
  ).map((o) => ({ ...o, fc: Number(o.fc), paise: Number(o.paise) }))

  let applied = 0
  let n = 0
  for (const c of credits) {
    let leftFc = -Number(c.fc)
    let leftPaise = -Number(c.paise)
    for (const o of open) {
      if (leftFc <= 0) break
      if (o.currency !== c.currency || o.fc <= 0) continue
      const take = Math.min(leftFc, o.fc)
      // The base value of what is taken, at each side's own rate.
      const fromCredit = take === leftFc ? leftPaise : mulDiv(leftPaise, take, leftFc)
      const fromInvoice = take === o.fc ? o.paise : mulDiv(o.paise, take, o.fc)
      const row = { institutionId, partyId, side, accountId: c.accountId, voucherType: 'advance_applied', voucherId: c.voucherId, postingDate: on, currency: c.currency }
      await tx.insert(partyLedger).values([
        { ...row, againstId: null, amountFc: take, amountPaise: fromCredit },
        { ...row, againstId: o.againstId, amountFc: -take, amountPaise: -fromInvoice },
      ])
      const difference = fromCredit - fromInvoice
      if (difference !== 0) {
        // More base value set off than the invoice was booked at: on a
        // receivable that is a gain, on a payable a loss.
        const gainLoss = await accountFor(tx, institutionId, 'exchange_gain_loss')
        const toParty = side === 'receivable' ? -difference : difference
        await postWithin(tx, institutionId, actorId, {
          postingDate: on,
          memo: 'Exchange difference on an advance set against an invoice',
          sourceModule: 'finance',
          sourceRef: `advance:${c.voucherId}:${o.againstId}:${Date.now()}-${n++}`,
          lines: [
            { accountId: c.accountId, partyId, debitPaise: Math.max(-toParty, 0), creditPaise: Math.max(toParty, 0) },
            { accountId: gainLoss, debitPaise: Math.max(toParty, 0), creditPaise: Math.max(-toParty, 0) },
          ],
        })
      }
      o.fc -= take
      o.paise -= fromInvoice
      leftFc -= take
      leftPaise -= fromCredit
      applied += take
    }
  }
  return applied
}

/**
 * Take back what a voucher's credit was set against, before the voucher
 * itself is cancelled: the invoices it settled are open again.
 */
export async function unapplyAdvances(tx: Tx, institutionId: string, actorId: string | null, voucherId: string) {
  const rows = await tx
    .select()
    .from(partyLedger)
    .where(and(eq(partyLedger.voucherType, 'advance_applied'), eq(partyLedger.voucherId, voucherId)))
  if (rows.length === 0) return
  const net = new Map<string, (typeof rows)[number] & { netFc: number; netPaise: number }>()
  for (const r of rows) {
    const k = `${r.againstId ?? ''}|${r.currency}`
    const s = net.get(k) ?? { ...r, netFc: 0, netPaise: 0 }
    s.netFc += r.amountFc
    s.netPaise += r.amountPaise
    net.set(k, s)
  }
  const undo = [...net.values()].filter((s) => s.netFc !== 0 || s.netPaise !== 0)
  if (undo.length) {
    await tx.insert(partyLedger).values(
      undo.map((s) => ({
        institutionId,
        partyId: s.partyId,
        side: s.side,
        accountId: s.accountId,
        voucherType: 'advance_applied',
        voucherId,
        againstId: s.againstId,
        postingDate: s.postingDate,
        currency: s.currency,
        amountFc: -s.netFc,
        amountPaise: -s.netPaise,
      })),
    )
  }
  // An exchange difference posted when it was applied is undone with it.
  const diffs = await tx
    .select({ id: entries.id })
    .from(entries)
    .where(
      and(
        eq(entries.sourceModule, 'finance'),
        sql`${entries.sourceRef} like ${`advance:${voucherId}:%`}`,
        isNull(entries.reversalOf),
        sql`not exists (select 1 from finance_journal_entries r where r.reversal_of = "finance_journal_entries"."id")`,
      ),
    )
  for (const d of diffs) await reverseWithin(tx, institutionId, actorId, d.id, 'advance taken back')
}

export async function applyAdvances(actor: Actor, input: unknown) {
  const tenant = requireOperate(actor)
  const data = z
    .object({ partyId: z.uuid(), side: z.enum(['receivable', 'payable']), on: z.iso.date().optional() })
    .parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      const on = data.on ?? new Date().toISOString().slice(0, 10)
      const applied = await applyAdvancesWithin(tx, tenant, actor.id, data.partyId, data.side, on)
      return { applied, notice: applied ? 'Advances set against open invoices.' : 'Nothing to set off.' }
    }),
  )
}

/** A party's statement: every row of their account, oldest first, with the running balance. */
export async function partyStatement(
  actor: Actor,
  input: { partyId: string; side?: 'receivable' | 'payable'; from?: string; to?: string },
) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) => {
    const party = await partyWithin(tx, input.partyId)
    const side = input.side ?? (party.isCustomer ? 'receivable' : 'payable')
    const [opening] = input.from
      ? await tx
          .select({ v: sql<number>`coalesce(sum(${partyLedger.amountPaise}), 0)::bigint` })
          .from(partyLedger)
          .where(
            and(
              eq(partyLedger.partyId, party.id),
              eq(partyLedger.side, side),
              sql`${partyLedger.postingDate} < ${input.from}`,
            ),
          )
      : [{ v: 0 }]
    // Setting an advance off moves nothing a statement shows: it nets to zero.
    const rows = await tx
      .select()
      .from(partyLedger)
      .where(
        and(
          eq(partyLedger.partyId, party.id),
          eq(partyLedger.side, side),
          input.from ? sql`${partyLedger.postingDate} >= ${input.from}` : undefined,
          input.to ? sql`${partyLedger.postingDate} <= ${input.to}` : undefined,
          sql`${partyLedger.voucherType} <> 'advance_applied'`,
        ),
      )
      .orderBy(asc(partyLedger.postingDate), asc(partyLedger.createdAt))
    // A voucher's rows (one payment across several invoices) read as one line.
    const merged: {
      postingDate: string
      voucherType: string
      voucherId: string
      amountPaise: number
      amountFc: number
      currency: string
    }[] = []
    for (const r of rows) {
      const last = merged[merged.length - 1]
      if (
        last &&
        last.voucherId === r.voucherId &&
        last.postingDate === r.postingDate &&
        Math.sign(last.amountPaise) === Math.sign(r.amountPaise)
      ) {
        last.amountPaise += r.amountPaise
        last.amountFc += r.amountFc
      } else {
        merged.push({
          postingDate: r.postingDate,
          voucherType: r.voucherType,
          voucherId: r.voucherId,
          amountPaise: r.amountPaise,
          amountFc: r.amountFc,
          currency: r.currency,
        })
      }
    }
    const openingPaise = Number(opening?.v ?? 0)
    let balance = openingPaise
    const lines = merged.map((m) => {
      balance += m.amountPaise
      return { ...m, balancePaise: balance }
    })
    return { party, side, openingPaise, lines, closingPaise: balance }
  })
}
