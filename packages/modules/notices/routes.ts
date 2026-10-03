import { flag, jsonBody, requiredParam, type PluginRoute } from '@campusos/module-framework'
import {
  addAttachment,
  attachmentFile,
  board,
  createNotice,
  emailNotice,
  inbox,
  markRead,
  noticeView,
  publishNotice,
  removeAttachment,
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
    path: '/board/notice',
    handler: (actor, req) => noticeView(actor as Actor, requiredParam(req, 'id')),
  },
  {
    method: 'POST',
    path: '/board/attachments',
    handler: async (actor, req) => addAttachment(actor as Actor, await jsonBody(req)),
  },
  {
    method: 'POST',
    path: '/board/attachments/remove',
    handler: async (actor, req) => removeAttachment(actor as Actor, await jsonBody(req)),
  },
  {
    // A document on a notice, for whoever may read the notice. Served as
    // the type it was checked to be, never sniffed, and sandboxed: a file
    // shown in the browser runs nothing.
    method: 'GET',
    path: '/board/attachment',
    raw: true,
    handler: async (actor, req) => {
      const a = await attachmentFile(actor as Actor, requiredParam(req, 'id'))
      return new Response(new Uint8Array(a.content) as unknown as BodyInit, {
        headers: {
          'content-type': a.type,
          'content-disposition': `inline; filename="${a.name.replace(/[^a-zA-Z0-9._-]/g, '_')}"`,
          'content-length': String(a.size),
          'cache-control': 'private, no-store',
          'x-content-type-options': 'nosniff',
          'content-security-policy': 'sandbox',
        },
      })
    },
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
