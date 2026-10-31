import { type PluginPage } from '@campusos/module-framework'
import { listStaff, taxDetails, WORK_STATES, type Actor } from './api'
import { taxYearOf } from './api/payroll'

/**
 * A person's tax inputs in one place (P1-06b, NEW-51): their statutory
 * details, the year's declarations and any previous employment. A person is
 * chosen first, so every form shows what it will replace.
 */

const ADMIN = ['institution_admin', 'super_admin'] as const

const stateOptions = WORK_STATES.map((v) => ({ value: v, label: v }))

const headOptions = [
  { value: '80c', label: '80C investments (with employee PF)' },
  { value: '80ccd_1b', label: '80CCD(1B) own NPS' },
  { value: '80d', label: '80D health insurance (allowable amount)' },
  { value: '24b', label: '24(b) home-loan interest' },
  { value: 'other', label: 'Other Chapter VI-A (allowable amount)' },
  { value: 'rent', label: 'Rent paid in the year (for HRA)' },
]

const rupees = (paise: number | null | undefined) => (paise === null || paise === undefined ? '' : String(paise / 100))
const yearName = (y: number) => `${y}-${String((y + 1) % 100).padStart(2, '0')}`

export const taxPages: PluginPage[] = [
  {
    path: '/payroll/tax',
    title: 'Tax and statutory details',
    menu: 'Tax details',
    roles: [...ADMIN],
    async load(actor, req) {
      const a = actor as Actor
      const q = new URL(req.url).searchParams
      // Leavers too: their last payslip trues up the year's tax.
      const staff = await listStaff(a, true)
      const asked = Number(q.get('taxYear'))
      const taxYear = Number.isInteger(asked) && asked >= 2000 && asked <= 2100
        ? asked
        : taxYearOf(new Date().toISOString().slice(0, 7) + '-01', 4)
      const staffId = q.get('staffId') ?? ''
      const base = {
        staffOptions: staff.map((s) => ({ value: s.id, label: `${s.employeeCode} - ${s.name}` })),
        staffId,
        taxYear,
      }
      if (!staff.some((s) => s.id === staffId)) return { ...base, chosen: false }
      const t = await taxDetails(a, staffId, taxYear)
      return {
        ...base,
        chosen: true,
        identity: t.identity,
        declarationRows: t.declarations.map((d) => ({
          head: d.head,
          declared: rupees(d.declaredPaise),
          proved: rupees(d.provedPaise),
          metro: String(d.metro),
        })),
        previousIncome: rupees(t.previous?.incomePaise),
        previousTds: rupees(t.previous?.tdsPaise),
      }
    },
    sections: (data) => {
      const year = Number(data.taxYear)
      const chooser = {
        kind: 'form' as const,
        title: 'Whose details',
        submit: 'Show',
        path: '/payroll/tax',
        method: 'GET' as const,
        fields: [
          { name: 'staffId', label: 'Who', kind: 'select' as const, options: 'staffOptions', value: String(data.staffId) },
          { name: 'taxYear', label: 'Tax year (the year it starts, e.g. 2026)', value: String(year) },
        ],
      }
      if (!data.chosen) return [chooser]
      const id = data.identity as Record<string, string | boolean | null>
      const text = (k: string) => (id[k] === null ? '' : String(id[k]))
      const hidden = [
        { name: 'staffId', label: '', kind: 'hidden' as const, value: String(data.staffId) },
      ]
      return [
        chooser,
        {
          kind: 'form',
          title: 'Statutory details',
          note: 'Every field is saved together; the form shows what is stored now.',
          submit: 'Save details',
          path: '/staff/statutory',
          roles: [...ADMIN],
          fields: [
            ...hidden,
            { name: 'pan', label: 'PAN', optional: true, value: text('pan') },
            { name: 'uan', label: 'UAN', optional: true, value: text('uan') },
            { name: 'esiNumber', label: 'ESI number', optional: true, value: text('esiNumber') },
            { name: 'bankAccount', label: 'Bank account', optional: true, value: text('bankAccount') },
            { name: 'bankIfsc', label: 'IFSC', optional: true, value: text('bankIfsc') },
            { name: 'workState', label: 'Work state', kind: 'select', options: stateOptions, optional: true, value: text('workState') },
            { name: 'pfMember', label: 'PF member', kind: 'checkbox', optional: true, value: text('pfMember') },
            { name: 'pfOnActual', label: 'PF on actual wages above the ceiling (joint option)', kind: 'checkbox', optional: true, value: text('pfOnActual') },
            { name: 'epsExcluded', label: 'Not in the pension scheme (EPS)', kind: 'checkbox', optional: true, value: text('epsExcluded') },
            { name: 'esiExempt', label: 'Exempt from ESI', kind: 'checkbox', optional: true, value: text('esiExempt') },
          ],
        },
        {
          kind: 'form',
          title: `Declarations for ${yearName(year)}`,
          note:
            'Replaces the year’s declarations. A declared amount counts until the last three months of the tax year; ' +
            'from then only a proved one. Deductions and HRA count only under a regime that allows them.',
          submit: 'Save declarations',
          path: '/payroll/tax/declarations',
          roles: [...ADMIN],
          fields: [
            ...hidden,
            { name: 'taxYear', label: '', kind: 'hidden', value: String(year) },
            {
              name: 'rows',
              label: 'Declarations',
              kind: 'lines',
              lineCount: 6,
              value: 'declarationRows',
              columns: [
                { name: 'head', label: 'Head', kind: 'select', options: headOptions },
                { name: 'declared', label: 'Declared', kind: 'money' },
                { name: 'proved', label: 'Proved', kind: 'money', optional: true },
                { name: 'metro', label: 'Metro (rent only)', kind: 'checkbox', optional: true },
              ],
            },
          ],
        },
        {
          kind: 'form',
          title: `Previous employment in ${yearName(year)}`,
          submit: 'Save',
          path: '/payroll/tax/previous',
          roles: [...ADMIN],
          fields: [
            ...hidden,
            { name: 'taxYear', label: '', kind: 'hidden', value: String(year) },
            { name: 'income', label: 'Taxable salary there', kind: 'money', value: String(data.previousIncome) },
            { name: 'tds', label: 'Tax deducted there', kind: 'money', value: String(data.previousTds) },
          ],
        },
      ]
    },
  },
]
