import { performancePages } from './pages-performance'
import { recruitmentPages } from './pages-recruitment'
import { shiftsPages } from './pages-shifts'
import { leavePages } from './pages-leave'
import { lifecyclePages } from './pages-lifecycle'
import { formatPaise } from '@campusos/money'
import { param, type PluginPage } from '@campusos/module-framework'
import {
  componentsFor,
  leaveBalances,
  listLeave,
  listLeaveTypes,
  listPayslips,
  listSalaryPayments,
  listStaff,
  myEmployment,
  type Actor,
} from './api'

const OFFICE = ['institution_admin', 'super_admin', 'accounts_staff'] as const
const ADMIN = ['institution_admin', 'super_admin'] as const

const thisMonth = () => new Date().toISOString().slice(0, 7)

const corePages: PluginPage[] = [
  {
    path: '/',
    title: 'Staff',
    menu: 'Staff',
    roles: [...OFFICE],
    async load(actor, req) {
      const a = actor as Actor
      const staff = await listStaff(a, true)
      const staffId = param(req, 'staffId')
      const active = staff.filter((s) => !s.leftOn)
      return {
        staff: staff.map((s) => ({ ...s, unpaid: s.monthlyGrossPaise === 0 })),
        monthly: formatPaise(active.reduce((n, s) => n + s.monthlyGrossPaise, 0)),
        employed: active.length,
        activeOptions: active.map((s) => ({
          value: s.id,
          label: `${s.employeeCode} - ${s.name}`,
        })),
        components: staffId ? await componentsFor(a, staffId) : [],
        balances: staffId ? await leaveBalances(a, staffId) : [],
        staffId: staffId ?? '',
      }
    },
    sections: (data) => [
      {
        kind: 'note',
        text:
          `${data.employed} employed, ${data.monthly} of monthly gross on the ` +
          `books. A staff record is independent of the academic roster: a cook ` +
          `and a driver belong here and never teach a section.`,
      },
      {
        kind: 'table',
        rows: 'staff',
        empty: 'Nobody on record yet.',
        columns: [
          {
            key: 'employeeCode',
            label: 'Code',
            kind: 'code',
            href: '/m/hr?staffId={id}',
          },
          { key: 'name', label: 'Name' },
          { key: 'designation', label: 'Designation' },
          { key: 'joinedOn', label: 'Since', kind: 'date' },
          { key: 'leftOn', label: 'Left', kind: 'date' },
          { key: 'monthlyGrossPaise', label: 'Monthly gross', kind: 'money', alertWhen: 'unpaid' },
        ],
      },
      {
        kind: 'table',
        title: 'Pay, for the selected person',
        note:
          'Dated rows, not a current-salary column: a raise in August does not ' +
          'rewrite the July payslip, and last year’s figure is still here.',
        rows: 'components',
        empty: 'Pick somebody above to see their pay.',
        columns: [
          { key: 'label', label: 'Component' },
          { key: 'kind', label: 'Kind' },
          { key: 'amountPaise', label: 'Amount', kind: 'money' },
          { key: 'effectiveFrom', label: 'From', kind: 'date' },
          { key: 'effectiveTo', label: 'To', kind: 'date' },
        ],
      },
      {
        kind: 'table',
        title: 'Leave this year',
        rows: 'balances',
        empty: '',
        columns: [
          { key: 'typeName', label: 'Type' },
          { key: 'annualDays', label: 'Entitlement', kind: 'days' },
          { key: 'takenDays', label: 'Taken', kind: 'days' },
          { key: 'remainingDays', label: 'Left', kind: 'days' },
        ],
      },
      {
        kind: 'form',
        title: 'Add someone',
        submit: 'Add',
        path: '/staff',
        roles: [...ADMIN],
        fields: [
          { name: 'employeeCode', label: 'Employee code' },
          { name: 'name', label: 'Name' },
          { name: 'designation', label: 'Designation' },
          { name: 'department', label: 'Department', optional: true },
          {
            name: 'employment',
            label: 'Employment',
            kind: 'select',
            options: [
              { value: 'permanent', label: 'permanent' },
              { value: 'contract', label: 'contract' },
              { value: 'visiting', label: 'visiting' },
              { value: 'probation', label: 'probation' },
            ],
          },
          { name: 'joinedOn', label: 'Joined on', kind: 'date' },
          { name: 'email', label: 'Email', optional: true },
          {
            name: 'userId',
            label: 'Login',
            optional: true,
            hint: 'Optional. Plenty of staff never sign in.',
          },
        ],
      },
      {
        kind: 'form',
        title: 'Set a pay line',
        note: 'Supersedes the current row of the same code, closing it the day before.',
        submit: 'Set',
        path: '/pay/components',
        roles: [...ADMIN],
        fields: [
          { name: 'staffId', label: 'Who', kind: 'select', options: 'activeOptions' },
          { name: 'code', label: 'Code', hint: 'e.g. basic, hra, pf' },
          { name: 'label', label: 'Label' },
          {
            name: 'kind',
            label: 'Kind',
            kind: 'select',
            options: [
              { value: 'earning', label: 'earning - adds to gross' },
              { value: 'deduction', label: 'deduction - subtracts from it' },
            ],
          },
          { name: 'amount', label: 'Amount', kind: 'money', hint: 'Rupees per month' },
          { name: 'effectiveFrom', label: 'Effective from', kind: 'date' },
        ],
      },
      {
        kind: 'form',
        title: 'End employment',
        note:
          'Audited: it stops a salary, and exactly when somebody left is a ' +
          'question with money attached.',
        submit: 'End employment',
        path: '/staff/end',
        roles: [...ADMIN],
        fields: [
          { name: 'staffId', label: 'Who', kind: 'select', options: 'activeOptions' },
          { name: 'leftOn', label: 'Last day', kind: 'date' },
          { name: 'reason', label: 'Reason' },
        ],
      },
    ],
  },

  {
    path: '/leave',
    title: 'Leave',
    menu: 'Leave',
    roles: [...OFFICE],
    async load(actor) {
      const a = actor as Actor
      const [pending, all, types, staff] = await Promise.all([
        listLeave(a, true),
        listLeave(a),
        listLeaveTypes(a),
        listStaff(a),
      ])
      const row = (l: (typeof all)[number]) => ({
        ...l,
        span: l.toOn === l.fromOn ? l.fromOn : `${l.fromOn} to ${l.toOn}`,
        waiting: l.status === 'pending',
      })
      return {
        pending: pending.map(row),
        all: all.map(row),
        count: pending.length,
        pendingOptions: pending.map((l) => ({
          value: l.id,
          label: `${l.staffName} - ${l.typeCode} ${l.fromOn} (${l.days}d)`,
        })),
        approvedOptions: all
          .filter((l) => l.status === 'approved')
          .map((l) => ({ value: l.id, label: `${l.staffName} - ${l.fromOn} (${l.days}d)` })),
        staffOptions: staff.map((s) => ({ value: s.id, label: `${s.employeeCode} - ${s.name}` })),
        typeOptions: types.map((t) => ({
          value: t.id,
          label: `${t.name}${t.paid ? '' : ' (unpaid)'}`,
        })),
      }
    },
    sections: (data) => [
      {
        kind: 'note',
        text:
          `${data.count} waiting on a decision. Nobody approves their own, and two ` +
          `approvals cannot overlap on the same person — the database refuses the ` +
          `second, so payroll never reads two answers for one day.`,
      },
      {
        kind: 'table',
        title: 'Waiting',
        rows: 'pending',
        empty: 'Nothing waiting.',
        columns: [
          { key: 'staffName', label: 'Who' },
          { key: 'typeName', label: 'Type' },
          { key: 'span', label: 'Dates' },
          { key: 'days', label: 'Days', kind: 'days' },
          { key: 'status', label: 'Status', alertWhen: 'waiting' },
        ],
      },
      {
        kind: 'form',
        title: 'Decide',
        submit: 'Record decision',
        path: '/leave/decide',
        fields: [
          { name: 'requestId', label: 'Request', kind: 'select', options: 'pendingOptions' },
          {
            name: 'approve',
            label: 'Decision',
            kind: 'select',
            options: [
              { value: 'true', label: 'approve' },
              { value: 'false', label: 'reject' },
            ],
          },
          { name: 'note', label: 'Note', optional: true },
        ],
      },
      {
        kind: 'form',
        title: 'File a request',
        submit: 'File',
        path: '/leave',
        fields: [
          { name: 'staffId', label: 'Who', kind: 'select', options: 'staffOptions' },
          { name: 'leaveTypeId', label: 'Type', kind: 'select', options: 'typeOptions' },
          { name: 'fromOn', label: 'From', kind: 'date' },
          { name: 'toOn', label: 'To', kind: 'date', hint: 'Inclusive' },
          { name: 'reason', label: 'Reason' },
        ],
      },
      {
        kind: 'table',
        title: 'Everything on record',
        rows: 'all',
        empty: 'Nothing on record.',
        columns: [
          { key: 'staffName', label: 'Who' },
          { key: 'typeName', label: 'Type' },
          { key: 'span', label: 'Dates' },
          { key: 'status', label: 'Status' },
          { key: 'decisionNote', label: 'Note' },
        ],
      },
      {
        kind: 'form',
        title: 'Withdraw approved leave',
        note: 'Audited: payroll may already have run on it.',
        submit: 'Withdraw',
        path: '/leave/cancel',
        fields: [
          { name: 'requestId', label: 'Request', kind: 'select', options: 'approvedOptions' },
          { name: 'reason', label: 'Reason' },
        ],
      },
      {
        kind: 'form',
        title: 'Add a leave type',
        note:
          'An entitlement of zero means unlimited but still recorded. Unpaid ' +
          'leave still needs approving; it stops the salary for those days.',
        submit: 'Add type',
        path: '/leave/types',
        roles: [...ADMIN],
        fields: [
          { name: 'code', label: 'Code', hint: 'e.g. cl, sl, lwp' },
          { name: 'name', label: 'Name' },
          { name: 'annualDays', label: 'Days per year', kind: 'number', value: '12' },
          { name: 'paid', label: 'Paid', kind: 'checkbox', optional: true },
        ],
      },
    ],
  },

  {
    path: '/payroll',
    title: 'Payroll',
    menu: 'Payroll',
    roles: [...OFFICE],
    async load(actor, req) {
      const a = actor as Actor
      const period = param(req, 'period') ?? thisMonth()
      const [payslips, staff, paid] = await Promise.all([
        listPayslips(a, period),
        listStaff(a),
        listSalaryPayments(a),
      ])
      const thisOne = paid.find((x) => x.period === `${period.slice(0, 7)}-01`)
      return {
        period,
        paidOn: thisOne?.paidOn ?? '',
        paidFrom: thisOne?.paidFrom ?? '',
        isPaid: !!thisOne,
        today: new Date().toISOString().slice(0, 10),
        payslips: payslips.map((p) => ({
          ...p,
          month: p.period.slice(0, 7),
          lop: p.unpaidLeaveDays > 0,
        })),
        total: formatPaise(payslips.reduce((n, p) => n + p.netPaise, 0)),
        count: payslips.length,
        staffOptions: staff.map((s) => ({ value: s.id, label: `${s.employeeCode} - ${s.name}` })),
      }
    },
    sections: (data) => [
      {
        kind: 'note',
        text:
          `${data.period}: ${data.count} payslips, ${data.total} net. Figures only ` +
          `— no statutory filing. A payslip cannot be edited once generated; ` +
          `corrections go on the next one.`,
      },
      ...(data.isPaid
        ? [
            {
              kind: 'note' as const,
              tone: 'info' as const,
              text:
                `Paid on ${String(data.paidOn)} from ${String(data.paidFrom)}. ` +
                'The month is closed: a payslip added now would accrue a salary ' +
                'that payment never covered, so it is refused. Put the correction ' +
                'on the next month.',
            },
          ]
        : []),
      {
        kind: 'table',
        rows: 'payslips',
        empty: 'Nothing generated for this month.',
        columns: [
          { key: 'employeeCode', label: 'Code', kind: 'code' },
          { key: 'staffName', label: 'Who' },
          { key: 'grossPaise', label: 'Gross', kind: 'money' },
          { key: 'unpaidLeaveDays', label: 'Unpaid', kind: 'days', alertWhen: 'lop' },
          { key: 'deductionsPaise', label: 'Deductions', kind: 'money' },
          { key: 'netPaise', label: 'Net', kind: 'money' },
        ],
      },
      {
        kind: 'form',
        title: 'Run payroll',
        note:
          'Anybody already paid for the month is skipped, not re-paid. Leave the ' +
          'person blank to run for everybody employed that month.',
        submit: 'Generate',
        path: '/payroll',
        fields: [
          { name: 'period', label: 'Month', hint: 'YYYY-MM', value: String(data.period) },
          {
            name: 'staffId',
            label: 'Just one person',
            kind: 'select',
            optional: true,
            options: 'staffOptions',
          },
        ],
      },
      ...(data.isPaid || Number(data.count ?? 0) === 0
        ? []
        : [
            {
              kind: 'form' as const,
              title: 'Pay these salaries',
              note:
                'Clears what the payslips accrued. The amount is their total, not ' +
                'something to type: the entry that discharges the liability has to ' +
                'be the one that created it. The cost stays in the month worked ' +
                'even when the money leaves in the next one.',
              submit: 'Mark paid',
              path: '/payroll/paid',
              roles: [...ADMIN],
              fields: [
                {
                  name: 'period',
                  kind: 'hidden' as const,
                  label: '',
                  value: String(data.period ?? ''),
                },
                {
                  name: 'paidOn',
                  label: 'Paid on',
                  kind: 'date' as const,
                  value: String(data.today ?? ''),
                },
                {
                  name: 'paidFrom',
                  label: 'From',
                  kind: 'select' as const,
                  options: [
                    { value: 'bank', label: 'bank' },
                    { value: 'cash', label: 'cash' },
                  ],
                },
                { name: 'reference', label: 'Reference', optional: true },
              ],
            },
          ]),
    ],
  },

  {
    path: '/me',
    title: 'My employment',
    menu: 'My employment',
    roles: ['faculty'],
    async load(actor) {
      const mine = await myEmployment(actor as Actor)
      if (!mine.onRecord || !mine.staff) return { onRecord: false, leave: [], payslips: [], balances: [] }
      return {
        onRecord: true,
        who: `${mine.staff.designation} · ${mine.staff.employeeCode} · since ${mine.staff.joinedOn}`,
        gross: formatPaise(mine.staff.monthlyGrossPaise),
        balances: mine.balances,
        leave: mine.leave.map((l) => ({
          ...l,
          span: l.toOn === l.fromOn ? l.fromOn : `${l.fromOn} to ${l.toOn}`,
        })),
        payslips: mine.payslips.map((p) => ({ ...p, month: p.period.slice(0, 7) })),
      }
    },
    sections: (data) =>
      data.onRecord
        ? [
            {
              kind: 'figures',
              title: String(data.who),
              figures: [{ label: 'Monthly gross', value: String(data.gross) }],
            },
            {
              kind: 'table',
              title: 'Leave this year',
              rows: 'balances',
              empty: 'No leave types defined.',
              columns: [
                { key: 'typeName', label: 'Type' },
                { key: 'annualDays', label: 'Entitlement', kind: 'days' },
                { key: 'takenDays', label: 'Taken', kind: 'days' },
                { key: 'remainingDays', label: 'Left', kind: 'days' },
              ],
            },
            {
              kind: 'table',
              title: 'My leave',
              rows: 'leave',
              empty: 'Nothing on record.',
              columns: [
                { key: 'typeName', label: 'Type' },
                { key: 'span', label: 'Dates' },
                { key: 'days', label: 'Days', kind: 'days' },
                { key: 'status', label: 'Status' },
              ],
            },
            {
              kind: 'table',
              title: 'Payslips',
              rows: 'payslips',
              empty: 'No payslips yet.',
              columns: [
                { key: 'month', label: 'Month' },
                { key: 'grossPaise', label: 'Gross', kind: 'money' },
                { key: 'deductionsPaise', label: 'Deductions', kind: 'money' },
                { key: 'netPaise', label: 'Net', kind: 'money' },
              ],
            },
          ]
        : [
            {
              kind: 'note',
              text:
                'No staff record is linked to this login. The HR office links a ' +
                'record to an account; this page fills in once yours is.',
            },
          ],
  },
]

export const pages: PluginPage[] = [...corePages, ...lifecyclePages, ...leavePages, ...shiftsPages, ...recruitmentPages, ...performancePages]
