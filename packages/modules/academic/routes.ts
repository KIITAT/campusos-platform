import { jsonBody, type PluginRoute } from '@campusos/module-framework'
import {
  addSectionMember,
  createCourse,
  createDepartment,
  createOffering,
  createProgram,
  createRoom,
  createSection,
  createSlot,
  createTerm,
  getTimetable,
  setCurrentTerm,
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
]
