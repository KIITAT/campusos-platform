import { jsonBody, param, requiredParam, type PluginRoute } from '@campusos/module-framework'
import {
  addQuestion,
  addScaleQuestions,
  classResults,
  completion,
  createForm,
  createWindow,
  formView,
  give,
  giveView,
  listForms,
  listWindows,
  myClassResults,
  myFeedback,
  publishForm,
  publishWindow,
  removeQuestions,
  retireForm,
  windowView,
  withdrawWindow,
  type Actor,
} from './api'

const post = (path: string, fn: (a: Actor, body: unknown) => Promise<unknown>): PluginRoute => ({
  method: 'POST',
  path,
  handler: async (a, req) => fn(a as Actor, await jsonBody(req)),
})

export const routes: PluginRoute[] = [
  { method: 'GET', path: '/forms', handler: (a) => listForms(a as Actor) },
  post('/forms', createForm),
  { method: 'GET', path: '/form', handler: (a, req) => formView(a as Actor, requiredParam(req, 'formId')) },
  post('/forms/publish', publishForm),
  post('/forms/retire', retireForm),
  post('/questions', addQuestion),
  post('/questions/scale', addScaleQuestions),
  post('/questions/remove', removeQuestions),

  { method: 'GET', path: '/windows', handler: (a) => listWindows(a as Actor) },
  post('/windows', createWindow),
  { method: 'GET', path: '/window', handler: (a, req) => windowView(a as Actor, requiredParam(req, 'windowId')) },
  post('/windows/publish', publishWindow),
  post('/windows/withdraw', withdrawWindow),
  {
    method: 'GET',
    path: '/class',
    handler: (a, req) => classResults(a as Actor, requiredParam(req, 'windowId'), requiredParam(req, 'offeringId')),
  },
  { method: 'GET', path: '/results', handler: (a) => myClassResults(a as Actor) },

  { method: 'GET', path: '/me', handler: (a) => myFeedback(a as Actor) },
  {
    method: 'GET',
    path: '/give',
    handler: (a, req) => giveView(a as Actor, requiredParam(req, 'windowId'), param(req, 'offeringId') || null),
  },
  post('/give', give),
  {
    method: 'GET',
    path: '/completion',
    handler: (a, req) => completion(a as Actor, requiredParam(req, 'studentId'), requiredParam(req, 'termId')),
  },
]
