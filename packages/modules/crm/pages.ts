import { withTenant } from '@campusos/db'
import { itemChoices } from '@campusos/module-finance/api'
import type { PluginActor, PluginPage, PluginSection } from '@campusos/module-framework'
import { ADMIN, STAFF, tenant, convertChoices, leadDetail, listLeads, openBoard, ownerChoices, pipelinePage, settings, staffChoices, SOURCES } from './api'
import { choice, field, form, hidden, pick, rupees, screen, table } from './ui'

const STAFF_ROLES = [...STAFF]
const NOT_IN_TEAM = 'Ask an administrator to add you to a sales team.'
const refusedWith = (code: string) => (e: unknown) => (e as { code?: string }).code === code
const items = (actor: PluginActor) => withTenant(tenant(actor), tx => itemChoices(tx, 'any'))
const opt = (rows: { id: string; name: string; archived: boolean }[]) => rows.filter(r => !r.archived).map(r => ({ value: r.id, label: r.name }))
const idOf = (request: Request) => new URL(request.url).searchParams.get('id')

const leadFields = (itemKey: string, edit = true) => [
  field('title', 'Title', 'text', edit), field('company', 'Company', 'text', true), field('contactName', 'Contact name', 'text', true), field('email', 'E-mail', 'text', true),
  field('phone', 'Phone', 'text', true), field('gstin', 'GSTIN', 'text', true), field('notes', 'Notes', 'textarea', true),
  pick('itemId', 'What is being sold', itemKey, true), field('expectedValue', 'Expected value (before tax)', 'money', true), field('expectedClose', 'Expected close', 'date', true),
]

export const pages: PluginPage[] = [
  screen({
    path: '/', title: 'Sales pipeline', menu: 'Pipeline', roles: STAFF_ROLES,
    load: async (actor, request) => {
      try {
        const [board, leads, cfg, itemOptions] = await Promise.all([openBoard(actor), listLeads(actor, pipelinePage(request, 'leads'), {}), settings(actor), items(actor)])
        return { member: true, board, leads: leads.rows.map(r => ({ ...r, close: r.expectedClose, updated: r.updatedAt })), leadsPage: { total: leads.total, next: leads.next }, lanes: cfg.stages.filter(s => !s.archived), items: itemOptions, sources: choice(SOURCES) }
      } catch (error) {
        if (!refusedWith('not_in_sales_team')(error)) throw error
        return { member: false, board: [], leads: [], leadsPage: { total: 0, next: null }, lanes: [], items: [], sources: choice(SOURCES) }
      }
    },
    sections: (data): PluginSection[] => !data.member ? [{ kind: 'note', text: NOT_IN_TEAM }] : [
      { kind: 'note', text: "You see your own leads; a team manager sees the team's." },
      {
        kind: 'kanban', title: 'Open opportunities', rows: 'board', groupBy: 'stageId', empty: 'No open opportunities.',
        lanes: (data.lanes as { id: string; name: string }[]).map(s => ({ value: s.id, label: s.name })),
        card: { title: 'title', subtitle: 'company', meta: [{ key: 'expectedValuePaise', label: 'Value', kind: 'money' }, { key: 'expectedClose', label: 'Close', kind: 'date' }], href: '/m/crm/lead?id={id}' },
      },
      {
        kind: 'table', title: 'All leads', rows: 'leads', empty: 'No leads yet.', paging: { data: 'leadsPage', sorts: ['updated', 'close', 'title'] },
        columns: [
          { key: 'title', label: 'Title', href: '/m/crm/lead?id={id}' }, { key: 'kind', label: 'Kind' }, { key: 'status', label: 'Status', kind: 'status' }, { key: 'stageName', label: 'Stage' },
          { key: 'ownerName', label: 'Owner' }, { key: 'expectedValuePaise', label: 'Value', kind: 'money' }, { key: 'close', label: 'Close', kind: 'date' }, { key: 'updated', label: 'Updated', kind: 'date' },
        ],
      },
      form('New lead', '/leads', [{ name: 'kind', label: 'Kind', kind: 'radio', options: choice(['lead', 'opportunity']), value: 'lead' }, ...leadFields('items', false).slice(0, 7), pick('source', 'Where it came from', 'sources'), ...leadFields('items', false).slice(7)], STAFF_ROLES),
    ],
  }),
  screen({
    path: '/lead', title: 'Lead', roles: STAFF_ROLES,
    load: async (actor, request) => {
      const id = idOf(request)
      const empty = { lead: null, activities: [], stages: [], reasons: [], owners: [], assignees: [], items: [], customers: [], matches: [], admin: false, stageName: null, ownerName: '', lostReason: null }
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
        owners: ownerOptions, assignees: [...new Map([me ?? { value: actor.id, label: 'Me' }, owner ?? { value: lead.ownerId, label: detail.ownerName }].map(o => [o.value, o])).values()],
        items: await items(actor), customers: convert.customers, matches: convert.matches,
        activities: detail.activities.map(a => ({ ...a, dueAt: a.dueAt.toISOString(), doneAt: a.doneAt?.toISOString() ?? null })),
      }
    },
    sections: (data): PluginSection[] => {
      const lead = data.lead as null | { id: string; kind: string; status: string; title: string; notes: string | null; expectedValuePaise: number | null; expectedClose: string | null; partyId: string | null; quotationId: string | null; erasedAt: Date | null }
      if (!lead) return [{ kind: 'note', text: 'Open a lead from the pipeline.' }, { kind: 'shortcuts', items: [{ label: 'Pipeline', href: '/m/crm' }] }]
      const id = hidden('leadId', lead.id)
      const open = lead.status === 'open'
      const acts = data.activities as { id: string; summary: string; doneAt: string | null }[]
      const head: PluginSection[] = [
        { kind: 'figures', figures: [
          { label: 'Kind', value: lead.kind }, { label: 'Status', value: lead.status }, { label: 'Stage', value: (data.stageName as string | null) ?? '—' }, { label: 'Owner', value: data.ownerName as string },
          { label: 'Expected value', value: rupees(lead.expectedValuePaise) }, { label: 'Expected close', value: lead.expectedClose ?? '—' },
        ] },
        ...(lead.notes ? [{ kind: 'prose' as const, title: lead.title, text: lead.notes }] : [{ kind: 'prose' as const, title: 'Lead', text: lead.title }]),
        table('Activities', 'activities', [{ key: 'kind', label: 'Kind' }, { key: 'summary', label: 'What' }, { key: 'dueAt', label: 'Due', kind: 'when' }, { key: 'doneAt', label: 'Done', kind: 'when' }]),
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
        ...(open ? [form('Add activity', '/activities', [id, { name: 'kind', label: 'Kind', kind: 'select', options: choice(['call', 'meeting', 'task']) }, field('summary', 'What'), field('dueAt', 'Due', 'datetime'), { name: 'remindBefore', label: 'Remind me', kind: 'select', options: [{ value: '15m', label: '15 minutes before' }, { value: '1h', label: '1 hour before' }, { value: '1d', label: '1 day before' }, { value: 'none', label: 'Do not remind' }] }, pick('assigneeId', 'Assigned to', 'assignees', true)], STAFF_ROLES)] : []),
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
          stageOptions: cfg.stages.map(s => ({ value: s.id, label: s.name })), reasonOptions: cfg.reasons.filter(r => !r.archived).map(r => ({ value: r.id, label: r.name })), teamOptions: cfg.teams.map(t => ({ value: t.id, label: t.name })) }
      } catch (error) {
        if (!refusedWith('not_in_sales_team')(error)) throw error
        return { member: false, admin, stages: [], reasons: [], teams: [], memberships: [], staff: [], stageOptions: [], reasonOptions: [], teamOptions: [] }
      }
    },
    sections: (data): PluginSection[] => !data.member ? [{ kind: 'note', text: NOT_IN_TEAM }] : [
      table('Pipeline stages', 'stages', [{ key: 'name', label: 'Stage' }, { key: 'seq', label: 'Order' }, { key: 'archived', label: 'Archived', kind: 'bool' }]),
      table('Lost reasons', 'reasons', [{ key: 'name', label: 'Reason' }, { key: 'archived', label: 'Archived', kind: 'bool' }]),
      table('Teams', 'teams', [{ key: 'name', label: 'Team' }, { key: 'managerName', label: 'Manager' }, { key: 'memberNames', label: 'Members' }]),
      ...(data.admin ? [
        form('Add stage', '/stages', [field('name', 'Name'), field('seq', 'Order', 'number')]),
        form('Change stage', '/stages/update', [pick('stageId', 'Stage', 'stageOptions'), field('name', 'New name', 'text', true), field('seq', 'New order', 'number', true), field('archived', 'Archive it', 'checkbox', true)]),
        form('Add lost reason', '/lost-reasons', [field('name', 'Reason')]),
        form('Archive lost reason', '/lost-reasons/archive', [pick('reasonId', 'Reason', 'reasonOptions')]),
        form('Create team', '/teams', [field('name', 'Team name'), pick('managerId', 'Manager', 'staff')]),
        form('Add team member', '/teams/members', [pick('teamId', 'Team', 'teamOptions'), pick('userId', 'Person', 'staff')]),
        form('Remove team member', '/teams/members/remove', [pick('teamId', 'Team', 'teamOptions'), pick('userId', 'Person', 'staff')]),
      ] : []),
    ],
  }),
]
