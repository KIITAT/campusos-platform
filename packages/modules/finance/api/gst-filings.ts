import { desc, sql } from 'drizzle-orm'
import { audit, withTenant } from '@campusos/db'
import * as z from 'zod'
import { gstFilings } from '../schema'
import { FinanceError, named, requireConfigure, requireRead, type Actor, type Tx } from './core'
import { addMonths, monthEnd } from './numbers'

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
    returnType: z.enum(['gstr1', 'gstr3b']),
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

  // A month, or (from P1-05) a quarter: the first of a month to the last day of the same month or the one two later.
  const monthly = data.periodTo === monthEnd(data.periodFrom)
  const quarterly = data.periodTo === monthEnd(addMonths(data.periodFrom, 2))
  if (!data.periodFrom.endsWith('-01') || !(monthly || quarterly)) {
    throw new FinanceError(400, 'bad_return_period', 'a return covers a month, or a quarter from its first day to its last')
  }

  return withTenant(tenant, (tx) =>
    named(async () => {
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

/** Whether a day falls inside a filed GSTR-1. */
export async function inFiledReturn(tx: Tx, postingDate: string): Promise<boolean> {
  const r = await tx.execute(sql`select 1 from finance_gst_filings where return_type = 'gstr1' and ${postingDate}::date between period_from and period_to`)
  return r.rows.length > 0
}
