/**
 * Draft the SQL for new tables in a module's schema.
 *
 *   node --import tsx scripts/module-ddl.mts packages/modules/hr/schema.ts \
 *     jobRequisitions jobOpenings requisitionStatusEnum ...
 *
 * Module migrations are plain SQL that travels in the plugin archive, not a
 * drizzle-kit history, so there is no snapshot to diff against. This diffs the
 * named exports against nothing and prints what drizzle-kit would create --
 * enums, tables, foreign keys, indexes, row level security and policies -- as
 * a starting point. Triggers and the reasons for them are still written by
 * hand, which is the part worth a human reading.
 */
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(resolve(import.meta.dirname, '../packages/db/package.json'))
const { generateDrizzleJson, generateMigration } = require('drizzle-kit/api') as {
  generateDrizzleJson: (imports: Record<string, unknown>) => unknown
  generateMigration: (prev: unknown, cur: unknown) => Promise<string[]>
}

const [file, ...names] = process.argv.slice(2)
if (!file || names.length === 0) {
  console.error('usage: module-ddl.mts <schema.ts> <export> [export...]')
  process.exit(1)
}

const mod = (await import(pathToFileURL(resolve(file)).href)) as Record<string, unknown>
const picked: Record<string, unknown> = {}
for (const n of names) {
  if (!(n in mod)) {
    console.error(`no export named ${n} in ${file}`)
    process.exit(1)
  }
  picked[n] = mod[n]
}

const statements = await generateMigration(generateDrizzleJson({}), generateDrizzleJson(picked))
console.log(statements.join('--> statement-breakpoint\n'))
process.exit(0)
