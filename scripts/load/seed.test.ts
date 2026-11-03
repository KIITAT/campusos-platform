import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CONFIRMATION, validateLoadEnvironment } from './seed'

const url = (role: string, database: string) => `postgresql://${role}:x@127.0.0.1:55433/${database}`
const valid = (over: Record<string, string | undefined> = {}) => ({
  NODE_ENV: 'test', CONFIRM_LOAD_SEED: CONFIRMATION,
  DATABASE_URL: url('campusos_app', 'campusos_load'), MIGRATION_DATABASE_URL: url('postgres', 'campusos_load'), ...over,
})

test('the load seed refuses anything that is not a disposable load database', () => {
  const refused = (over: Record<string, string | undefined>) => assert.throws(() => validateLoadEnvironment(valid(over)), Error)
  refused({ NODE_ENV: 'production' })
  refused({ CONFIRM_LOAD_SEED: undefined })
  refused({ AUTH_DATABASE_URL: url('postgres', 'campusos_load') })
  refused({ DATABASE_URL: url('campusos_app', 'campusos'), MIGRATION_DATABASE_URL: url('postgres', 'campusos') })
  refused({ DATABASE_URL: url('campusos_app', 'campusos_test'), MIGRATION_DATABASE_URL: url('postgres', 'campusos_test') })
  refused({ MIGRATION_DATABASE_URL: url('postgres', 'other_load') })
  refused({ LOAD_SCALE: 'huge' })
  assert.deepEqual(validateLoadEnvironment(valid()), { database: 'campusos_load', scale: 'smoke' })
  assert.deepEqual(validateLoadEnvironment(valid({ LOAD_SCALE: 'full' })), { database: 'campusos_load', scale: 'full' })
})
