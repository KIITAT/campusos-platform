import { bigint, numeric, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { institutions } from '@campusos/db'

/**
 * The column helpers every table in the books shares.
 *
 * Money is integer minor units of the institution's base currency -- paise for
 * an Indian college, cents for one elsewhere -- in a bigint read as a number.
 * The column names still say `paise` because that is what they meant first and
 * what every posting module already writes; "paise" here means "the base
 * currency's smallest unit", and the base currency is a setting.
 *
 * Quantities are integer thousandths (`_milli`): 2.5 kg is 2500, a box of 12
 * is 12000. Fractional stock is real -- reagents by the millilitre, cable by
 * the metre -- and a float that has drifted by a millionth makes a stock
 * ledger that never quite reaches zero.
 */

export const tenantId = () =>
  uuid('institution_id')
    .notNull()
    .references(() => institutions.id, { onDelete: 'cascade' })

export const pk = () => uuid().primaryKey().defaultRandom()

export const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow()

export const paise = (name: string) => bigint(name, { mode: 'number' })

export const milli = (name: string) => bigint(name, { mode: 'number' })

/** Units of base currency per one unit of the foreign one, exactly as typed. */
export const rate = (name: string) => numeric(name, { precision: 20, scale: 10 })

/** An ISO 4217 code. */
export const currency = (name: string) => text(name)
