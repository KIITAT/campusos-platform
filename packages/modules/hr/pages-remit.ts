import { param, type PluginPage } from '@campusos/module-framework'
import { listDues, listRemittances, WORK_STATES, type Actor } from './api'

/**
 * Remittances (P1-06c, ACC-24): what each statutory head owes for a month,
 * the challans paid against it, and a void for a mistake.
 */

const ADMIN = ['institution_admin', 'super_admin'] as const

const thisMonth = () => new Date().toISOString().slice(0, 7)

export const remitPages: PluginPage[] = [
  {
    path: '/payroll/remit',
    title: 'Remittances',
    menu: 'Remittances',
    roles: [...ADMIN],
    async load(actor, req) {
      const a = actor as Actor
      const period = (param(req, 'period') ?? thisMonth()).slice(0, 7)
      const [dues, done] = await Promise.all([listDues(a, period), listRemittances(a, period)])
      return {
        period,
        today: new Date().toISOString().slice(0, 10),
        dues: dues.map((d) => ({ ...d, headName: d.head.toUpperCase(), stateName: d.state ?? '' })),
        remittances: done.map((r) => ({
          ...r,
          headName: r.head.toUpperCase(),
          status: r.voidedAt ? 'void' : 'recorded',
        })),
        liveOptions: done.filter((r) => !r.voidedAt).map((r) => ({ value: r.id, label: `${r.head.toUpperCase()} ${r.challanRef}` })),
      }
    },
    sections: (data) => [
      {
        kind: 'note',
        text:
          'Amounts due come from the month’s payslips; interest and late fees are not computed: ' +
          'post them as journal entries in finance. A remittance cannot be edited: void it with a reason and enter it again.',
      },
      {
        kind: 'form',
        method: 'GET',
        path: '/payroll/remit',
        submit: 'Show',
        placement: 'inline',
        fields: [{ name: 'period', label: 'Month', hint: 'YYYY-MM', value: String(data.period) }],
      },
      {
        kind: 'table',
        title: `Due for ${String(data.period)}`,
        rows: 'dues',
        empty: 'Nothing is due for this month.',
        columns: [
          { key: 'headName', label: 'Head' },
          { key: 'stateName', label: 'State' },
          { key: 'dueEmployeePaise', label: 'Employee share', kind: 'money' },
          { key: 'dueEmployerPaise', label: 'Employer share', kind: 'money' },
          { key: 'adminTopUpPaise', label: 'Admin minimum', kind: 'money' },
          { key: 'duePaise', label: 'Due', kind: 'money' },
          { key: 'remittedPaise', label: 'Remitted', kind: 'money' },
          { key: 'balancePaise', label: 'Balance', kind: 'money' },
        ],
      },
      {
        kind: 'form',
        title: 'Record a remittance',
        submit: 'Record',
        path: '/payroll/remittances',
        placement: 'inline',
        roles: [...ADMIN],
        fields: [
          {
            name: 'head',
            label: 'Head',
            kind: 'select',
            options: [
              { value: 'pf', label: 'Provident fund' },
              { value: 'esi', label: 'ESI' },
              { value: 'pt', label: 'Professional tax' },
              { value: 'tds', label: 'TDS on salaries' },
            ],
          },
          { name: 'period', kind: 'hidden', label: '', value: String(data.period) },
          { name: 'state', label: 'State (professional tax only)', kind: 'select', optional: true, options: WORK_STATES.map((v) => ({ value: v, label: v })) },
          { name: 'amount', label: 'Amount', kind: 'money' },
          { name: 'paidOn', label: 'Paid on', kind: 'date', value: String(data.today) },
          { name: 'paidFrom', label: 'From', kind: 'select', options: [{ value: 'bank', label: 'bank' }, { value: 'cash', label: 'cash' }] },
          { name: 'challanRef', label: 'Challan or transaction reference' },
          { name: 'bsrCode', label: 'BSR code (TDS)', optional: true },
          { name: 'challanSerial', label: 'Challan serial (TDS)', optional: true },
          { name: 'note', label: 'Note', optional: true },
        ],
      },
      {
        kind: 'table',
        title: 'Remittances this month',
        rows: 'remittances',
        empty: 'Nothing recorded yet.',
        columns: [
          { key: 'headName', label: 'Head' },
          { key: 'state', label: 'State' },
          { key: 'amountPaise', label: 'Amount', kind: 'money' },
          { key: 'paidOn', label: 'Paid on', kind: 'date' },
          { key: 'challanRef', label: 'Challan', kind: 'code' },
          { key: 'status', label: 'Status', kind: 'status' },
          { key: 'voidReason', label: 'Void reason' },
        ],
      },
      {
        kind: 'form',
        title: 'Void a remittance',
        note: 'Reverses its books entry. Enter the payment again afterwards if it was only recorded wrongly.',
        submit: 'Void',
        path: '/payroll/remittances/void',
        placement: 'inline',
        roles: [...ADMIN],
        fields: [
          { name: 'remittanceId', label: 'Remittance', kind: 'select', options: 'liveOptions' },
          { name: 'reason', label: 'Reason' },
        ],
      },
    ],
  },
]
