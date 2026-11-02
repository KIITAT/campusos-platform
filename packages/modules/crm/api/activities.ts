import * as z from 'zod'
import { eq, sql } from 'drizzle-orm'
import { withTenant } from '@campusos/db'
import { notify } from '@campusos/module-notices/api'
import { activities } from '../schema'
import { CrmError, log, tenant, type Actor, type Tx } from './core'
import { assertNotErased, assertOpen, visibleLead } from './leads'

const REMIND = { none: null, '15m': '15 minutes', '1h': '1 hour', '1d': '1 day' } as const
export const activitySchema = z.object({
  leadId: z.uuid(), kind: z.enum(['call', 'meeting', 'task']), summary: z.string().trim().min(1).max(500),
  dueAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/), remindBefore: z.enum(['none', '15m', '1h', '1d']).default('15m'),
  assigneeId: z.preprocess(v => (v === '' ? undefined : v), z.string().min(1).optional()),
})
export const activityDoneSchema = z.object({ activityId: z.uuid() })

export async function createActivity(actor: Actor, input: unknown) {
  const institutionId = tenant(actor)
  const data = activitySchema.parse(input)
  return withTenant(institutionId, async tx => {
    const { lead } = await visibleLead(tx, actor, data.leadId)
    assertNotErased(lead)
    assertOpen(lead)
    const assigneeId = data.assigneeId ?? actor.id
    if (assigneeId !== actor.id && assigneeId !== lead.ownerId) throw new CrmError(400, 'bad_assignee', "Choose yourself or the lead's owner.")
    const before = REMIND[data.remindBefore]
    const rows = (await tx.execute(sql`
      insert into crm_activities (institution_id, lead_id, kind, summary, due_at, remind_at, assignee_id, created_by)
      select ${institutionId}::uuid, ${lead.id}::uuid, ${data.kind}, ${data.summary}, d, ${before ? sql`d - ${before}::interval` : sql`null`}, ${assigneeId}, ${actor.id}
        from (select (${data.dueAt}::timestamp at time zone 'Asia/Kolkata') as d) t
      returning id`)).rows as { id: string }[]
    await tx.execute(sql`update crm_leads set updated_at = now() where id = ${lead.id}`)
    await log(tx, actor, 'activity.created', rows[0]!.id, 'Sales activity scheduled')
    return { id: rows[0]!.id, notice: 'Saved.', next: '/m/crm/lead?id=' + lead.id }
  })
}
export async function completeActivity(actor: Actor, input: unknown) {
  const institutionId = tenant(actor)
  const data = activityDoneSchema.parse(input)
  return withTenant(institutionId, async tx => {
    const [activity] = await tx.select().from(activities).where(eq(activities.id, data.activityId)).for('update')
    if (!activity) throw new CrmError(404, 'not_found', 'No such lead in your pipeline.')
    await visibleLead(tx, actor, activity.leadId)
    if (activity.doneAt) throw new CrmError(409, 'already_done', 'This activity is already done.')
    await tx.update(activities).set({ doneAt: new Date() }).where(eq(activities.id, activity.id))
    await tx.execute(sql`update crm_leads set updated_at = now() where id = ${activity.leadId}`)
    await log(tx, actor, 'activity.done', activity.id, 'Sales activity completed')
    return { id: activity.id, notice: 'Saved.', next: '/m/crm/lead?id=' + activity.leadId }
  })
}

const KIND_LABEL: Record<string, string> = { call: 'A call', meeting: 'A meeting', task: 'A task' }
/** D400: no lead title, contact or summary; a notification outlives the lead's erasure. */
export function reminderText(kind: string, at: Date): string {
  const zone = { timeZone: 'Asia/Kolkata' }
  const time = new Intl.DateTimeFormat('en-IN', { ...zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at)
  const day = new Intl.DateTimeFormat('en-IN', { ...zone, day: 'numeric', month: 'short', year: 'numeric' }).format(at)
  return `${KIND_LABEL[kind] ?? 'An activity'} is due at ${time} on ${day}.`
}
/** Sends each due reminder once, to the assignee, in the caller's transaction. Returns how many were due. */
export async function sendDueReminders(tx: Tx, institutionId: string): Promise<number> {
  const due = (await tx.execute(sql`
    select a.id, a.lead_id, a.assignee_id, a.kind, a.due_at
      from crm_activities a join crm_leads l on l.institution_id = a.institution_id and l.id = a.lead_id
     where a.remind_at <= now() and a.reminded_at is null and a.done_at is null
       and l.status = 'open' and l.erased_at is null
     order by a.remind_at limit 500
     for update of a skip locked`)).rows as { id: string; lead_id: string; assignee_id: string; kind: string; due_at: string }[]
  for (const a of due) {
    await notify(tx, institutionId, { userIds: [a.assignee_id], moduleId: 'crm', title: 'Sales activity due', body: reminderText(a.kind, new Date(a.due_at)), link: `/m/crm/lead?id=${a.lead_id}` })
    await tx.execute(sql`update crm_activities set reminded_at = now() where id = ${a.id}`)
  }
  return due.length
}
