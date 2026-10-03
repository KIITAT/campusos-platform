import { jsonBody, requiredParam, type PluginRoute } from '@campusos/module-framework'
import {
  addLeaveType,
  addNote,
  applyLeave,
  assignMentor,
  assignmentList,
  cancelLeave,
  decideLeave,
  endAssignments,
  leaveDocument,
  listLeaveTypes,
  menteeView,
  myMentees,
  myMentoring,
  pendingLeave,
  retireLeaveType,
  sendMessage,
  type Actor,
} from './api'

const post = (path: string, fn: (a: Actor, body: unknown) => Promise<unknown>): PluginRoute => ({
  method: 'POST',
  path,
  handler: async (a, req) => fn(a as Actor, await jsonBody(req)),
})

export const routes: PluginRoute[] = [
  { method: 'GET', path: '/assignments', handler: (a) => assignmentList(a as Actor) },
  post('/assign', assignMentor),
  post('/assignments/end', endAssignments),

  { method: 'GET', path: '/mentees', handler: (a) => myMentees(a as Actor) },
  { method: 'GET', path: '/mentee', handler: (a, req) => menteeView(a as Actor, requiredParam(req, 'studentId')) },
  post('/notes', addNote),
  post('/messages', sendMessage),

  { method: 'GET', path: '/leave-types', handler: (a) => listLeaveTypes(a as Actor) },
  post('/leave-types', addLeaveType),
  post('/leave-types/retire', retireLeaveType),
  post('/leave', applyLeave),
  { method: 'GET', path: '/leave/pending', handler: (a) => pendingLeave(a as Actor) },
  post('/leave/decide', decideLeave),
  post('/leave/cancel', cancelLeave),
  {
    // The supporting PDF, for the student, their mentors and the office.
    method: 'GET',
    path: '/leave/document.pdf',
    raw: true,
    handler: async (a, req) => {
      const d = await leaveDocument(a as Actor, requiredParam(req, 'applicationId'))
      return new Response(new Uint8Array(d.content) as unknown as BodyInit, {
        headers: {
          'content-type': 'application/pdf',
          'content-disposition': `inline; filename="${d.name.replace(/[^a-zA-Z0-9._-]/g, '_')}"`,
          'cache-control': 'no-store',
        },
      })
    },
  },

  { method: 'GET', path: '/me', handler: (a) => myMentoring(a as Actor) },
]
