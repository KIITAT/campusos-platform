import {
  jsonBody,
  param,
  requiredParam,
  type PluginRoute,
} from '@campusos/module-framework'
import {
  archiveAccount,
  budgetReport,
  closePeriod,
  createAccount,
  entryLines,
  listAccounts,
  listEntries,
  listPeriods,
  postEntry,
  reopenPeriod,
  reverseEntry,
  setBudget,
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
    path: '/periods',
    handler: (actor, req) =>
      listPeriods(actor as Actor, { year: param(req, 'year') ?? undefined }),
  },
  {
    method: 'POST',
    path: '/periods/close',
    handler: async (actor, req) => closePeriod(actor as Actor, await jsonBody(req)),
  },
  {
    method: 'POST',
    path: '/periods/reopen',
    handler: async (actor, req) => reopenPeriod(actor as Actor, await jsonBody(req)),
  },

  {
    method: 'GET',
    path: '/budgets',
    handler: (actor, req) =>
      budgetReport(actor as Actor, {
        year: requiredParam(req, 'year'),
        costCenter: param(req, 'costCenter') ?? undefined,
      }),
  },
  {
    method: 'POST',
    path: '/budgets',
    handler: async (actor, req) => setBudget(actor as Actor, await jsonBody(req)),
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
