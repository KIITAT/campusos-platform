import * as z from 'zod'
import { and, asc, eq, sql } from 'drizzle-orm'
import { users, withTenant } from '@campusos/db'
import { formatPaise, parseRupeesToPaise } from '@campusos/money'
import { moduleEnabled } from '@campusos/module-framework'
import { chargeStayWithin, endStayWithin, termChoicesWithin, termOnWithin, type Stay } from '@campusos/module-fees/api'
import { manifest as feesManifest } from '@campusos/module-fees/manifest'
import { localToday } from '@campusos/module-finance/api'
import { manifest } from '../manifest'
import { assignments, routes, stops, vehicles } from '../schema'
import { ADMIN, DomainError, log, person, tenant, type Actor } from './core'
export * from './core'

export const vehicleSchema = z.object({ registration: z.string().trim().min(2).max(40).transform(value => value.toUpperCase()), capacity: z.coerce.number().int().min(1).max(200) })
export const routeSchema = z.object({ name: z.string().trim().min(2).max(120), vehicleId: z.uuid() })
export const stopSchema = z.object({ routeId: z.uuid(), name: z.string().trim().min(2).max(120), position: z.coerce.number().int().min(1).max(1000) })
export const assignSchema = z.object({ routeId: z.uuid(), stopId: z.uuid(), studentId: z.string().min(1) })
export const releaseSchema = z.object({ assignmentId: z.uuid(), reason: z.string().trim().min(5).max(500) })
/** The fee per seat per term, as typed in rupees; empty clears it (decision 578). */
export const routeFeeSchema = z.object({ routeId: z.uuid(), termFee: z.string().trim().max(20), reason: z.string().trim().min(5).max(500) })
export const chargeTermSchema = z.object({ termId: z.uuid() })

/** Whether seats are charged through the student's fee account here. */
const feesOn = (institutionId: string) => moduleEnabled([manifest, feesManifest], 'fees', institutionId)
type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]
/** A moment as a date in the institution's zone (finance's setting; fees needs finance). */
const localDay = async (tx: Tx, at: Date) =>
  String(((await tx.execute(sql`select (${at.toISOString()}::timestamptz at time zone coalesce((select time_zone from finance_settings), 'Asia/Kolkata'))::date::text as d`)).rows[0] as { d: string }).d)
/** One assignment, as a stay the fee account can charge (ACC-28). */
const stayOf = (a: { id: string; studentId: string }, route: { name: string; termFeePaise: number }, from: string, until: string | null): Stay => ({
  sourceModule: 'transport', stayId: a.id, studentId: a.studentId, label: `Transport ${route.name}`, termFeePaise: route.termFeePaise, from, until,
})
const invoicedNotice = (codes: string[]) => codes.length ? ` Already invoiced for ${codes.join(', ')}: grant a waiver in Fees for the days not used.` : ''
export const listVehicles = (actor: Actor) => withTenant(tenant(actor, ADMIN), transaction => transaction.select().from(vehicles).orderBy(asc(vehicles.registration)))
export const listRoutes = (actor: Actor) => withTenant(tenant(actor), transaction => transaction.select({ id: routes.id, name: routes.name, vehicleId: routes.vehicleId, registration: vehicles.registration, capacity: vehicles.capacity, termFeePaise: routes.termFeePaise }).from(routes).innerJoin(vehicles, eq(vehicles.id, routes.vehicleId)).orderBy(asc(routes.name)))
export const listStops = (actor: Actor) => withTenant(tenant(actor), transaction => transaction.select().from(stops).orderBy(asc(stops.position)))
export const listAssignments = (actor: Actor) => withTenant(tenant(actor), transaction => transaction.select({ id: assignments.id, studentId: assignments.studentId, student: users.name, route: routes.name, stop: stops.name, status: assignments.status, releaseReason: assignments.releaseReason }).from(assignments).innerJoin(routes, eq(routes.id, assignments.routeId)).innerJoin(stops, eq(stops.id, assignments.stopId)).innerJoin(users, eq(users.id, assignments.studentId)).where(ADMIN.includes(actor.role) ? undefined : eq(assignments.studentId, actor.id)).limit(1000))
export async function addVehicle(actor: Actor, input: unknown) {
  const institutionId = tenant(actor, ADMIN)
  const data = vehicleSchema.parse(input)
  return withTenant(institutionId, async transaction => {
    const [row] = await transaction.insert(vehicles).values({ institutionId, ...data }).onConflictDoNothing().returning()
    if (!row) throw new DomainError(409, 'registration_exists', 'A vehicle already has that registration.')
    await log(transaction, actor, 'vehicle.created', row.id, 'Vehicle registered for campus transport')
    return row
  })
}
export async function addRoute(actor: Actor, input: unknown) {
  const institutionId = tenant(actor, ADMIN)
  const data = routeSchema.parse(input)
  return withTenant(institutionId, async transaction => {
    const [vehicle] = await transaction.select().from(vehicles).where(eq(vehicles.id, data.vehicleId)).for('update')
    if (!vehicle) throw new DomainError(404, 'not_found', 'No vehicle in this institution.')
    const [row] = await transaction.insert(routes).values({ institutionId, ...data }).onConflictDoNothing().returning()
    if (!row) throw new DomainError(409, 'vehicle_assigned', 'A vehicle can serve one route; choose another vehicle.')
    await log(transaction, actor, 'route.created', row.id, 'Transport route created')
    return row
  })
}
export async function addStop(actor: Actor, input: unknown) {
  const institutionId = tenant(actor, ADMIN)
  const data = stopSchema.parse(input)
  return withTenant(institutionId, async transaction => {
    const [route] = await transaction.select().from(routes).where(eq(routes.id, data.routeId)).for('update')
    if (!route) throw new DomainError(404, 'not_found', 'No route in this institution.')
    const [row] = await transaction.insert(stops).values({ institutionId, ...data }).onConflictDoNothing().returning()
    if (!row) throw new DomainError(409, 'stop_position', 'Another stop occupies that position.')
    await log(transaction, actor, 'stop.created', row.id, 'Stop added to route')
    return row
  })
}
export async function assign(actor: Actor, input: unknown) {
  const institutionId = tenant(actor, ADMIN)
  const data = assignSchema.parse(input)
  const billed = await feesOn(institutionId)
  return withTenant(institutionId, async transaction => {
    const [route] = await transaction.select().from(routes).where(eq(routes.id, data.routeId)).for('update')
    if (!route) throw new DomainError(404, 'not_found', 'No route in this institution.')
    const [vehicle] = await transaction.select().from(vehicles).where(eq(vehicles.id, route.vehicleId))
    const [stop] = await transaction.select().from(stops).where(and(eq(stops.id, data.stopId), eq(stops.routeId, route.id)))
    if (!stop) throw new DomainError(404, 'wrong_stop', 'The stop must belong to the chosen route.')
    await person(transaction, data.studentId, 'student')
    const taken = await transaction.select({ id: assignments.id }).from(assignments).where(and(eq(assignments.routeId, route.id), eq(assignments.status, 'active')))
    if (taken.length >= vehicle!.capacity) throw new DomainError(409, 'route_full', 'This route has no seats available.')
    const [row] = await transaction.insert(assignments).values({ institutionId, ...data }).onConflictDoNothing().returning()
    if (!row) throw new DomainError(409, 'already_assigned', 'Release the student’s existing assignment before assigning another route.')
    await log(transaction, actor, 'student.assigned', row.id, 'Student allocated a transport seat')
    // The seat and its fee land together or not at all (ACC-28, decision 578).
    if (billed && route.termFeePaise) {
      const from = await localToday(transaction, institutionId)
      const term = await termOnWithin(transaction, from)
      if (term) await chargeStayWithin(transaction, institutionId, actor.id, stayOf(row, { name: route.name, termFeePaise: route.termFeePaise }, from, null), term.id)
    }
    return row
  })
}
export async function release(actor: Actor, input: unknown) {
  const institutionId = tenant(actor, ADMIN)
  const data = releaseSchema.parse(input)
  const billed = await feesOn(institutionId)
  return withTenant(institutionId, async transaction => {
    const [current] = await transaction.select().from(assignments).where(eq(assignments.id, data.assignmentId))
    if (!current) throw new DomainError(404, 'not_found', 'No assignment in this institution.')
    const [route] = await transaction.select().from(routes).where(eq(routes.id, current.routeId)).for('update')
    const [row] = await transaction.update(assignments).set({ status: 'released', releaseReason: data.reason, releasedAt: new Date() }).where(and(eq(assignments.id, current.id), eq(assignments.status, 'active'))).returning()
    if (!row) throw new DomainError(409, 'already_released', 'This assignment has already been released.')
    await log(transaction, actor, 'student.released', row.id, data.reason)
    // Charges not yet invoiced shrink to the days used (ACC-28, decision 575).
    let invoiced: string[] = []
    // Each at the fee it was raised at, so a changed or cleared fee does not matter.
    if (billed) {
      const stay = stayOf(row, { name: route!.name, termFeePaise: route!.termFeePaise ?? 0 }, await localDay(transaction, row.createdAt), null)
      invoiced = (await endStayWithin(transaction, institutionId, actor.id, { ...stay, until: await localDay(transaction, row.releasedAt!) })).invoiced
    }
    return { ...row, invoiced, notice: `Released.${invoicedNotice(invoiced)}` }
  })
}

/** The fee per seat per term on a route; administrators only, audited with a reason. */
export async function setRouteFee(actor: Actor, input: unknown) {
  const institutionId = tenant(actor, ADMIN)
  const data = routeFeeSchema.parse(input)
  const termFeePaise = data.termFee === '' ? null : parseRupeesToPaise(data.termFee)
  if (data.termFee !== '' && (termFeePaise === null || termFeePaise <= 0)) throw new DomainError(400, 'bad_amount', 'Enter the fee in rupees, more than nothing, or leave it empty.')
  return withTenant(institutionId, async transaction => {
    const [row] = await transaction.update(routes).set({ termFeePaise }).where(eq(routes.id, data.routeId)).returning()
    if (!row) throw new DomainError(404, 'not_found', 'No route in this institution.')
    await log(transaction, actor, 'route.fee_set', row.id, data.reason)
    return { ...row, notice: termFeePaise === null ? 'This route is no longer charged.' : `Fee set: ${formatPaise(termFeePaise)} a term.` }
  })
}

/** Whether the fee forms apply here, and the terms they bill. */
export async function feeChoices(actor: Actor) {
  const institutionId = tenant(actor, ADMIN)
  if (!(await feesOn(institutionId))) return { on: false, terms: [] as { value: string; label: string }[] }
  return { on: true, terms: await withTenant(institutionId, transaction => termChoicesWithin(transaction)) }
}

/**
 * Charge every rider of a term who has no charge for it yet. Safe to repeat;
 * two runs of one term take turns.
 */
export async function chargeTerm(actor: Actor, input: unknown) {
  const institutionId = tenant(actor, ADMIN)
  const data = chargeTermSchema.parse(input)
  if (!(await feesOn(institutionId))) throw new DomainError(409, 'fees_not_enabled', 'Transport charges need the Fees module.')
  return withTenant(institutionId, async transaction => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'transport.charge:' + data.termId}, 0))`)
    const [term] = (await transaction.execute(sql`select id, code, starts_on::text as starts_on, ends_on::text as ends_on from academic_terms where id = ${data.termId}`)).rows as { id: string; code: string; starts_on: string; ends_on: string }[]
    if (!term) throw new DomainError(404, 'not_found', 'No such term.')
    const zone = sql`coalesce((select time_zone from finance_settings), 'Asia/Kolkata')`
    const riders = (await transaction.execute(sql`
      select a.id, a.student_id, r.name, r.term_fee_paise::bigint as fee,
             (a.created_at at time zone ${zone})::date::text as from_day,
             (a.released_at at time zone ${zone})::date::text as until_day
        from transport_assignments a join transport_routes r on r.id = a.route_id
       where r.term_fee_paise is not null
         and (a.created_at at time zone ${zone})::date <= ${term.ends_on}::date
         and (a.released_at is null or (a.released_at at time zone ${zone})::date > ${term.starts_on}::date)`)).rows as { id: string; student_id: string; name: string; fee: string; from_day: string; until_day: string | null }[]
    let charged = 0
    let alreadyCharged = 0
    let amountPaise = 0
    for (const r of riders) {
      const out = await chargeStayWithin(transaction, institutionId, actor.id, stayOf({ id: r.id, studentId: r.student_id }, { name: r.name, termFeePaise: Number(r.fee) }, r.from_day, r.until_day), term.id)
      if (out?.existing) alreadyCharged++
      else if (out) { charged++; amountPaise += out.amountPaise }
    }
    await log(transaction, actor, 'term.charged', term.id, `Charged ${charged} riders for ${term.code}`)
    return { termCode: term.code, charged, alreadyCharged, amountPaise, notice: `Charged ${charged} riders ${formatPaise(amountPaise)} for ${term.code}. ${alreadyCharged} already had their charge. Billed on the next invoice.` }
  })
}
