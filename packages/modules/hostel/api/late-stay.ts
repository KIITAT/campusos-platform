import { sql } from 'drizzle-orm'
import * as z from 'zod'
import { audit, withTenant } from '@campusos/db'
import { notify } from '@campusos/module-notices/api'
import { HostelError, requireWarden, tenantOf, type Actor } from './operations'
import { addDays, localInstant, localParts, nightOf, zoneIn } from './clock'
import { loadPolicy } from './policy'
import { recipientsFor } from './wardens'

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]

const MODULE = 'hostel'

const clock = z.string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'a time as HH:MM')
const day = z.iso.date()

export const createWindowSchema = z
  .object({
    blockId: z.uuid().nullish(),
    fromOn: day,
    toOn: day,
    untilTime: clock.refine((v) => v >= '21:00', 'between 21:00 and 23:59'),
    reason: z.string().trim().min(5).max(200),
  })
  .refine((d) => d.toOn >= d.fromOn && (Date.parse(d.toOn) - Date.parse(d.fromOn)) / 86_400_000 <= 60, {
    message: 'a window is at most 60 days',
    path: ['toOn'],
  })
  .meta({ id: 'HostelLateWindowCreate' })

export const cancelWindowSchema = z.object({ windowId: z.uuid() }).meta({ id: 'HostelLateWindowCancel' })

export const requestPassSchema = z
  .object({
    untilTime: clock,
    nextDay: z.preprocess((v) => (v === 'false' ? false : v === 'on' || v === 'true' ? true : v), z.boolean()).default(false),
    reason: z.string().trim().min(5).max(200),
  })
  .meta({ id: 'HostelLatePassRequest' })

export const decidePassSchema = z
  .object({ passId: z.uuid(), decision: z.enum(['approved', 'refused']) })
  .meta({ id: 'HostelLatePassDecide' })

/** Administrators, or a hostel_staff user holding a chief-level scope row (D1336). */
async function requireChief(actor: Actor): Promise<string> {
  const tenant = tenantOf(actor)
  if (actor.role === 'institution_admin' || actor.role === 'super_admin') return tenant
  if (actor.role === 'hostel_staff') {
    const ok = await withTenant(tenant, async (tx) =>
      ((await tx.execute(sql`select 1 from hostel_warden_scopes where user_id = ${actor.id} and level = 'chief' limit 1`)).rows.length > 0),
    )
    if (ok) return tenant
  }
  throw new HostelError(403, 'forbidden', 'not permitted')
}

export async function createWindow(actor: Actor, input: unknown) {
  const tenant = await requireChief(actor)
  const d = createWindowSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [row] = (await tx.execute(sql`
      insert into hostel_late_stay_windows (institution_id, block_id, from_on, to_on, until_time, reason, created_by)
      values (${tenant}, ${d.blockId ?? null}, ${d.fromOn}::date, ${d.toOn}::date, ${d.untilTime}::time, ${d.reason}, ${actor.id})
      returning id, block_id as "blockId", from_on::text as "fromOn", to_on::text as "toOn", until_time::text as "untilTime", reason`)).rows as { id: string }[]
    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: 'hostel.late_window_created',
      entity: 'hostel_late_stay_windows',
      entityId: row!.id,
      reason: d.reason,
      detail: { blockId: d.blockId ?? null, fromOn: d.fromOn, toOn: d.toOn, untilTime: d.untilTime },
    })
    return row!
  })
}

export async function cancelWindow(actor: Actor, input: unknown) {
  const tenant = await requireChief(actor)
  const d = cancelWindowSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const rows = (await tx.execute(sql`update hostel_late_stay_windows set cancelled_at = now() where id = ${d.windowId} and cancelled_at is null returning id`)).rows
    if (rows.length === 0) throw new HostelError(404, 'no_such_window', 'no such window')
    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: 'hostel.late_window_cancelled',
      entity: 'hostel_late_stay_windows',
      entityId: d.windowId,
      reason: 'window cancelled',
    })
    return { cancelled: true }
  })
}

/** Windows still in force or yet to come, with the block's code (all blocks: null). */
export async function listWindows(actor: Actor) {
  const tenant = requireWarden(actor)
  return withTenant(tenant, async (tx) =>
    (await tx.execute(sql`
      select w.id, b.code as "blockCode", w.from_on::text as "fromOn", w.to_on::text as "toOn",
             w.until_time::text as "untilTime", w.reason, w.cancelled_at as "cancelledAt"
        from hostel_late_stay_windows w left join hostel_blocks b on b.id = w.block_id
       order by w.from_on desc, w.created_at desc limit 100`)).rows,
  )
}

/** The curfew of one block on a night: its own or the policy's, raised by a window, never lowered (D1321). */
async function curfewOf(tx: Tx, tenant: string, blockId: string, night: string, zone: string): Promise<Date> {
  const p = await loadPolicy(tx, tenant)
  const [r] = (await tx.execute(sql`
    select ((${night}::date + greatest(coalesce(b.curfew_time, ${p.curfewTime}::time),
              coalesce((select max(w.until_time) from hostel_late_stay_windows w
                         where w.cancelled_at is null and ${night}::date between w.from_on and w.to_on
                           and (w.block_id is null or w.block_id = b.id)), '00:00'::time))) at time zone ${zone}) as t
      from hostel_blocks b where b.id = ${blockId}`)).rows as { t: Date | string }[]
  return new Date(r!.t)
}

/** A resident asks for tonight's pass (D1337). Nothing is auto-approved. */
export async function requestPass(actor: Actor, input: unknown, now = new Date()) {
  const tenant = tenantOf(actor)
  if (actor.role !== 'student') throw new HostelError(403, 'forbidden', 'not permitted')
  const d = requestPassSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [home] = (await tx.execute(sql`
      select r.block_id from hostel_allocations a join hostel_rooms r on r.id = a.room_id
       where a.student_id = ${actor.id} and a.vacated_on is null`)).rows as { block_id: string }[]
    if (!home) throw new HostelError(400, 'not_housed', 'you do not have a bed in the hostel')

    const zone = await zoneIn(tx, tenant)
    const night = await nightOf(tx, now, zone)
    const p = await loadPolicy(tx, tenant)
    const untilAt = await localInstant(tx, d.nextDay ? await addDays(tx, night, 1) : night, d.untilTime, zone)
    const latest = await localInstant(tx, await addDays(tx, night, 1), p.latePassLatestTime, zone)
    if (untilAt.getTime() > latest.getTime()) throw new HostelError(409, 'late_pass_too_late', 'that time is past the latest allowed')
    if (untilAt.getTime() <= (await curfewOf(tx, tenant, home.block_id, night, zone)).getTime()) {
      throw new HostelError(400, 'pass_not_later', "the pass must end after tonight's curfew")
    }
    const open = (await tx.execute(sql`select 1 from hostel_late_passes where student_id = ${actor.id} and night = ${night}::date and status in ('requested', 'approved')`)).rows
    if (open.length > 0) throw new HostelError(409, 'late_pass_exists', 'a late pass is already open for tonight')

    const [row] = (await tx.execute(sql`
      insert into hostel_late_passes (institution_id, student_id, night, until_at, reason, requested_by)
      values (${tenant}, ${actor.id}, ${night}::date, ${untilAt.toISOString()}::timestamptz, ${d.reason}, ${actor.id})
      on conflict (student_id, night) where status in ('requested', 'approved') do nothing
      returning id, night::text as night, until_at as "untilAt", status`)).rows as { id: string; status: string }[]
    if (!row) throw new HostelError(409, 'late_pass_exists', 'a late pass is already open for tonight')
    return row
  })
}

/** A warden of the resident's block or higher approves or refuses (D1337); until 22b a hostel_staff user with no scope may decide. */
export async function decidePass(actor: Actor, input: unknown) {
  const tenant = requireWarden(actor)
  const d = decidePassSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [pass] = (await tx.execute(sql`select id, student_id, status, until_at from hostel_late_passes where id = ${d.passId} for update`)).rows as {
      id: string
      student_id: string
      status: string
      until_at: Date | string
    }[]
    if (!pass) throw new HostelError(404, 'no_such_pass', 'no such pass')

    if (actor.role === 'hostel_staff') {
      const own = (await tx.execute(sql`select 1 from hostel_warden_scopes where user_id = ${actor.id} limit 1`)).rows.length > 0
      if (own) {
        const team = new Set<string>()
        for (const level of ['floor', 'block', 'chief'] as const) (await recipientsFor(tx, tenant, pass.student_id, level)).userIds.forEach((u) => team.add(u))
        if (!team.has(actor.id)) throw new HostelError(403, 'forbidden', 'not permitted')
      }
    }
    if (pass.status !== 'requested') throw new HostelError(409, 'pass_decided', 'this pass is already decided')

    await tx.execute(sql`update hostel_late_passes set status = ${d.decision}, decided_by = ${actor.id}, decided_at = now() where id = ${d.passId}`)
    const zone = await zoneIn(tx, tenant)
    const hhmm = (await localParts(tx, new Date(pass.until_at), zone)).time.slice(0, 5)
    await notify(tx, tenant, {
      userIds: [pass.student_id],
      moduleId: 'hostel',
      title: `Late-stay pass ${d.decision}`,
      body: `Your pass for tonight until ${hhmm} was ${d.decision}.`,
      link: '/m/hostel/me',
    })
    await tx.execute(sql`
      insert into hostel_presence_log (institution_id, student_id, at, kind, source, detail)
      values (${tenant}, ${pass.student_id}, now(), 'late_pass_decided', 'hostel', ${JSON.stringify({ passId: d.passId, decision: d.decision })}::jsonb)`)
    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: 'hostel.late_pass_decided',
      entity: 'hostel_late_passes',
      entityId: d.passId,
      reason: `late-stay pass ${d.decision}`,
      detail: { studentId: pass.student_id, decision: d.decision },
    })
    return { id: d.passId, status: d.decision }
  })
}

/** Passes for tonight's and later nights (wardens), or a student's own recent ones. */
export async function listPasses(actor: Actor) {
  const tenant = tenantOf(actor)
  const own = actor.role === 'student'
  if (!own) requireWarden(actor)
  return withTenant(tenant, async (tx) =>
    (await tx.execute(sql`
      select p.id, p.student_id as "studentId", u.name, p.night::text as night, p.until_at as "untilAt", p.reason, p.status
        from hostel_late_passes p join users u on u.id = p.student_id
       where ${own ? sql`p.student_id = ${actor.id}` : sql`p.night >= current_date - 2`}
       order by p.night desc, p.created_at desc limit 100`)).rows,
  )
}

