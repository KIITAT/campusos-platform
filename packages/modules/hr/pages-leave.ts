import { type PluginPage } from '@campusos/module-framework'
import {
  listCompOffs,
  listEncashments,
  listLeavePolicies,
  listLeaveTypes,
  listStaff,
  type Actor,
} from './api'

const OFFICE = ['institution_admin', 'super_admin', 'accounts_staff'] as const
const ADMIN = ['institution_admin', 'super_admin'] as const

const rulesOf = (t: Awaited<ReturnType<typeof listLeaveTypes>>[number]) =>
  [
    t.paid ? 'paid' : 'unpaid',
    t.allowNegative ? 'may overdraw' : null,
    t.maxCarryForward > 0 ? `carries ${t.maxCarryForward}d` : null,
    t.encashable ? `sold at ${t.encashmentComponents.join('+')}` : null,
    t.compensatory
      ? `earned, lapses ${t.compOffValidityDays ? `after ${t.compOffValidityDays}d` : 'at year end'}`
      : null,
  ]
    .filter(Boolean)
    .join(', ')

export const leavePages: PluginPage[] = [
  {
    path: '/leave/policy',
    title: 'Leave policy',
    menu: 'Leave policy',
    roles: [...OFFICE],
    async load(actor) {
      const a = actor as Actor
      const [policies, types, staff, claims, payouts] = await Promise.all([
        listLeavePolicies(a),
        listLeaveTypes(a),
        listStaff(a),
        listCompOffs(a),
        listEncashments(a),
      ])
      return {
        policies: policies.map((p) => ({
          ...p,
          entitles: p.lines.map((l) => `${l.typeCode} ${l.annualDays}d`).join(', '),
        })),
        types: types.map((t) => ({ ...t, rules: rulesOf(t) })),
        claims: claims.map((c) => ({ ...c, waiting: c.status === 'pending' })),
        payouts: payouts.map((p) => ({
          ...p,
          month: p.period.slice(0, 7),
          waiting: p.status === 'pending',
        })),
        staffOptions: staff.map((s) => ({ value: s.id, label: `${s.employeeCode} - ${s.name}` })),
        policyOptions: policies.map((p) => ({ value: p.id, label: `${p.code} - ${p.name}` })),
        claimOptions: claims
          .filter((c) => c.status === 'pending')
          .map((c) => ({ value: c.id, label: `${c.employeeCode} - worked ${c.workedOn}` })),
        payoutOptions: payouts
          .filter((p) => p.status === 'pending')
          .map((p) => ({
            value: p.id,
            label: `${p.employeeCode} - ${p.days}d ${p.typeCode} in ${p.period.slice(0, 7)}`,
          })),
        thisYear: String(new Date().getFullYear()),
      }
    },
    sections: (data) => [
      {
        kind: 'note',
        text:
          'Somebody on no policy gets each leave type’s own figure. Once a policy is ' +
          'allocated it replaces that figure rather than adding to it; carried and earned ' +
          'days add on top of either. Approving leave past the balance is refused unless ' +
          'the type allows overdrawing.',
      },
      {
        kind: 'table',
        title: 'Leave types',
        rows: 'types',
        columns: [
          { key: 'code', label: 'Code', kind: 'code' },
          { key: 'name', label: 'Name' },
          { key: 'annualDays', label: 'Default', kind: 'days' },
          { key: 'rules', label: 'Rules' },
        ],
      },
      {
        kind: 'table',
        title: 'Policies',
        rows: 'policies',
        empty: 'No policies: everybody gets the type defaults.',
        columns: [
          { key: 'code', label: 'Code', kind: 'code' },
          { key: 'name', label: 'Name' },
          { key: 'entitles', label: 'Entitles' },
          { key: 'prorateJoiners', label: 'Prorates joiners', kind: 'bool' },
          { key: 'people', label: 'People' },
        ],
      },
      {
        kind: 'form',
        title: 'Put somebody on a policy',
        submit: 'Assign',
        path: '/leave/policies/assign',
        roles: [...ADMIN],
        fields: [
          { name: 'staffId', label: 'Who', kind: 'select', options: 'staffOptions' },
          { name: 'policyId', label: 'Policy', kind: 'select', options: 'policyOptions' },
          { name: 'effectiveFrom', label: 'From', kind: 'date' },
        ],
      },
      {
        kind: 'form',
        title: 'Allocate a year',
        note: 'From the policies in force, plus carry-forward. Safe to run again.',
        submit: 'Allocate',
        path: '/leave/allocations/year',
        fields: [{ name: 'year', label: 'Year', kind: 'number', value: data.thisYear as string }],
      },
      {
        kind: 'table',
        title: 'Worked days claimed back',
        rows: 'claims',
        empty: 'No claims.',
        columns: [
          { key: 'employeeCode', label: 'Code', kind: 'code' },
          { key: 'staffName', label: 'Name' },
          { key: 'workedOn', label: 'Worked', kind: 'date' },
          { key: 'days', label: 'Days', kind: 'days' },
          { key: 'reason', label: 'Why' },
          { key: 'status', label: 'Status', kind: 'status', alertWhen: 'waiting' },
        ],
      },
      {
        kind: 'form',
        title: 'Decide a claim',
        submit: 'Decide',
        path: '/leave/comp-off/decide',
        fields: [
          { name: 'requestId', label: 'Claim', kind: 'select', options: 'claimOptions' },
          { name: 'approve', label: 'Approve', kind: 'checkbox', optional: true },
          { name: 'note', label: 'Note', optional: true },
        ],
      },
      {
        kind: 'table',
        title: 'Leave sold back',
        rows: 'payouts',
        empty: 'No payouts.',
        columns: [
          { key: 'employeeCode', label: 'Code', kind: 'code' },
          { key: 'staffName', label: 'Name' },
          { key: 'typeCode', label: 'Type' },
          { key: 'days', label: 'Days', kind: 'days' },
          { key: 'month', label: 'Paid in' },
          { key: 'amountPaise', label: 'Amount', kind: 'money' },
          { key: 'status', label: 'Status', kind: 'status', alertWhen: 'waiting' },
          { key: 'paid', label: 'On a payslip', kind: 'bool' },
        ],
      },
      {
        kind: 'form',
        title: 'Decide a payout',
        note: 'Approval fixes the amount from the pay in force that month.',
        submit: 'Decide',
        path: '/leave/encashments/decide',
        roles: [...ADMIN],
        fields: [
          { name: 'requestId', label: 'Payout', kind: 'select', options: 'payoutOptions' },
          { name: 'approve', label: 'Approve', kind: 'checkbox', optional: true },
        ],
      },
    ],
  },
]
