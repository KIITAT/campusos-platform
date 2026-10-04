import assert from 'node:assert/strict'
import { test } from 'node:test'
import { moduleReference } from './module-catalog.mjs'

test('the reference accounts for each page, route, field and scheduled job', () => {
  const reference = moduleReference([{
    manifest: { id: 'example', name: 'Example', version: '1.0.0', description: 'One | two', dependsOn: [], rolesWithAccess: ['student'], apiBasePath: '/api/v1/modules/example' },
    pages: [{ path: '/', title: 'Home', roles: ['student'] }],
    routes: [{ method: 'POST', path: '/submit' }],
    openapiPaths: { '/api/v1/modules/example/submit': { post: { summary: 'Submit a record', requestBody: { content: { 'application/json': { schema: { properties: { title: {} } } } } } } } },
    jobs: [{ kind: 'example.daily', daily: true, roles: ['institution_admin'] }],
  }])
  assert.match(reference, /One \\\| two/)
  assert.match(reference, /`POST \/api\/v1\/modules\/example\/submit`/)
  assert.match(reference, /`title`/)
  assert.match(reference, /`\/m\/example`/)
  assert.match(reference, /`example.daily`/)
})
