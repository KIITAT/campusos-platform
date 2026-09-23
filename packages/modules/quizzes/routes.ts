import { jsonBody, requiredParam, type PluginRoute } from '@campusos/module-framework'
import {
  addItems,
  attemptView,
  courseChoices,
  createQuestion,
  createQuiz,
  grantExtension,
  listQuestions,
  listQuizzes,
  myQuizzes,
  overrideResponse,
  publishQuiz,
  questionView,
  quizView,
  removeItems,
  retireQuestion,
  reviseQuestion,
  reviseQuiz,
  saveAnswers,
  startAttempt,
  submitAttempt,
  updateQuiz,
  withdrawQuiz,
  type Actor,
} from './api'

const post = (path: string, fn: (a: Actor, body: unknown) => Promise<unknown>): PluginRoute => ({
  method: 'POST',
  path,
  handler: async (a, req) => fn(a as Actor, await jsonBody(req)),
})

export const routes: PluginRoute[] = [
  { method: 'GET', path: '/courses', handler: (a) => courseChoices(a as Actor) },
  {
    method: 'GET',
    path: '/questions',
    handler: (a, req) => listQuestions(a as Actor, requiredParam(req, 'courseId')),
  },
  post('/questions', createQuestion),
  post('/questions/revise', reviseQuestion),
  post('/questions/retire', retireQuestion),
  {
    method: 'GET',
    path: '/question',
    handler: (a, req) => questionView(a as Actor, requiredParam(req, 'questionId')),
  },

  { method: 'GET', path: '/quizzes', handler: (a) => listQuizzes(a as Actor) },
  post('/quizzes', createQuiz),
  post('/quizzes/update', updateQuiz),
  { method: 'GET', path: '/quiz', handler: (a, req) => quizView(a as Actor, requiredParam(req, 'quizId')) },
  post('/quizzes/items', addItems),
  post('/quizzes/items/remove', removeItems),
  post('/quizzes/publish', publishQuiz),
  post('/quizzes/withdraw', withdrawQuiz),
  post('/quizzes/revise', reviseQuiz),
  post('/quizzes/extensions', grantExtension),

  { method: 'GET', path: '/me', handler: (a) => myQuizzes(a as Actor) },
  post('/attempts/start', startAttempt),
  post('/attempts/answers', saveAnswers),
  post('/attempts/submit', submitAttempt),
  {
    method: 'GET',
    path: '/attempt',
    handler: (a, req) => attemptView(a as Actor, requiredParam(req, 'attemptId')),
  },
  post('/responses/override', overrideResponse),
]
