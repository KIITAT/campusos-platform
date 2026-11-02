import type { PluginField, PluginPage, PluginSection } from '@campusos/module-framework'
import {
  OFFICE, listBillings, listCostings, listCostRates, listProjects, listTasks, listTimesheets, profitability, projectDetail, taskDetail,
  billingPage, costingPage, profitPage, projectPage, ratePage, sheetPage, taskPage,
} from './api'
import {
  NO_PICKERS, OFFICE_ROLES, STAFF_ROLES, field, form, hidden, memberOptions, officePickers, pick, rupees, screen, staffOptions, table, withValue,
} from './ui'

const param = (request: Request, name: string) => new URL(request.url).searchParams.get(name) ?? ''
const big = () => new Request('https://x/?n=500')
const label = (p: { code: string; name: string }) => `${p.code} ${p.name}`

/** The fields of a project's money, shared by the create form. */
const moneyFields = (): PluginField[] => [
  pick('partyId', 'Customer', 'customerOptions', true),
  { name: 'billingRate', label: 'Hourly rate (₹)', kind: 'money', optional: true },
  pick('taxTemplateId', 'Tax', 'taxOptions', true),
  pick('fundId', 'Fund', 'fundOptions', true),
]

export const pages: PluginPage[] = [
  screen({
    path: '/', title: 'Projects', menu: 'Projects', roles: STAFF_ROLES,
    load: async (actor, request) => {
      const found = await listProjects(actor, {}, projectPage(request, 'projects'))
      const office = OFFICE.includes(actor.role)
      return {
        projects: found.rows,
        projectsPage: { total: found.total, next: found.next },
        office,
        staffOptions: office ? await staffOptions(actor) : [],
        ...(office ? await officePickers(actor) : NO_PICKERS),
      }
    },
    sections: (data) => [
      { kind: 'note', text: "A project's money is kept in the books under its cost centre. Time is logged on a task, approved by the project manager, then billed and costed by the accounts office." },
      {
        kind: 'table', title: 'Projects', rows: 'projects', empty: 'No projects yet.',
        paging: { data: 'projectsPage', sorts: ['code', 'name'] },
        columns: [
          { key: 'code', label: 'Code', kind: 'code', href: '/m/projects/project?id={id}' },
          { key: 'name', label: 'Name' },
          { key: 'managerName', label: 'Manager' },
          { key: 'status', label: 'Status', kind: 'status' },
          { key: 'startsOn', label: 'Starts', kind: 'date' },
          { key: 'endsOn', label: 'Ends', kind: 'date' },
          { key: 'billable', label: 'Billable', kind: 'bool' },
        ],
      },
      ...(data.office ? [form('New project', '/projects', [
        field('code', 'Code'), field('name', 'Name'), field('description', 'Description', 'textarea', true),
        pick('managerId', 'Manager', 'staffOptions'), pick('costCenter', 'Cost centre', 'costCenterOptions'),
        field('startsOn', 'Starts', 'date'), field('endsOn', 'Ends', 'date', true), field('billable', 'Billable', 'checkbox', true),
        ...moneyFields(),
      ], OFFICE_ROLES)] : []),
    ],
  }),

  screen({
    path: '/project', title: 'Project', roles: STAFF_ROLES,
    load: async (actor, request) => {
      const id = param(request, 'id')
      if (!id) return { project: null }
      const detail = await projectDetail(actor, id)
      const found = await listTasks(actor, { projectId: id }, taskPage(request, 'tasks'))
      const office = OFFICE.includes(actor.role)
      return {
        project: detail.project,
        managerName: detail.managerName,
        members: detail.members,
        milestones: detail.milestones,
        stages: detail.stages,
        tasks: found.rows,
        tasksNext: found.next,
        canManage: detail.canManage,
        office,
        staffOptions: detail.canManage ? await staffOptions(actor) : [],
        memberOptions: detail.canManage ? memberOptions(detail) : [],
        stageOptions: detail.stages.map((s) => ({ value: s.id, label: s.name })),
        milestoneOptions: detail.milestones.filter((m) => !m.reachedOn).map((m) => ({ value: m.id, label: m.name })),
        ...(office ? await officePickers(actor) : NO_PICKERS),
      }
    },
    sections: (data) => {
      const p = data.project
      if (!p) return [{ kind: 'note', text: 'Open a project from the project list.' }, { kind: 'shortcuts', items: [{ label: 'Projects', href: '/m/projects' }] }]
      const sections: PluginSection[] = [
        {
          kind: 'figures',
          figures: [
            { label: 'Status', value: p.status },
            { label: 'Manager', value: data.managerName ?? '' },
            { label: 'Cost centre', value: p.costCenter },
            { label: 'Billing', value: p.billable && p.billingRatePaise ? `₹${rupees(p.billingRatePaise)}/h` : 'Not billed' },
            { label: 'Starts', value: p.startsOn },
            { label: 'Ends', value: p.endsOn ?? '' },
          ],
        },
        {
          kind: 'kanban', title: 'Tasks', rows: 'tasks', groupBy: 'stageId', empty: 'No tasks yet.',
          lanes: data.stages.map((s) => ({ value: s.id, label: s.name, tone: s.closes ? 'green' as const : 'blue' as const })),
          card: { title: 'title', subtitle: 'assigneeName', meta: [{ key: 'deadline', label: 'Due', kind: 'date' }], href: '/m/projects/task?id={id}' },
        },
        ...(data.tasksNext ? [{ kind: 'shortcuts' as const, items: [{ label: 'More tasks', href: `/m/projects/project?id=${p.id}&tasks.after=${encodeURIComponent(data.tasksNext)}` }] }] : []),
        table('Milestones', 'milestones', [{ key: 'name', label: 'Milestone' }, { key: 'dueOn', label: 'Due', kind: 'date' }, { key: 'reachedOn', label: 'Reached', kind: 'date' }]),
        table('Members', 'members', [{ key: 'name', label: 'Name' }, { key: 'role', label: 'Role' }, { key: 'addedAt', label: 'Added', kind: 'date' }]),
      ]
      if (data.canManage) {
        sections.push(
          form('New task', '/tasks', [
            hidden('projectId', p.id), field('title', 'Title'), field('description', 'Description', 'textarea', true),
            pick('stageId', 'Stage', 'stageOptions', true), pick('assigneeId', 'Assignee', 'memberOptions', true),
            field('deadline', 'Due', 'date', true), pick('milestoneId', 'Milestone', 'milestoneOptions', true),
          ]),
          form('Add member', '/members', [hidden('projectId', p.id), pick('userId', 'Person', 'staffOptions')]),
          form('Remove member', '/members/remove', [hidden('projectId', p.id), pick('userId', 'Person', 'memberOptions')]),
          form('Add stage', '/stages', [hidden('projectId', p.id), field('name', 'Name'), field('seq', 'Position', 'number'), field('closes', 'Closes the task', 'checkbox', true)]),
          form('Add milestone', '/milestones', [hidden('projectId', p.id), field('name', 'Name'), field('dueOn', 'Due', 'date', true)]),
          form('Mark a milestone reached', '/milestones/reached', [pick('milestoneId', 'Milestone', 'milestoneOptions')]),
        )
      }
      if (data.office) {
        sections.push(
          form('Edit project', '/projects/update', [
            hidden('projectId', p.id), withValue(field('name', 'Name'), p.name), withValue(field('description', 'Description', 'textarea', true), p.description),
            withValue(pick('managerId', 'Manager', 'staffOptions'), p.managerId), withValue(field('endsOn', 'Ends', 'date', true), p.endsOn),
            withValue(field('billable', 'Billable', 'checkbox', true), p.billable ? 'true' : ''),
            withValue(pick('partyId', 'Customer', 'customerOptions', true), p.partyId),
            withValue({ name: 'billingRate', label: 'Hourly rate (₹)', kind: 'money', optional: true }, p.billingRatePaise ? rupees(p.billingRatePaise) : ''),
            withValue(pick('taxTemplateId', 'Tax', 'taxOptions', true), p.taxTemplateId),
            withValue(pick('fundId', 'Fund', 'fundOptions', true), p.fundId),
          ], OFFICE_ROLES),
          form('Close or reopen', '/projects/status', [
            hidden('projectId', p.id),
            { name: 'status', label: 'Status', kind: 'select', options: [{ value: 'active', label: 'active' }, { value: 'closed', label: 'closed' }], value: p.status },
          ], OFFICE_ROLES),
        )
      }
      return sections
    },
  }),

  screen({
    path: '/task', title: 'Task', roles: STAFF_ROLES,
    load: async (actor, request) => {
      const id = param(request, 'id')
      if (!id) return { task: null }
      const detail = await taskDetail(actor, id)
      const found = await listTimesheets(actor, { taskId: id }, sheetPage(request, 'time'))
      const project = detail.canManage || detail.canApprove ? await projectDetail(actor, detail.project.id) : null
      return {
        task: detail.task,
        project: detail.project,
        canManage: detail.canManage,
        canApprove: detail.canApprove,
        time: found.rows,
        timePage: { total: found.total, next: found.next },
        memberOptions: project ? memberOptions(project) : [],
        stageOptions: project ? project.stages.map((s) => ({ value: s.id, label: s.name })) : [],
        milestoneOptions: project ? project.milestones.map((m) => ({ value: m.id, label: m.name })) : [],
      }
    },
    sections: (data) => {
      const t = data.task
      if (!t) return [{ kind: 'note', text: 'Open a task from its project.' }]
      const sections: PluginSection[] = [
        {
          kind: 'figures',
          figures: [
            { label: 'Project', value: label(data.project), href: `/m/projects/project?id=${data.project.id}` },
            { label: 'Stage', value: t.stageName },
            { label: 'Assignee', value: t.assigneeName ?? '' },
            { label: 'Due', value: t.deadline ?? '' },
            { label: 'Milestone', value: t.milestoneName ?? '' },
          ],
        },
        ...(t.description ? [{ kind: 'prose' as const, title: 'Description', text: t.description }] : []),
        {
          kind: 'table', title: 'Time on this task', rows: 'time', empty: 'No time logged yet.',
          paging: { data: 'timePage', sorts: ['workDate'] },
          columns: [
            { key: 'workDate', label: 'Day', kind: 'date' }, { key: 'person', label: 'Person' }, { key: 'hours', label: 'Hours' },
            { key: 'description', label: 'Work' }, { key: 'status', label: 'Status', kind: 'status' },
          ],
        },
        form('Log time', '/timesheets', [
          hidden('taskId', t.id), field('workDate', 'Day', 'date'),
          { name: 'minutes', label: 'Minutes', kind: 'number', hint: 'In steps of 15, up to 1440' },
          field('description', 'What was done', 'textarea'),
          ...(data.canApprove ? [pick('userId', 'For (empty: yourself)', 'memberOptions', true)] : []),
        ]),
      ]
      if (data.canManage) {
        sections.push(form('Edit task', '/tasks/update', [
          hidden('taskId', t.id), withValue(field('title', 'Title'), t.title), withValue(field('description', 'Description', 'textarea', true), t.description),
          withValue(pick('stageId', 'Stage', 'stageOptions'), t.stageId), withValue(pick('assigneeId', 'Assignee', 'memberOptions', true), t.assigneeId),
          withValue(field('deadline', 'Due', 'date', true), t.deadline), withValue(pick('milestoneId', 'Milestone', 'milestoneOptions', true), t.milestoneId),
        ]))
      }
      return sections
    },
  }),

  screen({
    path: '/timesheets', title: 'Timesheets', menu: 'Timesheets', roles: STAFF_ROLES,
    load: async (actor, request) => {
      const mine = await listTimesheets(actor, { userId: actor.id }, sheetPage(request, 'mine'))
      const queue = await listTimesheets(actor, { queue: 'approvals' }, sheetPage(request, 'queue'))
      const reopenable = await listTimesheets(actor, { queue: 'reopenable' }, sheetPage(big(), ''))
      const named = (r: { workDate: string; projectCode: string; taskTitle: string; hours: string }) => `${r.workDate} ${r.projectCode} ${r.taskTitle} ${r.hours} h`
      return {
        mine: mine.rows,
        minePage: { total: mine.total, next: mine.next },
        queue: queue.rows,
        queuePage: { total: queue.total, next: queue.next },
        editableOptions: mine.rows.filter((r) => r.status === 'submitted' || r.status === 'rejected').map((r) => ({ value: r.id, label: named(r) })),
        reopenOptions: reopenable.rows.map((r) => ({ value: r.id, label: named(r) })),
      }
    },
    sections: (data) => [
      { kind: 'note', text: "Log time from a task's page. Approved time is billed and costed by the accounts office; once it is, it is kept as it was." },
      {
        kind: 'table', title: 'My time', rows: 'mine', empty: 'No time logged yet.',
        paging: { data: 'minePage', sorts: ['workDate'] },
        columns: [
          { key: 'workDate', label: 'Day', kind: 'date' }, { key: 'projectCode', label: 'Project' },
          { key: 'taskTitle', label: 'Task', href: '/m/projects/task?id={taskId}' }, { key: 'hours', label: 'Hours' },
          { key: 'description', label: 'Work' }, { key: 'status', label: 'Status', kind: 'status' }, { key: 'decisionNote', label: 'Note' },
        ],
      },
      {
        kind: 'table', title: 'Waiting for my approval', rows: 'queue', empty: 'Nothing is waiting for you.',
        paging: { data: 'queuePage', sorts: ['workDate'] },
        columns: [
          { key: 'person', label: 'Person' }, { key: 'workDate', label: 'Day', kind: 'date' }, { key: 'projectCode', label: 'Project' },
          { key: 'taskTitle', label: 'Task' }, { key: 'hours', label: 'Hours' }, { key: 'description', label: 'Work' },
        ],
        bulk: [
          { label: 'Approve', path: '/timesheets/decide', idKey: 'id', field: 'ids', fields: [hidden('decision', 'approved')], roles: STAFF_ROLES },
          { label: 'Reject', path: '/timesheets/decide', idKey: 'id', field: 'ids', fields: [hidden('decision', 'rejected'), field('note', 'Why')], roles: STAFF_ROLES, tone: 'danger' },
        ],
      },
      form('Change my time', '/timesheets/update', [
        pick('lineId', 'Line', 'editableOptions'), field('workDate', 'Day', 'date'), field('minutes', 'Minutes', 'number'), field('description', 'What was done', 'textarea'),
      ]),
      form('Delete my time', '/timesheets/delete', [pick('lineId', 'Line', 'editableOptions')]),
      ...((data.reopenOptions as unknown[]).length > 0
        ? [form('Reopen approved time', '/timesheets/reopen', [pick('lineId', 'Line', 'reopenOptions'), field('reason', 'Why')])]
        : []),
    ],
  }),

  screen({
    path: '/money', title: 'Billing and costs', menu: 'Billing and costs', roles: OFFICE_ROLES,
    load: async (actor, request) => {
      const rates = await listCostRates(actor, {}, ratePage(request, 'rates'))
      const billed = await listBillings(actor, {}, billingPage(request, 'billings'))
      const costed = await listCostings(actor, {}, costingPage(request, 'costings'))
      const active = await listProjects(actor, { status: 'active' }, projectPage(big(), ''))
      const open = await listCostings(actor, { open: 'true' }, costingPage(big(), ''))
      return {
        rates: rates.rows, ratesPage: { total: rates.total, next: rates.next },
        billings: billed.rows, billingsPage: { total: billed.total, next: billed.next },
        costings: costed.rows, costingsPage: { total: costed.total, next: costed.next },
        staffOptions: await staffOptions(actor),
        projectOptions: active.rows.map((r) => ({ value: r.id, label: label(r) })),
        billableOptions: active.rows.filter((r) => r.billable).map((r) => ({ value: r.id, label: label(r) })),
        costingOptions: open.rows.map((r) => ({ value: r.id, label: `${r.projectCode} ${r.period} ₹${rupees(r.amountPaise)}` })),
      }
    },
    sections: () => [
      {
        kind: 'table', title: 'Cost rates', rows: 'rates', empty: 'No cost rates yet.',
        paging: { data: 'ratesPage', sorts: ['effectiveFrom'] },
        columns: [
          { key: 'person', label: 'Person' }, { key: 'effectiveFrom', label: 'From', kind: 'date' },
          { key: 'hourlyCostPaise', label: 'Hourly cost', kind: 'money' }, { key: 'homeCostCenter', label: 'Home cost centre' },
        ],
      },
      form('Set a cost rate', '/cost-rates', [
        pick('userId', 'Person', 'staffOptions'), field('effectiveFrom', 'From', 'date'), field('hourlyCost', 'Hourly cost (₹)', 'money'),
        { name: 'homeCostCenter', label: 'Home cost centre', kind: 'text', optional: true, hint: "The cost centre payroll posts this person's salary to: their HR department, as written there" },
      ], OFFICE_ROLES),
      {
        kind: 'table', title: 'Billings', rows: 'billings', empty: 'Nothing billed yet.',
        paging: { data: 'billingsPage', sorts: ['billedOn'] },
        columns: [
          { key: 'billedOn', label: 'Billed', kind: 'date' }, { key: 'projectCode', label: 'Project' },
          { key: 'invoiceNumber', label: 'Invoice', kind: 'code', href: '/m/finance/invoice?id={invoiceId}' },
          { key: 'hours', label: 'Hours' }, { key: 'amountPaise', label: 'Amount', kind: 'money' },
        ],
      },
      form('Bill a project', '/billings', [pick('projectId', 'Project', 'billableOptions'), field('through', 'Through', 'date', true)], OFFICE_ROLES),
      {
        kind: 'table', title: 'Costings', rows: 'costings', empty: 'Nothing costed yet.',
        paging: { data: 'costingsPage', sorts: ['postedOn'] },
        columns: [
          { key: 'postedOn', label: 'Posted', kind: 'date' }, { key: 'projectCode', label: 'Project' }, { key: 'period', label: 'Month' },
          { key: 'hours', label: 'Hours' }, { key: 'amountPaise', label: 'Amount', kind: 'money' }, { key: 'reversed', label: 'Reversed', kind: 'bool' },
        ],
      },
      form('Cost a month', '/costings', [
        pick('projectId', 'Project', 'projectOptions'),
        { name: 'period', label: 'Month', kind: 'text', hint: 'YYYY-MM, a month that has ended' },
      ], OFFICE_ROLES),
      form('Reverse a costing', '/costings/reverse', [pick('costingId', 'Costing', 'costingOptions'), field('reason', 'Why')], OFFICE_ROLES),
    ],
  }),

  screen({
    path: '/profitability', title: 'Project profitability', menu: 'Profitability', roles: OFFICE_ROLES,
    load: async (actor, request) => {
      const report = await profitability(actor, { from: param(request, 'from'), to: param(request, 'to') }, profitPage(request, 'projects'))
      return { from: report.from, to: report.to, projects: report.rows, projectsPage: { total: report.total, next: report.next } }
    },
    sections: (data) => [
      {
        kind: 'form', title: 'Period', path: '/profitability', method: 'GET', submit: 'Show',
        fields: [withValue(field('from', 'From', 'date', true), data.from), withValue(field('to', 'To', 'date', true), data.to)],
      },
      { kind: 'note', text: "Income and expense are read from the books by each project's cost centre. Billed and costed are this module's own records; a difference is something else posted to the cost centre, such as a credit note or a purchase." },
      {
        kind: 'table', title: 'Projects', rows: 'projects', empty: 'No projects yet.',
        paging: { data: 'projectsPage', sorts: ['code', 'name'] },
        columns: [
          { key: 'code', label: 'Code' }, { key: 'name', label: 'Name' }, { key: 'hours', label: 'Hours' },
          { key: 'billedPaise', label: 'Billed', kind: 'money' }, { key: 'incomePaise', label: 'Income in the books', kind: 'money' },
          { key: 'costedPaise', label: 'Costed', kind: 'money' }, { key: 'expensePaise', label: 'Expense in the books', kind: 'money' },
          { key: 'marginPaise', label: 'Margin', kind: 'money' },
          { key: 'unexplainedIncomePaise', label: 'Income not from billing', kind: 'money' },
          { key: 'unexplainedExpensePaise', label: 'Expense not from costing', kind: 'money' },
        ],
      },
    ],
  }),
]
