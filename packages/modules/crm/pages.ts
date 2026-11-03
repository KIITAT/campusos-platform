import { withTenant } from '@campusos/db'
import { itemChoices } from '@campusos/module-finance/api'
import type { PluginActor, PluginPage, PluginSection } from '@campusos/module-framework'
import { ADMIN, STAFF, KINDS, tenant, convertChoices, duplicates, forecast, leadDetail, listLeads, openBoard, ownerChoices, pipelinePage, report, settings, staffChoices, SOURCES } from './api'
import { choice, field, form, hidden, pick, rupees, screen, table } from './ui'

const STAFF_ROLES = [...STAFF]
const NOT_IN_TEAM = 'Ask an administrator to add you to a sales team.'
const refusedWith = (code: string) => (e: unknown) => (e as { code?: string }).code === code
const items = (actor: PluginActor) => withTenant(tenant(actor), tx => itemChoices(tx, 'any'))
const opt = (rows: { id: string; name: string; archived: boolean }[]) => rows.filter(r => !r.archived).map(r => ({ value: r.id, label: r.name }))
const idOf = (request: Request) => new URL(request.url).searchParams.get('id')

const PRIORITIES = [{ value: '0', label: 'Normal' }, { value: '1', label: 'Low' }, { value: '2', label: 'High' }, { value: '3', label: 'Very high' }]
const leadFields = (itemKey: string, edit = true) => [
  field('title', 'Title', 'text', edit), field('company', 'Company', 'text', true), field('contactName', 'Contact name', 'text', true), field('email', 'E-mail', 'text', true),
  field('phone', 'Phone', 'text', true), field('gstin', 'GSTIN', 'text', true), field('notes', 'Notes', 'textarea', true),
  pick('itemId', 'What is being sold', itemKey, true), field('expectedValue', 'Expected value (before tax)', 'money', true), field('expectedClose', 'Expected close', 'date', true),
  { name: 'priority', label: 'Priority', kind: 'select' as const, options: PRIORITIES, optional: true },
]

export const pages: PluginPage[] = [
  screen({
    path: '/', title: 'Sales pipeline', menu: 'Pipeline', roles: STAFF_ROLES,
    load: async (actor, request) => {
      try {
        const [board, leads, cfg, itemOptions, fc] = await Promise.all([openBoard(actor), listLeads(actor, pipelinePage(request, 'leads'), {}), settings(actor), items(actor), forecast(actor)])
        const totals = new Map(fc.stages.map(t => [t.stageId, t]))
        return { role: actor.role, member: true, board, leads: leads.rows.map(r => ({ ...r, close: r.expectedClose, updated: r.updatedAt })), leadsPage: { total: leads.total, next: leads.next }, lanes: cfg.stages.filter(s => !s.archived).map(s => ({ ...s, count: totals.get(s.id)?.count ?? 0, totalPaise: totals.get(s.id)?.totalPaise ?? 0 })), fc, items: itemOptions, sources: choice(SOURCES) }
      } catch (error) {
        if (!refusedWith('not_in_sales_team')(error)) throw error
        return { role: actor.role, member: false, board: [], leads: [], leadsPage: { total: 0, next: null }, lanes: [], fc: null, items: [], sources: choice(SOURCES) }
      }
    },
    sections: (data): PluginSection[] => !data.member ? [{ kind: 'note', text: NOT_IN_TEAM }] : [
      { kind: 'note', text: "You see your own leads; a team manager sees the team's." },
      ...(data.fc ? [{ kind: 'figures' as const, figures: [{ label: 'Open pipeline', value: rupees((data.fc as { totalPaise: number }).totalPaise) }, { label: 'Weighted by stage', value: rupees((data.fc as { weightedPaise: number }).weightedPaise) }] }, { kind: 'shortcuts' as const, items: [{ label: 'Forecast and team report', href: '/m/crm/report' }] }] : []),
      {
        kind: 'kanban', title: 'Open opportunities', rows: 'board', groupBy: 'stageId', empty: 'No open opportunities.',
        lanes: (data.lanes as { id: string; name: string; probability: number; count: number; totalPaise: number }[]).map(s => ({ value: s.id, label: `${s.name} · ${s.count} · ${rupees(s.totalPaise)} · ${s.probability}%` })),
        card: { title: 'title', subtitle: 'company', meta: [{ key: 'expectedValuePaise', label: 'Value', kind: 'money' }, { key: 'expectedClose', label: 'Close', kind: 'date' }, { key: 'score', label: 'Score' }], href: '/m/crm/lead?id={id}' },
      },
      {
        kind: 'table', title: 'All leads', rows: 'leads', empty: 'No leads yet.', paging: { data: 'leadsPage', sorts: ['updated', 'close', 'title'] },
        columns: [
          { key: 'title', label: 'Title', href: '/m/crm/lead?id={id}' }, { key: 'kind', label: 'Kind' }, { key: 'status', label: 'Status', kind: 'status' }, { key: 'stageName', label: 'Stage' },
          { key: 'ownerName', label: 'Owner' }, { key: 'score', label: 'Score' }, { key: 'expectedValuePaise', label: 'Value', kind: 'money' }, { key: 'close', label: 'Close', kind: 'date' }, { key: 'updated', label: 'Updated', kind: 'date' },
        ],
      },
      ...(ADMIN.includes(data.role as never) ? [
        form('Capture a lead from outside', '/leads/capture', [field('title', 'Title'), field('company', 'Company', 'text', true), field('contactName', 'Contact name', 'text', true), field('email', 'E-mail', 'text', true), field('phone', 'Phone', 'text', true), pick('source', 'Where it came from', 'sources'), field('notes', 'Notes', 'textarea', true)]),
        form('Import leads from a spreadsheet', '/leads/import', [field('csv', 'Paste the sheet as CSV: a header row with title, source, company, contactName, email, phone, gstin, notes, expectedValue, expectedClose, priority', 'textarea')]),
      ] : []),
      form('New lead', '/leads', [{ name: 'kind', label: 'Kind', kind: 'radio', options: choice(['lead', 'opportunity']), value: 'lead' }, ...leadFields('items', false).slice(0, 7), pick('source', 'Where it came from', 'sources'), ...leadFields('items', false).slice(7)], STAFF_ROLES),
    ],
  }),
  screen({
    path: '/lead', title: 'Lead', roles: STAFF_ROLES,
    load: async (actor, request) => {
      const id = idOf(request)
      const empty = { score: 0, probability: null as number | null, history: [], dupes: [], lead: null, activities: [], stages: [], reasons: [], owners: [], assignees: [], items: [], customers: [], matches: [], admin: false, stageName: null, ownerName: '', lostReason: null }
      if (!id) return empty
      const detail = await leadDetail(actor, id)
      const lead = detail.lead
      const cfg = await settings(actor)
      const ownerOptions = await ownerChoices(actor)
      const convert = lead.status === 'won' && !lead.partyId ? await convertChoices(actor, id) : { customers: [], matches: [] }
      const me = ownerOptions.find(o => o.value === actor.id)
      const owner = ownerOptions.find(o => o.value === lead.ownerId)
      return {
        ...empty, ...detail, lead, admin: ADMIN.includes(actor.role), stages: opt(cfg.stages), reasons: cfg.reasons.filter(r => !r.archived).map(r => ({ value: r.id, label: r.name })),
        dupeOptions: (lead.status === 'open' ? await duplicates(actor, id) : []).map(d => ({ value: d.id, label: `${d.title} (${d.matches.join(', ')})` })), owners: ownerOptions, assignees: [...new Map([me ?? { value: actor.id, label: 'Me' }, owner ?? { value: lead.ownerId, label: detail.ownerName }].map(o => [o.value, o])).values()],
        items: await items(actor), customers: convert.customers, matches: convert.matches, dupes: lead.status === 'open' ? await duplicates(actor, id) : [],
        activities: detail.activities.map(a => ({ ...a, dueAt: a.dueAt.toISOString(), doneAt: a.doneAt?.toISOString() ?? null })),
      }
    },
    sections: (data): PluginSection[] => {
      const lead = data.lead as null | { priority: number; id: string; kind: string; status: string; title: string; notes: string | null; expectedValuePaise: number | null; expectedClose: string | null; partyId: string | null; quotationId: string | null; erasedAt: Date | null }
      if (!lead) return [{ kind: 'note', text: 'Open a lead from the pipeline.' }, { kind: 'shortcuts', items: [{ label: 'Pipeline', href: '/m/crm' }] }]
      const id = hidden('leadId', lead.id)
      const open = lead.status === 'open'
      const acts = data.activities as { id: string; summary: string; doneAt: string | null }[]
      const head: PluginSection[] = [
        { kind: 'figures', figures: [
          { label: 'Kind', value: lead.kind }, { label: 'Status', value: lead.status }, { label: 'Stage', value: (data.stageName as string | null) ?? '—' }, { label: 'Owner', value: data.ownerName as string },
          { label: 'Expected value', value: rupees(lead.expectedValuePaise) }, { label: 'Expected close', value: lead.expectedClose ?? '—' },
          { label: 'Score', value: String(data.score) }, { label: 'Win chance', value: data.probability == null ? '—' : data.probability + '%' }, { label: 'Priority', value: PRIORITIES[lead.priority]?.label ?? 'Normal' },
        ] },
        ...(lead.notes ? [{ kind: 'prose' as const, title: lead.title, text: lead.notes }] : [{ kind: 'prose' as const, title: 'Lead', text: lead.title }]),
        table('Activities', 'activities', [{ key: 'kind', label: 'Kind' }, { key: 'summary', label: 'What' }, { key: 'dueAt', label: 'Due', kind: 'when' }, { key: 'doneAt', label: 'Done', kind: 'when' }]),
        table('History', 'history', [{ key: 'createdAt', label: 'When', kind: 'when' }, { key: 'authorName', label: 'Who' }, { key: 'body', label: 'What' }]),
      ]
      if (lead.erasedAt) return [...head, { kind: 'note', text: "This lead's contact data was erased." }]
      return [
        ...head,
        ...(lead.partyId ? [{ kind: 'note' as const, text: 'Converted: customer and draft quotation created in finance.' }, ...(lead.quotationId ? [{ kind: 'shortcuts' as const, items: [{ label: 'Quotation in finance', href: '/m/finance/order?id=' + lead.quotationId }] }] : [])] : []),
        ...(open ? [form('Edit', '/leads/update', [id, ...leadFields('items')], STAFF_ROLES)] : []),
        ...(open && lead.kind === 'lead' ? [form('Qualify', '/leads/qualify', [id], STAFF_ROLES)] : []),
        ...(open && lead.kind === 'opportunity' ? [form('Move stage', '/leads/stage', [id, pick('stageId', 'Stage', 'stages')], STAFF_ROLES), form('Mark won', '/leads/won', [id], STAFF_ROLES)] : []),
        ...(open ? [form('Mark lost', '/leads/lost', [id, pick('reasonId', 'Why was it lost?', 'reasons'), field('lostNote', 'Note', 'textarea', true)], STAFF_ROLES)] : []),
        form('Assign', '/leads/assign', [id, pick('ownerId', 'New owner', 'owners')], STAFF_ROLES),
        ...(lead.status === 'lost' || (lead.status === 'won' && !lead.partyId) ? [form('Reopen', '/leads/reopen', [id], STAFF_ROLES)] : []),
        ...(lead.status === 'won' && !lead.partyId ? [form('Convert', '/leads/convert', [id, pick('partyId', 'Existing customer', 'matches', true), field('createNew', 'Create a new customer anyway', 'checkbox', true), field('code', 'Customer code', 'text', true)], STAFF_ROLES)] : []),
        ...(open ? [form('Add activity', '/activities', [id, { name: 'kind', label: 'Kind', kind: 'select', options: choice(KINDS) }, field('summary', 'What'), field('dueAt', 'Due', 'datetime'), { name: 'remindBefore', label: 'Remind me', kind: 'select', options: [{ value: '15m', label: '15 minutes before' }, { value: '1h', label: '1 hour before' }, { value: '1d', label: '1 day before' }, { value: 'none', label: 'Do not remind' }] }, pick('assigneeId', 'Assigned to', 'assignees', true)], STAFF_ROLES)] : []),
        form('Add a note', '/notes', [id, field('body', 'Note', 'textarea')], STAFF_ROLES),
        ...(open && (data.dupes as unknown[]).length ? [{ kind: 'note' as const, text: 'Possible duplicates: ' + (data.dupes as { title: string; matches: string[] }[]).map(d => `${d.title} (${d.matches.join(', ')})`).join('; ') }, form('Merge a duplicate into this lead', '/leads/merge', [hidden('keepId', lead.id), pick('mergeId', 'Duplicate', 'dupeOptions')], STAFF_ROLES)] : []),
        ...acts.filter(a => !a.doneAt).map(a => form('Mark done', '/activities/done', [hidden('activityId', a.id)], STAFF_ROLES)),
        ...(data.admin ? [form('Erase contact data', '/leads/erase', [id, { name: 'reason', label: 'Reason', kind: 'text', hint: "A request reference, not the person's name" }], ADMIN)] : []),
      ]
    },
  }),
  screen({
    path: '/settings', title: 'Sales settings', menu: 'Settings', roles: STAFF_ROLES,
    load: async actor => {
      const admin = ADMIN.includes(actor.role)
      try {
        const cfg = await settings(actor)
        const staff = admin ? await staffChoices(actor) : []
        const memberships = cfg.teams.flatMap(t => t.members.map(m => ({ id: t.id + ':' + m.userId, teamName: t.name, name: m.name })))
        return { member: true, admin, stages: cfg.stages, reasons: cfg.reasons, teams: cfg.teams.map(t => ({ ...t, memberNames: t.members.map(m => m.name).join(', ') })), memberships, staff,
          stageOptions: cfg.stages.map(s => ({ value: s.id, label: s.name })), reasonOptions: cfg.reasons.filter(r => !r.archived).map(r => ({ value: r.id, label: r.name })), teamOptions: cfg.teams.map(t => ({ value: t.id, label: t.name })), scripts: cfg.scripts, scriptOptions: cfg.scripts.map(x => ({ value: x.id, label: `after ${x.afterKind}: ${x.summary}` })) }
      } catch (error) {
        if (!refusedWith('not_in_sales_team')(error)) throw error
        return { member: false, admin, stages: [], reasons: [], teams: [], memberships: [], staff: [], stageOptions: [], reasonOptions: [], teamOptions: [], scripts: [], scriptOptions: [] }
      }
    },
    sections: (data): PluginSection[] => !data.member ? [{ kind: 'note', text: NOT_IN_TEAM }] : [
      table('Pipeline stages', 'stages', [{ key: 'name', label: 'Stage' }, { key: 'seq', label: 'Order' }, { key: 'probability', label: 'Win chance %' }, { key: 'archived', label: 'Archived', kind: 'bool' }]),
      table('Lost reasons', 'reasons', [{ key: 'name', label: 'Reason' }, { key: 'archived', label: 'Archived', kind: 'bool' }]),
      table('Teams', 'teams', [{ key: 'name', label: 'Team' }, { key: 'managerName', label: 'Manager' }, { key: 'memberNames', label: 'Members' }, { key: 'autoAssign', label: 'Round robin', kind: 'bool' }]),
      table('Next-activity scripts', 'scripts', [{ key: 'afterKind', label: 'After' }, { key: 'nextKind', label: 'Plan' }, { key: 'afterDays', label: 'Days later' }, { key: 'summary', label: 'What' }]),
      ...(data.admin ? [
        form('Add stage', '/stages', [field('name', 'Name'), field('seq', 'Order', 'number'), field('probability', 'Win chance %', 'number', true)]),
        form('Change stage', '/stages/update', [pick('stageId', 'Stage', 'stageOptions'), field('name', 'New name', 'text', true), field('seq', 'New order', 'number', true), field('probability', 'New win chance %', 'number', true), field('archived', 'Archive it', 'checkbox', true)]),
        form('Add lost reason', '/lost-reasons', [field('name', 'Reason')]),
        form('Archive lost reason', '/lost-reasons/archive', [pick('reasonId', 'Reason', 'reasonOptions')]),
        form('Create team', '/teams', [field('name', 'Team name'), pick('managerId', 'Manager', 'staff')]),
        form('Add team member', '/teams/members', [pick('teamId', 'Team', 'teamOptions'), pick('userId', 'Person', 'staff')]),
        form('Round-robin assignment', '/teams/auto-assign', [pick('teamId', 'Team', 'teamOptions'), field('autoAssign', 'Give new leads to this team in turn', 'checkbox', true)]),
        form('Plan the next activity', '/scripts', [{ name: 'afterKind', label: 'After this kind finishes', kind: 'select', options: choice(KINDS) }, { name: 'nextKind', label: 'Plan this kind', kind: 'select', options: choice(KINDS) }, field('afterDays', 'Days later', 'number'), field('summary', 'What')]),
        form('Remove a script', '/scripts/delete', [pick('scriptId', 'Script', 'scriptOptions')]),
        form('Remove team member', '/teams/members/remove', [pick('teamId', 'Team', 'teamOptions'), pick('userId', 'Person', 'staff')]),
      ] : []),
    ],
  }),
  screen({
    path: '/report', title: 'Forecast and team report', menu: 'Report', roles: STAFF_ROLES,
    load: async (actor, request) => {
      const q = new URL(request.url).searchParams
      try {
        const [fc, rep] = await Promise.all([forecast(actor), report(actor, { from: q.get('from') || undefined, to: q.get('to') || undefined })])
        return { member: true, fc, rep, months: fc.months.map(m => ({ ...m, month: m.month })), owners: rep.owners, lostReasons: rep.lostReasons, sources: rep.sources }
      } catch (error) {
        if (!refusedWith('not_in_sales_team')(error)) throw error
        return { member: false, fc: null, rep: null, months: [], owners: [], lostReasons: [], sources: [] }
      }
    },
    sections: (data): PluginSection[] => !data.member ? [{ kind: 'note', text: NOT_IN_TEAM }] : [
      { kind: 'figures', figures: [
        { label: 'Open pipeline', value: rupees((data.fc as { totalPaise: number }).totalPaise) }, { label: 'Weighted forecast', value: rupees((data.fc as { weightedPaise: number }).weightedPaise) },
        { label: 'Won', value: String((data.rep as { won: number }).won) }, { label: 'Lost', value: String((data.rep as { lost: number }).lost) },
        { label: 'Win rate', value: (data.rep as { winRate: number | null }).winRate == null ? '—' : (data.rep as { winRate: number }).winRate + '%' }, { label: 'Won value', value: rupees((data.rep as { wonPaise: number }).wonPaise) },
      ] },
      table('Expected close, by month', 'months', [{ key: 'month', label: 'Month' }, { key: 'count', label: 'Deals' }, { key: 'totalPaise', label: 'Total', kind: 'money' }, { key: 'weightedPaise', label: 'Weighted', kind: 'money' }]),
      table('By salesperson', 'owners', [{ key: 'name', label: 'Person' }, { key: 'open', label: 'Open' }, { key: 'openPaise', label: 'Open value', kind: 'money' }, { key: 'won', label: 'Won' }, { key: 'wonPaise', label: 'Won value', kind: 'money' }, { key: 'lost', label: 'Lost' }, { key: 'winRate', label: 'Win rate %' }, { key: 'daysToWin', label: 'Days to win' }]),
      table('Why deals were lost', 'lostReasons', [{ key: 'name', label: 'Reason' }, { key: 'count', label: 'Deals' }]),
      table('By source', 'sources', [{ key: 'source', label: 'Source' }, { key: 'leads', label: 'Leads' }, { key: 'won', label: 'Won' }]),
      { kind: 'note', text: 'Weighted forecast counts each open opportunity at its stage\'s win chance. Add ?from=YYYY-MM-DD&to=YYYY-MM-DD to the address to report on a period.' },
    ],
  }),
]
