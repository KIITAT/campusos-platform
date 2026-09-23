import { formatPaise } from '@campusos/money'
import { param, type PluginPage } from '@campusos/module-framework'
import { claimLines, isHr, listAdvances, listClaims, listStaff, myEmployment, type Actor } from './api'

const EVERYONE = ['faculty', 'hod', 'institution_admin', 'super_admin', 'accounts_staff'] as const
const ADMIN = ['institution_admin', 'super_admin'] as const

export const expensesPages: PluginPage[] = [
  {
    path: '/claims',
    title: 'Claims and advances',
    menu: 'Claims',
    roles: [...EVERYONE],
    async load(actor, req) {
      const a = actor as Actor
      const claimId = param(req, 'claimId')
      const [claims, advances] = await Promise.all([listClaims(a), listAdvances(a)])
      const lines = claimId ? await claimLines(a, claimId) : []
      // The desk files for anybody; everybody else files for themselves.
      const people = isHr(a.role)
        ? (await listStaff(a)).map((s) => ({ value: s.id, label: `${s.employeeCode} - ${s.name}` }))
        : await myEmployment(a).then((m) =>
            m.staff ? [{ value: m.staff.id, label: `${m.staff.employeeCode} - ${m.staff.name}` }] : [],
          )
      const outstanding = advances.reduce((n, x) => n + x.outstandingPaise, 0)
      return {
        claims: claims.map((c) => ({
          ...c,
          waiting: c.status === 'submitted' || c.status === 'approved',
          cut: c.sanctionedPaise !== null && c.sanctionedPaise < c.claimedPaise,
        })),
        advances: advances.map((x) => ({ ...x, open: x.outstandingPaise > 0 })),
        lines: lines.map((l) => ({ ...l, cut: l.sanctionedPaise !== null && l.sanctionedPaise < l.amountPaise })),
        outstanding: formatPaise(outstanding),
        staffOptions: people,
        submittedOptions: claims
          .filter((c) => c.status === 'submitted')
          .map((c) => ({ value: c.id, label: `${c.employeeCode} - ${c.title}` })),
        approvedOptions: claims
          .filter((c) => c.status === 'approved')
          .map((c) => ({ value: c.id, label: `${c.employeeCode} - ${c.title}` })),
        requestedOptions: advances
          .filter((x) => x.status === 'requested')
          .map((x) => ({ value: x.id, label: `${x.employeeCode} - ${x.purpose}` })),
        approvedAdvanceOptions: advances
          .filter((x) => x.status === 'approved')
          .map((x) => ({ value: x.id, label: `${x.employeeCode} - ${x.purpose}` })),
        openAdvanceOptions: advances
          .filter((x) => x.status === 'paid')
          .map((x) => ({ value: x.id, label: `${x.employeeCode} - ${x.purpose} (${formatPaise(x.outstandingPaise)} out)` })),
      }
    },
    sections: (data) => [
      {
        kind: 'note',
        text:
          `${data.outstanding} of advances outstanding. An advance stays the institution’s ` +
          'money until it is accounted for: by a claim set against it, by deductions from ' +
          'pay, or by being repaid.',
      },
      {
        kind: 'table',
        title: 'Claims',
        rows: 'claims',
        empty: 'No claims.',
        columns: [
          { key: 'employeeCode', label: 'Code', kind: 'code' },
          { key: 'title', label: 'Claim', href: '/m/hr/claims?claimId={id}' },
          { key: 'claimedPaise', label: 'Claimed', kind: 'money' },
          { key: 'sanctionedPaise', label: 'Agreed', kind: 'money', alertWhen: 'cut' },
          { key: 'advanceAppliedPaise', label: 'Against advance', kind: 'money' },
          { key: 'paidPaise', label: 'Paid', kind: 'money' },
          { key: 'status', label: 'Status', alertWhen: 'waiting' },
        ],
      },
      {
        kind: 'table',
        title: 'Lines of the selected claim',
        rows: 'lines',
        empty: 'Pick a claim to see its lines.',
        columns: [
          { key: 'spentOn', label: 'Spent', kind: 'date' },
          { key: 'category', label: 'Category' },
          { key: 'description', label: 'What' },
          { key: 'receiptRef', label: 'Receipt', kind: 'code' },
          { key: 'amountPaise', label: 'Claimed', kind: 'money' },
          { key: 'sanctionedPaise', label: 'Agreed', kind: 'money', alertWhen: 'cut' },
        ],
      },
      {
        kind: 'form',
        title: 'Claim an expense',
        note: 'One line here; a claim with several lines goes through the API.',
        submit: 'Submit',
        path: '/claims',
        fields: [
          { name: 'staffId', label: 'Who', kind: 'select', options: 'staffOptions' },
          { name: 'title', label: 'Claim' },
          { name: 'spentOn', label: 'Spent on', kind: 'date' },
          { name: 'category', label: 'Category', hint: 'Travel, Conference fee, Supplies' },
          { name: 'description', label: 'What' },
          { name: 'amount', label: 'Amount', kind: 'money' },
          { name: 'receiptRef', label: 'Receipt number', optional: true },
        ],
      },
      {
        kind: 'form',
        title: 'Approve or reject a claim',
        note: 'Approves every line in full; cut a line through the API with a sanction list.',
        submit: 'Decide',
        path: '/claims/decide',
        roles: [...ADMIN],
        fields: [
          { name: 'claimId', label: 'Claim', kind: 'select', options: 'submittedOptions' },
          { name: 'approve', label: 'Approve', kind: 'checkbox', optional: true },
          { name: 'note', label: 'Note', optional: true },
        ],
      },
      {
        kind: 'form',
        title: 'Settle a claim',
        submit: 'Settle',
        path: '/claims/settle',
        roles: [...ADMIN],
        fields: [
          { name: 'claimId', label: 'Claim', kind: 'select', options: 'approvedOptions' },
          { name: 'advanceId', label: 'Set against advance', kind: 'select', options: 'openAdvanceOptions', optional: true },
          { name: 'paidOn', label: 'Paid on', kind: 'date' },
          {
            name: 'paidFrom',
            label: 'From',
            kind: 'select',
            options: [
              { value: 'bank', label: 'bank' },
              { value: 'cash', label: 'cash' },
            ],
          },
        ],
      },
      {
        kind: 'table',
        title: 'Advances',
        rows: 'advances',
        empty: 'No advances.',
        columns: [
          { key: 'employeeCode', label: 'Code', kind: 'code' },
          { key: 'purpose', label: 'For' },
          { key: 'amountPaise', label: 'Amount', kind: 'money' },
          { key: 'monthlyRecoveryPaise', label: 'From pay monthly', kind: 'money' },
          { key: 'recoveredPaise', label: 'Back', kind: 'money' },
          { key: 'outstandingPaise', label: 'Outstanding', kind: 'money', alertWhen: 'open' },
          { key: 'status', label: 'Status' },
        ],
      },
      {
        kind: 'form',
        title: 'Ask for an advance',
        submit: 'Ask',
        path: '/advances',
        fields: [
          { name: 'staffId', label: 'Who', kind: 'select', options: 'staffOptions' },
          { name: 'purpose', label: 'For' },
          { name: 'amount', label: 'Amount', kind: 'money' },
        ],
      },
      {
        kind: 'form',
        title: 'Approve or reject an advance',
        submit: 'Decide',
        path: '/advances/decide',
        roles: [...ADMIN],
        fields: [
          { name: 'advanceId', label: 'Advance', kind: 'select', options: 'requestedOptions' },
          { name: 'approve', label: 'Approve', kind: 'checkbox', optional: true },
          { name: 'monthlyRecovery', label: 'Recover from pay, monthly', kind: 'money', optional: true },
        ],
      },
      {
        kind: 'form',
        title: 'Hand an advance over',
        submit: 'Pay',
        path: '/advances/pay',
        roles: [...ADMIN],
        fields: [
          { name: 'advanceId', label: 'Advance', kind: 'select', options: 'approvedAdvanceOptions' },
          { name: 'paidOn', label: 'Paid on', kind: 'date' },
          {
            name: 'paidFrom',
            label: 'From',
            kind: 'select',
            options: [
              { value: 'bank', label: 'bank' },
              { value: 'cash', label: 'cash' },
            ],
          },
        ],
      },
    ],
  },
]
