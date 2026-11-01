import * as z from 'zod'
import { manifest } from '../manifest'
import {
  assignStructureSchema,
  createGratuityRuleSchema,
  createStructureSchema,
  createTaxRegimeSchema,
  electRegimeSchema,
  liftWithholdingSchema,
  payGratuitySchema,
  payrollSettingsSchema,
  releasePayslipSchema,
  reissueSchema,
  remitSchema,
  voidRemittanceSchema,
  setPreviousEmploymentSchema,
  setPtSlabsSchema,
  setTaxDeclarationsSchema,
  setStatutoryIdentitySchema,
  withholdSalarySchema,
} from './schemas'

const base = manifest.apiBasePath
const err = z.object({ error: z.string(), message: z.string() })
const json = (schema: z.ZodType) => ({ 'application/json': { schema } })
const ok = {
  '200': { description: 'OK' },
  '403': { description: 'Forbidden, or the module is not enabled', content: json(err) },
  '409': { description: 'Refused', content: json(err) },
}
const post = (summary: string, schema: z.ZodType, description?: string) => ({
  post: {
    summary,
    ...(description ? { description } : {}),
    tags: ['hr'],
    requestBody: { content: json(schema) },
    responses: ok,
  },
})
const get = (summary: string, query: string[] = []) => ({
  get: {
    summary,
    tags: ['hr'],
    parameters: query.map((name) => ({ name, in: 'query', required: true, schema: { type: 'string' } })),
    responses: ok,
  },
})

/** A downloadable file for a month; 409 `incomplete_details` lists whose records are short. */
const file = (summary: string, type: string) => ({
  get: {
    ...get(summary, ['period']).get,
    responses: { ...ok, '200': { description: 'OK', content: { [type]: {} } } },
  },
})

export const payPaths = {
  [`${base}/pay/structures`]: {
    ...get('Salary structures, their lines, and how many people are on each'),
    ...post(
      'Define a salary structure',
      createStructureSchema,
      'One base line; the rest fixed or a percentage of another line, in any order. No formula ' +
        'language. Each line says whether it is taxable.',
    ),
  },
  [`${base}/pay/structures/assign`]: post(
    'Put somebody on a structure at a base, from a date',
    assignStructureSchema,
    'Closes the previous assignment the day before; never two at once. A per-person pay ' +
      'component of the same code overrides the structure line.',
  ),
  [`${base}/pay/tax`]: {
    ...get('Income-tax regimes and their slabs'),
    ...post(
      'Enter an income-tax regime',
      createTaxRegimeSchema,
      'Nothing is seeded: slabs, standard deduction, cess and rebate are the institution’s to ' +
        'enter from the current Finance Act. Overlapping slabs are refused.',
    ),
  },
  [`${base}/pay/tax/elect`]: post(
    'Choose a regime for a tax year',
    electRegimeSchema,
    'By HR or the person. With no election there is no tax line: nothing is guessed. ' +
      'The monthly deduction projects the year at this month’s taxable pay, subtracts what earlier ' +
      'payslips in the year deducted, and spreads the rest.',
  ),
  [`${base}/pay/gratuity`]: {
    ...get('Gratuity rules'),
    ...post('Enter a gratuity rule', createGratuityRuleSchema, 'Every figure is the institution’s.'),
  },
  [`${base}/pay/gratuity/quote`]: get('What a gratuity would come to, with the working', ['staffId', 'ruleId']),
  [`${base}/pay/gratuity/pay`]: post(
    'Pay gratuity on leaving',
    payGratuitySchema,
    'Once per employment, computed not typed, posted to employer contributions.',
  ),
  [`${base}/pay/withheld`]: get('Payslips held back, and whether released'),
  [`${base}/pay/withhold`]: post(
    'Hold back somebody’s salary from a month',
    withholdSalarySchema,
    'Audited. Payslips are still generated -- the cost belongs to the month -- but left out of ' +
      'the payment run.',
  ),
  [`${base}/pay/withhold/lift`]: post('Stop holding back future salary', liftWithholdingSchema),
  [`${base}/pay/withheld/release`]: post(
    'Pay one held-back payslip',
    releasePayslipSchema,
    'Audited, and posted as the salary liability being discharged.',
  ),
  [`${base}/payroll/payslip.pdf`]: {
    get: {
      ...get('A payslip as a PDF: one’s own, or anyone’s for the office', ['payslipId']).get,
      responses: { ...ok, '200': { description: 'OK', content: { 'application/pdf': {} } }, '404': { description: 'No such payslip', content: json(err) } },
    },
  },
  [`${base}/payroll/reissue`]: post('Reissue a payslip: reverse its books entry and make a new one', reissueSchema, 'Refused once the month is paid, after the person has a later payslip, with advance recoveries on it, after a release of a held payslip, or once the month has been remitted.'),
  [`${base}/payroll/dues`]: get('What each statutory head owes for a month, what was remitted and what is left', ['period']),
  [`${base}/payroll/remittances`]: {
    get: { ...get('Remittances, newest first, voided ones included', []).get, parameters: [{ name: 'period', in: 'query', required: false, schema: { type: 'string' } }] },
    ...post('Record money paid to a statutory authority', remitSchema, 'Part payments are allowed. Refused beyond the balance, in the future, or for a challan reference already used. The first PF remittance of a month also posts the EPF administration minimum.'),
  },
  [`${base}/payroll/remittances/void`]: post('Void a remittance with a reason; its books entry is reversed', voidRemittanceSchema),
  [`${base}/payroll/ecr`]: file('The provident fund ECR text file for a month', 'text/plain'),
  [`${base}/payroll/esi`]: file('The ESI monthly contribution CSV for a month', 'text/csv'),
  [`${base}/payroll/bank-advice`]: file('The salary transfer advice CSV for a month (non-withheld payslips)', 'text/csv'),
  [`${base}/payroll/runs`]: get('Every payroll run: when, by whom, for how much'),
  [`${base}/payroll/settings`]: {
    ...get('How a part month is paid'),
    ...post(
      'Set how a part month is paid',
      payrollSettingsSchema,
      'calendar: a day is the month over its own days; days_30: over 30; days_26: over 26, Sundays not ' +
        'counted. Applies to joiners, leavers, unpaid leave and leave encashment from the next run. Audited.',
    ),
  },
  [`${base}/staff/statutory`]: {
    ...get("A person's statutory details", ['staffId']),
    ...post(
      "Set a person's statutory details",
      setStatutoryIdentitySchema,
      'PAN, UAN, ESI number, bank, work state and the PF and ESI options. Every field is replaced. Audited by field name, never by value.',
    ),
  },
  [`${base}/payroll/pt-slabs`]: {
    ...get('Professional tax slabs the institution has entered'),
    ...post(
      "Set a state's professional tax slabs",
      setPtSlabsSchema,
      'Replaces the slabs for that state from that month. The slab set in force for a month is the latest one not after it. Audited.',
    ),
  },
  [`${base}/payroll/tax/declarations`]: {
    ...post(
      "Replace a person's tax declarations for a year",
      setTaxDeclarationsSchema,
      'Every row for that person and year is replaced. A declared amount counts until the last three months of the tax year; then only a proved one. Administrators only. Audited by head.',
    ),
  },
  [`${base}/payroll/tax/previous`]: {
    ...post(
      'Record previous employment for a year',
      setPreviousEmploymentSchema,
      'Taxable salary and tax deducted by an earlier employer in the same tax year (Form 12B). One row per person and year. Administrators only. Audited.',
    ),
  },
}
