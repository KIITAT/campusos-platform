import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validatePlugin, type PluginForm } from '@campusos/module-framework'
import { assignCase, createCase, resolveCase } from './api'
import { pages } from './pages'
import plugin from './plugin'
import { specs } from './routes'
import { paths } from './api/openapi'
import { college } from './test-support.test'

test('case pages enforce participant privacy and present actions for the current role and state', async () => {
  const actors = await college()
  const issue = await createCase(actors.student, { subject: 'Repair request', description: 'The projector in room 102 is broken.', kind: 'helpdesk' })
  validatePlugin(plugin)
  assert.deepEqual(pages.map(page => page.path), ['/', '/case'])
  const request = new Request('http://college.test/m/helpdesk/case?id=' + issue.id)
  const detail = pages[1]!
  const forms = new Map<string, PluginForm>()
  const collect = async (actor: typeof actors.admin, page = detail) => {
    const data = await page.load(actor, request)
    const found: PluginForm[] = []
    for (const section of page.sections(data)) {
      if (section.kind === 'table') assert.ok(Array.isArray(data[section.rows]), section.rows)
      if (section.kind !== 'form') continue
      found.push(section)
      forms.set(section.path, section)
      assert.ok(section.roles?.includes(actor.role))
      assert.ok(specs.some(route => route.path === section.path && route.method === 'POST' && route.body))
      assert.ok(paths['/api/v1/modules/helpdesk' + section.path]?.post)
      for (const field of section.fields) if (typeof field.options === 'string') assert.ok(Array.isArray(data[field.options]))
    }
    return found.map(form => form.path)
  }
  await collect(actors.student, pages[0]!)
  assert.deepEqual(await collect(actors.student), ['/cases/messages'])
  assert.ok((await collect(actors.admin)).includes('/cases/assign'))
  await assert.rejects(() => detail.load(actors.other, request))
  await assignCase(actors.admin, { caseId: issue.id, assigneeId: actors.faculty.id })
  assert.deepEqual(await collect(actors.faculty), ['/cases/messages', '/cases/resolve'])
  await resolveCase(actors.faculty, { caseId: issue.id, resolution: 'Projector replaced' })
  assert.deepEqual(await collect(actors.faculty), [])
  assert.deepEqual(await collect(actors.student), ['/cases/reopen'])
  assert.deepEqual([...forms.keys()].sort(), specs.filter(route => route.method === 'POST').map(route => route.path).sort())
  const reopen = specs.find(route => route.path === '/cases/reopen')!
  await reopen.handler(actors.student, new Request('http://college.test/api/v1/modules/helpdesk/cases/reopen', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ caseId: issue.id, reason: 'The replacement also fails' }) }))
  assert.deepEqual(await collect(actors.student), ['/cases/messages'])
  const empty = await detail.load(actors.student, new Request('http://college.test/m/helpdesk/case'))
  assert.equal(detail.sections(empty).filter(section => section.kind === 'form').length, 0)
})
