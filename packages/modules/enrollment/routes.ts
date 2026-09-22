import { jsonBody, param, requiredParam, type PluginRoute } from '@campusos/module-framework'
import {
  creditLoad,
  drop,
  listRegistrationEvents,
  listRegistrations,
  listRoster,
  listSeats,
  register,
  setOfferingLimit,
  type Actor,
} from './api'

/** Declared rather than mounted; the host dispatches and gates. */
const post = (
  path: string,
  op: (a: Actor, input: unknown) => Promise<unknown>,
): PluginRoute => ({
  method: 'POST',
  path,
  handler: async (actor, req) => op(actor as Actor, await jsonBody(req)),
})

export const routes: PluginRoute[] = [
  post('/register', register),
  post('/drop', drop),
  post('/seats', setOfferingLimit),

  { method: 'GET', path: '/seats', handler: (actor) => listSeats(actor as Actor) },
  {
    method: 'GET',
    path: '/roster',
    handler: (actor, req) =>
      listRoster(actor as Actor, { offeringId: requiredParam(req, 'offeringId') }),
  },
  {
    method: 'GET',
    path: '/registrations',
    handler: (actor, req) =>
      listRegistrations(actor as Actor, {
        studentId: param(req, 'studentId'),
        termId: param(req, 'termId'),
      }),
  },
  {
    method: 'GET',
    path: '/credit-load',
    handler: (actor, req) =>
      creditLoad(actor as Actor, {
        studentId: param(req, 'studentId'),
        termId: requiredParam(req, 'termId'),
      }),
  },
  {
    method: 'GET',
    path: '/events',
    handler: (actor, req) =>
      listRegistrationEvents(actor as Actor, {
        termId: requiredParam(req, 'termId'),
        studentId: param(req, 'studentId'),
      }),
  },
]
