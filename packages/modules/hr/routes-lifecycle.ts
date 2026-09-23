import { jsonBody, param, requiredParam, type PluginRoute } from '@campusos/module-framework'
import {
  completeOnboardingActivity,
  createGrade,
  createOnboardingTemplate,
  exitInterviewsOutstanding,
  gradeUsage,
  listChanges,
  listOnboardingTemplates,
  listSeparations,
  onboardingFor,
  openOnboardings,
  recordChange,
  recordExitInterview,
  separate,
  serviceDays,
  startOnboarding,
  type Actor,
} from './api'

/**
 * The employment lifecycle, as routes.
 *
 * A file of its own because hr's route table stopped fitting on a screen the
 * moment HR became the whole of HR rather than payroll with a staff list.
 */

export const lifecycleRoutes: PluginRoute[] = [
  { method: 'GET', path: '/grades', handler: (actor) => gradeUsage(actor as Actor) },
  {
    method: 'POST',
    path: '/grades',
    handler: async (actor, req) => createGrade(actor as Actor, await jsonBody(req)),
  },

  {
    method: 'GET',
    path: '/onboarding/templates',
    handler: (actor) => listOnboardingTemplates(actor as Actor),
  },
  {
    method: 'POST',
    path: '/onboarding/templates',
    handler: async (actor, req) =>
      createOnboardingTemplate(actor as Actor, await jsonBody(req)),
  },
  {
    method: 'GET',
    path: '/onboarding',
    handler: (actor, req) => onboardingFor(actor as Actor, requiredParam(req, 'staffId')),
  },
  {
    method: 'POST',
    path: '/onboarding',
    handler: async (actor, req) => startOnboarding(actor as Actor, await jsonBody(req)),
  },
  {
    method: 'GET',
    path: '/onboarding/open',
    handler: (actor) => openOnboardings(actor as Actor),
  },
  {
    method: 'POST',
    path: '/onboarding/complete',
    handler: async (actor, req) =>
      completeOnboardingActivity(actor as Actor, await jsonBody(req)),
  },

  {
    method: 'GET',
    path: '/changes',
    handler: (actor, req) => listChanges(actor as Actor, param(req, 'staffId')),
  },
  {
    method: 'POST',
    path: '/changes',
    handler: async (actor, req) => recordChange(actor as Actor, await jsonBody(req)),
  },

  { method: 'GET', path: '/separations', handler: (actor) => listSeparations(actor as Actor) },
  {
    method: 'POST',
    path: '/separations',
    handler: async (actor, req) => separate(actor as Actor, await jsonBody(req)),
  },
  {
    method: 'GET',
    path: '/separations/outstanding',
    handler: (actor) => exitInterviewsOutstanding(actor as Actor),
  },
  {
    method: 'POST',
    path: '/separations/interview',
    handler: async (actor, req) =>
      recordExitInterview(actor as Actor, await jsonBody(req)),
  },

  {
    method: 'GET',
    path: '/service',
    handler: (actor, req) =>
      serviceDays(actor as Actor, requiredParam(req, 'staffId'), param(req, 'on')),
  },
]
