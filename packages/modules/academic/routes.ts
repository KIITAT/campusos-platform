import { jsonBody, param, type PluginRoute } from '@campusos/module-framework'
import {
  addEquivalence,
  addPrerequisite,
  addSectionMember,
  createCourse,
  createDepartment,
  createOffering,
  createProgram,
  createRoom,
  createSection,
  createCurriculum,
  createRequirement,
  createSlot,
  createTerm,
  checkEligibility,
  correctCompletion,
  declareProgram,
  degreeAudit,
  endStudentProgram,
  getTimetable,
  listCompletions,
  listCurricula,
  listPrerequisites,
  listStudentPrograms,
  listWaivers,
  recordCompletion,
  setCurrentTerm,
  setTermCalendar,
  waivePrerequisite,
  type Actor,
} from './api'

/** Declared rather than mounted; the host dispatches and gates. */
const post = (path: string, op: (a: Actor, input: unknown) => Promise<unknown>): PluginRoute => ({
  method: 'POST',
  path,
  handler: async (actor, req) => op(actor as Actor, await jsonBody(req)),
})

export const routes: PluginRoute[] = [
  post('/departments', createDepartment),
  post('/programs', createProgram),
  post('/courses', createCourse),
  post('/rooms', createRoom),
  post('/terms', createTerm),
  post('/terms/current', setCurrentTerm),
  post('/sections', createSection),
  post('/sections/members', addSectionMember),
  post('/offerings', createOffering),
  post('/slots', createSlot),
  { method: 'GET', path: '/timetable', handler: (actor) => getTimetable(actor as Actor) },

  // The registrar's half: what a degree requires, what a course requires, and
  // what a named student has actually done.
  post('/terms/calendar', setTermCalendar),
  post('/curricula', createCurriculum),
  post('/requirements', createRequirement),
  post('/prerequisites', addPrerequisite),
  post('/prerequisites/waivers', waivePrerequisite),
  post('/equivalences', addEquivalence),
  post('/students/programs', declareProgram),
  post('/students/programs/end', endStudentProgram),
  post('/completions', recordCompletion),
  post('/eligibility', checkEligibility),
  post('/completions/correct', correctCompletion),
  post('/degree-audit', degreeAudit),

  { method: 'GET', path: '/curricula', handler: (actor) => listCurricula(actor as Actor) },
  {
    method: 'GET',
    path: '/prerequisites',
    handler: (actor) => listPrerequisites(actor as Actor),
  },
  {
    method: 'GET',
    path: '/prerequisites/waivers',
    handler: (actor) => listWaivers(actor as Actor),
  },
  {
    method: 'GET',
    path: '/students/programs',
    handler: (actor, req) =>
      listStudentPrograms(actor as Actor, {
        studentId: param(req, 'studentId') ?? undefined,
      }),
  },
  {
    method: 'GET',
    path: '/completions',
    handler: (actor, req) =>
      listCompletions(actor as Actor, {
        studentId: param(req, 'studentId') ?? undefined,
      }),
  },
]
