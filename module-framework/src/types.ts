import type { roleEnum } from '@campusos/db'

export type PricingModel =
  | 'included_in_base'
  | 'flat_monthly'
  | 'per_student_monthly'
  | 'not_priced_yet'

/**
 * Derived from the Postgres enum rather than re-declared, so adding a role in
 * one place and forgetting the other is a type error instead of a runtime
 * surprise in a nav filter.
 */
export type Role = (typeof roleEnum.enumValues)[number]

export interface ModuleManifest {
  id: string
  name: string
  description: string
  version: string
  /** Core/bundled modules: always on, never checked against entitlements. */
  alwaysEnabled: boolean
  /** Hard requirement. Enabling this module without these is refused. */
  dependsOn: string[]
  /**
   * Optional integrations. A module lists a peer here when it can use it but
   * degrades gracefully without it -- e.g. hostel attendance reuses the
   * attendance module's sessions when enabled, and falls back to manual
   * check-in when not (spec phase 6).
   */
  softDependsOn?: string[]
  pricing: { model: PricingModel; priceINR: number | null }
  rolesWithAccess: Role[]
  navEntries: { label: string; href: string; roles: Role[] }[]
  apiBasePath: string
}

/** 403 body when a module is gated off. The UI turns this into an upsell. */
export interface ModuleDeniedPayload {
  moduleId: string
  name: string
  pricing: ModuleManifest['pricing']
}
