import { sql } from 'drizzle-orm'
import {
  check,
  date,
  index,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { institutions, tenantPolicy, users } from '@campusos/db'

/**
 * Skills: what a student can do, as they judge it and as a teacher judges it,
 * against a framework the institution defines.
 *
 * Kept apart from grades on purpose. A grade says how a student did in one
 * course, once, and is locked; a skill -- communication, teamwork, SQL -- is
 * built across many courses and outside them, and a level moves as evidence
 * comes in. This module depends on no other: it reads no marks and writes
 * none, and a transcript never shows it.
 */

const tenantId = () =>
  uuid('institution_id')
    .notNull()
    .references(() => institutions.id, { onDelete: 'cascade' })
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()

/** A set of skills and the scale they are judged on: "Employability", "Lab practice". */
export const frameworks = pgTable(
  'skill_frameworks',
  {
    id: uuid().primaryKey().defaultRandom(),
    institutionId: tenantId(),
    name: text().notNull(),
    description: text(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('skill_frameworks_name').on(t.institutionId, t.name),
    check('skill_frameworks_name_len', sql`length(trim(name)) > 0`),
    tenantPolicy('skill_frameworks'),
  ],
)

/**
 * The scale: rank 1 is the lowest. What each level means is the institution's
 * to write, and once a student has been judged against a level, what it means
 * does not change underneath them -- a level can be added, not rewritten.
 */
export const levels = pgTable(
  'skill_levels',
  {
    id: uuid().primaryKey().defaultRandom(),
    institutionId: tenantId(),
    frameworkId: uuid('framework_id')
      .notNull()
      .references(() => frameworks.id, { onDelete: 'cascade' }),
    rank: smallint().notNull(),
    name: text().notNull(),
    /** What a student at this level can do. */
    descriptor: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('skill_levels_rank').on(t.frameworkId, t.rank),
    check('skill_levels_rank_range', sql`rank between 1 and 10`),
    check('skill_levels_descriptor', sql`length(trim(descriptor)) >= 5`),
    tenantPolicy('skill_levels'),
  ],
)

export const skills = pgTable(
  'skill_skills',
  {
    id: uuid().primaryKey().defaultRandom(),
    institutionId: tenantId(),
    frameworkId: uuid('framework_id')
      .notNull()
      .references(() => frameworks.id, { onDelete: 'restrict' }),
    code: text().notNull(),
    name: text().notNull(),
    category: text(),
    description: text(),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('skill_skills_code').on(t.institutionId, t.code),
    index('skill_skills_framework').on(t.frameworkId),
    check('skill_skills_code_shape', sql`code ~ '^[A-Z0-9][A-Z0-9_-]{0,23}$'`),
    tenantPolicy('skill_skills'),
  ],
)

export const sourceEnum = pgEnum('skill_source', ['self', 'faculty'])

/**
 * One judgement: a student at a level of a skill, by themselves or by a
 * teacher, on a day, with the evidence. Never changed and never deleted --
 * a later judgement supersedes an earlier one, and the history is the point:
 * it shows a skill growing.
 */
export const assessments = pgTable(
  'skill_assessments',
  {
    id: uuid().primaryKey().defaultRandom(),
    institutionId: tenantId(),
    studentId: text('student_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    skillId: uuid('skill_id')
      .notNull()
      .references(() => skills.id, { onDelete: 'restrict' }),
    rank: smallint().notNull(),
    source: sourceEnum().notNull(),
    assessorId: text('assessor_id').references(() => users.id, { onDelete: 'set null' }),
    /** What it rests on: a project, a presentation, an observation. */
    evidence: text(),
    assessedOn: date('assessed_on').notNull().default(sql`current_date`),
    createdAt: createdAt(),
  },
  (t) => [
    index('skill_assessments_student').on(t.studentId, t.skillId, t.createdAt),
    index('skill_assessments_skill').on(t.skillId),
    check('skill_assessments_rank_range', sql`rank between 1 and 10`),
    // A teacher's judgement rests on something that can be pointed at.
    check('skill_assessments_evidence', sql`source = 'self' or length(trim(coalesce(evidence, ''))) >= 10`),
    tenantPolicy('skill_assessments'),
  ],
)

export type Framework = typeof frameworks.$inferSelect
export type Level = typeof levels.$inferSelect
export type Skill = typeof skills.$inferSelect
export type Assessment = typeof assessments.$inferSelect
