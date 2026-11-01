import { sql } from 'drizzle-orm'
import { boolean, check, date, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { tenantPolicy } from '@campusos/db'
import { paise, pk, tenantId } from './common'

/**
 * GSTR-2B as the portal sent it (P1-05a, ACC-03). Reference data the portal
 * regenerates, so re-importing a month replaces it. Only B2B invoices and
 * credit or debit notes are kept; the rest are counted in `skipped`.
 * No person column: the audit log says who imported it.
 */
export const gstr2bReturns = pgTable(
  'finance_gstr2b_returns',
  {
    id: pk(),
    institutionId: tenantId(),
    /** `YYYY-MM`. */
    period: text().notNull(),
    gstin: text().notNull(),
    fileName: text('file_name').notNull(),
    documents: integer().notNull(),
    skipped: jsonb().$type<Record<string, number>>().notNull().default({}),
    importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('finance_gstr2b_returns_one').on(t.institutionId, t.period),
    check('finance_gstr2b_returns_period', sql`period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
    check('finance_gstr2b_returns_documents', sql`documents >= 0`),
    tenantPolicy('finance_gstr2b_returns'),
  ],
)

export const gstr2bLines = pgTable(
  'finance_gstr2b_lines',
  {
    id: pk(),
    institutionId: tenantId(),
    returnId: uuid('return_id')
      .notNull()
      .references(() => gstr2bReturns.id, { onDelete: 'cascade' }),
    /** Null when the supplier's GSTIN fails the format check; it then never matches. */
    supplierGstin: text('supplier_gstin'),
    supplierGstinRaw: text('supplier_gstin_raw').notNull(),
    supplierName: text('supplier_name'),
    docType: text('doc_type').$type<'invoice' | 'credit' | 'debit'>().notNull(),
    docNumber: text('doc_number').notNull(),
    docKey: text('doc_key').notNull(),
    docDate: date('doc_date').notNull(),
    valuePaise: paise('value_paise').notNull(),
    taxablePaise: paise('taxable_paise').notNull(),
    igstPaise: paise('igst_paise').notNull().default(0),
    cgstPaise: paise('cgst_paise').notNull().default(0),
    sgstPaise: paise('sgst_paise').notNull().default(0),
    cessPaise: paise('cess_paise').notNull().default(0),
    itcAvailable: boolean('itc_available').notNull(),
    reverseCharge: boolean('reverse_charge').notNull(),
  },
  (t) => [
    index('finance_gstr2b_lines_key').on(t.institutionId, t.supplierGstin, t.docKey),
    index('finance_gstr2b_lines_return').on(t.returnId),
    check('finance_gstr2b_lines_doc_type', sql`doc_type in ('invoice', 'credit', 'debit')`),
    check(
      'finance_gstr2b_lines_gstin',
      sql`supplier_gstin is null or supplier_gstin ~ '^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]Z[0-9A-Z]$'`,
    ),
    tenantPolicy('finance_gstr2b_lines'),
  ],
)
