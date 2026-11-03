import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { institutions, tenantPolicy, users } from '@campusos/db'

// The checks, composite foreign keys and functions live in migrations/0000_reports.sql, which is the source of truth.

export const reports = pgTable('reports_reports', {
  id: uuid().primaryKey().defaultRandom(),
  institutionId: uuid('institution_id').notNull().references(() => institutions.id, { onDelete: 'cascade' }),
  name: text().notNull(),
  dataset: text().notNull(),
  spec: jsonb().notNull(),
  viewerRoles: text('viewer_roles').array().notNull().default([]),
  onDashboard: boolean('on_dashboard').notNull().default(false),
  schedule: text().notNull().default('none'),
  nextRunAt: timestamp('next_run_at', { withTimezone: true }),
  createdBy: text('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('reports_reports_tenant_id').on(t.institutionId, t.id),
  index('reports_reports_due').on(t.nextRunAt),
  tenantPolicy('reports_reports'),
])

export const runs = pgTable('reports_runs', {
  id: uuid().primaryKey().defaultRandom(),
  institutionId: uuid('institution_id').notNull().references(() => institutions.id, { onDelete: 'cascade' }),
  reportId: uuid('report_id').notNull(),
  trigger: text().notNull(),
  runBy: text('run_by').references(() => users.id),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }).notNull().defaultNow(),
  status: text().notNull(),
  errorCode: text('error_code'),
  rowCount: integer('row_count').notNull().default(0),
  truncated: boolean().notNull().default(false),
  onReplica: boolean('on_replica').notNull().default(false),
  dataAsOf: timestamp('data_as_of', { withTimezone: true }),
  columns: jsonb().notNull().default([]),
  rows: jsonb().notNull().default([]),
}, (t) => [
  index('reports_runs_latest').on(t.reportId, t.startedAt, t.id),
  index('reports_runs_age').on(t.institutionId, t.startedAt),
  tenantPolicy('reports_runs'),
])

export type Report = typeof reports.$inferSelect
export type Run = typeof runs.$inferSelect
