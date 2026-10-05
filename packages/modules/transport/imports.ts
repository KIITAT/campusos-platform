import { and, eq, sql } from 'drizzle-orm'
import { users, withTenant } from '@campusos/db'
import type { ImportSpec, PluginActor } from '@campusos/module-framework'
import { assignments, routes, stops, vehicles } from './schema'
import { addRoute, addStop, addVehicle, assign } from './api'

/**
 * The fleet, its routes and who rides where, from the transport office's
 * sheets. A seat is only given on a route with one free, and a student holds
 * one seat at a time.
 */

const ADMIN = ['institution_admin', 'super_admin'] as const
const tenantOf = (actor: PluginActor) => actor.institutionId!
const plate = (v: string) => v.trim().toUpperCase()

const vehicleByRegistration = async (actor: PluginActor, registration: string) => {
  const [row] = await withTenant(tenantOf(actor), (tx) => tx.select({ id: vehicles.id }).from(vehicles).where(eq(vehicles.registration, plate(registration))))
  return row?.id
}
const routeByName = async (actor: PluginActor, name: string) => {
  const [row] = await withTenant(tenantOf(actor), (tx) => tx.select({ id: routes.id }).from(routes).where(sql`lower(${routes.name}) = ${name.trim().toLowerCase()}`))
  if (!row) throw new Error(`no route ${name}`)
  return row.id
}
const stopOn = async (actor: PluginActor, routeId: string, name: string) => {
  const [row] = await withTenant(tenantOf(actor), (tx) => tx.select({ id: stops.id }).from(stops).where(and(eq(stops.routeId, routeId), sql`lower(${stops.name}) = ${name.trim().toLowerCase()}`)))
  return row?.id
}

export const imports: ImportSpec[] = [
  {
    id: 'vehicles',
    title: 'Vehicles',
    note: 'One row per bus or van.',
    roles: [...ADMIN],
    columns: [
      { name: 'registration', required: true, note: 'The number plate', example: 'KA01AB1234' },
      { name: 'seats', required: true, note: 'Seats for students, 1 to 200', example: '42' },
    ],
    row: async (actor, { values: v }) => {
      if (await vehicleByRegistration(actor, v.registration!)) return 'skipped'
      await addVehicle(actor, { registration: v.registration, capacity: v.seats })
      return 'created'
    },
  },
  {
    id: 'routes',
    title: 'Routes',
    note: 'One row per route and the vehicle that runs it. A vehicle runs one route.',
    roles: [...ADMIN],
    columns: [
      { name: 'name', required: true, note: 'What the route is called', example: 'Route 4: Whitefield' },
      { name: 'vehicle', required: true, note: 'The vehicle’s registration', example: 'KA01AB1234' },
    ],
    row: async (actor, { values: v }) => {
      const [existing] = await withTenant(tenantOf(actor), (tx) => tx.select({ id: routes.id }).from(routes).where(sql`lower(${routes.name}) = ${v.name!.toLowerCase()}`))
      if (existing) return 'skipped'
      const vehicleId = await vehicleByRegistration(actor, v.vehicle!)
      if (!vehicleId) throw new Error(`no vehicle ${plate(v.vehicle!)}`)
      await addRoute(actor, { name: v.name, vehicleId })
      return 'created'
    },
  },
  {
    id: 'stops',
    title: 'Stops',
    note: 'One row per stop, numbered in the order the bus reaches them.',
    roles: [...ADMIN],
    columns: [
      { name: 'route', required: true, note: 'The route’s name', example: 'Route 4: Whitefield' },
      { name: 'stop', required: true, note: 'The stop’s name', example: 'Hope Farm junction' },
      { name: 'position', required: true, note: '1 for the first stop, 2 for the next…', example: '3' },
    ],
    row: async (actor, { values: v }) => {
      const routeId = await routeByName(actor, v.route!)
      if (await stopOn(actor, routeId, v.stop!)) return 'skipped'
      await addStop(actor, { routeId, name: v.stop, position: v.position })
      return 'created'
    },
  },
  {
    id: 'seats',
    title: 'Student seats',
    note: 'Which student rides which route, boarding where. A student already on a route keeps it: release the seat first to move them.',
    roles: [...ADMIN],
    columns: [
      { name: 'email', required: true, note: 'The student’s email address', example: 'dev@college.edu' },
      { name: 'route', required: true, note: 'The route’s name', example: 'Route 4: Whitefield' },
      { name: 'stop', required: true, note: 'Where they board', example: 'Hope Farm junction' },
    ],
    row: async (actor, { values: v }) => {
      const [student] = await withTenant(tenantOf(actor), (tx) => tx.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${v.email!.toLowerCase()}`))
      if (!student) throw new Error(`nobody here has the email ${v.email}`)
      const routeId = await routeByName(actor, v.route!)
      const stopId = await stopOn(actor, routeId, v.stop!)
      if (!stopId) throw new Error(`${v.route} has no stop ${v.stop}`)
      const [seat] = await withTenant(tenantOf(actor), (tx) =>
        tx.select({ routeId: assignments.routeId, stopId: assignments.stopId }).from(assignments).where(and(eq(assignments.studentId, student.id), eq(assignments.status, 'active'))),
      )
      if (seat?.routeId === routeId && seat.stopId === stopId) return 'skipped'
      if (seat) throw new Error(`${v.email} already has a seat on another route or stop; release it first`)
      await assign(actor, { routeId, stopId, studentId: student.id })
      return 'created'
    },
  },
]
