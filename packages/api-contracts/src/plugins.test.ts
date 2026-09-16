import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { matchRoute, pluginPaths, type Plugin } from '@campusos/module-framework'

import academic from '@campusos/module-academic/plugin'
import attendance from '@campusos/module-attendance/plugin'
import examinations from '@campusos/module-examinations/plugin'
import fees from '@campusos/module-fees/plugin'
import library from '@campusos/module-library/plugin'
import hostel from '@campusos/module-hostel/plugin'
import hr from '@campusos/module-hr/plugin'
import notices from '@campusos/module-notices/plugin'
import parents from '@campusos/module-parents/plugin'

/**
 * Every module, as the host will see it after installing the package.
 *
 * Importing each `plugin` entry already runs `validatePlugin` at module scope,
 * so simply getting this far proves none of them declares a route outside its
 * own base path, a duplicate, or an apiBasePath that contradicts its id.
 */
const PLUGINS: Plugin[] = [
  academic,
  attendance,
  examinations,
  fees,
  library,
  hostel,
  hr,
  notices,
  parents,
]

const MODULES_DIR = join(process.cwd(), '..', 'modules')

const documented = (p: Plugin) =>
  new Set(
    Object.entries(p.openapiPaths).flatMap(([path, ops]) =>
      Object.keys(ops as object).map((m) => `${m.toUpperCase()} ${path}`),
    ),
  )

const declared = (p: Plugin) => new Set(pluginPaths(p))

test('every module ships a plugin entry the host can load', () => {
  const onDisk = readdirSync(MODULES_DIR).filter((d) =>
    existsSync(join(MODULES_DIR, d, 'package.json')),
  )
  assert.equal(
    PLUGINS.length,
    onDisk.length,
    `packages/modules has ${onDisk.length} modules, this test loads ${PLUGINS.length}`,
  )
  assert.equal(new Set(PLUGINS.map((p) => p.manifest.id)).size, PLUGINS.length)
})

test('every module carries the migrations that build its own tables', () => {
  // A plugin that installs and then 500s on its first query because its tables
  // were never created is the failure this prevents.
  for (const p of PLUGINS) {
    const dir = join(MODULES_DIR, p.manifest.id, 'migrations')
    assert.ok(existsSync(dir), `${p.manifest.id} has no migrations/`)
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql'))
    assert.ok(files.length > 0, `${p.manifest.id} has an empty migrations/`)
    // Ordered by name, so the numbering has to be the ordering.
    assert.deepEqual(files, [...files].sort(), `${p.manifest.id}: migrations misordered`)
  }
})

test('what a module documents and what it answers are the same set', () => {
  // The OpenAPI fragment is what the Flutter client generates against. A route
  // that exists but is undocumented is invisible to it; a documented route that
  // does not exist is a 404 the client cannot predict.
  for (const p of PLUGINS) {
    assert.deepEqual(
      [...declared(p)].sort(),
      [...documented(p)].sort(),
      `${p.manifest.id}: routes and OpenAPI disagree`,
    )
  }
})

test('the whole product still answers the same number of endpoints', () => {
  // The monorepo had 94 route *files*, several exporting both a GET and a POST;
  // these tables declare 101 endpoints, which is the same surface counted
  // honestly. A regression guard on the conversion, not a target.
  const total = PLUGINS.reduce((n, p) => n + p.routes.length, 0)
  assert.equal(total, 101, `expected 101 endpoints across all modules, found ${total}`)
})

test('a longer path is never swallowed by a shorter one', () => {
  // /sessions/close must not be matched by /sessions, which is exactly what a
  // naive prefix router does.
  const found = matchRoute(attendance.routes, 'POST', '/sessions/close')
  assert.equal(found?.path, '/sessions/close')
  assert.equal(matchRoute(attendance.routes, 'GET', '/sessions')?.path, '/sessions')
  assert.equal(matchRoute(attendance.routes, 'GET', '/sessions/nope'), null)
})

test('a method that is not declared does not fall through to another', () => {
  assert.equal(matchRoute(library.routes, 'DELETE', '/titles'), null)
  assert.equal(matchRoute(library.routes, 'PUT', '/settings')?.method, 'PUT')
  assert.equal(matchRoute(library.routes, 'GET', '/settings')?.method, 'GET')
})

test('only the two document routes return bytes instead of JSON', () => {
  const raw = PLUGINS.flatMap((p) =>
    p.routes.filter((r) => r.raw).map((r) => `${p.manifest.id}${r.path}`),
  )
  assert.deepEqual(raw.sort(), ['examinations/transcript.pdf', 'fees/receipt.pdf'])
})

test('a plugin declares nothing outside its own base path', () => {
  for (const p of PLUGINS) {
    for (const path of Object.keys(p.openapiPaths)) {
      assert.ok(
        path.startsWith(p.manifest.apiBasePath),
        `${p.manifest.id} documents ${path}`,
      )
    }
  }
})

test('dependencies name modules that exist', () => {
  const ids = new Set(PLUGINS.map((p) => p.manifest.id))
  for (const p of PLUGINS) {
    for (const dep of [...p.manifest.dependsOn, ...(p.manifest.softDependsOn ?? [])]) {
      assert.ok(ids.has(dep), `${p.manifest.id} depends on unknown module ${dep}`)
    }
  }
})
