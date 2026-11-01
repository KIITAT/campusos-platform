import type { Role } from '@campusos/module-framework'

/**
 * Who may call each route (decision 192). The host refuses every other role
 * before the handler runs; each operation keeps its own check, because page
 * loaders call it in-process. A new route without an entry here fails at load.
 */
export const routeRoles: Record<string, readonly Role[]> = {}
