import { writeFileSync } from 'node:fs'
import type { ZodType } from 'zod'
import { createDocument } from 'zod-openapi'
// One line per module, mirroring the registry in apps/web/lib/modules.ts.
import { paths as academicPaths } from '@campusos/module-academic/api/openapi'
import { paths as attendancePaths } from '@campusos/module-attendance/api/openapi'
import { paths as examinationPaths } from '@campusos/module-examinations/api/openapi'
import { paths as feePaths } from '@campusos/module-fees/api/openapi'
import { paths as hostelPaths } from '@campusos/module-hostel/api/openapi'
import { paths as hrPaths } from '@campusos/module-hr/api/openapi'
import { paths as noticePaths } from '@campusos/module-notices/api/openapi'
import { paths as parentPaths } from '@campusos/module-parents/api/openapi'
import { paths as libraryPaths } from '@campusos/module-library/api/openapi'
import {
  assignRoleSchema,
  consentStateSchema,
  createInstitutionSchema,
  eraseUserSchema,
  errorSchema,
  institutionSchema,
  meSchema,
  moduleDeniedSchema,
  toggleModuleSchema,
} from './schemas'

const json = (schema: ZodType) => ({ 'application/json': { schema } })

/**
 * The generated spec is what the Flutter client codegens from, so it is the
 * contract -- not documentation written after the fact. Every module phase adds
 * its paths here rather than hand-writing Dart HTTP calls.
 */
export const document = createDocument({
  openapi: '3.1.0',
  info: {
    title: 'CampusOS API',
    version: '0.0.0',
    description:
      'Multi-tenant college ERP. Tenant is resolved from the request host; ' +
      'every tenant-scoped read is additionally enforced by Postgres RLS.',
  },
  paths: {
    '/api/v1/me': {
      get: {
        summary: 'The signed-in user, their role, and the modules their institution has enabled',
        responses: {
          '200': { description: 'OK', content: json(meSchema) },
          '401': { description: 'Not signed in', content: json(errorSchema) },
        },
      },
    },
    '/api/v1/institutions': {
      post: {
        summary: 'Create an institution (super_admin only)',
        requestBody: { content: json(createInstitutionSchema) },
        responses: {
          '201': { description: 'Created', content: json(institutionSchema) },
          '403': { description: 'Forbidden', content: json(errorSchema) },
          '409': { description: 'Slug or email domain already taken', content: json(errorSchema) },
        },
      },
    },
    '/api/v1/users/role': {
      post: {
        summary: 'Approve a pending user and assign a role (institution_admin or super_admin)',
        requestBody: { content: json(assignRoleSchema) },
        responses: {
          '204': { description: 'Assigned' },
          '403': { description: 'Forbidden', content: json(errorSchema) },
          '404': { description: 'No such user in this institution', content: json(errorSchema) },
        },
      },
    },
    '/api/v1/devices': {
      get: {
        summary: 'Devices paired to this account',
        responses: { '200': { description: 'OK' } },
      },
      post: {
        summary: 'Generate a pairing code for a phone',
        description:
          'Six characters, ten minutes, single use. It exists so the long-lived device token ' +
          'never travels through a screenshot or a chat message.',
        responses: { '200': { description: 'A code, shown once' } },
      },
    },
    '/api/v1/devices/claim': {
      post: {
        summary: 'Exchange a pairing code for a device token',
        description:
          'The one unauthenticated endpoint that grants a credential -- the phone has none yet. ' +
          'A wrong, expired or malformed code returns the same 401, so guessing learns nothing. ' +
          'The token is then sent as `Authorization: Bearer`; everything downstream (the module ' +
          'gate, each operation’s own checks, RLS) is identical to a browser session, so the ' +
          'mobile client can never reach anything the web client cannot.',
        responses: {
          '200': { description: 'A device token, shown once' },
          '401': { description: 'Not a valid code', content: json(errorSchema) },
        },
      },
    },
    '/api/v1/devices/revoke': {
      post: {
        summary: 'Revoke a device immediately',
        responses: {
          '204': { description: 'Revoked' },
          '404': { description: 'No such device', content: json(errorSchema) },
        },
      },
    },
    '/api/v1/me/consent': {
      get: {
        summary: 'Whether this person has agreed to the privacy notice in force',
        responses: {
          '200': { description: 'OK', content: json(consentStateSchema) },
          '401': { description: 'Not signed in', content: json(errorSchema) },
        },
      },
      post: {
        summary: 'Record consent to the notice currently in force',
        description:
          'The version shown is stored alongside, so "what did they agree to" has an answer ' +
          'after the notice is rewritten.',
        responses: { '204': { description: 'Recorded' } },
      },
    },
    '/api/v1/me/export': {
      get: {
        summary: 'Everything held about one person, as JSON',
        description:
          'Assembled by walking the foreign keys to `users`, so a module added next year is ' +
          'covered without anybody remembering to edit an export list.',
        responses: {
          '200': { description: 'OK' },
          '403': { description: 'Not yours to export', content: json(errorSchema) },
        },
      },
    },
    '/api/v1/users/erase': {
      post: {
        summary: 'Erase a person, keeping the institution’s records',
        description:
          'Anonymisation, not deletion: a fee receipt, a mark and an attendance register are ' +
          'the institution’s own records with their own retention obligations. The identifying ' +
          'fields go and the rows that referenced them become unattributable. Refused for the ' +
          'last remaining administrator.',
        requestBody: { content: json(eraseUserSchema) },
        responses: {
          '200': { description: 'Erased' },
          '403': { description: 'Forbidden', content: json(errorSchema) },
          '409': { description: 'That is the only administrator', content: json(errorSchema) },
        },
      },
    },
    '/api/v1/modules/toggle': {
      post: {
        summary: 'Enable or disable a module for an institution (super_admin only)',
        requestBody: { content: json(toggleModuleSchema) },
        responses: {
          '204': { description: 'Toggled' },
          '403': { description: 'Forbidden', content: json(errorSchema) },
          '409': {
            description: 'Dependencies not enabled',
            content: json(errorSchema),
          },
        },
      },
    },

    // Module-contributed paths.
    ...academicPaths,
    ...attendancePaths,
    ...examinationPaths,
    ...feePaths,
    ...libraryPaths,
    ...hostelPaths,
    ...hrPaths,
    ...noticePaths,
    ...parentPaths,
  },
  components: {
    schemas: {
      // Referenced so the shared 403 shape lands in the spec even though no
      // module route exists yet to return it.
      ModuleDenied: moduleDeniedSchema,
    },
  },
})

// `tsx src/openapi.ts` regenerates the committed spec; CI fails on drift.
if (process.argv[1]?.endsWith('openapi.ts')) {
  const out = new URL('../openapi.json', import.meta.url)
  writeFileSync(out, JSON.stringify(document, null, 2) + '\n')
  console.log(`wrote ${out.pathname}`)
}
