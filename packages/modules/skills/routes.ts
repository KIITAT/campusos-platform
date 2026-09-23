import { jsonBody, requiredParam, type PluginRoute } from '@campusos/module-framework'
import {
  addLevel,
  assess,
  coverage,
  createFramework,
  createSkill,
  frameworkView,
  listFrameworks,
  listStudents,
  profile,
  retireSkill,
  selfAssess,
  type Actor,
} from './api'

const post = (path: string, fn: (a: Actor, body: unknown) => Promise<unknown>): PluginRoute => ({
  method: 'POST',
  path,
  handler: async (a, req) => fn(a as Actor, await jsonBody(req)),
})

export const routes: PluginRoute[] = [
  { method: 'GET', path: '/frameworks', handler: (a) => listFrameworks(a as Actor) },
  post('/frameworks', createFramework),
  {
    method: 'GET',
    path: '/framework',
    handler: (a, req) => frameworkView(a as Actor, requiredParam(req, 'frameworkId')),
  },
  post('/levels', addLevel),
  post('/skills', createSkill),
  post('/skills/retire', retireSkill),
  { method: 'GET', path: '/students', handler: (a) => listStudents(a as Actor) },
  {
    method: 'GET',
    path: '/profile',
    handler: (a, req) => profile(a as Actor, requiredParam(req, 'studentId')),
  },
  { method: 'GET', path: '/me', handler: (a) => profile(a as Actor, (a as Actor).id) },
  post('/assess', assess),
  post('/self-assess', selfAssess),
  { method: 'GET', path: '/coverage', handler: (a) => coverage(a as Actor) },
]
