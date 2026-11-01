import { desc, sql } from 'drizzle-orm'
import { audit, withTenant } from '@campusos/db'
import * as z from 'zod'
import { gstFilings } from '../schema'
import { FinanceError, named, requireConfigure, requireRead, type Actor, type Tx } from './core'
import { addMonths, monthEnd } from './numbers'
import { settingsWithin } from './years'

/**
 * GST returns marked filed (P1-04, ACC-05).
 *
 * GST forbids cancelling an invoice already reported in a return: the correction
 * is a credit or debit note. So the books need to know which days a filed GSTR-1
 * covers. No route undoes a filing: a mistaken mark only forces credit notes,
 * which is always lawful. There is no person column; the audit log says who.
 */

const MODULE = 'finance'

/** The first month of each quarter of the Indian GST year: April, July, October, January. */
export const QUARTER_START_MONTHS = [4, 7, 10, 1] as const

/** Whether a period is exactly one calendar month, exactly one GST quarter, or neither. */
export function periodKind(from: string, to: string): 'month' | 'quarter' | null {
  if (!from.endsWith('-01')) return null
  if (to === monthEnd(from)) return 'month'
  const month = Number(from.slice(5, 7))
  if ((QUARTER_START_MONTHS as readonly number[]).includes(month) && to === monthEnd(addMonths(from, 2))) return 'quarter'
  return null
}
const isoDate = z.iso.date()

export const gstFilingSchema = z
  .object({
    returnType: z.enum(['gstr1', 'gstr3b', 'iff', 'cmp08']),
    periodFrom: isoDate,
    periodTo: isoDate,
    filedOn: isoDate,
    arn: z
      .string()
      .trim()
      .regex(/^[A-Z0-9]{15}$/)
      .optional()
      .or(z.literal('').transform(() => undefined)),
  })
  .meta({ id: 'FinanceGstFiling' })

export async function markFiled(actor: Actor, input: unknown) {
  const tenant = requireConfigure(actor)
  const data = gstFilingSchema.parse(input)

  return withTenant(tenant, (tx) =>
    named(async () => {
      // What may be filed, and over what, depends on the institution's scheme (P1-05a D8).
      const s = await settingsWithin(tx, tenant)
      const rule = filingRule(s.gstScheme, s.gstFiling, data.returnType)
      if (!rule) throw new FinanceError(400, 'bad_return_type', "that return is not filed under the institution's GST scheme")
      const kind = periodKind(data.periodFrom, data.periodTo)
      const month = Number(data.periodFrom.slice(5, 7))
      const inQuarter = [3, 6, 9, 12].includes(month) ? 3 : 1 // the third month of a quarter takes no IFF
      if (kind !== rule.kind || (rule.firstTwoOnly && inQuarter === 3)) {
        throw new FinanceError(400, 'bad_return_period', `that period does not match how the institution files: ${rule.words}`)
      }
      const overlap = await tx.execute(sql`
        select 1 from finance_gst_filings
         where return_type = ${data.returnType}
           and daterange(period_from, period_to, '[]') && daterange(${data.periodFrom}::date, ${data.periodTo}::date, '[]')`)
      if (overlap.rows.length > 0) {
        throw new FinanceError(409, 'return_already_filed', 'a return of that type is already marked filed for part of that period')
      }
      const [row] = await tx
        .insert(gstFilings)
        .values({
          institutionId: tenant,
          returnType: data.returnType,
          periodFrom: data.periodFrom,
          periodTo: data.periodTo,
          filedOn: data.filedOn,
          arn: data.arn ?? null,
        })
        .returning()
      await audit(tx, {
        institutionId: tenant,
        actorId: actor.id,
        actorEmail: actor.email ?? null,
        moduleId: MODULE,
        action: 'gst.return_filed',
        entity: 'finance_gst_filings',
        entityId: row!.id,
        reason: `${data.returnType} ${data.periodFrom} to ${data.periodTo} marked filed`,
        detail: { ...row },
      })
      return { ...row!, notice: 'Marked filed. Invoices in that period now change only by credit or debit note.' }
    }),
  )
}

export async function listFilings(actor: Actor) {
  const tenant = requireRead(actor)
  return withTenant(tenant, (tx) => tx.select().from(gstFilings).orderBy(desc(gstFilings.periodFrom)))
}

/**
 * The period a return covers for the institution's scheme, or null when that
 * scheme does not file it (P1-05a D8).
 */
function filingRule(scheme: 'regular' | 'composition', filing: 'monthly' | 'quarterly', type: string) {
  if (scheme === 'composition') return type === 'cmp08' ? { kind: 'quarter' as const, words: 'a quarter', firstTwoOnly: false } : null
  if (type === 'gstr1' || type === 'gstr3b') {
    return filing === 'quarterly'
      ? { kind: 'quarter' as const, words: 'a quarter', firstTwoOnly: false }
      : { kind: 'month' as const, words: 'a month', firstTwoOnly: false }
  }
  if (type === 'iff' && filing === 'quarterly') return { kind: 'month' as const, words: 'the first or second month of a quarter', firstTwoOnly: true }
  return null
}

/**
 * Whether a day falls inside a filed return that reports an invoice: any GSTR-1,
 * or an IFF for an invoice to a registered buyer (b2b).
 */
export async function inFiledReturn(tx: Tx, postingDate: string, b2b: boolean): Promise<boolean> {
  const r = await tx.execute(sql`
    select 1 from finance_gst_filings
     where ${postingDate}::date between period_from and period_to
       and (return_type = 'gstr1' or (return_type = 'iff' and ${b2b}::boolean))`)
  return r.rows.length > 0
}
