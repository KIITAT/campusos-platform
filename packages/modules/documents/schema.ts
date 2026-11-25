import { customType, foreignKey, index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { institutions, tenantPolicy, users } from '@campusos/db'

// The CHECK constraints, the append-only triggers and the DPDP hooks live in
// migrations/0000_document_store.sql; this file only names what queries touch.
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' })
const tenantId = () => uuid('institution_id').notNull().references(() => institutions.id, { onDelete: 'cascade' })
const at = (name: string) => timestamp(name, { withTimezone: true })

export const documentFiles = pgTable('documents_files', {
  id: uuid().primaryKey().defaultRandom(), institutionId: tenantId(),
  subjectUserId: text('subject_user_id').notNull().references(() => users.id),
  kind: text().notNull(), scope: text().notNull(), title: text().notNull(), mediaType: text('media_type').notNull(),
  body: bytea().notNull(), sha256: text().notNull(), createdAt: at('created_at').notNull().defaultNow(),
  retentionBasis: text('retention_basis'), authorityRef: text('authority_ref'), retainUntil: at('retain_until'),
}, table => [unique('documents_files_institution_id_id_key').on(table.institutionId, table.id), index('documents_files_page').on(table.institutionId, table.createdAt.desc(), table.id.desc()), index('documents_files_subject').on(table.subjectUserId), tenantPolicy('documents_files')])

export const signRequests = pgTable('documents_sign_requests', {
  id: uuid().primaryKey().defaultRandom(), institutionId: tenantId(), documentId: uuid('document_id').notNull(),
  signerId: text('signer_id').notNull().references(() => users.id), status: text().notNull().default('pending'),
  createdAt: at('created_at').notNull().defaultNow(), expiresAt: at('expires_at').notNull(), viewedAt: at('viewed_at'), decidedAt: at('decided_at'),
  codeDigest: text('code_digest'), recipientDigest: text('recipient_digest'), codeExpiresAt: at('code_expires_at'), codeIssuedAt: at('code_issued_at'),
}, table => [unique('documents_sign_requests_institution_id_id_key').on(table.institutionId, table.id), unique('documents_sign_requests_institution_id_document_id_key').on(table.institutionId, table.documentId), foreignKey({ columns: [table.institutionId, table.documentId], foreignColumns: [documentFiles.institutionId, documentFiles.id] }).onDelete('cascade'), index('documents_requests_signer').on(table.signerId), tenantPolicy('documents_sign_requests')])

export const documentSignatures = pgTable('documents_signatures', {
  id: uuid().primaryKey(), institutionId: tenantId(), documentId: uuid('document_id').notNull(), requestId: uuid('request_id').notNull(),
  signerId: text('signer_id').notNull().references(() => users.id), signedAt: at('signed_at').notNull(),
  method: text().notNull(), intentVersion: text('intent_version').notNull(), sha256: text().notNull(),
}, table => [unique('documents_signatures_institution_id_document_id_key').on(table.institutionId, table.documentId), unique('documents_signatures_institution_id_request_id_key').on(table.institutionId, table.requestId), foreignKey({ columns: [table.institutionId, table.documentId], foreignColumns: [documentFiles.institutionId, documentFiles.id] }).onDelete('cascade'), foreignKey({ columns: [table.institutionId, table.requestId], foreignColumns: [signRequests.institutionId, signRequests.id] }).onDelete('cascade'), index('documents_signatures_signer').on(table.signerId), tenantPolicy('documents_signatures')])
