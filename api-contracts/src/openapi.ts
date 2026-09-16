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
import { paths as libraryPaths } from '@campusos/module-library/api/openapi'
import {
  assignRoleSchema,
  createInstitutionSchema,
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
