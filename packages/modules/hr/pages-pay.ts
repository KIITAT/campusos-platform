import { formatPaise } from '@campusos/money'
import { type PluginPage } from '@campusos/module-framework'
import {
  listGratuityRules,
  listRuns,
  listStaff,
  listStructures,
  listTaxRegimes,
  listWithheld,
  type Actor,
} from './api'

const OFFICE = ['institution_admin', 'super_admin', 'accounts_staff'] as const
const ADMIN = ['institution_admin', 'super_admin'] as const

const pct = (bp: number | null) => (bp === null ? '' : `${bp / 100}%`)

export const payPages: PluginPage[] = [
  {
    path: '/payroll/setup',
    title: 'Pay setup',
    menu: 'Pay setup',
    roles: [...OFFICE],
    async load(actor) {
      const a = actor as Actor
      const [structures, regimes, rules, withheld, runs, staff] = await Promise.all([
        listStructures(a),
        listTaxRegimes(a),
        listGratuityRules(a),
        listWithheld(a),
        listRuns(a),
        listStaff(a),
      ])
      return {
        structures: structures.map((s) => ({
          ...s,
          makeup: s.lines
            .map((l) =>
              l.calc === 'base'
                ? `${l.code} = base`
                : l.calc === 'fixed'
                  ? `${l.code} ${formatPaise(l.amountPaise ?? 0)}`
                  : `${l.code} ${pct(l.percentBp)} of ${l.of}`,
            )
            .join(', '),
        })),
        regimes: regimes.map((r) => ({
          ...r,
          slabText: r.slabs
            .map((s) => `${formatPaise(s.fromPaise)}${s.toPaise === null ? '+' : `-${formatPaise(s.toPaise)}`} @ ${pct(s.rateBp)}`)
            .join('; '),
          cess: pct(r.cessBp),
        })),
        rules: rules.map((g) => ({
          ...g,
          formula: `${g.daysPerYear}/${g.divisorDays} of ${g.wageCodes.join('+')} per year, from ${g.minServiceYears} years`,
        })),
        withheld: withheld.map((w) => ({ ...w, month: w.period.slice(0, 7), held: !w.releasedAt })),
        runs: runs.map((r) => ({ ...r, month: r.period.slice(0, 7) })),
        staffOptions: staff.map((s) => ({ value: s.id, label: `${s.employeeCode} - ${s.name}` })),
        structureOptions: structures.map((s) => ({ value: s.id, label: `${s.code} - ${s.name}` })),
        heldOptions: withheld
          .filter((w) => !w.releasedAt)
          .map((w) => ({ value: w.id, label: `${w.employeeCode} - ${w.period.slice(0, 7)} (${formatPaise(w.netPaise)})` })),
      }
    },
    sections: () => [
      {
        kind: 'note',
        text:
          'A payslip is the person’s structure at their base, with any per-person pay component ' +
          'taking the place of the line of the same code. Tax is deducted only for somebody who ' +
          'has chosen a regime; nothing statutory is seeded, so slabs and gratuity figures are ' +
          'entered here from the current rules.',
      },
      {
        kind: 'table',
        title: 'Salary structures',
        rows: 'structures',
        empty: 'No structures: pay comes from per-person components alone.',
        columns: [
          { key: 'code', label: 'Code', kind: 'code' },
          { key: 'name', label: 'Name' },
          { key: 'makeup', label: 'Lines' },
          { key: 'people', label: 'People' },
        ],
      },
      {
        kind: 'form',
        title: 'Put somebody on a structure',
        note: 'Structures themselves are defined through the API: POST /pay/structures.',
        submit: 'Assign',
        path: '/pay/structures/assign',
        roles: [...ADMIN],
        fields: [
          { name: 'staffId', label: 'Who', kind: 'select', options: 'staffOptions' },
          { name: 'structureId', label: 'Structure', kind: 'select', options: 'structureOptions' },
          { name: 'base', label: 'Base (monthly)', kind: 'money' },
          { name: 'effectiveFrom', label: 'From', kind: 'date' },
        ],
      },
      {
        kind: 'table',
        title: 'Income-tax regimes',
        rows: 'regimes',
        empty: 'None entered. No tax is deducted until one is, and chosen.',
        columns: [
          { key: 'code', label: 'Code', kind: 'code' },
          { key: 'name', label: 'Name' },
          { key: 'standardDeductionPaise', label: 'Standard deduction', kind: 'money' },
          { key: 'rebateUpToPaise', label: 'No tax up to', kind: 'money' },
          { key: 'cess', label: 'Cess' },
          { key: 'slabText', label: 'Slabs' },
        ],
      },
      {
        kind: 'table',
        title: 'Gratuity rules',
        rows: 'rules',
        empty: 'None entered.',
        columns: [
          { key: 'code', label: 'Code', kind: 'code' },
          { key: 'name', label: 'Name' },
          { key: 'formula', label: 'Rule' },
          { key: 'maxPaise', label: 'Ceiling', kind: 'money' },
        ],
      },
      {
        kind: 'table',
        title: 'Salary held back',
        rows: 'withheld',
        empty: 'Nothing held back.',
        columns: [
          { key: 'employeeCode', label: 'Code', kind: 'code' },
          { key: 'staffName', label: 'Name' },
          { key: 'month', label: 'Month' },
          { key: 'netPaise', label: 'Net', kind: 'money' },
          { key: 'releasedAt', label: 'Released', kind: 'when', alertWhen: 'held' },
        ],
      },
      {
        kind: 'form',
        title: 'Hold back a salary',
        note: 'Audited. Payslips are still made; they are left out of the payment run.',
        submit: 'Hold back',
        path: '/pay/withhold',
        roles: [...ADMIN],
        fields: [
          { name: 'staffId', label: 'Who', kind: 'select', options: 'staffOptions' },
          { name: 'fromPeriod', label: 'From month', hint: 'YYYY-MM' },
          { name: 'reason', label: 'Reason' },
        ],
      },
      {
        kind: 'form',
        title: 'Release a held payslip',
        submit: 'Release',
        path: '/pay/withheld/release',
        roles: [...ADMIN],
        fields: [
          { name: 'payslipId', label: 'Payslip', kind: 'select', options: 'heldOptions' },
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
          { name: 'reason', label: 'Reason' },
        ],
      },
      {
        kind: 'table',
        title: 'Payroll runs',
        rows: 'runs',
        empty: 'No runs yet.',
        columns: [
          { key: 'createdAt', label: 'When', kind: 'when' },
          { key: 'month', label: 'Month' },
          { key: 'generated', label: 'Payslips' },
          { key: 'skipped', label: 'Already done' },
          { key: 'grossPaise', label: 'Gross', kind: 'money' },
          { key: 'netPaise', label: 'Net', kind: 'money' },
        ],
      },
    ],
  },
]
