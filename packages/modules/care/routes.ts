import { jsonBody, param, requiredParam, type PluginRoute } from '@campusos/module-framework'
import {
  accept,
  addCounsellor,
  addInstrument,
  addNote,
  ask,
  book,
  cancelAppointment,
  careHome,
  careSettings,
  caseView,
  checkToTake,
  closeCase,
  deleteResult,
  handover,
  offeredChecks,
  queue,
  recordAppointment,
  resultView,
  retireInstrument,
  saveSettings,
  setCounsellorActive,
  statistics,
  takeCheck,
  withdraw,
  type Actor,
} from './api'

const post = (path: string, fn: (a: Actor, body: unknown) => Promise<unknown>): PluginRoute => ({
  method: 'POST',
  path,
  handler: async (a, req) => fn(a as Actor, await jsonBody(req)),
})

export const routes: PluginRoute[] = [
  // A student's own.
  { method: 'GET', path: '/home', handler: (a) => careHome(a as Actor) },
  { method: 'GET', path: '/instruments', handler: (a) => offeredChecks(a as Actor) },
  { method: 'GET', path: '/check', handler: (a, req) => checkToTake(a as Actor, requiredParam(req, 'code')) },
  post('/checks', takeCheck),
  { method: 'GET', path: '/result', handler: (a, req) => resultView(a as Actor, requiredParam(req, 'id')) },
  post('/results/delete', deleteResult),
  post('/requests', ask),
  post('/requests/withdraw', withdraw),
  post('/appointments/cancel', cancelAppointment),

  // The counsellors'.
  { method: 'GET', path: '/queue', handler: (a) => queue(a as Actor) },
  { method: 'GET', path: '/case', handler: (a, req) => caseView(a as Actor, requiredParam(req, 'id')) },
  post('/requests/accept', accept),
  post('/requests/handover', handover),
  post('/requests/close', closeCase),
  post('/appointments', book),
  post('/appointments/record', recordAppointment),
  post('/notes', addNote),

  // The office's, and counts for both.
  { method: 'GET', path: '/statistics', handler: (a, req) => statistics(a as Actor, param(req, 'period')) },
  { method: 'GET', path: '/settings', handler: (a) => careSettings(a as Actor) },
  post('/settings', saveSettings),
  post('/counsellors', addCounsellor),
  post('/counsellors/active', setCounsellorActive),
  post('/instruments', addInstrument),
  post('/instruments/retire', retireInstrument),
]
