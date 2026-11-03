import * as z from 'zod'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { withTenant } from '@campusos/db'
import { activities, activityScripts, leads, notes } from '../schema'
import { ADMIN, CrmError, log, tenant, trail, type Actor, type Tx } from './core'
import { KINDS } from './activities'
import { assertNotErased, assertOpen, insertLead, leadSchema, result, visibleLead } from './leads'
import { ensureDefaults, ownersOf } from './settings'

// --- contact history (Odoo's chatter) ---------------------------------------

export const noteSchema = z.object({ leadId: z.uuid(), body: z.string().trim().min(1).max(4000) })
/** A note on any lead the actor can see, closed ones too: the history is where a loss is explained. */
export async function addNote(actor: Actor, input: unknown) {
  const institutionId = tenant(actor)
  const data = noteSchema.parse(input)
  return withTenant(institutionId, async tx => {
    const { lead } = await visibleLead(tx, actor, data.leadId)
    assertNotErased(lead)
    const [row] = await tx.insert(notes).values({ institutionId, leadId: lead.id, kind: 'note', body: data.body, authorId: actor.id }).returning({ id: notes.id })
    await log(tx, actor, 'note.added', row!.id, 'Note added to a lead')
    return result(lead.id)
  })
}

// --- sales script: the next activity ----------------------------------------

export const scriptSchema = z.object({
  afterKind: z.enum(KINDS), nextKind: z.enum(KINDS), afterDays: z.coerce.number().int().min(0).max(90).default(1), summary: z.string().trim().min(1).max(500),
})
export const scriptDeleteSchema = z.object({ scriptId: z.uuid() })
/** One script per kind: finishing that kind of activity plans the next. Saving again replaces it. */
export async function setScript(actor: Actor, input: unknown) {
  const institutionId = tenant(actor, ADMIN)
  const data = scriptSchema.parse(input)
  return withTenant(institutionId, async tx => {
    const [row] = await tx.insert(activityScripts).values({ institutionId, ...data }).onConflictDoUpdate({
      target: [activityScripts.institutionId, activityScripts.afterKind], set: { nextKind: data.nextKind, afterDays: data.afterDays, summary: data.summary },
    }).returning({ id: activityScripts.id })
    await log(tx, actor, 'script.saved', row!.id, 'Next-activity script saved')
    return { id: row!.id, notice: 'Saved.' }
  })
}
export async function deleteScript(actor: Actor, input: unknown) {
  const institutionId = tenant(actor, ADMIN)
  const data = scriptDeleteSchema.parse(input)
  return withTenant(institutionId, async tx => {
    const [row] = await tx.delete(activityScripts).where(eq(activityScripts.id, data.scriptId)).returning({ id: activityScripts.id })
    if (!row) throw new CrmError(404, 'not_found', 'No such script.')
    await log(tx, actor, 'script.deleted', row.id, 'Next-activity script removed')
    return { id: row.id, notice: 'Saved.' }
  })
}

// --- capture, import and round-robin assignment ------------------------------

export const captureSchema = leadSchema.omit({ kind: true, ownerId: true, itemId: true }).extend({ teamId: z.preprocess(v => (v === '' ? undefined : v), z.uuid().optional()) })
export const importSchema = z.object({
  rows: z.array(z.unknown()).min(1).max(500).optional(), csv: z.string().max(400_000).optional(), teamId: z.preprocess(v => (v === '' ? undefined : v), z.uuid().optional()),
}).refine(v => (v.rows === undefined) !== (v.csv === undefined), 'Send rows or csv, not both.')

/** Header row, then one lead a line; commas, double quotes and quoted line breaks as spreadsheets write them. */
export function parseCsv(text: string): Record<string, string>[] {
  const table: string[][] = []
  let row: string[] = [], cell = '', quoted = false
  const end = () => { row.push(cell); cell = ''; if (row.some(c => c.trim() !== '')) table.push(row); row = [] }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++ } else if (ch === '"') quoted = false
      else if (ch !== '\r') cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { row.push(cell); cell = '' }
    else if (ch === '\n') end()
    else if (ch !== '\r') cell += ch
  }
  end()
  const [head, ...body] = table
  if (!head) return []
  const keys = head.map(h => h.trim().replace(/[^a-z0-9]+(.)?/gi, (_m, c: string | undefined) => (c ?? '').toUpperCase()).replace(/^./, c => c.toLowerCase()))
  return body.map(cells => Object.fromEntries(keys.map((k, i) => [k, (cells[i] ?? '').trim()])))
}

/**
 * Round robin by load: of the members of the teams that take automatic assignment
 * (one team, if named), the one with the fewest open leads; a tie goes to whoever
 * was given a lead longest ago. No such team means the caller keeps the lead.
 */
export async function nextOwner(tx: Tx, institutionId: string, teamId?: string): Promise<string | null> {
  const rows = (await tx.execute(sql`
    select m.user_id from crm_team_members m
      join crm_teams t on t.institution_id = m.institution_id and t.id = m.team_id
      left join crm_leads l on l.institution_id = m.institution_id and l.owner_id = m.user_id and l.status = 'open'
     where m.institution_id = ${institutionId}::uuid and t.auto_assign ${teamId ? sql`and t.id = ${teamId}::uuid` : sql``}
     group by m.user_id
     order by count(l.id), max(l.created_at) nulls first, m.user_id
     limit 1`)).rows as { user_id: string }[]
  return rows[0]?.user_id ?? null
}
/** A lead from outside (a web form, a mail-to-API bridge): recorded as a lead and given to the next salesperson. */
export async function captureLead(actor: Actor, input: unknown) {
  const institutionId = tenant(actor, ADMIN)
  const { teamId, ...data } = captureSchema.parse(input)
  return withTenant(institutionId, async tx => {
    await ensureDefaults(tx, institutionId)
    const ownerId = (await nextOwner(tx, institutionId, teamId)) ?? actor.id
    const id = await insertLead(tx, actor, institutionId, { ...data, kind: 'lead' }, ownerId)
    return { ...result(id), ownerId }
  })
}
/** Up to 500 rows in one go. A bad row is reported and skipped; it does not stop the rest. */
export async function importLeads(actor: Actor, input: unknown) {
  const institutionId = tenant(actor, ADMIN)
  const parsedInput = importSchema.parse(input)
  const { teamId } = parsedInput
  const rows = parsedInput.rows ?? parseCsv(parsedInput.csv!).slice(0, 501)
  if (!rows.length) throw new CrmError(400, 'empty_import', 'There are no leads to import.')
  if (rows.length > 500) throw new CrmError(400, 'too_many', 'Import at most 500 leads at a time.')
  return withTenant(institutionId, async tx => {
    await ensureDefaults(tx, institutionId)
    const created: string[] = []
    const skipped: { row: number; error: string }[] = []
    for (const [index, raw] of rows.entries()) {
      const parsed = captureSchema.safeParse(raw)
      if (!parsed.success) { skipped.push({ row: index + 1, error: parsed.error.issues[0]?.message ?? 'Not a valid row.' }); continue }
      try {
        // A savepoint per row: a database refusal (a bad amount) must not poison the transaction.
        await tx.transaction(async inner => {
          const ownerId = (await nextOwner(inner, institutionId, teamId)) ?? actor.id
          created.push(await insertLead(inner, actor, institutionId, { ...parsed.data, kind: 'lead' }, ownerId))
        })
      } catch (error) {
        if (!(error instanceof CrmError)) throw error
        skipped.push({ row: index + 1, error: error.message })
      }
    }
    await log(tx, actor, 'lead.imported', institutionId, `Imported ${created.length} leads, skipped ${skipped.length}`)
    return { created: created.length, skipped, notice: `Imported ${created.length}, skipped ${skipped.length}.` }
  })
}

// --- forecast and reports ------------------------------------------------------

const SCOPE = (owners: string[] | null) => (owners === null ? sql`` : sql`and l.owner_id in (${sql.join(owners.map(o => sql`${o}`), sql`, `)})`)

/** Open opportunities by stage and by expected-close month: the total, and the total weighted by each stage's probability. */
export async function forecast(actor: Actor) {
  const institutionId = tenant(actor)
  return withTenant(institutionId, async tx => {
    const owners = await ownersOf(tx, actor)
    const scope = SCOPE(owners)
    const byStage = (await tx.execute(sql`
      select s.id, s.name, s.probability, count(l.id)::int as count, coalesce(sum(l.expected_value_paise), 0)::bigint as total,
             coalesce(sum(l.expected_value_paise * s.probability / 100), 0)::bigint as weighted
        from crm_stages s left join crm_leads l on l.institution_id = s.institution_id and l.stage_id = s.id and l.status = 'open' ${scope}
       where s.archived_at is null group by s.id order by s.seq`)).rows as { id: string; name: string; probability: number; count: number; total: string; weighted: string }[]
    const byMonth = (await tx.execute(sql`
      select coalesce(to_char(l.expected_close, 'YYYY-MM'), 'unscheduled') as month, count(*)::int as count, coalesce(sum(l.expected_value_paise), 0)::bigint as total,
             coalesce(sum(l.expected_value_paise * s.probability / 100), 0)::bigint as weighted
        from crm_leads l join crm_stages s on s.institution_id = l.institution_id and s.id = l.stage_id
       where l.kind = 'opportunity' and l.status = 'open' ${scope}
       group by 1 order by 1`)).rows as { month: string; count: number; total: string; weighted: string }[]
    const n = (v: string) => Number(v)
    const stagesOut = byStage.map(r => ({ stageId: r.id, name: r.name, probability: r.probability, count: r.count, totalPaise: n(r.total), weightedPaise: n(r.weighted) }))
    const monthsOut = byMonth.map(r => ({ month: r.month, count: r.count, totalPaise: n(r.total), weightedPaise: n(r.weighted) }))
    return {
      stages: stagesOut, months: monthsOut,
      totalPaise: stagesOut.reduce((a, r) => a + r.totalPaise, 0), weightedPaise: stagesOut.reduce((a, r) => a + r.weightedPaise, 0),
    }
  })
}

export const reportSchema = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })
/** Team performance: per owner, what is open, what was won and lost in the period, the win rate and the days a win took. Plus why deals were lost. */
export async function report(actor: Actor, input: unknown = {}) {
  const institutionId = tenant(actor)
  const range = reportSchema.parse(input)
  return withTenant(institutionId, async tx => {
    const owners = await ownersOf(tx, actor)
    const scope = SCOPE(owners)
    const from = range.from ?? '0001-01-01', to = range.to ?? '9999-12-31'
    const people = (await tx.execute(sql`
      select l.owner_id, u.name,
             count(*) filter (where l.status = 'open')::int as open_count,
             coalesce(sum(l.expected_value_paise) filter (where l.status = 'open'), 0)::bigint as open_value,
             count(*) filter (where l.status = 'won' and l.closed_at::date between ${from}::date and ${to}::date)::int as won_count,
             coalesce(sum(l.expected_value_paise) filter (where l.status = 'won' and l.closed_at::date between ${from}::date and ${to}::date), 0)::bigint as won_value,
             count(*) filter (where l.status = 'lost' and l.closed_at::date between ${from}::date and ${to}::date)::int as lost_count,
             coalesce(round(avg(extract(epoch from (l.closed_at - l.created_at)) / 86400) filter (where l.status = 'won' and l.closed_at::date between ${from}::date and ${to}::date))::int, 0) as days_to_win
        from crm_leads l join users u on u.id = l.owner_id
       where true ${scope} group by l.owner_id, u.name order by u.name`)).rows as { owner_id: string; name: string; open_count: number; open_value: string; won_count: number; won_value: string; lost_count: number; days_to_win: number }[]
    const lost = (await tx.execute(sql`
      select r.name, count(*)::int as count from crm_leads l join crm_lost_reasons r on r.institution_id = l.institution_id and r.id = l.lost_reason_id
       where l.status = 'lost' and l.closed_at::date between ${from}::date and ${to}::date ${scope} group by r.name order by count(*) desc, r.name`)).rows as { name: string; count: number }[]
    const bySource = (await tx.execute(sql`
      select l.source, count(*)::int as leads, count(*) filter (where l.status = 'won')::int as won from crm_leads l where true ${scope} group by l.source order by l.source`)).rows as { source: string; leads: number; won: number }[]
    const rate = (w: number, l: number) => (w + l === 0 ? null : Math.round((w * 100) / (w + l)))
    const rows = people.map(r => ({ ownerId: r.owner_id, name: r.name, open: r.open_count, openPaise: Number(r.open_value), won: r.won_count, wonPaise: Number(r.won_value), lost: r.lost_count, winRate: rate(r.won_count, r.lost_count), daysToWin: r.days_to_win }))
    const won = rows.reduce((a, r) => a + r.won, 0), lostN = rows.reduce((a, r) => a + r.lost, 0)
    return { owners: rows, lostReasons: lost, sources: bySource, won, lost: lostN, winRate: rate(won, lostN), wonPaise: rows.reduce((a, r) => a + r.wonPaise, 0) }
  })
}

// --- duplicates ----------------------------------------------------------------

const digits = (v: string | null) => (v ?? '').replace(/\D/g, '')
/** Other open leads in the actor's pipeline that share the lead's e-mail, phone or company. */
export async function duplicates(actor: Actor, id: string) {
  const institutionId = tenant(actor)
  return withTenant(institutionId, async tx => {
    const { lead, owners } = await visibleLead(tx, actor, id)
    if (lead.erasedAt) return []
    const email = lead.email?.trim().toLowerCase() || null, phone = digits(lead.phone).slice(-10) || null, company = lead.company?.trim().toLowerCase() || null
    if (!email && !phone && !company) return []
    const rows = (await tx.execute(sql`
      select l.id, l.title, l.company, l.kind, l.status,
             (${email}::text is not null and lower(l.email) = ${email}) as same_email,
             (${phone}::text is not null and right(regexp_replace(coalesce(l.phone, ''), '[^0-9]', '', 'g'), 10) = ${phone}) as same_phone,
             (${company}::text is not null and lower(l.company) = ${company}) as same_company
        from crm_leads l
       where l.id <> ${lead.id}::uuid and l.status = 'open' and l.erased_at is null ${SCOPE(owners)}
         and ((${email}::text is not null and lower(l.email) = ${email}) or (${phone}::text is not null and right(regexp_replace(coalesce(l.phone, ''), '[^0-9]', '', 'g'), 10) = ${phone})
              or (${company}::text is not null and lower(l.company) = ${company}))
       order by l.created_at limit 20`)).rows as { id: string; title: string; company: string | null; kind: string; status: string; same_email: boolean; same_phone: boolean; same_company: boolean }[]
    return rows.map(r => ({ id: r.id, title: r.title, company: r.company, kind: r.kind, matches: [r.same_email && 'e-mail', r.same_phone && 'phone', r.same_company && 'company'].filter(Boolean) as string[] }))
  })
}

export const mergeSchema = z.object({ keepId: z.uuid(), mergeId: z.uuid() })
const FILL = ['company', 'contact_name', 'email', 'phone', 'gstin', 'notes', 'item_id', 'expected_value_paise', 'expected_close'] as const
/** Folds one open lead into another: its activities and history move over, its blank-filled details fill the gaps, and it is removed. */
export async function mergeLeads(actor: Actor, input: unknown) {
  const institutionId = tenant(actor)
  const data = mergeSchema.parse(input)
  if (data.keepId === data.mergeId) throw new CrmError(400, 'same_lead', 'Choose two different leads.')
  return withTenant(institutionId, async tx => {
    const { lead: keep } = await visibleLead(tx, actor, data.keepId)
    const { lead: gone } = await visibleLead(tx, actor, data.mergeId)
    for (const l of [keep, gone]) { assertNotErased(l); assertOpen(l, 'Only open leads are merged.') }
    await tx.update(activities).set({ leadId: keep.id }).where(eq(activities.leadId, gone.id))
    await tx.update(notes).set({ leadId: keep.id }).where(eq(notes.leadId, gone.id))
    await tx.execute(sql`update crm_leads k set ${sql.join(FILL.map(c => sql`${sql.raw(c)} = coalesce(k.${sql.raw(c)}, g.${sql.raw(c)})`), sql`, `)}, updated_at = now()
      from crm_leads g where k.id = ${keep.id}::uuid and g.id = ${gone.id}::uuid`)
    await tx.delete(leads).where(and(eq(leads.id, gone.id), inArray(leads.status, ['open'])))
    await trail(tx, institutionId, keep.id, actor.id, 'Merged with a duplicate lead')
    await log(tx, actor, 'lead.merged', keep.id, 'Duplicate lead merged')
    return result(keep.id, 'Merged.')
  })
}
