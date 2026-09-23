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
  releasePayslipSchema,
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
  [`${base}/payroll/runs`]: get('Every payroll run: when, by whom, for how much'),
}
