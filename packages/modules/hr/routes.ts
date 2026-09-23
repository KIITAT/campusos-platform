import { shiftsRoutes } from './routes-shifts'
import { leaveRoutes } from './routes-leave'
import { lifecycleRoutes } from './routes-lifecycle'
import { flag, jsonBody, param, requiredParam, type PluginRoute } from '@campusos/module-framework'
import {
  cancelLeave,
  componentsFor,
  createLeaveType,
  createStaff,
  decideLeave,
  endEmployment,
  generatePayroll,
  leaveBalances,
  listLeave,
  listLeaveTypes,
  listPayslips,
  listSalaryPayments,
  paySalaries,
  listStaff,
  myEmployment,
  requestLeave,
  setComponent,
  type Actor,
} from './api'

const coreRoutes: PluginRoute[] = [
  {
    method: 'GET',
    path: '/staff',
    handler: (actor, req) => listStaff(actor as Actor, flag(req, 'includeLeft')),
  },
  {
    method: 'POST',
    path: '/staff',
    handler: async (actor, req) => createStaff(actor as Actor, await jsonBody(req)),
  },
  {
    method: 'POST',
    path: '/staff/end',
    handler: async (actor, req) => endEmployment(actor as Actor, await jsonBody(req)),
  },

  {
    method: 'GET',
    path: '/leave',
    handler: (actor, req) => listLeave(actor as Actor, flag(req, 'pending')),
  },
  {
    method: 'POST',
    path: '/leave',
    handler: async (actor, req) => requestLeave(actor as Actor, await jsonBody(req)),
  },
  { method: 'GET', path: '/leave/types', handler: (actor) => listLeaveTypes(actor as Actor) },
  {
    method: 'POST',
    path: '/leave/types',
    handler: async (actor, req) => createLeaveType(actor as Actor, await jsonBody(req)),
  },
  {
    method: 'POST',
    path: '/leave/decide',
    handler: async (actor, req) => decideLeave(actor as Actor, await jsonBody(req)),
  },
  {
    method: 'POST',
    path: '/leave/cancel',
    handler: async (actor, req) => cancelLeave(actor as Actor, await jsonBody(req)),
  },
  {
    method: 'GET',
    path: '/leave/balances',
    handler: (actor, req) =>
      leaveBalances(actor as Actor, requiredParam(req, 'staffId'), param(req, 'year')),
  },

  {
    method: 'GET',
    path: '/pay/components',
    handler: (actor, req) => componentsFor(actor as Actor, requiredParam(req, 'staffId')),
  },
  {
    method: 'POST',
    path: '/pay/components',
    handler: async (actor, req) => setComponent(actor as Actor, await jsonBody(req)),
  },

  {
    method: 'GET',
    path: '/payroll',
    handler: (actor, req) => listPayslips(actor as Actor, param(req, 'period')),
  },
  {
    method: 'POST',
    path: '/payroll',
    handler: async (actor, req) => generatePayroll(actor as Actor, await jsonBody(req)),
  },

  {
    method: 'GET',
    path: '/payroll/paid',
    handler: (actor) => listSalaryPayments(actor as Actor),
  },
  {
    method: 'POST',
    path: '/payroll/paid',
    handler: async (actor, req) => paySalaries(actor as Actor, await jsonBody(req)),
  },

  { method: 'GET', path: '/me', handler: (actor) => myEmployment(actor as Actor) },
]

/** Everything the module answers, in one table for the host to validate. */
export const routes: PluginRoute[] = [...coreRoutes, ...lifecycleRoutes, ...leaveRoutes, ...shiftsRoutes]
