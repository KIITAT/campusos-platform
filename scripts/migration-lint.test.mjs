import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { RULES, lintFiles, lintSql } from './migration-lint.mjs'

const repoRoot = resolve(import.meta.dirname, '..')

const SAMPLES = {
  'drop table': 'DROP TABLE x;',
  'drop column': 'ALTER TABLE x DROP COLUMN y;',
  'drop view': 'DROP VIEW v;',
  'drop function': 'DROP FUNCTION f();',
  'drop type': 'DROP TYPE t;',
  'drop schema': 'DROP SCHEMA s;',
  rename: 'ALTER TABLE x RENAME TO y;',
  'set not null': 'ALTER TABLE x ALTER COLUMN y SET NOT NULL;',
  'column type change': 'ALTER TABLE x ALTER COLUMN y TYPE int;',
  truncate: 'TRUNCATE x;',
  'not null column without default': 'ALTER TABLE x ADD COLUMN y int NOT NULL;',
}

test('each rule refuses its statement', () => {
  assert.deepEqual(RULES.map(([name]) => name).sort(), Object.keys(SAMPLES).sort())
  for (const [name, sql] of Object.entries(SAMPLES)) {
    assert.deepEqual(lintSql(sql), [name], sql)
  }
})

test('expand statements pass', () => {
  for (const sql of [
    'CREATE TABLE x (id int not null);',
    'ALTER TABLE x ADD COLUMN y int NOT NULL DEFAULT 0;',
    'ALTER TABLE x ADD COLUMN z text;',
    'DROP POLICY IF EXISTS p ON x;',
    'DROP TRIGGER IF EXISTS t ON x;',
    'CREATE INDEX i ON x(y);',
  ]) {
    assert.deepEqual(lintSql(sql), [], sql)
  }
})

test('a comment never trips a rule', () => {
  assert.deepEqual(lintSql('-- drop table x\nCREATE TABLE y();'), [])
})

test('a marked contract passes', () => {
  assert.deepEqual(
    lintSql('-- campusos:contract drops the old fee column after 0.17\nALTER TABLE x DROP COLUMN y;'),
    [],
  )
  assert.deepEqual(lintSql('-- campusos:contract short\nALTER TABLE x DROP COLUMN y;'), ['drop column'])
})

test('the repository is clean', () => {
  const baseline = new Set(
    readFileSync(join(repoRoot, 'scripts', 'migration-lint.baseline.txt'), 'utf8').split('\n').filter(Boolean),
  )
  assert.deepEqual(lintFiles(repoRoot, baseline), [])
})

test('a new file outside the baseline is linted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lint-'))
  mkdirSync(join(dir, 'packages/modules/demo/migrations'), { recursive: true })
  writeFileSync(join(dir, 'packages/modules/demo/migrations/0001_x.sql'), 'DROP TABLE x;')
  const out = lintFiles(dir, new Set())
  assert.equal(out.length, 1)
  assert.match(out[0], /drop table is a contract change/)
})
