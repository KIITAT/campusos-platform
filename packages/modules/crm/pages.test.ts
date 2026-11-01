import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validatePlugin, type PluginForm, type PluginPage } from '@campusos/module-framework'
import { createItem } from '@campusos/module-finance/api'
import { createActivity } from './api/activities'
import { convertOpportunity } from './api/convert'
import { createLead, markLost, markWon, qualifyLead, reopenLead } from './api/leads'
import { settings } from './api/settings'
import { paths } from './api/openapi'
import { pages } from './pages'
import plugin from './plugin'
import { specs } from './routes'
import { college, team } from './test-support.test'

test('the pipeline, lead and settings screens offer each role only what its state admits', async () => {
  const c = await college()
  await team(c.admin, 'Team One', c.manager.id, [c.rep.id])
  const item = await createItem(c.clerk, { code: 'SVC', name: 'Service', nature: 'service' }) as { id: string }
  validatePlugin(plugin)
  assert.deepEqual(pages.map(p => p.path), ['/', '/lead', '/settings'])
  const [pipeline, detail, config] = pages as [PluginPage, PluginPage, PluginPage]
  const seen = new Map<string, PluginForm>()
  const collect = async (actor: typeof c.rep, page: PluginPage, id = '') => {
    const request = new Request('http://company.test/m/crm' + page.path + (id ? '?id=' + id : ''))
    const data = await page.load(actor, request)
    const found: string[] = []
    for (const section of page.sections(data)) {
      if (section.kind === 'table') assert.ok(Array.isArray(data[section.rows]), section.rows)
      if (section.kind === 'kanban') assert.ok(Array.isArray(data[section.rows]), section.rows)
      if (section.kind !== 'form') continue
      found.push(section.path)
      seen.set(section.path, section)
      assert.ok(section.roles?.includes(actor.role), section.path + ' for ' + actor.role)
      assert.ok(specs.some(r => r.path === section.path && r.method === 'POST' && r.body), section.path)
      assert.ok(paths['/api/v1/modules/crm' + section.path]?.post, section.path)
      for (const f of section.fields) if (typeof f.options === 'string') assert.ok(Array.isArray(data[f.options]), f.options)
    }
    return found
  }
  // An outsider gets a note and no form; their own loader does not throw.
  assert.deepEqual(await collect(c.outsider, pipeline), [])
  assert.deepEqual(await collect(c.rep, pipeline), ['/leads'])
  const cfg = await settings(c.admin)
  const stageOf = (name: string) => cfg.stages.find(s => s.name === name)!.id
  void stageOf
  const l = await createLead(c.rep, { kind: 'lead', title: 'Page lead', source: 'website', itemId: item.id, expectedValue: '500' })
  assert.deepEqual((await collect(c.rep, detail, l.id)).sort(), ['/activities', '/leads/assign', '/leads/lost', '/leads/qualify', '/leads/update'].sort())
  await qualifyLead(c.rep, { leadId: l.id })
  await createActivity(c.rep, { leadId: l.id, kind: 'call', summary: 'Ring them', dueAt: '2030-01-01T10:00' })
  assert.ok((await collect(c.rep, detail, l.id)).includes('/leads/stage'))
  assert.ok((await collect(c.rep, detail, l.id)).includes('/activities/done'))
  assert.ok(!(await collect(c.rep, detail, l.id)).includes('/leads/erase'))
  assert.ok((await collect(c.admin, detail, l.id)).includes('/leads/erase'))
  await markWon(c.rep, { leadId: l.id })
  const wonForms = await collect(c.rep, detail, l.id)
  assert.ok(wonForms.includes('/leads/convert') && wonForms.includes('/leads/reopen') && !wonForms.includes('/leads/won'))
  await convertOpportunity(c.rep, { leadId: l.id })
  const converted = await collect(c.rep, detail, l.id)
  assert.ok(!converted.includes('/leads/convert') && !converted.includes('/leads/reopen'))
  const l2 = await createLead(c.rep, { kind: 'lead', title: 'Lost lead', source: 'website' })
  await markLost(c.rep, { leadId: l2.id, reasonId: cfg.reasons[0]!.id })
  assert.ok((await collect(c.rep, detail, l2.id)).includes('/leads/reopen'))
  await reopenLead(c.rep, { leadId: l2.id })
  // Another team's manager never sees the lead; the detail load is refused.
  await assert.rejects(() => detail.load(c.rep2, new Request('http://company.test/m/crm/lead?id=' + l.id)))
  await collect(c.admin, config)
  await collect(c.manager, config)
  assert.deepEqual([...seen.keys()].sort(), specs.filter(r => r.method === 'POST').map(r => r.path).sort())
  const empty = await detail.load(c.rep, new Request('http://company.test/m/crm/lead'))
  assert.equal(detail.sections(empty).filter(s => s.kind === 'form').length, 0)
})
