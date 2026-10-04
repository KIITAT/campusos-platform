import { jsonBody, param, requiredParam, type PluginRoute } from '@campusos/module-framework'
import {
  attendanceRules,
  attendanceSummary,
  classAbsentees,
  grantExcuse,
  listExcuses,
  revokeExcuse,
  setAttendanceRules,
  approveDevice,
  closeSession,
  currentQrFor,
  listPendingDevices,
  myAttendance,
  openSession,
  openSessions,
  override,
  registerDevice,
  roster,
  scan,
  setGeofence,
  signedScan,
  registerDeviceKey,
  myDevices,
  revokeDevice,
  offlinePolicy,
  setOfflinePolicy,
  prepareSession,
  markSessionHeld,
  revokeCredential,
  type Actor,
} from './api'

export const routes: PluginRoute[] = [
  { method: 'POST', path: '/scan/signed', handler: async (actor, req) => signedScan(actor as Actor, await jsonBody(req)) },
  { method: 'POST', path: '/devices/key', handler: async (actor, req) => registerDeviceKey(actor as Actor, await jsonBody(req)) },
  { method: 'GET', path: '/devices/mine', handler: (actor) => myDevices(actor as Actor) },
  { method: 'POST', path: '/devices/revoke', handler: async (actor, req) => revokeDevice(actor as Actor, await jsonBody(req)) },
  { method: 'GET', path: '/offline/policy', handler: (actor) => offlinePolicy(actor as Actor) },
  { method: 'POST', path: '/offline/policy', handler: async (actor, req) => setOfflinePolicy(actor as Actor, await jsonBody(req)) },
  { method: 'POST', path: '/sessions/prepare', handler: async (actor, req) => prepareSession(actor as Actor, await jsonBody(req)) },
  { method: 'POST', path: '/sessions/held', handler: async (actor, req) => markSessionHeld(actor as Actor, await jsonBody(req)) },
  { method: 'POST', path: '/sessions/prepare/revoke', handler: async (actor, req) => revokeCredential(actor as Actor, await jsonBody(req)) },
  { method: 'GET', path: '/rules', handler: (actor) => attendanceRules(actor as Actor) },
  { method: 'POST', path: '/rules', handler: async (actor, req) => setAttendanceRules(actor as Actor, await jsonBody(req)) },
  { method: 'GET', path: '/excuses', handler: (actor) => listExcuses(actor as Actor) },
  { method: 'POST', path: '/excuses', handler: async (actor, req) => grantExcuse(actor as Actor, await jsonBody(req)) },
  { method: 'POST', path: '/excuses/revoke', handler: async (actor, req) => revokeExcuse(actor as Actor, await jsonBody(req)) },
  { method: 'GET', path: '/absentees', handler: (actor, req) => classAbsentees(actor as Actor, requiredParam(req, 'offeringId')) },
  {
    method: 'GET',
    path: '/summary',
    handler: (actor, req) => attendanceSummary(actor as Actor, param(req, 'studentId') || (actor as Actor).id, param(req, 'termId')),
  },
  { method: 'GET', path: '/sessions', handler: (actor) => openSessions(actor as Actor) },
  {
    method: 'POST',
    path: '/sessions',
    handler: async (actor, req) => openSession(actor as Actor, await jsonBody(req)),
  },
  {
    method: 'POST',
    path: '/sessions/close',
    handler: async (actor, req) => {
      await closeSession(actor as Actor, await jsonBody(req))
    },
  },
  {
    method: 'GET',
    path: '/sessions/qr',
    handler: (actor, req) => currentQrFor(actor as Actor, requiredParam(req, 'sessionId')),
  },
  {
    method: 'GET',
    path: '/sessions/roster',
    handler: (actor, req) => roster(actor as Actor, requiredParam(req, 'sessionId')),
  },

  {
    method: 'POST',
    path: '/scan',
    handler: async (actor, req) => scan(actor as Actor, await jsonBody(req)),
  },
  {
    method: 'POST',
    path: '/override',
    handler: async (actor, req) => {
      await override(actor as Actor, await jsonBody(req))
    },
  },

  { method: 'GET', path: '/devices', handler: (actor) => listPendingDevices(actor as Actor) },
  {
    method: 'POST',
    path: '/devices',
    handler: async (actor, req) => registerDevice(actor as Actor, await jsonBody(req)),
  },
  {
    method: 'POST',
    path: '/devices/approve',
    handler: async (actor, req) => {
      await approveDevice(actor as Actor, await jsonBody(req))
    },
  },
  {
    method: 'POST',
    path: '/geofences',
    handler: async (actor, req) => {
      await setGeofence(actor as Actor, await jsonBody(req))
    },
  },

  { method: 'GET', path: '/me', handler: (actor) => myAttendance(actor as Actor) },
]
