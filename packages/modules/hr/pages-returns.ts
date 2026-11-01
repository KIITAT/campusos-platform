import { param, type PluginPage } from '@campusos/module-framework'
import { listStaff, TAX_FORM, type Actor } from './api'
import { taxYearOf } from './api/payroll'

/**
 * Tax returns (P1-06c, ACC-17): each person's annual statement, and the
 * quarterly TDS working file the accountant checks the 24Q against.
 */

const ADMIN = ['institution_admin', 'super_admin'] as const

export const returnsPages: PluginPage[] = [
  {
    path: '/payroll/returns',
    title: 'Tax returns',
    menu: 'Tax returns',
    roles: [...ADMIN],
    async load(actor, req) {
      const a = actor as Actor
      const asked = Number(param(req, 'taxYear'))
      const taxYear = Number.isInteger(asked) && asked >= 2000 && asked <= 2100 ? asked : taxYearOf(new Date().toISOString().slice(0, 10), 4)
      const q = Number(param(req, 'quarter'))
      const quarter = Number.isInteger(q) && q >= 1 && q <= 4 ? q : 1
      const form = taxYear >= TAX_FORM.cutOverTaxYear ? TAX_FORM.from : TAX_FORM.before
      // Leavers too: their last payslip trues up the year's tax.
      const people = await listStaff(a, true)
      return {
        taxYear,
        quarter,
        files: [{ name: 'Quarterly TDS statement (working file)', taxYear, quarter }],
        people: people.map((p) => ({ id: p.id, employeeCode: p.employeeCode, name: p.name, statement: form, taxYear })),
      }
    },
    sections: (data) => [
      {
        kind: 'note',
        text: 'The NSDL FVU file is built from the specification the owner supplies; this working file holds the same figures.',
      },
      {
        kind: 'form',
        method: 'GET',
        path: '/payroll/returns',
        submit: 'Show',
        placement: 'inline',
        fields: [
          { name: 'taxYear', label: 'Tax year (the year it starts in)', kind: 'number', value: String(data.taxYear) },
          {
            name: 'quarter',
            label: 'Quarter',
            kind: 'select',
            value: String(data.quarter),
            options: [
              { value: '1', label: 'April to June' },
              { value: '2', label: 'July to September' },
              { value: '3', label: 'October to December' },
              { value: '4', label: 'January to March' },
            ],
          },
        ],
      },
      {
        kind: 'table',
        title: 'Working file',
        rows: 'files',
        columns: [{ key: 'name', label: 'File', href: '/api/v1/modules/hr/payroll/tds-quarter?taxYear={taxYear}&quarter={quarter}' }],
      },
      {
        kind: 'table',
        title: 'Annual tax statement',
        rows: 'people',
        empty: 'Nobody on record.',
        columns: [
          { key: 'employeeCode', label: 'Code', kind: 'code' },
          { key: 'name', label: 'Who' },
          { key: 'statement', label: '', href: '/api/v1/modules/hr/payroll/tax-statement.pdf?staffId={id}&taxYear={taxYear}' },
        ],
      },
    ],
  },
]
