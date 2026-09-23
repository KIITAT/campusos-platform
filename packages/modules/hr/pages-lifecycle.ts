import { formatPaise } from '@campusos/money'
import { param, type PluginPage } from '@campusos/module-framework'
import {
  exitInterviewsOutstanding,
  gradeUsage,
  listChanges,
  listOnboardingTemplates,
  listSeparations,
  listStaff,
  onboardingFor,
  openOnboardings,
  type Actor,
} from './api'

const OFFICE = ['institution_admin', 'super_admin', 'accounts_staff'] as const
const ADMIN = ['institution_admin', 'super_admin'] as const

const staffOptions = (rows: Awaited<ReturnType<typeof listStaff>>) =>
  rows.map((s) => ({ value: s.id, label: `${s.employeeCode} - ${s.name}` }))

const band = (min: number | null, max: number | null) =>
  min === null && max === null
    ? 'no band'
    : `${min === null ? '...' : formatPaise(min)} to ${max === null ? '...' : formatPaise(max)}`

export const lifecyclePages: PluginPage[] = [
  {
    path: '/onboarding',
    title: 'Onboarding',
    menu: 'Onboarding',
    roles: [...OFFICE],
    async load(actor, req) {
      const a = actor as Actor
      const staffId = param(req, 'staffId')
      const [open, templates, staff] = await Promise.all([
        openOnboardings(a),
        listOnboardingTemplates(a),
        listStaff(a),
      ])
      const run = staffId ? await onboardingFor(a, staffId) : null
      return {
        open: open.map((o) => ({ ...o, step: `${o.seq}. ${o.title}` })),
        overdue: open.filter((o) => o.overdue).length,
        templates: templates.map((t) => ({
          ...t,
          steps: t.activities.length,
          outline: t.activities.map((x) => x.title).join(' / '),
        })),
        templateOptions: templates.map((t) => ({ value: t.id, label: `${t.code} - ${t.name}` })),
        staffOptions: staffOptions(staff),
        run: run?.activities ?? [],
        runTitle: run
          ? `${run.templateName}, started ${run.startedOn}` +
            (run.completedAt ? `, complete` : `, ${run.outstanding} outstanding`)
          : '',
        activityOptions: open.map((o) => ({
          value: o.activityId,
          label: `${o.employeeCode} - ${o.seq}. ${o.title} (${o.owner})`,
        })),
      }
    },
    sections: (data) => [
      {
        kind: 'note',
        tone: (data.overdue as number) > 0 ? 'warn' : 'info',
        text:
          `${(data.open as unknown[]).length} activities open, ${data.overdue} overdue. ` +
          'Due dates count from the joining date, so a checklist started late is ' +
          'visibly late. An onboarding completes itself when its last activity does.',
      },
      {
        kind: 'table',
        title: 'Open, across everybody',
        rows: 'open',
        empty: 'Nothing open.',
        columns: [
          { key: 'employeeCode', label: 'Code', kind: 'code', href: '/m/hr/onboarding?staffId={staffId}' },
          { key: 'staffName', label: 'Name' },
          { key: 'step', label: 'Activity' },
          { key: 'owner', label: 'Owner' },
          { key: 'dueOn', label: 'Due', kind: 'date', alertWhen: 'overdue' },
        ],
      },
      {
        kind: 'table',
        title: (data.runTitle as string) || 'One person’s checklist',
        rows: 'run',
        empty: 'Pick somebody above to see their whole checklist.',
        columns: [
          { key: 'seq', label: '#' },
          { key: 'title', label: 'Activity' },
          { key: 'owner', label: 'Owner' },
          { key: 'dueOn', label: 'Due', kind: 'date', alertWhen: 'overdue' },
          { key: 'doneAt', label: 'Done', kind: 'when' },
          { key: 'note', label: 'Note' },
        ],
      },
      {
        kind: 'form',
        title: 'Mark an activity done',
        submit: 'Done',
        path: '/onboarding/complete',
        fields: [
          { name: 'activityId', label: 'Activity', kind: 'select', options: 'activityOptions' },
          { name: 'note', label: 'Note', optional: true },
        ],
      },
      {
        kind: 'form',
        title: 'Start somebody’s onboarding',
        note: 'The template is copied, so editing it later does not rewrite this.',
        submit: 'Start',
        path: '/onboarding',
        fields: [
          { name: 'staffId', label: 'Who', kind: 'select', options: 'staffOptions' },
          { name: 'templateId', label: 'Checklist', kind: 'select', options: 'templateOptions' },
        ],
      },
      {
        kind: 'table',
        title: 'Checklists',
        rows: 'templates',
        empty: 'No checklists yet. Define one through the API: POST /onboarding/templates.',
        columns: [
          { key: 'code', label: 'Code', kind: 'code' },
          { key: 'name', label: 'Name' },
          { key: 'steps', label: 'Steps' },
          { key: 'outline', label: 'Activities' },
        ],
      },
    ],
  },

  {
    path: '/lifecycle',
    title: 'Employment history',
    menu: 'History',
    roles: [...OFFICE],
    async load(actor, req) {
      const a = actor as Actor
      const staffId = param(req, 'staffId')
      const [changes, separations, outstanding, grades, active] = await Promise.all([
        listChanges(a, staffId),
        listSeparations(a),
        exitInterviewsOutstanding(a),
        gradeUsage(a),
        listStaff(a),
      ])
      const move = (from: string | null, to: string | null) =>
        to === null ? '' : `${from ?? '-'} -> ${to}`
      return {
        changes: changes.map((c) => ({
          ...c,
          designation: move(c.fromDesignation, c.toDesignation),
          department: move(c.fromDepartment, c.toDepartment),
          grade: move(c.fromGrade, c.toGrade),
          employment: move(c.fromEmployment, c.toEmployment),
        })),
        separations: separations.map((s) => ({
          ...s,
          rehire: s.rehireEligible === null ? '' : s.rehireEligible ? 'yes' : 'no',
        })),
        outstanding: outstanding.length,
        grades: grades.map((g) => ({ ...g, band: band(g.minPaise, g.maxPaise) })),
        gradeOptions: grades.map((g) => ({ value: g.id, label: `${g.code} - ${g.name}` })),
        activeOptions: staffOptions(active),
        separatedOptions: separations
          .filter((s) => s.interviewPending)
          .map((s) => ({ value: s.staffId, label: `${s.employeeCode} - ${s.staffName}` })),
      }
    },
    sections: (data) => [
      {
        kind: 'note',
        text:
          'Every transfer, promotion, confirmation and separation as a dated row. ' +
          'The staff record carries where somebody is; this is how they got there.',
      },
      {
        kind: 'table',
        title: 'Changes',
        rows: 'changes',
        empty: 'No changes recorded.',
        columns: [
          { key: 'effectiveOn', label: 'From', kind: 'date' },
          { key: 'employeeCode', label: 'Code', kind: 'code', href: '/m/hr/lifecycle?staffId={staffId}' },
          { key: 'staffName', label: 'Name' },
          { key: 'kind', label: 'Change' },
          { key: 'designation', label: 'Designation' },
          { key: 'department', label: 'Department' },
          { key: 'grade', label: 'Grade' },
          { key: 'employment', label: 'Employment' },
          { key: 'reason', label: 'Why' },
        ],
      },
      {
        kind: 'form',
        title: 'Record a change',
        note: 'What you leave blank does not move.',
        submit: 'Record',
        path: '/changes',
        roles: [...ADMIN],
        fields: [
          { name: 'staffId', label: 'Who', kind: 'select', options: 'activeOptions' },
          {
            name: 'kind',
            label: 'Change',
            kind: 'select',
            options: [
              { value: 'transfer', label: 'transfer' },
              { value: 'promotion', label: 'promotion' },
              { value: 'confirmation', label: 'confirmation' },
              { value: 'grade_change', label: 'grade change' },
            ],
          },
          { name: 'effectiveOn', label: 'Effective on', kind: 'date' },
          { name: 'toDesignation', label: 'New designation', optional: true },
          { name: 'toDepartment', label: 'New department', optional: true },
          { name: 'toGradeId', label: 'New grade', kind: 'select', options: 'gradeOptions', optional: true },
          {
            name: 'toEmployment',
            label: 'New employment',
            kind: 'select',
            optional: true,
            options: [
              { value: 'permanent', label: 'permanent' },
              { value: 'contract', label: 'contract' },
              { value: 'visiting', label: 'visiting' },
              { value: 'probation', label: 'probation' },
            ],
          },
          { name: 'reason', label: 'Reason' },
        ],
      },
      {
        kind: 'table',
        title: 'Separations',
        note: `${data.outstanding} exit interviews not yet held.`,
        rows: 'separations',
        empty: 'Nobody has left.',
        columns: [
          { key: 'lastDayOn', label: 'Last day', kind: 'date' },
          { key: 'employeeCode', label: 'Code', kind: 'code' },
          { key: 'staffName', label: 'Name' },
          { key: 'kind', label: 'How' },
          { key: 'noticeGivenOn', label: 'Notice', kind: 'date' },
          { key: 'exitInterviewOn', label: 'Interviewed', kind: 'date', alertWhen: 'interviewPending' },
          { key: 'rehire', label: 'Rehire' },
          { key: 'reason', label: 'Why' },
        ],
      },
      {
        kind: 'form',
        title: 'Separate',
        note:
          'Ends the employment, records the change and the separation together. ' +
          'Audited; the leaving date does not move afterwards without a reason.',
        submit: 'Separate',
        path: '/separations',
        roles: [...ADMIN],
        fields: [
          { name: 'staffId', label: 'Who', kind: 'select', options: 'activeOptions' },
          {
            name: 'kind',
            label: 'How',
            kind: 'select',
            options: [
              { value: 'resignation', label: 'resignation' },
              { value: 'retirement', label: 'retirement' },
              { value: 'termination', label: 'termination' },
              { value: 'end_of_contract', label: 'end of contract' },
              { value: 'death', label: 'death' },
              { value: 'other', label: 'other' },
            ],
          },
          { name: 'noticeGivenOn', label: 'Notice given on', kind: 'date', optional: true },
          { name: 'lastDayOn', label: 'Last day', kind: 'date' },
          { name: 'reason', label: 'Reason' },
        ],
      },
      {
        kind: 'form',
        title: 'Record an exit interview',
        submit: 'Record',
        path: '/separations/interview',
        fields: [
          { name: 'staffId', label: 'Who', kind: 'select', options: 'separatedOptions' },
          { name: 'on', label: 'Held on', kind: 'date' },
          { name: 'notes', label: 'Notes', kind: 'textarea', rows: 4 },
          { name: 'rehireEligible', label: 'Eligible for rehire', kind: 'checkbox', optional: true },
        ],
      },
      {
        kind: 'table',
        title: 'Grades',
        note: 'Bands are advisory: pay outside one is recorded, not refused.',
        rows: 'grades',
        empty: 'No grades. Plenty of colleges run one scale and never name one.',
        columns: [
          { key: 'code', label: 'Code', kind: 'code' },
          { key: 'name', label: 'Name' },
          { key: 'rank', label: 'Rank' },
          { key: 'band', label: 'Band' },
          { key: 'people', label: 'People' },
        ],
      },
      {
        kind: 'form',
        title: 'Add a grade',
        submit: 'Add',
        path: '/grades',
        roles: [...ADMIN],
        fields: [
          { name: 'code', label: 'Code' },
          { name: 'name', label: 'Name' },
          { name: 'rank', label: 'Rank', kind: 'number', hint: 'Lower is junior' },
          { name: 'minPaise', label: 'Band floor', kind: 'money', optional: true },
          { name: 'maxPaise', label: 'Band top', kind: 'money', optional: true },
        ],
      },
    ],
  },
]
