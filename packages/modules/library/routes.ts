import { jsonBody, param, requiredParam, type PluginRoute } from '@campusos/module-framework'
import {
  addCopies,
  borrowerStatus,
  catalogue,
  copiesOf,
  createTitle,
  getSettings,
  issue,
  openLoans,
  overdueReport,
  renew,
  returnCopy,
  setCopyStatus,
  setSettings,
  settleFine,
  waiveFine,
  type Actor,
} from './api'

/**
 * What this module answers, declared rather than mounted.
 *
 * Each handler is the operation it always was and still checks its own
 * permissions; the host wraps the session and the entitlement gate around all
 * of them. The only thing that changed is who writes the file.
 */
export const routes: PluginRoute[] = [
  {
    method: 'GET',
    path: '/titles',
    handler: (actor, req) => catalogue(actor as Actor, param(req, 'q')),
  },
  {
    method: 'POST',
    path: '/titles',
    handler: async (actor, req) => createTitle(actor as Actor, await jsonBody(req)),
  },

  {
    method: 'GET',
    path: '/copies',
    handler: (actor, req) => copiesOf(actor as Actor, requiredParam(req, 'titleId')),
  },
  {
    method: 'POST',
    path: '/copies',
    handler: async (actor, req) => addCopies(actor as Actor, await jsonBody(req)),
  },
  {
    method: 'POST',
    path: '/copies/status',
    handler: async (actor, req) => setCopyStatus(actor as Actor, await jsonBody(req)),
  },

  { method: 'GET', path: '/loans', handler: (actor) => openLoans(actor as Actor) },
  {
    method: 'POST',
    path: '/loans/issue',
    handler: async (actor, req) => issue(actor as Actor, await jsonBody(req)),
  },
  {
    method: 'POST',
    path: '/loans/return',
    handler: async (actor, req) => returnCopy(actor as Actor, await jsonBody(req)),
  },
  {
    method: 'POST',
    path: '/loans/renew',
    handler: async (actor, req) => renew(actor as Actor, await jsonBody(req)),
  },

  {
    method: 'POST',
    path: '/fines/waive',
    handler: async (actor, req) => waiveFine(actor as Actor, await jsonBody(req)),
  },
  {
    method: 'POST',
    path: '/fines/settle',
    handler: async (actor, req) => settleFine(actor as Actor, await jsonBody(req)),
  },

  {
    method: 'GET',
    path: '/status',
    // No borrowerId means "mine", so the common case needs no parameter at all.
    handler: (actor, req) =>
      borrowerStatus(actor as Actor, param(req, 'borrowerId') ?? actor.id),
  },
  { method: 'GET', path: '/overdue', handler: (actor) => overdueReport(actor as Actor) },

  { method: 'GET', path: '/settings', handler: (actor) => getSettings(actor as Actor) },
  {
    method: 'PUT',
    path: '/settings',
    handler: async (actor, req) => setSettings(actor as Actor, await jsonBody(req)),
  },
]
