import { flag, jsonBody, param, requiredParam, type PluginRoute } from '@campusos/module-framework'
import {
  addRooms,
  addScope,
  allocate,
  casePage,
  chargeTerm,
  createBlock,
  getPolicy,
  grantLeave,
  listBlocks,
  listCases,
  listScopes,
  listRooms,
  mark,
  myHostel,
  rollCall,
  removeScope,
  resolveCase,
  rollCallCode,
  scanCheckIn,
  setBlockCurfew,
  setPolicy,
  setRoomFee,
  studentPresence,
  vacate,
  visitorIn,
  visitorLog,
  visitorOut,
  visitorPage,
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
    path: '/rooms/fee',
    handler: async (actor, req) => setRoomFee(actor as Actor, await jsonBody(req)),
  },
  {
    method: 'POST',
    path: '/charges',
    handler: async (actor, req) => chargeTerm(actor as Actor, await jsonBody(req)),
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
      visitorLog(actor as Actor, param(req, 'blockId'), flag(req, 'open'), visitorPage(req, '')),
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

  // Curfew cases, presence and the policy behind them (P2-22a).
  { method: 'GET', path: '/presence/cases', handler: (actor, req) => listCases(actor as Actor, { resolved: flag(req, 'resolved') }, casePage(req, '')) },
  { method: 'POST', path: '/presence/cases/resolve', handler: async (actor, req) => resolveCase(actor as Actor, await jsonBody(req)) },
  { method: 'GET', path: '/presence/student', handler: (actor, req) => studentPresence(actor as Actor, requiredParam(req, 'studentId')) },
  { method: 'GET', path: '/policy', handler: (actor) => getPolicy(actor as Actor) },
  { method: 'PUT', path: '/policy', handler: async (actor, req) => setPolicy(actor as Actor, await jsonBody(req)) },
  { method: 'POST', path: '/blocks/curfew', handler: async (actor, req) => setBlockCurfew(actor as Actor, await jsonBody(req)) },
  { method: 'GET', path: '/scopes', handler: (actor) => listScopes(actor as Actor) },
  { method: 'POST', path: '/scopes', handler: async (actor, req) => addScope(actor as Actor, await jsonBody(req)) },
  { method: 'POST', path: '/scopes/remove', handler: async (actor, req) => removeScope(actor as Actor, await jsonBody(req)) },

  {
    method: 'GET',
    path: '/me',
    handler: (actor, req) => myHostel(actor as Actor, param(req, 'studentId')),
  },
]
