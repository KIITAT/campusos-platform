import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseCsvRecords } from './csv'
import { importTemplate, runImport, withImports, type ImportBatch, type ImportSpec } from './imports'
import type { Plugin, PluginActor } from './plugin'

const admin: PluginActor = { id: 'u1', role: 'institution_admin', institutionId: 'i1' }

/** Stands in for withTenantBatch: steps run, and a throw from the batch is what rolls back. */
function fakeBatch() {
  const committed: string[] = []
  let pending: string[] = []
  const batch: ImportBatch = async (_institution, fn) => {
    pending = []
    const result = await fn((run) => run())
    committed.push(...pending)
    return result
  }
  return { batch, committed, write: (v: string) => pending.push(v) }
}

function spec(write: (v: string) => void): ImportSpec {
  return {
    id: 'rooms',
    title: 'Rooms',
    note: 'One row per room.',
    roles: ['institution_admin'],
    columns: [
      { name: 'code', required: true, note: 'The room code', example: 'CR-101' },
      { name: 'capacity', note: 'Seats', example: '60' },
    ],
    row: async (_actor, row) => {
      if (row.values.code === 'TAKEN') return 'skipped'
      if (row.values.capacity && !/^\d+$/.test(row.values.capacity)) throw new Error('capacity must be a whole number')
      write(row.values.code!)
      return 'created'
    },
  }
}

test('quoted cells, doubled quotes, line breaks and the byte-order mark', () => {
  const records = parseCsvRecords('﻿name,note\r\n"Rao, Priya","said ""hi"""\n\n"two\nlines",x\n')
  assert.deepEqual(records, [
    { line: 1, cells: ['name', 'note'] },
    { line: 2, cells: ['Rao, Priya', 'said "hi"'] },
    { line: 4, cells: ['two\nlines', 'x'] },
  ])
})

test('a clean file is checked without writing, then imported with apply', async () => {
  const f = fakeBatch()
  const s = spec(f.write)
  const csv = 'Code,CAPACITY\nCR-101,60\nTAKEN,\n'
  const checked = await runImport(s, admin, { csv }, f.batch)
  assert.equal(checked.applied, false)
  assert.deepEqual([checked.created, checked.skipped], [1, 1])
  assert.match(checked.notice, /Nothing was written/)
  assert.deepEqual(f.committed, [])
  const imported = await runImport(s, admin, { csv, apply: 'on' }, f.batch)
  assert.equal(imported.applied, true)
  assert.match(imported.notice, /Imported 2 rows: 1 created, 1 already here/)
  assert.deepEqual(f.committed, ['CR-101'])
})

test('every bad row is reported by its line and nothing is written', async () => {
  const f = fakeBatch()
  await assert.rejects(
    runImport(spec(f.write), admin, { csv: 'code,capacity\nCR-1,60\n,10\nCR-3,many\n', apply: true }, f.batch),
    (e: Error & { code?: string; detail?: { errors: unknown[] } }) => {
      assert.equal(e.code, 'bad_rows')
      assert.match(e.message, /2 rows need fixing.*line 3: code is required; line 4: capacity must be a whole number/)
      assert.equal(e.detail?.errors.length, 2)
      return true
    },
  )
  assert.deepEqual(f.committed, [])
})

test('a header that does not match is refused before any row runs', async () => {
  const f = fakeBatch()
  await assert.rejects(runImport(spec(f.write), admin, { csv: 'room,capacity\nCR-1,2\n' }, f.batch), /unknown column room; missing column code/)
  await assert.rejects(runImport(spec(f.write), admin, { csv: 'code,code\nA,B\n' }, f.batch), /given twice/)
  await assert.rejects(runImport(spec(f.write), admin, { csv: 'code\n' }, f.batch), /no rows/)
  await assert.rejects(runImport(spec(f.write), admin, { csv: 'PK\u0003\u0004binary' }, f.batch), /not a CSV/)
  await assert.rejects(runImport(spec(f.write), { ...admin, role: 'student' }, { csv: 'code\nA\n' }, f.batch), /cannot import/)
})

test('withImports adds the routes, the page and their documentation', async () => {
  const f = fakeBatch()
  const base: Plugin = {
    manifest: { id: 'rooms', name: 'Rooms', apiBasePath: '/api/v1/modules/rooms' } as Plugin['manifest'],
    routes: [],
    openapiPaths: {},
    pages: [],
  }
  const plugin = withImports(base, [spec(f.write)], f.batch)
  assert.deepEqual(plugin.routes.map((r) => `${r.method} ${r.path}`), ['GET /imports', 'GET /imports/template', 'POST /imports/run'])
  assert.deepEqual(Object.keys(plugin.openapiPaths).sort(), ['/api/v1/modules/rooms/imports', '/api/v1/modules/rooms/imports/run', '/api/v1/modules/rooms/imports/template'])
  const template = plugin.routes.find((r) => r.path === '/imports/template')!
  const response = (await template.handler(admin, new Request('http://x/imports/template?id=rooms'))) as Response
  assert.equal(await response.text(), importTemplate(spec(f.write)))
  assert.equal(importTemplate(spec(f.write)), 'code,capacity\r\nCR-101,60\r\n')
  const page = plugin.pages!.find((p) => p.path === '/import')!
  const data = await page.load(admin, new Request('http://x/m/rooms/import'))
  const kinds = page.sections(data).map((s) => s.kind)
  assert.deepEqual(kinds, ['note', 'form', 'links', 'table'])
  assert.deepEqual(page.sections(await page.load({ ...admin, role: 'student' }, new Request('http://x'))).map((s) => s.kind), ['note'])
  const run = plugin.routes.find((r) => r.path === '/imports/run')!
  const answer = (await run.handler(admin, new Request('http://x', { method: 'POST', body: JSON.stringify({ importId: 'rooms', csv: 'code\nA\n' }) }))) as { created: number }
  assert.equal(answer.created, 1)
  await assert.rejects(run.handler(admin, new Request('http://x', { method: 'POST', body: JSON.stringify({ importId: 'nope', csv: 'code\nA\n' }) })), /no import nope/)
})
