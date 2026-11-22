import * as z from 'zod'
import { and, asc, eq, notExists, sql } from 'drizzle-orm'
import { audit, withTenant } from '@campusos/db'
import { exams, reportCardEntries, reportCardTemplates } from '../schema'
import { courses, offerings, programs, sections, terms } from './joins'
import { ExamError, type Actor } from './operations'
import { canonicalTemplate, schoolTemplateSchema, type SchoolTemplate } from './school-policy'

/**
 * Storage and the cohort lock for school term reports (P1-13b): the template
 * write, and what the entry and publication writes share with it.
 */

export type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]

export type UnassessedOffering = { id: string; section: string; courseCode: string; title: string }

export async function listUnassessedOfferings(tx: Tx, termId: string, programId: string, ids?: string[]): Promise<UnassessedOffering[]> {
  return tx
    .select({ id: offerings.id, section: sections.label, courseCode: courses.code, title: courses.title })
    .from(offerings)
    .innerJoin(sections, eq(sections.id, offerings.sectionId))
    .innerJoin(courses, eq(courses.id, offerings.courseId))
    .where(and(
      eq(offerings.termId, termId),
      eq(sections.programId, programId),
      notExists(tx.select({ one: sql`1` }).from(exams).where(eq(exams.offeringId, offerings.id))),
      ids && sql`${offerings.id} = any(array[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::uuid[])`,
    ))
    .orderBy(asc(sections.label), asc(courses.code), asc(offerings.id))
}

/** The outcomes of a school report card, with the words the portal and the API both use (D809). */
const REFUSALS = {
  no_such_school_pupil: [404, 'No such pupil for this section and term.'],
  no_report_card_template: [409, 'Set a report card template for this class and term.'],
  report_card_stale: [409, 'The template changed. Reload before saving.'],
  report_card_template_locked: [409, 'A pupil report has been started. Use a different term to change the template.'],
  invalid_report_card_template: [400, 'Enter a valid report card template.'],
  invalid_report_card_exclusion: [400, 'Choose offerings in this class and term that have no exams.'],
  unknown_report_card_value: [400, 'Choose a value from this template.'],
  report_card_unpublished: [409, 'This report card has not been published.'],
  report_card_incomplete: [409, 'This report card has incomplete results.'],
  report_card_published: [409, 'Unpublish this report card before editing.'],
} as const
export const reportCardRefusal = (c: keyof typeof REFUSALS) => new ExamError(REFUSALS[c][0], c, REFUSALS[c][1])

export const NOTICES = {
  template: 'Report card template saved.',
  entry: 'Report card entry saved.',
  published: 'Report card published.',
  unpublished: 'Report card unpublished.',
} as const

export const tenantOf = (actor: Actor): string => {
  if (!actor.institutionId) throw new ExamError(400, 'no_institution', 'no institution for this session')
  return actor.institutionId
}
export const isAdmin = (r: Actor['role']) => r === 'institution_admin' || r === 'super_admin'

/**
 * One lock per class and term, held to the end of the transaction. Template
 * and entry writes take it, so the freeze rule ("no entry yet") and the merge
 * of one grade into the entry's grades never race another writer.
 */
export async function lockReportCard(tx: Tx, tenant: string, termId: string, programId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`examinations.report-card:${tenant}:${termId}:${programId}`}, 0))`)
}

/** A template as stored, checked again on the way out: a row edited by hand must not be trusted. */
export const readTemplate = (raw: unknown): SchoolTemplate => {
  const r = schoolTemplateSchema.safeParse(raw)
  if (!r.success) throw reportCardRefusal('invalid_report_card_template')
  return r.data
}

const MAX_BYTES = 32_768
const body = z.object({
  termId: z.uuid(),
  programId: z.uuid(),
  expectedRevision: z.coerce.number().int().min(0),
  template: z.unknown(),
})

/** The template as an object, from JSON text or an object, within the size cap. */
function parseTemplate(raw: unknown): SchoolTemplate {
  let value = raw
  if (typeof raw === 'string') {
    if (Buffer.byteLength(raw, 'utf8') > MAX_BYTES) throw reportCardRefusal('invalid_report_card_template')
    try {
      value = JSON.parse(raw)
    } catch {
      throw reportCardRefusal('invalid_report_card_template')
    }
  } else if (Buffer.byteLength(JSON.stringify(raw) ?? '', 'utf8') > MAX_BYTES) throw reportCardRefusal('invalid_report_card_template')
  const r = schoolTemplateSchema.safeParse(value)
  if (!r.success) throw reportCardRefusal('invalid_report_card_template')
  return r.data
}

/**
 * Save a class's report template for a term, as the office. Compare-and-swap on
 * the revision (0 is "no saved row": the built-in default is in force), refused
 * once any pupil entry exists for that class and term, and a repeat of the
 * stored template changes and audits nothing.
 */
export async function setReportCardTemplate(actor: Actor, input: unknown): Promise<{ revision: number; notice: string }> {
  const tenant = tenantOf(actor)
  if (!isAdmin(actor.role)) throw new ExamError(403, 'forbidden', 'not permitted')
  const b = body.safeParse(input)
  if (!b.success) throw reportCardRefusal('invalid_report_card_template')
  const template = parseTemplate(b.data.template)
  const { termId, programId, expectedRevision } = b.data

  return withTenant(tenant, async (tx) => {
    const [program] = await tx.select({ id: programs.id }).from(programs).where(and(eq(programs.id, programId), eq(programs.level, 'school')))
    const [term] = await tx.select({ id: terms.id }).from(terms).where(eq(terms.id, termId))
    if (!program || !term) throw reportCardRefusal('no_such_school_pupil')

    await lockReportCard(tx, tenant, termId, programId)
    const [row] = await tx
      .select({ revision: reportCardTemplates.revision, template: reportCardTemplates.template })
      .from(reportCardTemplates)
      .where(and(eq(reportCardTemplates.termId, termId), eq(reportCardTemplates.programId, programId)))
    const current = row?.revision ?? 0
    if (current !== expectedRevision) throw reportCardRefusal('report_card_stale')
    if (row && canonicalTemplate(readTemplate(row.template)) === canonicalTemplate(template)) return { revision: current, notice: NOTICES.template }

    const [started] = await tx
      .select({ one: sql<number>`1` })
      .from(reportCardEntries)
      .innerJoin(sections, eq(sections.id, reportCardEntries.sectionId))
      .where(and(eq(reportCardEntries.termId, termId), eq(sections.programId, programId)))
      .limit(1)
    if (started) throw reportCardRefusal('report_card_template_locked')

    const excluded = template.excludedOfferingIds ?? []
    if (excluded.length && (await listUnassessedOfferings(tx, termId, programId, excluded)).length !== excluded.length)
      throw reportCardRefusal('invalid_report_card_exclusion')

    const revision = current + 1
    await tx
      .insert(reportCardTemplates)
      .values({ institutionId: tenant, termId, programId, revision, template })
      .onConflictDoUpdate({ target: [reportCardTemplates.institutionId, reportCardTemplates.termId, reportCardTemplates.programId], set: { revision, template } })
    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: 'examinations',
      action: 'report_card.template_saved',
      entity: 'exam_report_card_templates',
      entityId: `${termId}:${programId}`,
      reason: 'school report template saved',
      detail: { termId, programId, revision, classNumber: template.classNumber, excludedOfferingCount: excluded.length },
    })
    return { revision, notice: NOTICES.template }
  })
}
