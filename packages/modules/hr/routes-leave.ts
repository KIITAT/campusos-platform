import { flag, jsonBody, param, requiredParam, type PluginRoute } from '@campusos/module-framework'
import {
  allocateManually,
  allocateYear,
  assignPolicy,
  createLeavePolicy,
  decideCompOff,
  decideEncashment,
  listAllocations,
  listCompOffs,
  listEncashments,
  listLeavePolicies,
  requestCompOff,
  requestEncashment,
  type Actor,
} from './api'

/** Leave as policy: entitlements, allocations, earned days, payouts. */
export const leaveRoutes: PluginRoute[] = [
  { method: 'GET', path: '/leave/policies', handler: (a) => listLeavePolicies(a as Actor) },
  {
    method: 'POST',
    path: '/leave/policies',
    handler: async (a, req) => createLeavePolicy(a as Actor, await jsonBody(req)),
  },
  {
    method: 'POST',
    path: '/leave/policies/assign',
    handler: async (a, req) => assignPolicy(a as Actor, await jsonBody(req)),
  },
  {
    method: 'GET',
    path: '/leave/allocations',
    handler: (a, req) =>
      listAllocations(a as Actor, requiredParam(req, 'staffId'), param(req, 'year')),
  },
  {
    method: 'POST',
    path: '/leave/allocations',
    handler: async (a, req) => allocateManually(a as Actor, await jsonBody(req)),
  },
  {
    method: 'POST',
    path: '/leave/allocations/year',
    handler: async (a, req) => allocateYear(a as Actor, await jsonBody(req)),
  },
  {
    method: 'GET',
    path: '/leave/comp-off',
    handler: (a, req) => listCompOffs(a as Actor, flag(req, 'pending')),
  },
  {
    method: 'POST',
    path: '/leave/comp-off',
    handler: async (a, req) => requestCompOff(a as Actor, await jsonBody(req)),
  },
  {
    method: 'POST',
    path: '/leave/comp-off/decide',
    handler: async (a, req) => decideCompOff(a as Actor, await jsonBody(req)),
  },
  { method: 'GET', path: '/leave/encashments', handler: (a) => listEncashments(a as Actor) },
  {
    method: 'POST',
    path: '/leave/encashments',
    handler: async (a, req) => requestEncashment(a as Actor, await jsonBody(req)),
  },
  {
    method: 'POST',
    path: '/leave/encashments/decide',
    handler: async (a, req) => decideEncashment(a as Actor, await jsonBody(req)),
  },
]
