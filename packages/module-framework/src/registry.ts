import type { ModuleManifest } from './types'

/**
 * Registry helpers, deliberately with no registry of their own.
 *
 * The list of modules is composed by the application (see apps/web/lib/modules.ts),
 * not by this package. If the framework imported the modules, and a module
 * imported requireModule from the framework -- which every module route does --
 * that would be a genuine runtime cycle. Composition belongs above both.
 */

export const getManifest = (
  manifests: ModuleManifest[],
  id: string,
): ModuleManifest | undefined => manifests.find((m) => m.id === id)

/**
 * Throws on a registry that cannot be satisfied. Call it once where the registry
 * is composed, so a bad manifest fails at import time rather than on the first
 * request that needs it.
 */
export function validateRegistry(manifests: ModuleManifest[]): void {
  const ids = new Set<string>()
  for (const m of manifests) {
    if (ids.has(m.id)) throw new Error(`duplicate module id: ${m.id}`)
    ids.add(m.id)
  }

  // Only hard dependencies must be present. A soft one is exactly a module
  // that may not be installed -- library posts fines to finance when finance
  // is there and keeps its own ledger when it is not -- so demanding it here
  // made every server without finance fail to list its modules at all.
  for (const m of manifests) {
    for (const dep of m.dependsOn) {
      if (!ids.has(dep)) throw new Error(`${m.id} depends on unknown module: ${dep}`)
    }
  }

  // Cycles in dependsOn would make "enable with its dependencies" unresolvable.
  const state = new Map<string, 'visiting' | 'done'>()
  const walk = (id: string, path: string[]): void => {
    if (state.get(id) === 'done') return
    if (state.get(id) === 'visiting') {
      throw new Error(`dependsOn cycle: ${[...path, id].join(' -> ')}`)
    }
    state.set(id, 'visiting')
    for (const dep of getManifest(manifests, id)?.dependsOn ?? []) {
      walk(dep, [...path, id])
    }
    state.set(id, 'done')
  }
  for (const m of manifests) walk(m.id, [])
}
