/**
 * The generated module reference (CQ-03, decision 399).
 *
 * docs/module-reference.md is generated from every plugin manifest by
 * scripts/module-catalog.mjs; this fails when the committed copy has drifted.
 * `UPDATE_REFERENCE=1` rewrites it.
 *
 *   node --import ./packages/db/node_modules/tsx/dist/loader.mjs --test scripts/module-reference.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const file = join(root, 'docs/module-reference.md')

test('docs/module-reference.md matches the manifests', async () => {
  const directory = join(root, 'packages/modules')
  const ids = readdirSync(directory).filter((name) => existsSync(join(directory, name, 'plugin.ts'))).sort()
  const plugins = []
  for (const id of ids) plugins.push((await import(pathToFileURL(join(directory, id, 'plugin.ts')).href)).plugin)
  const { moduleReference } = await import(pathToFileURL(join(root, 'scripts/module-catalog.mjs')).href)
  const expected = moduleReference(plugins)
  if (process.env.UPDATE_REFERENCE === '1') {
    writeFileSync(file, expected)
    return
  }
  assert.equal(
    existsSync(file) ? readFileSync(file, 'utf8').replaceAll('\r\n', '\n') : '',
    expected,
    'docs/module-reference.md is stale: run it with UPDATE_REFERENCE=1',
  )
})
