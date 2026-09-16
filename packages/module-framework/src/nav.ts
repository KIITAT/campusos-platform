import type { ModuleManifest, Role } from './types'

export interface NavEntry {
  moduleId: string
  label: string
  href: string
}

/**
 * Builds the sidebar. A module the institution has not enabled contributes
 * nothing -- it is absent from the nav, not rendered-and-blocked, so a disabled
 * module is never discoverable (spec 3.5).
 */
export function buildNav(
  manifests: ModuleManifest[],
  enabledModules: string[],
  role: Role,
): NavEntry[] {
  const enabled = new Set(enabledModules)
  return manifests
    .filter((m) => m.alwaysEnabled || enabled.has(m.id))
    .filter((m) => m.rolesWithAccess.includes(role))
    .flatMap((m) =>
      m.navEntries
        .filter((e) => e.roles.includes(role))
        .map((e) => ({ moduleId: m.id, label: e.label, href: e.href })),
    )
}
