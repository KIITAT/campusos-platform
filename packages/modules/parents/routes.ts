import { flag, jsonBody, requiredParam, type PluginRoute } from '@campusos/module-framework'
import {
  childOverview,
  claimLink,
  decideLink,
  inviteGuardian,
  listGuardianInvites,
  listLinks,
  myChildren,
  revokeLink,
  withdrawGuardian,
  type Actor,
} from './api'

export const routes: PluginRoute[] = [
  {
    method: 'GET',
    path: '/links',
    handler: (actor, req) => listLinks(actor as Actor, flag(req, 'pending')),
  },
  {
    method: 'POST',
    path: '/links',
    handler: async (actor, req) => claimLink(actor as Actor, await jsonBody(req)),
  },
  {
    method: 'POST',
    path: '/links/decide',
    handler: async (actor, req) => decideLink(actor as Actor, await jsonBody(req)),
  },
  {
    method: 'POST',
    path: '/links/revoke',
    handler: async (actor, req) => {
      await revokeLink(actor as Actor, await jsonBody(req))
    },
  },

  { method: 'GET', path: '/guardians', handler: (actor) => listGuardianInvites(actor as Actor) },
  {
    method: 'POST',
    path: '/guardians/invite',
    handler: async (actor, req) => inviteGuardian(actor as Actor, await jsonBody(req)),
  },
  {
    method: 'POST',
    path: '/guardians/withdraw',
    handler: async (actor, req) => {
      await withdrawGuardian(actor as Actor, await jsonBody(req))
    },
  },

  { method: 'GET', path: '/children', handler: (actor) => myChildren(actor as Actor) },
  {
    method: 'GET',
    path: '/child',
    handler: (actor, req) => childOverview(actor as Actor, requiredParam(req, 'studentId')),
  },
]
