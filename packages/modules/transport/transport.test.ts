import { test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { auditLog, authDb, users, withTenant } from '@campusos/db'
import { college } from './test-support.test'
import { addRoute, addStop, addVehicle, assign, listAssignments, release } from './api'
import { vehicles, routes } from './schema'

test('transport RLS and composite vehicle links reject cross-tenant writes and erased students', async () => {
  const actors = await college()
  const other = await college()
  const vehicle = await addVehicle(actors.admin, { registration: 'SAFE-BUS', capacity: 2 })
  assert.deepEqual(await withTenant(other.id, transaction => transaction.select().from(vehicles)), [])
  await assert.rejects(() => withTenant(other.id, transaction => transaction.insert(vehicles).values({ institutionId: actors.id, registration: 'FOREIGN', capacity: 2 })))
  await assert.rejects(() => withTenant(other.id, transaction => transaction.insert(routes).values({ institutionId: other.id, name: 'Foreign vehicle', vehicleId: vehicle.id })))
  const route = await addRoute(actors.admin, { name: 'Local route', vehicleId: vehicle.id })
  const stop = await addStop(actors.admin, { routeId: route.id, name: 'Gate', position: 1 })
  await authDb.update(users).set({ erasedAt: new Date() }).where(eq(users.id, actors.student.id))
  await assert.rejects(() => assign(actors.admin, { routeId: route.id, stopId: stop.id, studentId: actors.student.id }))
  const trail = await withTenant(actors.id, transaction => transaction.select().from(auditLog).where(eq(auditLog.moduleId, 'transport')))
  assert.deepEqual(trail.map(row => row.action).sort(), ['vehicle.created', 'route.created', 'stop.created'].sort())
})

test('route capacity is serialized and release makes the seat available again', async () => {
  const actors = await college()
  const vehicle = await addVehicle(actors.admin, { registration: 'TEST-01', capacity: 1 })
  const route = await addRoute(actors.admin, { name: 'North campus', vehicleId: vehicle.id })
  const stop = await addStop(actors.admin, { routeId: route.id, name: 'Library', position: 1 })
  const results = await Promise.allSettled([actors.student, actors.other].map(student => assign(actors.admin, { routeId: route.id, stopId: stop.id, studentId: student.id })))
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  const allocation = (await listAssignments(actors.admin))[0]!
  await release(actors.admin, { assignmentId: allocation.id, reason: 'Changed transport' })
  const next = await assign(actors.admin, { routeId: route.id, stopId: stop.id, studentId: actors.other.id })
  assert.equal(next.status, 'active')
  await assert.rejects(() => assign(actors.admin, { routeId: route.id, stopId: stop.id, studentId: actors.other.id }))
})

test('students see only their transport and office cannot link foreign identities or stops', async () => {
  const actors = await college()
  const other = await college()
  const vehicle = await addVehicle(actors.admin, { registration: 'LOCAL', capacity: 3 })
  const route = await addRoute(actors.admin, { name: 'Local', vehicleId: vehicle.id })
  const stop = await addStop(actors.admin, { routeId: route.id, name: 'Gate', position: 1 })
  await assert.rejects(() => addVehicle(actors.student, { registration: 'NO', capacity: 2 }))
  await assert.rejects(() => assign(actors.admin, { routeId: route.id, stopId: stop.id, studentId: other.student.id }))
  await assert.rejects(() => addStop(other.admin, { routeId: route.id, name: 'Foreign', position: 2 }))
  await assign(actors.admin, { routeId: route.id, stopId: stop.id, studentId: actors.student.id })
  assert.equal((await listAssignments(actors.student)).length, 1)
  assert.deepEqual(await listAssignments(actors.other), [])
  assert.deepEqual(await listAssignments(other.admin), [])
})
