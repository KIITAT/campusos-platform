// Refuses destructive DDL in new migrations (P1-11, DATA-04, decision 383).
// A migration released while an older web replica can still be serving must be
// expand-only. Contract changes are marked "-- campusos:contract <reason>" and
// ship in a later release. Rules: docs/techandarch/migrations.md (KIITAT).
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const RULES = [
  ['drop table', /\bdrop\s+table\b/],
  ['drop column', /\bdrop\s+column\b/],
  ['drop view', /\bdrop\s+(materialized\s+)?view\b/],
  ['drop function', /\bdrop\s+function\b/],
  ['drop type', /\bdrop\s+type\b/],
  ['drop schema', /\bdrop\s+schema\b/],
  ['rename', /\brename\s+(to|column)\b/],
  ['set not null', /\balter\s+column\s+\S+\s+set\s+not\s+null\b/],
  ['column type change', /\balter\s+column\s+\S+\s+(set\s+data\s+)?type\b/],
  ['truncate', /\btruncate\b/],
  [
    'not null column without default',
    /\badd\s+column\s+(if\s+not\s+exists\s+)?[^;,]*\bnot\s+null\b(?![^;,]*\bdefault\b)/,
  ],
]

export function lintSql(text) {
  if (/^-- campusos:contract (.{10,})$/m.test(text)) return []
  const sql = text.replace(/--[^\n]*/g, '').toLowerCase()
  return RULES.filter(([, re]) => re.test(sql)).map(([name]) => name)
}

function migrationFiles(root) {
  const dirs = ['packages/db/migrations']
  const modules = join(root, 'packages/modules')
  if (existsSync(modules)) {
    for (const m of readdirSync(modules).sort()) dirs.push(`packages/modules/${m}/migrations`)
  }
  const files = []
  for (const d of dirs) {
    if (!existsSync(join(root, d))) continue
    for (const f of readdirSync(join(root, d)).sort()) if (f.endsWith('.sql')) files.push(`${d}/${f}`)
  }
  return files
}

export function lintFiles(root, baseline) {
  const messages = []
  for (const path of migrationFiles(root)) {
    if (baseline.has(path)) continue
    for (const rule of lintSql(readFileSync(join(root, path), 'utf8'))) {
      messages.push(
        `${path}: ${rule} is a contract change; ship it after the code stops using it and mark the file "-- campusos:contract <reason>" (docs/techandarch/migrations.md)`,
      )
    }
  }
  return messages
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(import.meta.dirname, '..')
  const baselineFile = join(root, 'scripts', 'migration-lint.baseline.txt')
  if (process.argv.includes('--write-baseline')) {
    writeFileSync(baselineFile, migrationFiles(root).join('\n') + '\n')
    process.exit(0)
  }
  const baseline = new Set(readFileSync(baselineFile, 'utf8').split('\n').filter(Boolean))
  const messages = lintFiles(root, baseline)
  if (messages.length) {
    console.error(messages.join('\n'))
    process.exit(1)
  }
  console.log(`migration lint: ok (${migrationFiles(root).filter((f) => !baseline.has(f)).length} files checked)`)
}
