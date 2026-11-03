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

// Review finding 6: Postgres makes COLUMN optional, a type can carry a comma, and
// comments and string literals must not hide or swallow a statement.
test('the forms that once slipped through are refused', () => {
  for (const [name, sql] of [
    ['drop column', 'ALTER TABLE x DROP y;'],
    ['drop column', 'ALTER TABLE x DROP IF EXISTS y;'],
    ['rename', 'ALTER TABLE x RENAME y TO z;'],
    ['set not null', 'ALTER TABLE x ALTER y SET NOT NULL;'],
    ['column type change', 'ALTER TABLE x ALTER y TYPE int;'],
    ['not null column without default', 'ALTER TABLE x ADD COLUMN amount numeric(10,2) NOT NULL;'],
    ['not null column without default', 'ALTER TABLE x ADD amount int NOT NULL;'],
    ['drop table', "INSERT INTO t VALUES ('--'); DROP TABLE x;"],
    ['drop table', 'DROP /* quiet */ TABLE x;'],
  ]) {
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
    'ALTER TABLE x DROP CONSTRAINT c;',
    'ALTER TABLE x ALTER COLUMN y DROP DEFAULT;',
    'ALTER TABLE x ALTER COLUMN y DROP NOT NULL;',
    'ALTER TABLE x ADD CONSTRAINT c CHECK (y IS NOT NULL);',
    'ALTER TABLE x RENAME CONSTRAINT a TO b;',
    "COMMENT ON TABLE x IS 'we never drop table x';",
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
