import * as z from 'zod'
import { roleEnum } from '@campusos/db'

/**
 * One source of truth per concept. `roleEnum.enumValues` comes from the
 * Postgres enum, so a role added to the database is automatically accepted by
 * the API and appears in the generated OpenAPI spec -- and one added only to
 * the API is a type error.
 */
export const roleSchema = z
  .enum(roleEnum.enumValues)
  .meta({ id: 'Role', description: 'A user role within an institution' })

export const pricingModelSchema = z
  .enum(['included_in_base', 'flat_monthly', 'per_student_monthly', 'not_priced_yet'])
  .meta({ id: 'PricingModel' })

export const slugSchema = z
  .string()
  .min(2)
  .max(40)
  // Must survive being a DNS label: this becomes a tenant subdomain.
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'lowercase letters, digits and hyphens only')
  .meta({ id: 'Slug', example: 'xyzcollege' })

export const emailDomainSchema = z
  .string()
  .min(3)
  .max(253)
  .toLowerCase()
  .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, 'a bare domain, without @')
  .meta({ id: 'EmailDomain', example: 'xyzcollege.edu.in' })

export const institutionSchema = z
  .object({
    id: z.uuid(),
    slug: slugSchema,
    name: z.string().min(1).max(200),
    customDomain: z.string().nullable(),
    allowedEmailDomains: z.array(emailDomainSchema),
    suspendedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'Institution' })

export const createInstitutionSchema = z
  .object({
    slug: slugSchema,
    name: z.string().min(1).max(200),
    // At least one: an institution with no allowed domain can never be signed
    // into, which looks like a broken deploy rather than a config mistake.
    allowedEmailDomains: z.array(emailDomainSchema).min(1),
    customDomain: z.string().max(253).nullish(),
  })
  .meta({ id: 'CreateInstitution' })

export const assignRoleSchema = z
  .object({
    userId: z.string().min(1),
    // `pending` is the state a user arrives in, never one an admin assigns.
    role: roleSchema.exclude(['pending']),
  })
  .meta({ id: 'AssignRole' })

export const toggleModuleSchema = z
  .object({
    institutionId: z.uuid(),
    moduleId: z.string().min(1).max(64),
    enabled: z.boolean(),
  })
  .meta({ id: 'ToggleModule' })

/** GET /api/v1/me -- what the Flutter shell conditions its navigation on. */
export const meSchema = z
  .object({
    id: z.string(),
    email: z.email(),
    name: z.string().nullable(),
    role: roleSchema,
    institutionId: z.uuid().nullable(),
    institutionSlug: z.string().nullable(),
    enabledModules: z.array(z.string()),
  })
  .meta({ id: 'Me' })

export const errorSchema = z
  .object({ error: z.string(), message: z.string() })
  .meta({ id: 'Error' })

/**
 * The 403 body a gated module returns. Carries enough for the client to render
 * "ask your admin to enable this" without a second round trip.
 */
export const moduleDeniedSchema = z
  .object({
    error: z.literal('module_not_enabled'),
    moduleId: z.string(),
    name: z.string(),
    pricing: z.object({ model: pricingModelSchema, priceINR: z.number().nullable() }),
  })
  .meta({ id: 'ModuleDenied' })

export type Me = z.infer<typeof meSchema>
export type CreateInstitution = z.infer<typeof createInstitutionSchema>
export type AssignRole = z.infer<typeof assignRoleSchema>
export type ToggleModule = z.infer<typeof toggleModuleSchema>
export type ModuleDenied = z.infer<typeof moduleDeniedSchema>
