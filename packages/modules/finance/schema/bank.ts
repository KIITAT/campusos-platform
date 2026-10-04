import { sql } from 'drizzle-orm'
import {
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { tenantPolicy, users } from '@campusos/db'
import { createdAt, paise, pk, tenantId } from './common'
import { accounts, lines } from './ledger'

/**
 * A bank account the institution holds, and the account in the books that
 * stands for it.
 */
export const bankAccounts = pgTable(
  'finance_bank_accounts',
  {
    id: pk(),
    institutionId: tenantId(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    bankName: text('bank_name').notNull(),
    branch: text(),
    ifsc: text(),
    accountNumber: text('account_number').notNull(),
    /**
     * How this bank's CSV reads: which column is the date, the narration, the
     * withdrawal, the deposit, and how dates are written. Remembered from the
     * last import so the next one needs nothing.
     */
    csvMapping: jsonb('csv_mapping').$type<Record<string, string>>(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('finance_bank_accounts_account').on(t.institutionId, t.accountId),
    check('finance_bank_accounts_ifsc', sql`ifsc is null or ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'`),
    tenantPolicy('finance_bank_accounts'),
  ],
)

/** One statement file, as the bank gave it. The same file twice is refused. */
export const bankStatements = pgTable(
  'finance_bank_statements',
  {
    id: pk(),
    institutionId: tenantId(),
    bankAccountId: uuid('bank_account_id')
      .notNull()
      .references(() => bankAccounts.id, { onDelete: 'restrict' }),
    fileName: text('file_name').notNull(),
    fileSha256: text('file_sha256').notNull(),
    format: text().$type<'csv' | 'xlsx' | 'mt940' | 'camt053'>().notNull(),
    fromDate: date('from_date'),
    toDate: date('to_date'),
    openingPaise: paise('opening_paise'),
    closingPaise: paise('closing_paise'),
    lineCount: integer('line_count').notNull(),
    importedBy: text('imported_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('finance_bank_statements_file').on(t.institutionId, t.bankAccountId, t.fileSha256),
    check('finance_bank_statements_format', sql`format in ('csv', 'xlsx', 'mt940', 'camt053')`),
    tenantPolicy('finance_bank_statements'),
  ],
)

/**
 * One line of a statement, and what in the books it is.
 *
 * Matched to one ledger line on the bank's account -- the line that moved the
 * same money the same way. A ledger line is matched at most once; that is what
 * makes "uncleared" a fact rather than an estimate.
 */
export const bankStatementLines = pgTable(
  'finance_bank_statement_lines',
  {
    id: pk(),
    institutionId: tenantId(),
    statementId: uuid('statement_id')
      .notNull()
      .references(() => bankStatements.id, { onDelete: 'cascade' }),
    bankAccountId: uuid('bank_account_id')
      .notNull()
      .references(() => bankAccounts.id, { onDelete: 'restrict' }),
    seq: integer().notNull(),
    txnDate: date('txn_date').notNull(),
    valueDate: date('value_date'),
    description: text().notNull(),
    reference: text(),
    withdrawalPaise: paise('withdrawal_paise').notNull().default(0),
    depositPaise: paise('deposit_paise').notNull().default(0),
    balancePaise: paise('balance_paise'),
    status: text().$type<'unmatched' | 'matched' | 'ignored'>().notNull().default('unmatched'),
    matchedLineId: uuid('matched_line_id').references(() => lines.id, { onDelete: 'restrict' }),
    matchedBy: text('matched_by').references(() => users.id, { onDelete: 'set null' }),
    matchedAt: timestamp('matched_at', { withTimezone: true }),
    note: text(),
  },
  (t) => [
    index('finance_bank_statement_lines_statement').on(t.statementId),
    index('finance_bank_statement_lines_account').on(t.institutionId, t.bankAccountId, t.status),
    uniqueIndex('finance_bank_statement_lines_matched')
      .on(t.matchedLineId)
      .where(sql`matched_line_id is not null`),
    check(
      'finance_bank_statement_lines_amount',
      sql`withdrawal_paise >= 0 and deposit_paise >= 0 and (withdrawal_paise = 0) <> (deposit_paise = 0)`,
    ),
    check(
      'finance_bank_statement_lines_status',
      sql`status in ('unmatched', 'matched', 'ignored') and (status = 'matched') = (matched_line_id is not null)`,
    ),
    tenantPolicy('finance_bank_statement_lines'),
  ],
)

/**
 * "A line that says SMS CHGS is bank charges": what to post for statement
 * lines the books have not heard of, so the office confirms rather than types.
 */
export const bankRules = pgTable(
  'finance_bank_rules',
  {
    id: pk(),
    institutionId: tenantId(),
    bankAccountId: uuid('bank_account_id').references(() => bankAccounts.id, {
      onDelete: 'cascade',
    }),
    contains: text().notNull(),
    direction: text().$type<'in' | 'out' | 'any'>().notNull().default('any'),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    costCenter: text('cost_center'),
    priority: integer().notNull().default(100),
    createdAt: createdAt(),
  },
  () => [
    check('finance_bank_rules_direction', sql`direction in ('in', 'out', 'any')`),
    check('finance_bank_rules_contains', sql`length(trim(contains)) >= 2`),
    tenantPolicy('finance_bank_rules'),
  ],
)
