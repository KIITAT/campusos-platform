import { jsonBody, requiredParam, type PluginRoute } from '@campusos/module-framework'
import {
  certificateDocument,
  certificateView,
  checkIn,
  clearHold,
  createCeremony,
  issueCertificates,
  listCandidates,
  listCeremonies,
  listCertificates,
  listHolds,
  myGraduation,
  placeHold,
  reissueCertificate,
  respond,
  revokeCertificate,
  runEligibility,
  setCeremonyStatus,
  verifyCertificate,
  type Actor,
} from './api'

const post = (path: string, fn: (a: Actor, body: unknown) => Promise<unknown>): PluginRoute => ({
  method: 'POST',
  path,
  handler: async (a, req) => fn(a as Actor, await jsonBody(req)),
})

export const routes: PluginRoute[] = [
  { method: 'GET', path: '/ceremonies', handler: (a) => listCeremonies(a as Actor) },
  post('/ceremonies', createCeremony),
  post('/ceremonies/status', setCeremonyStatus),
  post('/ceremonies/eligibility', runEligibility),
  {
    method: 'GET',
    path: '/candidates',
    handler: (a, req) => listCandidates(a as Actor, requiredParam(req, 'ceremonyId')),
  },
  { method: 'GET', path: '/holds', handler: (a, req) => listHolds(a as Actor, requiredParam(req, 'ceremonyId')) },
  post('/holds', placeHold),
  post('/holds/clear', clearHold),
  post('/respond', respond),
  post('/checkin', checkIn),
  { method: 'GET', path: '/me', handler: (a) => myGraduation(a as Actor) },
  {
    method: 'GET',
    path: '/certificates',
    handler: (a, req) => listCertificates(a as Actor, new URL(req.url).searchParams.get('ceremonyId') ?? undefined),
  },
  post('/certificates/issue', issueCertificates),
  post('/certificates/revoke', revokeCertificate),
  post('/certificates/reissue', reissueCertificate),
  {
    method: 'GET',
    path: '/certificate',
    handler: (a, req) => certificateView(a as Actor, requiredParam(req, 'certificateId')),
  },
  {
    method: 'GET',
    path: '/certificate.pdf',
    raw: true,
    handler: async (a, req) => {
      const { bytes, serial } = await certificateDocument(a as Actor, requiredParam(req, 'certificateId'))
      return new Response(bytes as unknown as BodyInit, {
        headers: {
          'content-type': 'application/pdf',
          'content-disposition': `inline; filename="certificate-${serial}.pdf"`,
        },
      })
    },
  },
  {
    method: 'GET',
    path: '/verify',
    handler: (a, req) => verifyCertificate(a as Actor, { code: requiredParam(req, 'code') }),
  },
]
