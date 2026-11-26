import { sql } from 'drizzle-orm'
import { check, date, foreignKey, index, integer, jsonb, pgTable, smallint, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { docStatusColumns, institutions, tenantPolicy, users } from '@campusos/db'
import { studentPrograms } from '@campusos/module-academic/schema'

/**
 * School transfer certificates (P1-13d, decisions 975 to 983), as migration
 * 0001 builds them. The header is the document of record: a serial, who and
 * when, never a name or a date of birth. The printable snapshot is a separate
 * row that registered erasure deletes, so the header and its audit stay.
 */
export const transferCertificates = pgTable(
  'ceremony_transfer_certificates',
  {
    id: uuid().primaryKey().defaultRandom(),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'cascade' }),
    studentId: text('student_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    studentProgramId: uuid('student_program_id')
      .notNull()
      .references(() => studentPrograms.id, { onDelete: 'restrict' }),
    /** The IST calendar year of the issue date; the serial restarts each year. */
    issueYear: smallint('issue_year').notNull(),
    serialNo: integer('serial_no').notNull(),
    issuedOn: date('issued_on').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    ...docStatusColumns(),
  },
  (t) => [
    uniqueIndex('ceremony_transfer_serial').on(t.institutionId, t.issueYear, t.serialNo),
    uniqueIndex('ceremony_transfer_original').on(t.institutionId, t.studentProgramId).where(sql`amended_from is null`),
    uniqueIndex('ceremony_transfer_standing').on(t.institutionId, t.studentProgramId).where(sql`docstatus <> 'cancelled'`),
    uniqueIndex('ceremony_transfer_replacement').on(t.institutionId, t.amendedFrom).where(sql`amended_from is not null`),
    index('ceremony_transfer_student').on(t.institutionId, t.studentId),
    index('ceremony_transfer_recent').on(t.institutionId, sql`issued_on desc`, sql`serial_no desc`, sql`id desc`),
    check('ceremony_transfer_certificates_serial_no_check', sql`serial_no between 1 and 999999`),
    tenantPolicy('ceremony_transfer_certificates'),
  ],
)

export const transferPayloads = pgTable(
  'ceremony_transfer_payloads',
  {
    certificateId: uuid('certificate_id').primaryKey(),
    institutionId: uuid('institution_id').notNull(),
    /** `cbse_annexure_i_v1`: every printed field, as the office confirmed it. */
    snapshot: jsonb().$type<TransferSnapshot>().notNull(),
  },
  (t) => [
    foreignKey({ columns: [t.institutionId, t.certificateId], foreignColumns: [transferCertificates.institutionId, transferCertificates.id], name: 'ceremony_transfer_payload_header' }),
    tenantPolicy('ceremony_transfer_payloads'),
  ],
)

/** The stored snapshot; see api/transfer-input.ts for each field's bounds. */
export interface TransferSnapshot {
  format: 'cbse_annexure_i_v1'
  schoolName: string
  pupilName: string
  birthOn: string
  lastProgramCode: string
  lastProgramName: string
  endedOn: string
  issuedOn: string
  [field: string]: unknown
}

export type TransferCertificate = typeof transferCertificates.$inferSelect
