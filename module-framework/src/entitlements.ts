import { and, eq } from 'drizzle-orm'
import { db, institutionModules } from '@campusos/db'
import { getManifest } from './registry'
import type { ModuleDeniedPayload, ModuleManifest } from './types'

/**
 * Entitlement lookup runs against the control plane, outside any tenant
 * transaction -- institution_modules is deliberately not RLS-scoped (spec 3.4)
 * because requireModule() has to answer before tenant context exists.
 */
export async function getEnabledModules(
  manifests: ModuleManifest[],
  institutionId: string,
): Promise<string[]> {
  const rows = await db
    .select({ moduleId: institutionModules.moduleId })
    .from(institutionModules)
    .where(
      and(
        eq(institutionModules.institutionId, institutionId),
        eq(institutionModules.enabled, true),
      ),
    )

  const enabled = new Set(rows.map((r) => r.moduleId))
  for (const m of manifests) if (m.alwaysEnabled) enabled.add(m.id)
  return [...enabled]
}

export class ModuleDeniedError extends Error {
  constructor(readonly payload: ModuleDeniedPayload) {
    super(`module not enabled: ${payload.moduleId}`)
  }
}

/**
 * Gate for every module route handler and module page layout.
 *
 * This is a product/billing control, not a security boundary -- RLS is what
 * actually stops cross-tenant reads. Never rely on this alone to protect data.
 */
export async function requireModule(
  manifests: ModuleManifest[],
  moduleId: string,
  institutionId: string,
): Promise<void> {
  const manifest = getManifest(manifests, moduleId)
  if (!manifest) throw new Error(`unregistered module: ${moduleId}`)
  if (manifest.alwaysEnabled) return

  const [row] = await db
    .select({ enabled: institutionModules.enabled })
    .from(institutionModules)
    .where(
      and(
        eq(institutionModules.institutionId, institutionId),
        eq(institutionModules.moduleId, moduleId),
      ),
    )

  if (row?.enabled) return

  throw new ModuleDeniedError({
    moduleId,
    name: manifest.name,
    pricing: manifest.pricing,
  })
}

/**
 * Refuses to enable a module whose hard dependencies are not themselves
 * enabled. softDependsOn is intentionally not checked: those degrade.
 */
export async function assertDependenciesEnabled(
  manifests: ModuleManifest[],
  moduleId: string,
  institutionId: string,
): Promise<void> {
  const manifest = getManifest(manifests, moduleId)
  if (!manifest) throw new Error(`unregistered module: ${moduleId}`)
  if (manifest.dependsOn.length === 0) return

  const enabled = new Set(await getEnabledModules(manifests, institutionId))
  const missing = manifest.dependsOn.filter((d) => !enabled.has(d))
  if (missing.length) {
    throw new Error(
      `cannot enable ${moduleId}: requires ${missing.join(', ')} to be enabled first`,
    )
  }
}
