import { jsonBody, type PluginActor, type PluginRoute } from '@campusos/module-framework'
import type * as z from 'zod'
import * as api from './api'

/**
 * Every operation of the timetable, as an HTTP route -- declared once, as a
 * list the OpenAPI document is read from too (api/openapi.ts).
 */

type A = api.Actor
type Query = Record<string, string | undefined>

export interface RouteSpec extends PluginRoute {
  summary: string
  body?: z.ZodType
  tag: string
}

const as = (actor: PluginActor) => actor as A
const query = (req: Request): Query => Object.fromEntries(new URL(req.url).searchParams)

function post(tag: string, path: string, summary: string, fn: (a: A, body: unknown) => Promise<unknown>, body?: z.ZodType): RouteSpec {
  return { method: 'POST', path, summary, body, tag, handler: async (actor, req) => fn(as(actor), await jsonBody(req)) }
}
function get(tag: string, path: string, summary: string, fn: (a: A, q: Query) => Promise<unknown>): RouteSpec {
  return { method: 'GET', path, summary, tag, handler: (actor, req) => fn(as(actor), query(req)) }
}
function pdf(tag: string, path: string, summary: string, fn: (a: A, q: Query) => Promise<{ bytes: Uint8Array; fileName: string }>): RouteSpec {
  return {
    method: 'GET',
    path,
    summary,
    tag,
    raw: true,
    handler: async (actor, req) => {
      const out = await fn(as(actor), query(req))
      return new Response(out.bytes as unknown as BodyInit, {
        headers: {
          'content-type': 'application/pdf',
          'content-disposition': `inline; filename="${out.fileName}"`,
          'cache-control': 'no-store',
        },
      })
    },
  }
}

const required = (q: Query, name: string) => {
  const v = q[name]
  if (!v) throw new api.TimetableError(400, `${name}_required`, `${name} is required`)
  return v
}

export const specs: RouteSpec[] = [
  // --- setting up ------------------------------------------------------------------
  get('setup', '/settings', 'Teachers’ default limits, when the year turns over, how long the solver may think', (a) => api.getSettings(a)),
  post('setup', '/settings', 'Change the defaults', api.updateSettings, api.settingsSchema),
  get('setup', '/periods', "The week's teaching periods: a term's own, or the standing week", (a, q) => api.listPeriods(a, { termId: q.termId })),
  post('setup', '/periods/generate', 'Lay out days of periods in one go: first start, length, how many, breaks', api.generatePeriods, api.generatePeriodsSchema),
  post('setup', '/periods', 'Add one period', api.addPeriod, api.periodSchema),
  post('setup', '/periods/delete', 'Remove a period', api.deletePeriod),
  get('setup', '/rooms', 'Rooms with their kind and whether the solver may use them', (a) => api.listRooms(a)),
  post('setup', '/rooms', "Set a room's kind -- classroom, lab, hall -- or take it out of timetabling", api.setRoom, api.roomSchema),
  get('setup', '/sections', 'Cohorts with their planned size and the section each batch is part of', (a) => api.listSections(a)),
  post('setup', '/sections', "Set a cohort's planned size, or make it a batch of another section", api.setSection, api.sectionPlanSchema),
  get('setup', '/teachers', 'Teachers with their limits and how much they are eligible for', (a) => api.listTeachers(a)),
  post('setup', '/teachers', "Set a teacher's own limits: periods a day, a week, in a row", api.setTeacher, api.teacherSchema),
  get('setup', '/eligibility', 'Who may teach what -- by course, department, programme and year -- with preferences', (a, q) =>
    api.listEligibility(a, { userId: q.userId, courseId: q.courseId })),
  post('setup', '/eligibility', 'Say a teacher may teach something, and how keen they are', api.addEligibility, api.eligibilitySchema),
  post('setup', '/eligibility/delete', 'Remove an eligibility', api.deleteEligibility),
  post('setup', '/eligibility/import', 'Import eligibility from CSV: email, course, department, programme, year, preference', api.importEligibility),
  get('setup', '/unavailable', 'When teachers, rooms or cohorts cannot be booked', (a, q) => api.listUnavailable(a, { userId: q.userId })),
  post('setup', '/unavailable', 'Mark a teacher, room or cohort unavailable for a day or a period (a teacher marks only themselves)', api.addUnavailable, api.unavailableSchema),
  post('setup', '/unavailable/delete', 'Remove an unavailability', api.deleteUnavailable),

  // --- the term's classes ------------------------------------------------------------
  get('classes', '/needs', "A term's classes with their weekly needs and how many teachers may take each", (a, q) => api.listNeeds(a, { termId: required(q, 'termId') })),
  post('classes', '/needs', "Set a class's weekly need of one kind: lecture periods, lab blocks", api.setNeed, api.needSchema),
  post('classes', '/needs/delete', 'Remove a need', api.deleteNeed),
  post('classes', '/needs/defaults', 'Give every class without a need one from its credits', api.defaultNeeds, api.defaultNeedsSchema),
  get('classes', '/pins', "What the office has pinned for a term's classes", (a, q) => api.listPins(a, { termId: required(q, 'termId') })),
  post('classes', '/pins', "Pin a class's teacher, or a block's time and room", api.addPin, api.pinSchema),
  post('classes', '/pins/delete', 'Remove a pin', api.deletePin),
  get('classes', '/check', 'Whether a term is ready to timetable, and what will not fit', (a, q) => api.checkTerm(a, { termId: required(q, 'termId') })),

  // --- drafts and the live timetable ------------------------------------------------------
  post('runs', '/runs', 'Draft a timetable for a term with the local solver (nothing live changes)', api.generateRun, api.runSchema),
  get('runs', '/runs', 'Drafts and applied timetables, newest first', (a, q) => api.listRuns(a, { termId: q.termId })),
  get('runs', '/runs/detail', 'One draft: what it placed, what it could not and why, teacher changes', (a, q) => api.runDetail(a, { runId: required(q, 'runId') })),
  get('runs', '/runs/grid', "A draft seen through a cohort, a teacher or a room (sectionId, teacherId or roomId), or its index", (a, q) =>
    api.runGrid(a, { runId: required(q, 'runId'), sectionId: q.sectionId, teacherId: q.teacherId, roomId: q.roomId })),
  get('runs', '/runs/workload', "Each teacher's load in a draft, against their limits", (a, q) => api.workload(a, { runId: required(q, 'runId') })),
  post('runs', '/runs/apply', 'Make a draft the live timetable: slots replaced and teachers assigned in one go', api.applyRun),
  post('runs', '/runs/discard', 'Discard a draft', api.discardRun),
  post('runs', '/runs/pin', "Keep one of a draft's meetings -- time, teacher or both -- for the next run", api.pinEntry, api.pinEntrySchema),
  pdf('runs', '/runs/pdf', 'A draft printed: one cohort, teacher or room, or every one (all=sections|teachers|rooms)', (a, q) =>
    api.runPdf(a, { runId: required(q, 'runId'), sectionId: q.sectionId, teacherId: q.teacherId, roomId: q.roomId, all: q.all })),
  get('live', '/live', 'The live timetable seen through a cohort, a teacher or a room (a teacher sees their own)', (a, q) =>
    api.liveGrid(a, { termId: q.termId, sectionId: q.sectionId, teacherId: q.teacherId, roomId: q.roomId })),
  get('live', '/live/workload', "Each teacher's load in the live timetable", (a, q) => api.workload(a, { termId: q.termId })),
  pdf('live', '/live/pdf', 'The live timetable printed: one cohort, teacher or room, or every one (all=sections|teachers|rooms)', (a, q) =>
    api.livePdf(a, { termId: q.termId, sectionId: q.sectionId, teacherId: q.teacherId, roomId: q.roomId, all: q.all })),
  get('live', '/my', "The signed-in teacher's own week", (a) => api.myTimetable(a)),
  pdf('live', '/my/pdf', "The signed-in teacher's own week, printed", (a) => api.myPdf(a)),
]

export const routes: PluginRoute[] = specs.map((s) => ({ method: s.method, path: s.path, handler: s.handler, ...(s.raw ? { raw: true } : {}) }))
