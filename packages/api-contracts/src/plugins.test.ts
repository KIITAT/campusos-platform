import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { matchRoute, pluginPaths, type Plugin } from '@campusos/module-framework'

import academic from '@campusos/module-academic/plugin'
import attendance from '@campusos/module-attendance/plugin'
import enrollment from '@campusos/module-enrollment/plugin'
import examinations from '@campusos/module-examinations/plugin'
import fees from '@campusos/module-fees/plugin'
import finance from '@campusos/module-finance/plugin'
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
  enrollment,
  examinations,
  fees,
  finance,
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
  // these tables declared 101 endpoints, which was the same surface counted
  // honestly. Finance added 8 more, fees three for issuing and refunds, hr two
  // for paying a month's salaries, and the academic core fifteen for curricula,
  // the prerequisite chain and a student's record, enrollment eight for
  // registration itself, and six more for the degree audit, finalising a course
  // and the scale a programme grades on. HR then became the whole of HR --
  // employment history, leave policy, shifts, recruitment, appraisals, claims
  // and advances, salary structures, tax and gratuity -- and went from 17 to
  // 110. A regression guard on the conversion, not a target.
  const total = PLUGINS.reduce((n, p) => n + p.routes.length, 0)
  assert.equal(total, 254, `expected 254 endpoints across all modules, found ${total}`)
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

test('every nav entry points at a page the module actually declares', () => {
  // The manifest's nav and the page table are written in different files and
  // drifted the moment the pages moved out of the host: academic advertised
  // /timetable and /sections while declaring / and /cohorts. A nav entry that
  // 404s is worse than no nav entry.
  for (const p of PLUGINS) {
    const declared = new Set((p.pages ?? []).map((page) => page.path))
    for (const entry of p.manifest.navEntries) {
      const prefix = `/m/${p.manifest.id}`
      assert.ok(
        entry.href === prefix || entry.href.startsWith(`${prefix}/`),
        `${p.manifest.id}: ${entry.href} is outside its own page space`,
      )
      const path = entry.href === prefix ? '/' : entry.href.slice(prefix.length)
      assert.ok(
        declared.has(path),
        `${p.manifest.id}: nav points at ${path}, which is not a declared page`,
      )
    }
  }
})

test('a page nobody may open is not in anybody’s menu', () => {
  for (const p of PLUGINS) {
    for (const page of p.pages ?? []) {
      if (!page.menu) continue
      assert.ok(page.roles.length > 0, `${p.manifest.id}: ${page.path} has a menu and no roles`)
      for (const role of page.roles) {
        assert.ok(
          p.manifest.rolesWithAccess.includes(role),
          `${p.manifest.id}: ${page.path} admits ${role}, which the manifest does not`,
        )
      }
    }
  }
})

test('every form on a page posts to a route the module answers', () => {
  // A form whose action does not exist is a button that 404s, and nothing else
  // in the codebase would catch it.
  for (const p of PLUGINS) {
    for (const page of p.pages ?? []) {
      // Forgiving stand-in data: this test is about where a form posts, not
      // about what a page renders, and a section builder should not have to be
      // written defensively to be inspectable.
      const blank = new Proxy(
        {},
        { get: () => [] },
      ) as Record<string, unknown>

      for (const section of page.sections(blank)) {
        // A list view's bulk actions are forms too.
        if (section.kind === 'table') {
          for (const b of section.bulk ?? []) {
            assert.ok(
              p.routes.some((r) => r.method === 'POST' && r.path === b.path),
              `${p.manifest.id}: ${page.path} bulk-posts to ${b.path}, which is not a route`,
            )
          }
        }
        if (section.kind !== 'form') continue
        const method = section.method ?? 'POST'
        assert.ok(
          p.routes.some((r) => r.method === method && r.path === section.path),
          `${p.manifest.id}: ${page.path} posts to ${method} ${section.path}, which is not a route`,
        )
      }

      // And a record's lifecycle buttons, when it offers them.
      const doc = page.record?.(blank)?.docStatus
      for (const path of [doc?.submit, doc?.cancel, doc?.amend].filter(Boolean) as string[]) {
        assert.ok(
          p.routes.some((r) => r.method === 'POST' && r.path === path),
          `${p.manifest.id}: ${page.path} offers ${path}, which is not a route`,
        )
      }
    }
  }
})

test('no module reaches for the owner connection', async () => {
  // A plugin runs as the application role, under row level security, and its
  // bundle cannot open a pool of its own. Code that reaches for the owner
  // connection passes every test in this workspace -- where it can -- and
  // fails the first time an installed module runs it. So: never, statically.
  const { readdirSync, readFileSync, statSync } = await import('node:fs')
  const { join, resolve } = await import('node:path')
  const root = resolve(import.meta.dirname, '../../modules')
  const OWNER_ONLY = /\b(authDb|invitedAccess|bindInvitedUser|corePool)\b/
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f)
      if (f === 'node_modules' || f === 'migrations') return []
      return statSync(p).isDirectory() ? walk(p) : [p]
    })
  const offenders = walk(root)
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\.ts$/.test(f))
    .filter((f) => OWNER_ONLY.test(readFileSync(f, 'utf8')))
  assert.deepEqual(offenders, [], `module code reaching for the owner connection: ${offenders.join(', ')}`)
})
