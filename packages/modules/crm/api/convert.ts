import * as z from 'zod'
import { and, eq, sql } from 'drizzle-orm'
import { withTenant } from '@campusos/db'
import { ticked } from '@campusos/module-framework'
import { formatDecimal, minorUnitsOf, named, partyChoices, saveOrderWithin, settingsWithin } from '@campusos/module-finance/api'
import { parties } from '@campusos/module-finance/schema'
import { leads } from '../schema'
import { CrmError, log, refuse, tenant, type Actor, type Tx } from './core'
import { assertNotErased, visibleLead, type Lead } from './leads'

export const convertSchema = z.object({
  leadId: z.uuid(),
  partyId: z.preprocess(v => (v === '' ? undefined : v), z.uuid().optional()),
  createNew: z.preprocess(ticked, z.boolean()).default(false),
  code: z.preprocess(v => (v === '' ? undefined : v), z.string().trim().min(1).max(40).optional()),
})

type Match = { id: string; code: string; name: string }
/** Decision 404: a party with the lead's GSTIN, else a customer with its e-mail. */
async function partyMatches(tx: Tx, lead: Lead): Promise<{ matches: Match[]; byGstin: boolean }> {
  if (lead.gstin) {
    const rows = (await tx.execute(sql`select id, code, name from finance_parties where gstin = ${lead.gstin} order by name`)).rows as Match[]
    if (rows.length) return { matches: rows, byGstin: true }
  }
  if (lead.email) {
    const rows = (await tx.execute(sql`select id, code, name from finance_parties where is_customer and archived_at is null and lower(email) = lower(${lead.email}) order by name`)).rows as Match[]
    return { matches: rows, byGstin: false }
  }
  return { matches: [], byGstin: false }
}
const label = (m: Match) => `${m.name} (${m.code})`

async function resolveParty(tx: Tx, institutionId: string, lead: Lead, input: z.infer<typeof convertSchema>): Promise<string> {
  if (input.partyId) {
    const [party] = await tx.select({ id: parties.id, name: parties.name, isCustomer: parties.isCustomer }).from(parties).where(and(eq(parties.id, input.partyId), sql`${parties.archivedAt} is null`))
    if (!party || !party.isCustomer) throw new CrmError(400, 'not_customer', `${party?.name ?? 'That party'} is not a customer. Mark it as a customer in finance first.`)
    return party.id
  }
  const { matches, byGstin } = await partyMatches(tx, lead)
  if (matches.length && !input.createNew) throw new CrmError(409, 'party_exists', `A customer already matches this opportunity: ${label(matches[0]!)}. Choose it, or tick "Create a new customer anyway".`)
  if (matches.length && byGstin) throw new CrmError(409, 'gstin_taken', `A party with this GSTIN already exists: ${label(matches[0]!)}. Choose it.`)
  const [row] = await tx.insert(parties).values({
    institutionId, code: input.code ?? 'CRM-' + lead.id.slice(0, 8).toUpperCase(), name: lead.company ?? lead.title, isCustomer: true,
    gstin: lead.gstin, stateCode: lead.gstin ? lead.gstin.slice(0, 2) : null, gstCategory: lead.gstin ? 'registered' : 'unregistered', email: lead.email, phone: lead.phone,
  }).returning({ id: parties.id })
  return row!.id
}

/** A won opportunity becomes a customer (or uses one) and a draft quotation, in one transaction. */
export async function convertOpportunity(actor: Actor, input: unknown) {
  const institutionId = tenant(actor)
  const data = convertSchema.parse(input)
  return withTenant(institutionId, tx => named(async () => {
    try {
      const { lead } = await visibleLead(tx, actor, data.leadId)
      assertNotErased(lead)
      if (lead.status !== 'won') throw new CrmError(409, 'not_won', 'Only a won opportunity is converted.')
      if (lead.partyId) throw new CrmError(409, 'already_converted', 'This opportunity was already converted.')
      if (!lead.itemId || !lead.expectedValuePaise) throw new CrmError(409, 'needs_item_and_value', 'Set the item and the expected value first.')
      const [item] = (await tx.execute(sql`select 1 from finance_items where id = ${lead.itemId}::uuid and archived_at is null`)).rows
      if (!item) throw new CrmError(400, 'bad_item', 'Choose an item from finance.')
      const partyId = await resolveParty(tx, institutionId, lead, data)
      const base = (await settingsWithin(tx, institutionId)).baseCurrency
      const minor = await minorUnitsOf(tx, institutionId, base)
      const quotationId = await saveOrderWithin(tx, actor, {
        kind: 'quotation', partyId, currency: base, memo: 'From sales opportunity', submit: false,
        lines: [{ itemId: lead.itemId, qty: '1', rate: formatDecimal(lead.expectedValuePaise, minor) }],
      })
      await tx.update(leads).set({ partyId, quotationId: quotationId as string, convertedAt: new Date(), updatedAt: new Date() }).where(eq(leads.id, lead.id))
      await log(tx, actor, 'lead.converted', lead.id, 'Won opportunity converted to a customer and a draft quotation')
      return { partyId, quotationId: quotationId as string, notice: 'Customer and draft quotation created. The accounts office submits the quotation.', next: '/m/crm/lead?id=' + lead.id }
    } catch (error) {
      throw refuse(error)
    }
  }))
}
/** For the lead page: who it could be converted to. */
export async function convertChoices(actor: Actor, leadId: string) {
  const institutionId = tenant(actor)
  return withTenant(institutionId, async tx => {
    const { lead } = await visibleLead(tx, actor, leadId)
    const { matches } = await partyMatches(tx, lead)
    return { customers: await partyChoices(tx, 'customer'), matches: matches.map(m => ({ value: m.id, label: label(m) })) }
  })
}
