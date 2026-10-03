import {
  jsonBody,
  param,
  requiredParam,
  type PluginRoute,
} from '@campusos/module-framework'
import {
  admitCard,
  admitCardPdf,
  backlogList,
  bookBacklog,
  cancelBacklog,
  cancelEnrolment,
  downloadPaper,
  enrol,
  enrolmentList,
  examCycleSettings,
  examStats,
  gradeReport,
  gradeReportPdf,
  listWindows,
  myExamCycle,
  papersFor,
  setExamCycleSettings,
  setWindow,
  studentPerformance,
  uploadPaper,
  createExam,
  createScheme,
  enterMarks,
  finaliseCourse,
  listExams,
  listProgramSchemes,
  listSchemes,
  officialTranscript,
  publishExam,
  setProgramScheme,
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

  {
    // The registrar's act, not the lecturer's: this is where a computed grade
    // becomes the academic record the degree audit reads.
    method: 'POST',
    path: '/finalise',
    handler: async (actor, req) => finaliseCourse(actor as Actor, await jsonBody(req)),
  },

  { method: 'GET', path: '/scales', handler: (actor) => listSchemes(actor as Actor) },
  {
    method: 'GET',
    path: '/scales/programs',
    handler: (actor) => listProgramSchemes(actor as Actor),
  },
  {
    method: 'POST',
    path: '/scales/programs',
    handler: async (actor, req) => {
      await setProgramScheme(actor as Actor, await jsonBody(req))
    },
  },
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
    method: 'GET',
    path: '/transcript/official',
    handler: (actor, req) =>
      officialTranscript(actor as Actor, requiredParam(req, 'studentId')),
  },
  {
    // Bytes, not JSON: the one shape the envelope cannot wrap.
    method: 'GET',
    path: '/transcript.pdf',
    raw: true,
    handler: async (actor, req) => {
      const studentId = requiredParam(req, 'studentId')
      // `official=1` prints the record; without it, what the marks currently
      // compute to, which the document itself says is provisional.
      const t =
        new URL(req.url).searchParams.get('official') === '1'
          ? await officialTranscript(actor as Actor, studentId)
          : await transcript(actor as Actor, studentId)
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

  // --- the examination cycle ---------------------------------------------------
  { method: 'GET', path: '/cycle/settings', handler: (actor) => examCycleSettings(actor as Actor) },
  post('/cycle/settings', setExamCycleSettings),
  { method: 'GET', path: '/windows', handler: (actor) => listWindows(actor as Actor) },
  post('/windows', setWindow),
  { method: 'GET', path: '/booking', handler: (actor, req) => myExamCycle(actor as Actor, param(req, 'termId')) },
  post('/enrol', enrol),
  { method: 'GET', path: '/enrolments', handler: (actor, req) => enrolmentList(actor as Actor, requiredParam(req, 'termId')) },
  post('/enrolments/cancel', cancelEnrolment),
  pdf('/admit-card.pdf', async (actor, req) => {
    const termId = requiredParam(req, 'termId')
    const studentId = param(req, 'studentId') || actor.id
    const a = await admitCard(actor, studentId, termId)
    return { bytes: await admitCardPdf(a), name: `admit-card-${a.ticketNo}` }
  }),
  post('/backlogs', bookBacklog),
  post('/backlogs/cancel', cancelBacklog),
  { method: 'GET', path: '/backlogs', handler: (actor, req) => backlogList(actor as Actor, requiredParam(req, 'termId')) },
  pdf('/grade-report.pdf', async (actor, req) => {
    const termId = requiredParam(req, 'termId')
    const studentId = param(req, 'studentId') || actor.id
    const g = await gradeReport(actor, studentId, termId)
    return { bytes: await gradeReportPdf(g), name: `grade-report-${g.term.code}-${g.student.rollNo ?? g.student.name}` }
  }),
  post('/papers', uploadPaper),
  { method: 'GET', path: '/papers', handler: (actor, req) => papersFor(actor as Actor, requiredParam(req, 'examId')) },
  {
    // The sealed paper itself, for the examination cell, on the record.
    method: 'GET',
    path: '/paper.pdf',
    raw: true,
    handler: async (actor, req) => {
      const p = await downloadPaper(actor as Actor, requiredParam(req, 'paperId'))
      return new Response(new Uint8Array(p.content) as unknown as BodyInit, {
        headers: {
          'content-type': p.contentType,
          'content-disposition': `attachment; filename="${p.fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}"`,
          'cache-control': 'no-store',
        },
      })
    },
  },
  { method: 'GET', path: '/stats', handler: (actor, req) => examStats(actor as Actor, requiredParam(req, 'examId')) },
  {
    method: 'GET',
    path: '/performance',
    handler: (actor, req) => studentPerformance(actor as Actor, param(req, 'studentId') || (actor as Actor).id),
  },
]

function post(path: string, fn: (a: Actor, body: unknown) => Promise<unknown>): PluginRoute {
  return { method: 'POST', path, handler: async (actor, req) => fn(actor as Actor, await jsonBody(req)) }
}

/** A generated document: bytes, not JSON, never cached. */
function pdf(path: string, make: (actor: Actor, req: Request) => Promise<{ bytes: Uint8Array; name: string }>): PluginRoute {
  return {
    method: 'GET',
    path,
    raw: true,
    handler: async (actor, req) => {
      const { bytes, name } = await make(actor as Actor, req)
      return new Response(bytes as unknown as BodyInit, {
        headers: {
          'content-type': 'application/pdf',
          'content-disposition': `inline; filename="${name.replace(/[^a-zA-Z0-9._-]/g, '_')}.pdf"`,
          'cache-control': 'no-store',
        },
      })
    },
  }
}
