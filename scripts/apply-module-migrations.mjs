import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * Apply every module's migrations on top of the core baseline, in dependency
 * order, the way a host does when the modules are installed as plugins.
 *
 * The core history is drizzle-kit's and is checked by `db:check`. A module's is
 * not: it is plain SQL that travels in the plugin archive, and the only way to
 * know it still applies is to apply it. A plugin that installs and then fails
 * its first query because a table was never created is the failure this
 * prevents, and it is much cheaper to find here than at an institution.
 */

const ROOT = resolve(import.meta.dirname, '..')
const MODULES = join(ROOT, 'packages', 'modules')

const url = process.env.MIGRATION_DATABASE_URL
if (!url) {
  console.error('MIGRATION_DATABASE_URL is required')
  process.exit(1)
}

/** Read each manifest's dependsOn without compiling TypeScript. */
function dependenciesOf(id) {
  const src = readFileSync(join(MODULES, id, 'manifest.ts'), 'utf8')
  const match = src.match(/dependsOn:\s*\[([^\]]*)\]/)
  if (!match) return []
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
}

const ids = readdirSync(MODULES).filter((d) =>
  existsSync(join(MODULES, d, 'package.json')),
)

// Topological: a module's foreign keys point at its dependencies' tables, so
// academic has to exist before anything that references an offering.
const ordered = []
const seen = new Set()
const visit = (id, trail = []) => {
  if (seen.has(id)) return
  if (trail.includes(id)) throw new Error(`dependency cycle: ${[...trail, id].join(' -> ')}`)
  for (const dep of dependenciesOf(id)) {
    if (ids.includes(dep)) visit(dep, [...trail, id])
  }
  seen.add(id)
  ordered.push(id)
}
for (const id of ids) visit(id)

let applied = 0
for (const id of ordered) {
  const dir = join(MODULES, id, 'migrations')
  if (!existsSync(dir)) continue

  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    // The breakpoint marker is drizzle-kit's, for splitting statements; psql
    // does not know it and does not need to.
    const sql = readFileSync(join(dir, file), 'utf8').replaceAll(
      '--> statement-breakpoint',
      '',
    )
    try {
      execFileSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-q'], {
        input: sql,
        stdio: ['pipe', 'inherit', 'inherit'],
      })
      applied++
    } catch (e) {
      // psql has already printed a SQL error above. What it cannot print is
      // its own absence, which used to look exactly like a broken migration.
      const why = e?.code === 'ENOENT' ? ' (psql is not installed or not on PATH)' : ''
      console.error(`\nfailed: ${id}/${file}${why}`)
      process.exit(1)
    }
  }
  console.log(`applied ${id}`)
}

console.log(`\n${applied} migrations across ${ordered.length} modules`)
