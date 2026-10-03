import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * A correlated subquery names the outer row by table, never by a Drizzle
 * column.
 *
 * Drizzle prints `${table.column}` unqualified when the outer select has no
 * join -- `"id"`, not `"library_titles"."id"`. Inside a subquery that bare name
 * binds to the subquery's own table first, so `c.title_id = "id"` compares a
 * copy with itself and the count is silently wrong; with a join inside, it is
 * ambiguous and the page fails. Neither shows until a list is read with data
 * in it. Writing `library_titles.id` says which row is meant, whatever the
 * outer query looks like.
 */

const MODULES = join(import.meta.dirname, '..', '..', 'modules')

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    if (f === 'node_modules' || f === 'dist') return []
    if (statSync(p).isDirectory()) return sources(p)
    return /\.ts$/.test(f) && !f.endsWith('.test.ts') ? [p] : []
  })

/** Names that are tables here: imported from a schema or the core, or declared with pgTable. */
function tablesIn(text: string): Set<string> {
  const names = new Set<string>()
  for (const m of text.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*'([^']+)'/g)) {
    if (!/schema$|^@campusos\/db$/.test(m[2]!)) continue
    for (const part of m[1]!.split(',')) {
      const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()!.trim()
      if (name) names.add(name)
    }
  }
  for (const m of text.matchAll(/(?:const|let)\s+(\w+)\s*=\s*pgTable\(/g)) names.add(m[1]!)
  return names
}

test('no correlated subquery refers to the outer row through a Drizzle column', () => {
  const found: string[] = []
  for (const file of sources(MODULES)) {
    const text = readFileSync(file, 'utf8')
    const tables = tablesIn(text)
    // Every sql`...` template, then any `(select` in it that interpolates a
    // table's column. `${row.id}` is a bound value and fine; `${titles.id}` is
    // the trap.
    for (const m of text.matchAll(/sql(?:<[^>]*>)?`([^`]*)`/g)) {
      const body = m[1]!
      const sub = body.indexOf('(select')
      if (sub === -1) continue
      for (const col of body.slice(sub).matchAll(/\$\{(\w+)\.\w+\}/g)) {
        if (!tables.has(col[1]!)) continue
        const line = text.slice(0, m.index).split('\n').length
        found.push(`${relative(MODULES, file)}:${line} \${${col[0].slice(2, -1)}}`)
      }
    }
  }
  assert.deepEqual(found, [], `name the outer table in the SQL instead:\n${found.join('\n')}`)
})
