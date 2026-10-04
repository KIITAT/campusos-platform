import * as z from 'zod'
import { and, asc, eq } from 'drizzle-orm'
import { users, withTenant } from '@campusos/db'
import { assignments, routes, stops, vehicles } from '../schema'
import { ADMIN, DomainError, log, person, tenant, type Actor } from './core'
export * from './core'

export const vehicleSchema = z.object({ registration: z.string().trim().min(2).max(40).transform(value => value.toUpperCase()), capacity: z.coerce.number().int().min(1).max(200) })
export const routeSchema = z.object({ name: z.string().trim().min(2).max(120), vehicleId: z.uuid() })
export const stopSchema = z.object({ routeId: z.uuid(), name: z.string().trim().min(2).max(120), position: z.coerce.number().int().min(1).max(1000) })
export const assignSchema = z.object({ routeId: z.uuid(), stopId: z.uuid(), studentId: z.string().min(1) })
export const releaseSchema = z.object({ assignmentId: z.uuid(), reason: z.string().trim().min(5).max(500) })
export const listVehicles = (actor: Actor) => withTenant(tenant(actor, ADMIN), transaction => transaction.select().from(vehicles).orderBy(asc(vehicles.registration)))
export const listRoutes = (actor: Actor) => withTenant(tenant(actor), transaction => transaction.select({ id: routes.id, name: routes.name, vehicleId: routes.vehicleId, registration: vehicles.registration, capacity: vehicles.capacity }).from(routes).innerJoin(vehicles, eq(vehicles.id, routes.vehicleId)).orderBy(asc(routes.name)))
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
    return row
  })
}
export async function release(actor: Actor, input: unknown) {
  const institutionId = tenant(actor, ADMIN)
  const data = releaseSchema.parse(input)
  return withTenant(institutionId, async transaction => {
    const [current] = await transaction.select().from(assignments).where(eq(assignments.id, data.assignmentId))
    if (!current) throw new DomainError(404, 'not_found', 'No assignment in this institution.')
    await transaction.select().from(routes).where(eq(routes.id, current.routeId)).for('update')
    const [row] = await transaction.update(assignments).set({ status: 'released', releaseReason: data.reason, releasedAt: new Date() }).where(and(eq(assignments.id, current.id), eq(assignments.status, 'active'))).returning()
    if (!row) throw new DomainError(409, 'already_released', 'This assignment has already been released.')
    await log(transaction, actor, 'student.released', row.id, data.reason)
    return row
  })
}
