import { flag, jsonBody, requiredParam, type PluginRoute } from '@campusos/module-framework'
import {
  board,
  createNotice,
  emailNotice,
  inbox,
  markRead,
  publishNotice,
  withdrawNotice,
  type Actor,
} from './api'

export const routes: PluginRoute[] = [
  {
    method: 'GET',
    path: '/board',
    handler: (actor, req) => board(actor as Actor, flag(req, 'drafts')),
  },
  {
    method: 'POST',
    path: '/board',
    handler: async (actor, req) => createNotice(actor as Actor, await jsonBody(req)),
  },
  {
    method: 'POST',
    path: '/board/publish',
    handler: async (actor, req) => publishNotice(actor as Actor, await jsonBody(req)),
  },
  {
    method: 'POST',
    path: '/board/withdraw',
    handler: async (actor, req) => {
      await withdrawNotice(actor as Actor, await jsonBody(req))
    },
  },
  {
    method: 'POST',
    path: '/board/email',
    handler: (actor, req) => emailNotice(actor as Actor, requiredParam(req, 'noticeId')),
  },

  {
    method: 'GET',
    path: '/inbox',
    handler: (actor, req) => inbox(actor as Actor, flag(req, 'unread')),
  },
  {
    method: 'POST',
    path: '/inbox',
    handler: async (actor, req) => markRead(actor as Actor, await jsonBody(req)),
  },
]
