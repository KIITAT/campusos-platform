import {
  jsonBody,
  param,
  requiredParam,
  type PluginRoute,
} from '@campusos/module-framework'
import {
  archiveAccount,
  createAccount,
  entryLines,
  listAccounts,
  listEntries,
  postEntry,
  reverseEntry,
  trialBalance,
  type Actor,
} from './api'

export const routes: PluginRoute[] = [
  { method: 'GET', path: '/accounts', handler: (actor) => listAccounts(actor as Actor) },
  {
    method: 'POST',
    path: '/accounts',
    handler: async (actor, req) => createAccount(actor as Actor, await jsonBody(req)),
  },
  {
    method: 'POST',
    path: '/accounts/archive',
    handler: async (actor, req) => {
      await archiveAccount(actor as Actor, await jsonBody(req))
    },
  },

  { method: 'GET', path: '/journal', handler: (actor) => listEntries(actor as Actor) },
  {
    method: 'GET',
    path: '/journal/lines',
    handler: (actor, req) => entryLines(actor as Actor, requiredParam(req, 'entryId')),
  },
  {
    method: 'POST',
    path: '/journal',
    handler: async (actor, req) => postEntry(actor as Actor, await jsonBody(req)),
  },
  {
    method: 'POST',
    path: '/journal/reverse',
    handler: async (actor, req) => reverseEntry(actor as Actor, await jsonBody(req)),
  },

  {
    method: 'GET',
    path: '/trial-balance',
    handler: (actor, req) =>
      trialBalance(actor as Actor, {
        from: param(req, 'from') ?? undefined,
        to: param(req, 'to') ?? undefined,
      }),
  },
]
