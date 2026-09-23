import { flag, jsonBody, param, requiredParam, type PluginRoute } from '@campusos/module-framework'
import {
  assignShift,
  createShiftType,
  decideShift,
  listShiftRequests,
  listShiftTypes,
  requestShift,
  rotateShifts,
  roster,
  shiftCoverage,
  today,
  type Actor,
} from './api'

/** Shifts: types, assignments, rotations, requests and the roster. */
export const shiftsRoutes: PluginRoute[] = [
  { method: 'GET', path: '/shifts/types', handler: (a) => listShiftTypes(a as Actor) },
  {
    method: 'POST',
    path: '/shifts/types',
    handler: async (a, req) => createShiftType(a as Actor, await jsonBody(req)),
  },
  {
    method: 'POST',
    path: '/shifts/assign',
    handler: async (a, req) => assignShift(a as Actor, await jsonBody(req)),
  },
  {
    method: 'POST',
    path: '/shifts/rotate',
    handler: async (a, req) => rotateShifts(a as Actor, await jsonBody(req)),
  },
  {
    method: 'GET',
    path: '/shifts/roster',
    handler: (a, req) =>
      roster(a as Actor, requiredParam(req, 'from'), requiredParam(req, 'to')),
  },
  {
    method: 'GET',
    path: '/shifts/coverage',
    handler: (a, req) => shiftCoverage(a as Actor, param(req, 'on') ?? today()),
  },
  {
    method: 'GET',
    path: '/shifts/requests',
    handler: (a, req) => listShiftRequests(a as Actor, flag(req, 'pending')),
  },
  {
    method: 'POST',
    path: '/shifts/requests',
    handler: async (a, req) => requestShift(a as Actor, await jsonBody(req)),
  },
  {
    method: 'POST',
    path: '/shifts/requests/decide',
    handler: async (a, req) => decideShift(a as Actor, await jsonBody(req)),
  },
]
