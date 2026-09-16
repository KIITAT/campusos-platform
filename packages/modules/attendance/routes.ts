import { jsonBody, requiredParam, type PluginRoute } from '@campusos/module-framework'
import {
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
  type Actor,
} from './api'

export const routes: PluginRoute[] = [
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
