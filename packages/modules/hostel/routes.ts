import { flag, jsonBody, param, requiredParam, type PluginRoute } from '@campusos/module-framework'
import {
  addRooms,
  allocate,
  createBlock,
  grantLeave,
  listBlocks,
  listRooms,
  mark,
  myHostel,
  rollCall,
  rollCallCode,
  scanCheckIn,
  vacate,
  visitorIn,
  visitorLog,
  visitorOut,
  type Actor,
} from './api'

export const routes: PluginRoute[] = [
  { method: 'GET', path: '/blocks', handler: (actor) => listBlocks(actor as Actor) },
  {
    method: 'POST',
    path: '/blocks',
    handler: async (actor, req) => createBlock(actor as Actor, await jsonBody(req)),
  },

  {
    method: 'GET',
    path: '/rooms',
    handler: (actor, req) => listRooms(actor as Actor, param(req, 'blockId')),
  },
  {
    method: 'POST',
    path: '/rooms',
    handler: async (actor, req) => addRooms(actor as Actor, await jsonBody(req)),
  },

  {
    method: 'POST',
    path: '/allocations',
    handler: async (actor, req) => allocate(actor as Actor, await jsonBody(req)),
  },
  {
    method: 'POST',
    path: '/allocations/vacate',
    handler: async (actor, req) => vacate(actor as Actor, await jsonBody(req)),
  },
  {
    method: 'POST',
    path: '/leave',
    handler: async (actor, req) => grantLeave(actor as Actor, await jsonBody(req)),
  },

  {
    method: 'GET',
    path: '/rollcall',
    handler: (actor, req) =>
      rollCall(actor as Actor, requiredParam(req, 'blockId'), param(req, 'night')),
  },
  {
    // The secret is derived from AUTH_SECRET per institution, so no key is
    // passed in and none is stored.
    method: 'GET',
    path: '/rollcall/qr',
    handler: (actor, req) => rollCallCode(actor as Actor, requiredParam(req, 'blockId')),
  },
  {
    method: 'POST',
    path: '/rollcall/scan',
    handler: async (actor, req) => scanCheckIn(actor as Actor, await jsonBody(req)),
  },
  {
    method: 'POST',
    path: '/rollcall/mark',
    handler: async (actor, req) => mark(actor as Actor, await jsonBody(req)),
  },

  {
    method: 'GET',
    path: '/visitors',
    handler: (actor, req) =>
      visitorLog(actor as Actor, param(req, 'blockId'), flag(req, 'open')),
  },
  {
    method: 'POST',
    path: '/visitors',
    handler: async (actor, req) => visitorIn(actor as Actor, await jsonBody(req)),
  },
  {
    method: 'POST',
    path: '/visitors/out',
    handler: async (actor, req) => visitorOut(actor as Actor, await jsonBody(req)),
  },

  {
    method: 'GET',
    path: '/me',
    handler: (actor, req) => myHostel(actor as Actor, param(req, 'studentId')),
  },
]
