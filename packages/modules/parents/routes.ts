import { flag, jsonBody, requiredParam, type PluginRoute } from '@campusos/module-framework'
import {
  childOverview,
  claimLink,
  decideLink,
  listLinks,
  myChildren,
  revokeLink,
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

  { method: 'GET', path: '/children', handler: (actor) => myChildren(actor as Actor) },
  {
    method: 'GET',
    path: '/child',
    handler: (actor, req) => childOverview(actor as Actor, requiredParam(req, 'studentId')),
  },
]
