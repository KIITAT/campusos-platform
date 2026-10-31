import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { test } from 'node:test'

/**
 * Admission, enrolment and fees never depend on the APAAR ID or the consent to
 * it (P1-08b, D15; FUNC-09). Only academic keeps them, and the parents page
 * shows them: any other module naming APAAR is a dependency by another door.
 */

const modules = join(import.meta.dirname, '..', 'packages', 'modules')
const allowed = (path) => path.startsWith(`academic${sep}`) || path === join('parents', 'pages.ts')

function* sources(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* sources(path)
    else if (entry.name.endsWith('.ts')) yield path
  }
}

test('no module but academic reads the APAAR ID or its consent', () => {
  const found = [...sources(modules)]
    .map((p) => relative(modules, p))
    .filter((p) => !allowed(p))
    .filter((p) => /apaar/i.test(readFileSync(join(modules, p), 'utf8')))
  assert.deepEqual(found, [], `these files name APAAR: ${found.join(', ')}`)
})
