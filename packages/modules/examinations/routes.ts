import {
  jsonBody,
  requiredParam,
  type PluginRoute,
} from '@campusos/module-framework'
import {
  createExam,
  createScheme,
  enterMarks,
  listExams,
  listSchemes,
  publishExam,
  reviseMark,
  sheet,
  transcript,
  transcriptPdf,
  unpublishExam,
  type Actor,
} from './api'

export const routes: PluginRoute[] = [
  {
    method: 'GET',
    path: '/exams',
    handler: (actor, req) => listExams(actor as Actor, requiredParam(req, 'offeringId')),
  },
  {
    method: 'POST',
    path: '/exams',
    handler: async (actor, req) => createExam(actor as Actor, await jsonBody(req)),
  },
  {
    method: 'POST',
    path: '/exams/publish',
    handler: async (actor, req) => {
      await publishExam(actor as Actor, await jsonBody(req))
    },
  },
  {
    method: 'POST',
    path: '/exams/unpublish',
    handler: async (actor, req) => {
      await unpublishExam(actor as Actor, await jsonBody(req))
    },
  },

  {
    method: 'GET',
    path: '/marks',
    handler: (actor, req) => sheet(actor as Actor, requiredParam(req, 'examId')),
  },
  {
    method: 'POST',
    path: '/marks',
    handler: async (actor, req) => {
      await enterMarks(actor as Actor, await jsonBody(req))
    },
  },
  {
    method: 'POST',
    path: '/marks/revise',
    handler: async (actor, req) => {
      await reviseMark(actor as Actor, await jsonBody(req))
    },
  },

  { method: 'GET', path: '/scales', handler: (actor) => listSchemes(actor as Actor) },
  {
    method: 'POST',
    path: '/scales',
    handler: async (actor, req) => createScheme(actor as Actor, await jsonBody(req)),
  },

  {
    method: 'GET',
    path: '/transcript',
    handler: (actor, req) => transcript(actor as Actor, requiredParam(req, 'studentId')),
  },
  {
    // Bytes, not JSON: the one shape the envelope cannot wrap.
    method: 'GET',
    path: '/transcript.pdf',
    raw: true,
    handler: async (actor, req) => {
      const studentId = requiredParam(req, 'studentId')
      const t = await transcript(actor as Actor, studentId)
      const bytes = await transcriptPdf(t)
      const name = (t.studentEmail ?? studentId).replace(/[^a-zA-Z0-9._-]/g, '_')
      return new Response(bytes as unknown as BodyInit, {
        headers: {
          'content-type': 'application/pdf',
          // inline, not attachment: a student checking their own result should
          // not have to open a download to read it.
          'content-disposition': `inline; filename="transcript-${name}.pdf"`,
          // A transcript changes whenever a mark is revised, so never cache it.
          'cache-control': 'no-store',
        },
      })
    },
  },
]
