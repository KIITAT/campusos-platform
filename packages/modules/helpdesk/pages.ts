import type { PluginPage } from '@campusos/module-framework'
import { ADMIN, MEMBERS, STAFF, caseDetail, listCases } from './api'
import { choice, field, form, hidden, people, pick, screen, table } from './ui'

export const pages: PluginPage[] = [
  screen({
    path: '/', title: 'Helpdesk and grievances', menu: 'Cases', roles: MEMBERS,
    load: async actor => ({ cases: await listCases(actor) }),
    sections: () => [
      { kind: 'note', text: 'Only the reporter, assigned staff member and institution administrators can read a case. Grievances are always confidential. Case contents are not copied into the audit log.' },
      table('Accessible cases', 'cases', [{ key: 'subject', label: 'Subject', href: '/m/helpdesk/case?id={id}' }, { key: 'kind', label: 'Kind' }, { key: 'status', label: 'Status', kind: 'status' }, { key: 'confidential', label: 'Confidential', kind: 'bool' }, { key: 'updatedAt', label: 'Updated', kind: 'date' }]),
      form('Open case', '/cases', [field('subject', 'Subject'), field('description', 'Describe the issue', 'textarea'), { name: 'kind', label: 'Case type', kind: 'select', options: choice(['helpdesk', 'grievance']) }, field('confidential', 'Confidential', 'checkbox', true)], MEMBERS),
    ],
  }),
  screen({
    path: '/case', title: 'Case discussion', roles: MEMBERS,
    load: async (actor, request) => {
      const id = new URL(request.url).searchParams.get('id')
      const detail = id ? await caseDetail(actor, id) : null
      const identities = detail && ADMIN.includes(actor.role) ? await people(actor) : []
      return {
        issue: detail?.case ?? null, messages: detail?.messages ?? [], actorId: actor.id, office: ADMIN.includes(actor.role), staff: STAFF.includes(actor.role),
        staffOptions: identities.filter(row => STAFF.includes(row.role)).map(row => ({ value: row.id, label: `${row.name} · ${row.role}` })),
      }
    },
    sections: data => {
      const issue = data.issue
      if (!issue) return [{ kind: 'note', text: 'Open a case from the case list to read its discussion.' }, { kind: 'shortcuts', items: [{ label: 'Case list', href: '/m/helpdesk' }] }]
      return [
        { kind: 'figures', figures: [{ label: 'Status', value: issue.status }, { label: 'Kind', value: issue.kind }, { label: 'Privacy', value: issue.confidential ? 'Confidential' : 'Participants only' }] },
        { kind: 'prose', title: issue.subject, text: issue.description },
        ...(issue.resolution ? [{ kind: 'prose' as const, title: 'Resolution', text: issue.resolution }] : []),
        table('Discussion', 'messages', [{ key: 'author', label: 'Author' }, { key: 'body', label: 'Message' }, { key: 'createdAt', label: 'Sent', kind: 'date' }]),
        ...(issue.status !== 'resolved' ? [
          form('Add message', '/cases/messages', [hidden('caseId', issue.id), field('body', 'Message', 'textarea')], MEMBERS),
          ...(data.office ? [form('Assign case', '/cases/assign', [hidden('caseId', issue.id), pick('assigneeId', 'Staff member', 'staffOptions')])] : []),
          ...(data.office || (data.staff && issue.assigneeId === data.actorId) ? [form('Resolve case', '/cases/resolve', [hidden('caseId', issue.id), field('resolution', 'Resolution', 'textarea')], STAFF)] : []),
        ] : data.office || issue.reporterId === data.actorId ? [form('Reopen case', '/cases/reopen', [hidden('caseId', issue.id), field('reason', 'What still needs attention?', 'textarea')], MEMBERS)] : []),
      ]
    },
  }),
]
