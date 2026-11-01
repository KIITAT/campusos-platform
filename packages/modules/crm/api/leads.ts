import * as z from 'zod'
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { users, withTenant } from '@campusos/db'
import { cursorColumn, finishPage, keyset, orderKeys, readPage, searchAny, type PageRequest, type SortSpec } from '@campusos/module-framework'
import { parseDecimal } from '@campusos/module-finance/api'
import { activities, leads, lostReasons, stages } from '../schema'
import { ADMIN, CrmError, log, tenant, type Actor, type Tx } from './core'
import { ensureDefaults, isSalesperson, ownersOf } from './settings'

const GSTIN = /^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]Z[0-9A-Z]$/
export const SOURCES = ['website', 'referral', 'event', 'cold_call', 'existing_customer', 'other'] as const
const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v)
const opt = <T extends z.ZodType>(schema: T) => z.preprocess(blank, schema.optional())
const text = (max: number) => opt(z.string().trim().max(max))

export const leadSchema = z.object({
  kind: z.enum(['lead', 'opportunity']).default('lead'),
  title: z.string().trim().min(2).max(200),
  company: text(200), contactName: text(200),
  email: opt(z.string().trim().max(200).refine(v => v.includes('@'), 'An e-mail address needs an @.')),
  phone: text(40),
  gstin: opt(z.string().trim().toUpperCase().regex(GSTIN, 'Not a valid GSTIN.')),
  source: z.enum(SOURCES), notes: text(4000),
  ownerId: opt(z.string().min(1)), itemId: opt(z.uuid()), expectedValue: opt(z.union([z.string(), z.number()])),
  expectedClose: opt(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
})
export const updateSchema = leadSchema.omit({ kind: true, ownerId: true, source: true, title: true }).extend({ title: opt(z.string().trim().min(2).max(200)), source: z.enum(SOURCES).optional() }).partial().extend({ leadId: z.uuid() })
export const stageMoveSchema = z.object({ leadId: z.uuid(), stageId: z.uuid() })
export const assignSchema = z.object({ leadId: z.uuid(), ownerId: z.string().min(1) })
export const lostSchema = z.object({ leadId: z.uuid(), reasonId: z.uuid(), lostNote: text(500) })
export const leadIdSchema = z.object({ leadId: z.uuid() })

export type Lead = typeof leads.$inferSelect

/** Locks the lead and applies the visibility rule (decision 396): not visible is not found. */
export async function visibleLead(tx: Tx, actor: Actor, id: string): Promise<{ lead: Lead; owners: string[] | null }> {
  const owners = await ownersOf(tx, actor)
  const parsed = z.uuid().safeParse(id)
  const [lead] = parsed.success ? await tx.select().from(leads).where(eq(leads.id, id)).for('update') : []
  if (!lead || (owners !== null && !owners.includes(lead.ownerId))) throw new CrmError(404, 'not_found', 'No such lead in your pipeline.')
  return { lead, owners }
}
export const assertOpen = (lead: Lead, message = 'Only an open lead can be changed this way.') => { if (lead.status !== 'open') throw new CrmError(409, 'not_open', message) }
export const assertNotErased = (lead: Lead) => { if (lead.erasedAt) throw new CrmError(409, 'erased', "This lead's contact data was erased.") }

async function checkItem(tx: Tx, itemId: string) {
  const r = await tx.execute(sql`select 1 from finance_items where id = ${itemId}::uuid and archived_at is null`)
  if (!r.rows.length) throw new CrmError(400, 'bad_item', 'Choose an item from finance.')
}
async function firstStage(tx: Tx): Promise<string> {
  const [stage] = await tx.select({ id: stages.id }).from(stages).where(isNull(stages.archivedAt)).orderBy(asc(stages.seq)).limit(1)
  if (!stage) throw new CrmError(400, 'bad_stage', 'Choose an active stage.')
  return stage.id
}
async function activeStage(tx: Tx, stageId: string) {
  const [stage] = await tx.select({ id: stages.id }).from(stages).where(and(eq(stages.id, stageId), isNull(stages.archivedAt)))
  if (!stage) throw new CrmError(400, 'bad_stage', 'Choose an active stage.')
}
function value(input: unknown): number | undefined {
  if (input === undefined) return undefined
  const paise = parseDecimal(input, 2)
  if (paise === null || paise < 0) throw new CrmError(400, 'bad_amount', 'Enter the expected value in rupees, up to two decimals.')
  return paise
}
/** Decision 397: who may become the owner. */
async function checkOwner(tx: Tx, actor: Actor, owners: string[] | null, ownerId: string) {
  if (owners !== null) {
    if (!owners.includes(ownerId)) throw new CrmError(403, 'not_your_team', 'You can assign only to yourself or to your team.')
    return
  }
  if (ownerId === actor.id) return
  if (!(await isSalesperson(tx, ownerId))) throw new CrmError(400, 'not_a_salesperson', 'Choose a member or manager of a sales team.')
}
const result = (id: string, notice = 'Saved.') => ({ id, notice, next: '/m/crm/lead?id=' + id })

export async function createLead(actor: Actor, input: unknown) {
  const institutionId = tenant(actor)
  const data = leadSchema.parse(input)
  return withTenant(institutionId, async tx => {
    const owners = await ownersOf(tx, actor)
    await ensureDefaults(tx, institutionId)
    const ownerId = data.ownerId ?? actor.id
    if (ownerId !== actor.id) await checkOwner(tx, actor, owners, ownerId)
    if (data.itemId) await checkItem(tx, data.itemId)
    const paise = value(data.expectedValue)
    const stageId = data.kind === 'opportunity' ? await firstStage(tx) : null
    const [row] = await tx.insert(leads).values({
      institutionId, kind: data.kind, title: data.title, company: data.company, contactName: data.contactName, email: data.email, phone: data.phone, gstin: data.gstin,
      source: data.source, notes: data.notes, ownerId, stageId, itemId: data.itemId, expectedValuePaise: paise, expectedClose: data.expectedClose, createdBy: actor.id,
    }).returning({ id: leads.id })
    await log(tx, actor, 'lead.created', row!.id, data.kind === 'lead' ? 'New lead recorded' : 'New opportunity recorded')
    return result(row!.id)
  })
}
export async function updateLead(actor: Actor, input: unknown) {
  const institutionId = tenant(actor)
  const { leadId, expectedValue, ...data } = updateSchema.parse(input)
  return withTenant(institutionId, async tx => {
    const { lead } = await visibleLead(tx, actor, leadId)
    assertNotErased(lead)
    assertOpen(lead)
    if (data.itemId) await checkItem(tx, data.itemId)
    const paise = value(expectedValue)
    const set = Object.fromEntries(Object.entries({ ...data, expectedValuePaise: paise }).filter(([, v]) => v !== undefined))
    await tx.update(leads).set({ ...set, updatedAt: new Date() }).where(eq(leads.id, lead.id))
    await log(tx, actor, 'lead.updated', lead.id, 'Lead details changed')
    return result(lead.id)
  })
}
export async function qualifyLead(actor: Actor, input: unknown) {
  const institutionId = tenant(actor)
  const { leadId } = leadIdSchema.parse(input)
  return withTenant(institutionId, async tx => {
    const { lead } = await visibleLead(tx, actor, leadId)
    assertNotErased(lead)
    assertOpen(lead)
    if (lead.kind === 'opportunity') throw new CrmError(409, 'already_opportunity', 'This is already an opportunity.')
    await tx.update(leads).set({ kind: 'opportunity', stageId: await firstStage(tx), updatedAt: new Date() }).where(eq(leads.id, lead.id))
    await log(tx, actor, 'lead.qualified', lead.id, 'Lead qualified as an opportunity')
    return result(lead.id)
  })
}
export async function moveStage(actor: Actor, input: unknown) {
  const institutionId = tenant(actor)
  const data = stageMoveSchema.parse(input)
  return withTenant(institutionId, async tx => {
    const { lead } = await visibleLead(tx, actor, data.leadId)
    assertNotErased(lead)
    assertOpen(lead)
    if (lead.kind !== 'opportunity') throw new CrmError(409, 'not_an_opportunity', 'Qualify the lead first.')
    await activeStage(tx, data.stageId)
    await tx.update(leads).set({ stageId: data.stageId, updatedAt: new Date() }).where(eq(leads.id, lead.id))
    await log(tx, actor, 'lead.stage_moved', lead.id, 'Opportunity moved to another stage')
    return result(lead.id)
  })
}
export async function assignLead(actor: Actor, input: unknown) {
  const institutionId = tenant(actor)
  const data = assignSchema.parse(input)
  return withTenant(institutionId, async tx => {
    const { lead, owners } = await visibleLead(tx, actor, data.leadId)
    assertNotErased(lead)
    await checkOwner(tx, actor, owners, data.ownerId)
    await tx.update(leads).set({ ownerId: data.ownerId, updatedAt: new Date() }).where(eq(leads.id, lead.id))
    await log(tx, actor, 'lead.assigned', lead.id, 'Lead given to another owner')
    return result(lead.id)
  })
}
export async function markWon(actor: Actor, input: unknown) {
  const institutionId = tenant(actor)
  const { leadId } = leadIdSchema.parse(input)
  return withTenant(institutionId, async tx => {
    const { lead } = await visibleLead(tx, actor, leadId)
    assertNotErased(lead)
    assertOpen(lead)
    if (lead.kind !== 'opportunity') throw new CrmError(409, 'not_an_opportunity', 'Qualify the lead first.')
    const now = new Date()
    await tx.update(leads).set({ status: 'won', wonAt: now, closedAt: now, updatedAt: now }).where(eq(leads.id, lead.id))
    await log(tx, actor, 'lead.won', lead.id, 'Opportunity won')
    return result(lead.id)
  })
}
export async function markLost(actor: Actor, input: unknown) {
  const institutionId = tenant(actor)
  const data = lostSchema.parse(input)
  return withTenant(institutionId, async tx => {
    const { lead } = await visibleLead(tx, actor, data.leadId)
    assertNotErased(lead)
    assertOpen(lead)
    const [reason] = await tx.select({ id: lostReasons.id }).from(lostReasons).where(and(eq(lostReasons.id, data.reasonId), isNull(lostReasons.archivedAt)))
    if (!reason) throw new CrmError(400, 'bad_reason', 'Choose an active lost reason.')
    const now = new Date()
    await tx.update(leads).set({ status: 'lost', lostReasonId: reason.id, lostNote: data.lostNote, closedAt: now, updatedAt: now }).where(eq(leads.id, lead.id))
    await log(tx, actor, 'lead.lost', lead.id, 'Lead marked lost')
    return result(lead.id)
  })
}
export async function reopenLead(actor: Actor, input: unknown) {
  const institutionId = tenant(actor)
  const { leadId } = leadIdSchema.parse(input)
  return withTenant(institutionId, async tx => {
    const { lead } = await visibleLead(tx, actor, leadId)
    assertNotErased(lead)
    if (!(lead.status === 'lost' || (lead.status === 'won' && lead.partyId === null))) throw new CrmError(409, 'not_open', 'Only a lost or an unconverted won opportunity is reopened.')
    await tx.update(leads).set({ status: 'open', lostReasonId: null, lostNote: null, wonAt: null, closedAt: null, updatedAt: new Date() }).where(eq(leads.id, lead.id))
    await log(tx, actor, 'lead.reopened', lead.id, 'Lead reopened')
    return result(lead.id)
  })
}

// --- reading ----------------------------------------------------------------

export const PIPELINE_SORTS: SortSpec = {
  updated: { dir: 'desc', keys: [{ sql: sql`${leads.updatedAt}`, type: 'timestamptz' }, { sql: sql`${leads.id}`, type: 'uuid' }] },
  close: { dir: 'asc', keys: [{ sql: sql`coalesce(${leads.expectedClose}, 'infinity'::date)`, type: 'date' }, { sql: sql`${leads.id}`, type: 'uuid' }] },
  title: { dir: 'asc', keys: [{ sql: sql`${leads.title}`, type: 'text' }, { sql: sql`${leads.id}`, type: 'uuid' }] },
}
export const pipelinePage = (req: Request, prefix: string) => readPage(req, prefix, PIPELINE_SORTS, 'updated')

const rowColumns = {
  id: leads.id, kind: leads.kind, status: leads.status, title: leads.title, company: leads.company, stageId: leads.stageId, stageName: stages.name,
  ownerId: leads.ownerId, ownerName: users.name, expectedValuePaise: leads.expectedValuePaise, expectedClose: leads.expectedClose, updatedAt: leads.updatedAt,
}
const toRow = <R extends { updatedAt: Date }>(r: R) => ({ ...r, updatedAt: r.updatedAt.toISOString() })

export async function listLeads(actor: Actor, page: PageRequest, filter: { kind?: string; status?: string }) {
  const institutionId = tenant(actor)
  const keys = PIPELINE_SORTS[page.sort]!.keys
  return withTenant(institutionId, async tx => {
    const owners = await ownersOf(tx, actor)
    const visible = and(
      owners === null ? undefined : inArray(leads.ownerId, owners),
      filter.kind ? eq(leads.kind, filter.kind) : undefined,
      filter.status ? eq(leads.status, filter.status) : undefined,
      searchAny(page.q, [sql`${leads.title}`, sql`${leads.company}`, sql`${leads.contactName}`, sql`${leads.email}`]),
    )
    const rows = await tx.select({ ...rowColumns, _cursor: cursorColumn(keys) }).from(leads)
      .leftJoin(stages, eq(stages.id, leads.stageId)).innerJoin(users, eq(users.id, leads.ownerId))
      .where(and(visible, keyset(keys, page))).orderBy(...orderKeys(keys, page.dir)).limit(page.limit + 1)
    const [counted] = await tx.select({ total: sql<number>`count(*)::int` }).from(leads).where(visible)
    return finishPage(rows.map(r => ({ ...r, ...toRow(r) })), page, counted!.total)
  })
}
/** Open opportunities for the kanban board. */
export async function openBoard(actor: Actor) {
  const institutionId = tenant(actor)
  return withTenant(institutionId, async tx => {
    const owners = await ownersOf(tx, actor)
    const rows = await tx.select(rowColumns).from(leads).leftJoin(stages, eq(stages.id, leads.stageId)).innerJoin(users, eq(users.id, leads.ownerId))
      .where(and(eq(leads.kind, 'opportunity'), eq(leads.status, 'open'), owners === null ? undefined : inArray(leads.ownerId, owners)))
      .orderBy(desc(leads.updatedAt)).limit(300) // ponytail: 300 cards; page the board if a team carries more open deals
    return rows.map(toRow)
  })
}
export async function leadDetail(actor: Actor, id: string) {
  const institutionId = tenant(actor)
  return withTenant(institutionId, async tx => {
    const owners = await ownersOf(tx, actor)
    const parsed = z.uuid().safeParse(id)
    const [lead] = parsed.success ? await tx.select().from(leads).where(eq(leads.id, id)) : []
    if (!lead || (owners !== null && !owners.includes(lead.ownerId))) throw new CrmError(404, 'not_found', 'No such lead in your pipeline.')
    const [stage] = lead.stageId ? await tx.select({ name: stages.name }).from(stages).where(eq(stages.id, lead.stageId)) : []
    const [owner] = await tx.select({ name: users.name }).from(users).where(eq(users.id, lead.ownerId))
    const [reason] = lead.lostReasonId ? await tx.select({ name: lostReasons.name }).from(lostReasons).where(eq(lostReasons.id, lead.lostReasonId)) : []
    const acts = await tx.select({ id: activities.id, kind: activities.kind, summary: activities.summary, dueAt: activities.dueAt, doneAt: activities.doneAt, assigneeId: activities.assigneeId }).from(activities).where(eq(activities.leadId, lead.id)).orderBy(asc(activities.dueAt))
    return { lead, stageName: stage?.name ?? null, ownerName: owner?.name ?? '', lostReason: reason?.name ?? null, activities: acts }
  })
}

// --- erasure (decision 406) -------------------------------------------------

export const eraseSchema = z.object({ leadId: z.uuid(), reason: z.string().trim().min(10).max(300) })
/** DPDP erasure for a data principal who is not a user: clears the contact, keeps the record that a lead existed. */
export async function eraseLead(actor: Actor, input: unknown) {
  const institutionId = tenant(actor, ADMIN)
  const data = eraseSchema.parse(input)
  return withTenant(institutionId, async tx => {
    const { lead } = await visibleLead(tx, actor, data.leadId)
    if (lead.erasedAt) throw new CrmError(409, 'already_erased', "This lead's contact data was already erased.")
    await tx.update(leads).set({ title: '[erased]', company: null, contactName: null, email: null, phone: null, gstin: null, notes: null, lostNote: null, erasedAt: new Date(), updatedAt: new Date() }).where(eq(leads.id, lead.id))
    await tx.update(activities).set({ summary: '[erased]' }).where(eq(activities.leadId, lead.id))
    await log(tx, actor, 'lead.erased', lead.id, data.reason)
    return result(lead.id, 'Contact data erased.')
  })
}
