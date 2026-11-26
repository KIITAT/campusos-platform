import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { and, asc, eq, like, sql } from 'drizzle-orm'
import { PDFDocument } from 'pdf-lib'
import { auditLog, authDb, institutionModules, institutions, users, withTenant } from '@campusos/db'
import * as academic from '@campusos/module-academic/api'
import { printedText } from '@campusos/module-framework/pdf'
import * as api from './api'
import { lockReportCard } from './api/report-card-store'
import { snapshot } from './api/report-card-input'
import { defaultSchoolTemplate } from './api/school-policy'
import { reportCardPages } from './report-card-pages'
import { reportCardEntries, reportCardTemplates, reportCardVersions } from './schema'
import { routes } from './routes'
import { routeRoles } from './route-roles'

/**
 * School term reports (FUNC-03, P1-13b): a template per class and term, a
 * teacher's observations, a per-pupil publication and the PDF read live from
 * the published marks. Fixture: Class 6 A with one subject (Maths) and an
 * Indic pupil name, in two tenants.
 */

/** The text of every draw, joined: printedText gives one entry per draw call. */
const printed = async (bytes: Uint8Array) => (await printedText(bytes)).join(' | ')
const pg = createRequire(import.meta.url)('../../db/node_modules/pg') as { Client: new (o: { connectionString?: string }) => { connect(): Promise<void>; query(q: string): Promise<unknown>; end(): Promise<void> } }
const SLUG = 'exam-rc-'
let n = 0
const NAME = 'অভিষেক চট্টোপাধ্যায়'
const code = (e: unknown) => (e as api.ExamError).code
const status = (e: unknown) => (e as { status?: number }).status

type A = api.Actor & { viewerOf?: string[] }
const as = (id: string, role: api.Actor['role'], inst: string, over: Record<string, unknown> = {}) => ({ id, email: `${role}@rc.test`, role, institutionId: inst, ...over }) as A

async function campus(opts: { level?: 'school' | 'undergraduate'; programCode?: string; extraOffering?: boolean } = {}) {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Report School', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const id = i!.id
  const names = ['Office', 'Class Teacher', 'Maths Teacher', 'Other Teacher', NAME, 'Second Pupil', 'Other Pupil', 'Guardian', 'Stranger Parent']
  const rows = await authDb
    .insert(users)
    .values(names.map((name, k) => ({ email: `u${k}@${tag}.test`, institutionId: id, role: (['institution_admin', 'faculty', 'faculty', 'faculty', 'student', 'student', 'student', 'parent', 'parent'] as const)[k]!, name })))
    .returning({ id: users.id })
  const [adm, ct, mt, ot, pupil, pupil2, otherPupil, guardian, stranger] = rows.map((r) => r.id) as [string, string, string, string, string, string, string, string, string]
  const admin = as(adm, 'institution_admin', id)
  const a = admin as unknown as academic.Actor
  const dept = await academic.createDepartment(a, { code: 'MID', name: 'Middle school' })
  const prog = await academic.createProgram(a, { departmentId: dept.id, code: opts.programCode ?? `Class-6`, name: 'Class 6', level: opts.level ?? 'school', durationTerms: 2 })
  const term = await academic.createTerm(a, { code: `T${n}`, name: 'Term 1', startsOn: '2026-04-01', endsOn: '2026-09-30' })
  const otherTerm = await academic.createTerm(a, { code: `U${n}`, name: 'Term 2', startsOn: '2026-10-01', endsOn: '2027-03-31' })
  const sec = await academic.createSection(a, { programId: prog.id, label: 'A', admissionYear: 2026 })
  const secB = await academic.createSection(a, { programId: prog.id, label: 'B', admissionYear: 2026 })
  await academic.setClassTeacher(a, { sectionId: sec.id, email: `u1@${tag}.test` })
  for (const s of [pupil, pupil2]) await academic.addSectionMember(a, { sectionId: sec.id, userId: s })
  await academic.addSectionMember(a, { sectionId: secB.id, userId: otherPupil })
  await academic.setStudentProfile(a, { studentId: pupil, rollNo: `R${n}01` })
  const maths = await academic.createCourse(a, { departmentId: dept.id, code: `MATH${n}`, title: 'Mathematics', credits: 1 })
  const offering = await academic.createOffering(a, { termId: term.id, courseId: maths.id, sectionId: sec.id, facultyUserId: mt })
  const offeringB = await academic.createOffering(a, { termId: term.id, courseId: maths.id, sectionId: secB.id, facultyUserId: mt })
  const teacher = as(mt, 'faculty', id)
  const exam = async (offeringId: string, name: string, kind: 'quiz' | 'assignment' | 'final', maxMarks: number, weightPercent: number) => (await api.createExam(teacher, { offeringId, name, kind, maxMarks, weightPercent })).id
  const exams = {
    periodic: await exam(offering.id, 'Periodic Test', 'quiz', 10, 10),
    notebook: await exam(offering.id, 'Notebook', 'assignment', 5, 5),
    enrichment: await exam(offering.id, 'Subject Enrichment', 'assignment', 5, 5),
    term: await exam(offering.id, 'Term Examination', 'final', 80, 80),
  }
  const crafts = opts.extraOffering
    ? await academic.createCourse(a, { departmentId: dept.id, code: 'CRAFT', title: 'Craft', credits: 1 })
    : null
  const craftA = crafts && await academic.createOffering(a, { termId: term.id, courseId: crafts.id, sectionId: sec.id, facultyUserId: mt })
  const craftB = crafts && await academic.createOffering(a, { termId: term.id, courseId: crafts.id, sectionId: secB.id, facultyUserId: mt })
  const craftBExamId = craftB && await exam(craftB.id, 'Craft final', 'final', 100, 100)
  return {
    id,
    tag,
    craftAId: craftA?.id,
    craftBId: craftB?.id,
    craftBExamId,
    admin,
    classTeacher: as(ct, 'faculty', id),
    teacher,
    otherTeacher: as(ot, 'faculty', id),
    pupil: as(pupil, 'student', id),
    pupil2: as(pupil2, 'student', id),
    otherPupil: as(otherPupil, 'student', id),
    guardian: as(guardian, 'parent', id, { viewerOf: [pupil] }),
    stranger: as(stranger, 'parent', id, { viewerOf: [otherPupil] }),
    programId: prog.id,
    termId: term.id,
    otherTermId: otherTerm.id,
    sectionId: sec.id,
    sectionBId: secB.id,
    offeringId: offering.id,
    offeringBId: offeringB.id,
    exams,
  }
}
type C = Awaited<ReturnType<typeof campus>>

/** Publish the four Maths marks of the Class 6 example: 8/10, 5/5, 4/5, 70/80. */
async function publishMarks(c: C, studentIds = [c.pupil.id]) {
  const scores: [string, number][] = [
    [c.exams.periodic, 8],
    [c.exams.notebook, 5],
    [c.exams.enrichment, 4],
    [c.exams.term, 70],
  ]
  for (const [examId, obtained] of scores) {
    await api.enterMarks(c.teacher, { examId, marks: studentIds.map((studentId) => ({ studentId, obtained })) })
    await api.publishExam(c.teacher, { examId })
  }
}

const identity = (c: C, studentId = c.pupil.id) => ({ termId: c.termId, sectionId: c.sectionId, studentId })
const reportOf = (c: C, who: A, studentId = c.pupil.id) => api.reportCard(who, studentId, c.termId, c.sectionId)
const publication = (c: C, over: Record<string, unknown> = {}, who: A = c.classTeacher) =>
  api.setReportCardPublication(who, { ...identity(c), published: true, reason: 'Checked with the class teacher', ...over })
const saveEntry = (c: C, area: string, value: string, who: A = c.classTeacher, studentId = c.pupil.id) => api.setReportCardEntry(who, { ...identity(c, studentId), area, value })
const saveTemplate = (c: C, over: Record<string, unknown> = {}, who: A = c.admin) =>
  api.setReportCardTemplate(who, { termId: c.termId, programId: c.programId, expectedRevision: 0, template: defaultSchoolTemplate(6), ...over })

const audits = (c: C, like_ = 'report_card.%') =>
  withTenant(c.id, async (tx) => (await tx.select({ n: sql<number>`count(*)::int` }).from(auditLog).where(and(eq(auditLog.moduleId, 'examinations'), sql`${auditLog.action} like ${like_}`)))[0]!.n)
const revisionOf = (c: C) =>
  withTenant(c.id, async (tx) => (await tx.select({ r: reportCardTemplates.revision }).from(reportCardTemplates).where(eq(reportCardTemplates.termId, c.termId)))[0]?.r ?? 0)
const entryOf = (c: C, studentId = c.pupil.id) =>
  withTenant(c.id, async (tx) => (await tx.select().from(reportCardEntries).where(and(eq(reportCardEntries.studentId, studentId), eq(reportCardEntries.termId, c.termId))))[0] ?? null)

const pdfRoute = routes.find((r) => r.path === '/report-card.pdf')!
const download = (c: C, who: A, studentId?: string, sectionId = c.sectionId) =>
  pdfRoute.handler(who as never, new Request(`http://t.test/report-card.pdf?termId=${c.termId}&sectionId=${sectionId}${studentId ? `&studentId=${studentId}` : ''}`)) as Promise<Response>

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

test('template exclusions accept only exam-free offerings in the selected programme and term', async () => {
  const c = await campus({ extraOffering: true })
  const foreign = await campus({ extraOffering: true })
  const template = defaultSchoolTemplate(6)!
  const excluding = (id: string) => ({ ...template, excludedOfferingIds: [id] })
  const refusal = (e: unknown) =>
    code(e) === 'invalid_report_card_exclusion' && status(e) === 400 && (e as Error).message === 'Choose offerings in this class and term that have no exams.'

  for (const id of [c.craftBId!, c.offeringId, foreign.craftAId!, crypto.randomUUID()]) {
    await assert.rejects(saveTemplate(c, { template: excluding(id) }), refusal)
  }
  await assert.rejects(saveTemplate(c, { termId: c.otherTermId, template: excluding(c.craftAId!) }), refusal)
  await assert.rejects(saveTemplate(c, { template: excluding(c.craftAId!) }, c.classTeacher), (e) => code(e) === 'forbidden')
  assert.equal(await revisionOf(c), 0)

  assert.equal((await saveTemplate(c, { template })).revision, 1)
  assert.equal((await saveTemplate(c, { expectedRevision: 1, template: { ...template, excludedOfferingIds: [] } })).revision, 1)
  assert.equal((await saveTemplate(c, { expectedRevision: 1, template: excluding(c.craftAId!) })).revision, 2)
  const [row] = await withTenant(c.id, (tx) => tx.select().from(reportCardTemplates))
  assert.deepEqual(row!.template, excluding(c.craftAId!))
  const details = await withTenant(c.id, (tx) => tx.select({ detail: auditLog.detail }).from(auditLog).where(eq(auditLog.action, 'report_card.template_saved')))
  assert.ok(details.some(({ detail }) => (detail as { excludedOfferingCount?: number }).excludedOfferingCount === 1))
  assert.ok(!JSON.stringify(details).includes(c.craftAId!))
  await saveEntry(c, 'art', 'a')
  assert.equal((await saveTemplate(c, { expectedRevision: 2, template: excluding(c.craftAId!) })).revision, 2)
  await assert.rejects(saveTemplate(c, { expectedRevision: 2, template: excluding(c.craftBId!) }), (e) => code(e) === 'report_card_template_locked')
})

test('an explicitly excluded exam-free offering allows publication and leaves the same course assessed in another section', async () => {
  const c = await campus({ extraOffering: true })
  const template = defaultSchoolTemplate(6)!
  const subjectOverrides = [{ courseCode: 'CRAFT', components: [{ key: 'paper', label: 'Craft exam', weight: 100, selectors: [{ kind: 'final' }] }] }]
  await publishMarks(c)
  await assert.rejects(publication(c), (e) => code(e) === 'report_card_incomplete')
  await saveTemplate(c, { template: { ...template, subjectOverrides, excludedOfferingIds: [c.craftAId!, c.offeringBId] } })
  assert.equal((await publication(c)).notice, 'Report card published.')
  const report = await reportOf(c, c.pupil)
  assert.deepEqual(report.subjects[0], {
    courseCode: 'CRAFT', title: 'Craft', components: [], total: null, grade: null, notAssessed: true,
  })
  assert.deepEqual([report.subjects[1]!.total, report.subjects[1]!.grade], [87, 'A2'])
  assert.ok(!('notAssessed' in report.subjects[1]!))
  const lines = (await printed(await api.reportCardPdf(report))).split(' | ')
  const craft = lines.indexOf('CRAFT Craft')
  const maths = lines.findIndex((line) => line.endsWith(' Mathematics'))
  assert.ok(craft >= 0 && maths > craft)
  assert.deepEqual(lines.slice(craft + 1, maths), ['Not assessed'])
  assert.ok(lines.includes('Total: 87.00 / 100') && lines.includes('Grade: A2'))

  await api.enterMarks(c.teacher, { examId: c.craftBExamId!, marks: [{ studentId: c.otherPupil.id, obtained: 75 }] })
  await api.publishExam(c.teacher, { examId: c.craftBExamId! })
  await publication(c, { sectionId: c.sectionBId, studentId: c.otherPupil.id }, c.admin)
  const other = await api.reportCard(c.otherPupil, c.otherPupil.id, c.termId, c.sectionBId)
  assert.equal(other.subjects.find((s) => s.courseCode === 'CRAFT')?.total, 75)
})

test('an added exam never breaks an issued exclusion', async () => {
  const c = await campus({ extraOffering: true })
  const template = defaultSchoolTemplate(6)!
  const subjectOverrides = [{ courseCode: 'CRAFT', components: [{ key: 'paper', label: 'Craft exam', weight: 100, selectors: [{ kind: 'final' }] }] }]
  await publishMarks(c)
  await saveTemplate(c, { template: { ...template, subjectOverrides, excludedOfferingIds: [c.craftAId!] } })
  await publication(c)
  const text = async () => {
    const res = await download(c, c.pupil)
    assert.equal(res.status, 200)
    return printed(new Uint8Array(await res.arrayBuffer()))
  }
  const issued = async () => {
    const t = await text()
    assert.ok(t.includes('Not assessed') && t.includes('87.00') && t.includes('Issue version 1'), 'the issued card is unchanged')
  }
  await issued()

  const exam = await api.createExam(c.teacher, { offeringId: c.craftAId!, name: 'Craft final', kind: 'final', maxMarks: 100, weightPercent: 100 })
  await issued()
  await api.enterMarks(c.teacher, { examId: exam.id, marks: [{ studentId: c.pupil.id, obtained: 80 }] })
  await issued()
  const republish = (expectedVersion: number) => publication(c, { republish: true, expectedVersion, reason: 'Craft examination now assessed' })
  await assert.rejects(republish(1), (e) => code(e) === 'report_card_incomplete' && status(e) === 409)
  await issued()
  await api.publishExam(c.teacher, { examId: exam.id })
  await issued()

  assert.equal((await republish(1)).changed, true)
  const second = await text()
  assert.ok(second.includes('80.00') && second.includes('B1') && second.includes('Issue version 2') && !second.includes('Not assessed'))
  assert.equal((await reportOf(c, c.pupil)).subjects[0]!.notAssessed, undefined)
})

test('a marks report can publish when all of the section offerings are excluded', async () => {
  const c = await campus()
  await saveTemplate(c, { template: { ...defaultSchoolTemplate(6)!, excludedOfferingIds: [c.offeringBId] } })
  assert.equal((await publication(c, { sectionId: c.sectionBId, studentId: c.otherPupil.id }, c.admin)).notice, 'Report card published.')
  const report = await api.reportCard(c.otherPupil, c.otherPupil.id, c.termId, c.sectionBId)
  assert.equal(report.subjects.length, 1)
  assert.equal(report.subjects[0]!.notAssessed, true)
})

// --- the template -------------------------------------------------------------

test('template: the office saves and revises, and the same template again changes nothing', async () => {
  const c = await campus()
  assert.equal(await revisionOf(c), 0, 'no saved template reads as revision 0')
  const saved = await saveTemplate(c)
  assert.deepEqual([saved.revision, saved.notice], [1, 'Report card template saved.'])
  assert.equal(await audits(c, 'report_card.template_saved'), 1)
  const edited = { ...defaultSchoolTemplate(6)!, name: 'Our term report' }
  const again = await saveTemplate(c, { expectedRevision: 1, template: JSON.stringify(edited) })
  assert.equal(again.revision, 2, 'JSON text is accepted as well as an object')
  const same = await saveTemplate(c, { expectedRevision: 2, template: edited })
  assert.equal(same.revision, 2)
  assert.equal(await audits(c, 'report_card.template_saved'), 2)
  const [row] = await withTenant(c.id, (tx) => tx.select().from(reportCardTemplates))
  assert.equal(row!.template.name, 'Our term report')
  const [log] = await withTenant(c.id, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, 'report_card.template_saved')).limit(1))
  assert.equal(log!.entity, 'exam_report_card_templates')
  assert.equal(log!.entityId, `${c.termId}:${c.programId}`)
  assert.equal(log!.reason, 'school report template saved')
})

test('template: stale, malformed, oversized and unauthorised saves are refused and change nothing', async () => {
  const c = await campus()
  await saveTemplate(c)
  const base = await audits(c)
  await assert.rejects(saveTemplate(c, { expectedRevision: 0 }), (e) => code(e) === 'report_card_stale' && status(e) === 409)
  await assert.rejects(saveTemplate(c, { expectedRevision: 1, template: { ...defaultSchoolTemplate(6)!, version: 2 } }), (e) => code(e) === 'invalid_report_card_template' && status(e) === 400)
  await assert.rejects(saveTemplate(c, { expectedRevision: 1, template: '{not json' }), (e) => code(e) === 'invalid_report_card_template')
  await assert.rejects(saveTemplate(c, { expectedRevision: 1, template: JSON.stringify({ ...defaultSchoolTemplate(6)!, name: 'é'.repeat(70), pad: 'x'.repeat(33_000) }) }), (e) => code(e) === 'invalid_report_card_template')
  for (const who of [c.classTeacher, c.teacher, c.pupil, c.guardian]) await assert.rejects(saveTemplate(c, { expectedRevision: 1 }, who), (e) => code(e) === 'forbidden' && status(e) === 403)
  await assert.rejects(saveTemplate(c, { expectedRevision: -1 }), (e) => code(e) === 'invalid_report_card_template')
  assert.equal(await revisionOf(c), 1)
  assert.equal(await audits(c), base)
})

test('template: only a school programme, and only in the caller’s own tenant', async () => {
  const c = await campus()
  const college = await campus({ level: 'undergraduate', programCode: 'BTECH' })
  await assert.rejects(saveTemplate(college), (e) => code(e) === 'no_such_school_pupil' && status(e) === 404)
  const other = await campus()
  await assert.rejects(saveTemplate(c, {}, other.admin), (e) => code(e) === 'no_such_school_pupil')
  await assert.rejects(saveTemplate(c, { termId: crypto.randomUUID() }), (e) => code(e) === 'no_such_school_pupil')
  assert.equal(await audits(c) + (await audits(college)) + (await audits(other)), 0)
})

test('template: another tenant reads nothing and cannot write a row into this one', async () => {
  const c = await campus()
  await saveTemplate(c)
  await saveEntry(c, 'art', 'a')
  const other = await campus()
  assert.equal((await withTenant(other.id, (tx) => tx.select().from(reportCardTemplates))).length, 0)
  assert.equal((await withTenant(other.id, (tx) => tx.select().from(reportCardEntries))).length, 0)
  await assert.rejects(
    withTenant(other.id, (tx) => tx.insert(reportCardTemplates).values({ institutionId: c.id, termId: c.otherTermId, programId: c.programId, revision: 1, template: defaultSchoolTemplate(6)! })),
  )
  assert.equal((await withTenant(c.id, (tx) => tx.select().from(reportCardTemplates))).length, 1)
})

test('template: frozen once any pupil entry exists in that class and term, open in another term', async () => {
  const c = await campus()
  await saveEntry(c, 'art', 'a')
  await assert.rejects(saveTemplate(c), (e) => code(e) === 'report_card_stale', 'the entry fixed the default as revision 1')
  await assert.rejects(saveTemplate(c, { expectedRevision: 1, template: { ...defaultSchoolTemplate(6)!, name: 'Changed' } }), (e) => code(e) === 'report_card_template_locked' && status(e) === 409)
  await saveTemplate(c, { termId: c.otherTermId })
  assert.equal(await revisionOf(c), 1, 'the first entry fixed the built-in default as revision 1')
})

// --- entries and publication ---------------------------------------------------

test('a published Class 6 report prints Indic text, 87.00 and A2, with no college figures', async () => {
  const c = await campus()
  await publishMarks(c)
  await saveEntry(c, 'art', 'a')
  await saveEntry(c, 'remark', 'steady')
  await assert.rejects(reportOf(c, c.pupil), (e) => code(e) === 'report_card_unpublished' && status(e) === 409)
  assert.deepEqual((await publication(c)).notice, 'Report card published.')
  const r = await reportOf(c, c.pupil)
  assert.equal(r.name, NAME)
  assert.equal(r.classNumber, 6)
  assert.equal(r.sectionLabel, 'A')
  assert.equal(r.mode, 'marks')
  assert.equal(r.subjects.length, 1)
  assert.deepEqual([r.subjects[0]!.total, r.subjects[0]!.grade], [87, 'A2'])
  assert.deepEqual(r.subjects[0]!.components.map((x) => x.value), [8, 5, 4, 70])
  assert.equal(r.areas.find((a) => a.key === 'art')!.grade, 'A')
  assert.equal(r.areas.find((a) => a.key === 'discipline')!.grade, null)
  assert.equal(r.remark, 'Steady progress this term.')
  assert.equal(r.legend[0]!.grade, 'A1')
  const text = await printed(await api.reportCardPdf(r))
  for (const want of [NAME, 'School term report', 'Mathematics', '87.00', 'A2', 'Art Education', 'Pending', 'Class 6', 'Section A']) assert.ok(text.includes(want), want)
  for (const never of ['SGPA', 'CGPA', 'Second Pupil', 'Other Pupil']) assert.ok(!text.includes(never), never)
})

test('approved marks require a new issue', async () => {
  const c = await campus()
  await publishMarks(c)
  await saveEntry(c, 'art', 'a')
  await assert.rejects(download(c, c.classTeacher, c.pupil.id), (e) => code(e) === 'report_card_unpublished')
  await publication(c)
  const res = await download(c, c.pupil)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'application/pdf')
  assert.equal(res.headers.get('cache-control'), 'no-store')
  assert.match(res.headers.get('content-disposition')!, /^inline; filename="report-card-[A-Za-z0-9._-]+\.pdf"$/)
  assert.ok(!res.headers.get('content-disposition')!.includes(NAME))
  const text = async () => printed(new Uint8Array(await (await download(c, c.pupil)).arrayBuffer()))
  const first = await printed(new Uint8Array(await res.arrayBuffer()))
  assert.ok(first.includes('87.00') && first.includes('A2') && first.includes(NAME) && first.includes('Issue version 1'))
  assert.match(res.headers.get('content-disposition')!, /-v1.pdf"$/)
  // P1-07c: a revision is a proposal; the card moves only when an administrator approves it.
  const p1 = await api.reviseMark(c.teacher, { examId: c.exams.term, studentId: c.pupil.id, obtained: 80, expectedRevision: 0, reason: 'Re-evaluated answer script' })
  assert.ok((await text()).includes('87.00'), 'a proposal changes nothing')
  await api.decideMarkReview(c.admin, { requestId: p1.requestId, decision: 'approve', reason: 'checked against the script' })
  const unchanged = await text()
  assert.ok(unchanged.includes('87.00') && unchanged.includes('A2') && !unchanged.includes('97.00'), 'an approval does not change an issued card')
  assert.equal((await reportOf(c, c.pupil)).subjects[0]!.total, 87)
  assert.equal(await audits(c, 'report_card.republished'), 0)

  await assert.rejects(publication(c, { republish: true, expectedVersion: 1, reason: 'short' }), (e) => code(e) === 'invalid_report_card_republication' && status(e) === 400)
  await assert.rejects(publication(c, { republish: true, reason: 'Re-evaluated answer script approved' }), (e) => code(e) === 'invalid_report_card_republication')
  assert.equal((await publication(c, { republish: true, expectedVersion: 1, reason: 'Re-evaluated answer script approved' })).notice, 'Report card republished.')
  const again = await text()
  assert.ok(again.includes('97.00') && again.includes('A1') && again.includes('Issue version 2'), 'the reissue shows the revised value')
  await assert.rejects(publication(c, { republish: true, expectedVersion: 1, reason: 'A second click on the same form' }), (e) => code(e) === 'report_card_version_stale' && status(e) === 409)
  assert.equal(await audits(c, 'report_card.republished'), 1)
  const [log] = await withTenant(c.id, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, 'report_card.republished')))
  assert.equal(log!.reason, 'Re-evaluated answer script approved')
  assert.deepEqual([(log!.detail as { previousVersion: number; version: number }).previousVersion, (log!.detail as { version: number }).version], [1, 2])

  const p2 = await api.reviseMark(c.teacher, { examId: c.exams.term, studentId: c.pupil.id, obtained: null, absent: true, expectedRevision: 1, reason: 'Absent at the re-evaluation sitting' })
  await api.decideMarkReview(c.admin, { requestId: p2.requestId, decision: 'approve', reason: 'checked against the script' })
  assert.ok((await text()).includes('97.00'), 'an approved absence waits for a reissue')
  await publication(c, { republish: true, expectedVersion: 2, reason: 'Absence recorded after re-evaluation' })
  const absent = await text()
  assert.ok(!absent.includes('97.00') && absent.includes('Issue version 3'), 'the absence first appears at version 3')
})

test('an issued card prints the IST date it was issued on', async () => {
  const c = await issued()
  const r = await reportOf(c, c.pupil)
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(r.issuedAt)).replace('Sept', 'Sep')
  assert.ok((await printed(await api.reportCardPdf(r))).includes(`Issued on ${day}`), day)
  // 2026-05-05T20:00Z is already 6 May in India.
  assert.ok((await printed(await api.reportCardPdf({ ...r, issuedAt: '2026-05-05T20:00:00.000000Z' }))).includes('Issued on 6 May 2026'))
})

test('PDF the pupil, a verified guardian and authorised staff may read it; no one else, and no bytes for them', async () => {
  const c = await campus()
  await publishMarks(c)
  await saveEntry(c, 'art', 'a')
  await publication(c)
  for (const [who, id] of [[c.pupil, undefined], [c.guardian, c.pupil.id], [c.admin, c.pupil.id], [c.classTeacher, c.pupil.id], [c.teacher, c.pupil.id]] as [A, string | undefined][]) {
    const res = await download(c, who, id)
    assert.equal(res.status, 200, who.role)
    assert.ok((await res.arrayBuffer()).byteLength > 500)
  }
  const refused = async (label: string, run: () => Promise<unknown>, want: number, wantCode: string) => {
    await assert.rejects(run(), (e) => status(e) === want && code(e) === wantCode, label)
  }
  const quiet = console.error
  console.error = () => {}
  try {
    await refused('another pupil', () => download(c, c.otherPupil, c.pupil.id), 403, 'not_your_student')
    await refused('an unrelated parent', () => download(c, c.stranger, c.pupil.id), 403, 'not_your_student')
    await refused('an unrelated teacher', () => download(c, c.otherTeacher, c.pupil.id), 403, 'not_your_student')
    const other = await campus()
    await refused('an admin of another tenant', () => download(c, other.admin, c.pupil.id), 404, 'no_such_school_pupil')
  } finally {
    console.error = quiet
  }
  // A parent is a route role for the PDF and for nothing else in this item.
  assert.ok(routeRoles['GET /report-card.pdf']!.includes('parent') && routeRoles['GET /report-card.pdf']!.includes('student'))
  assert.ok(!routeRoles['POST /report-card/entry']!.includes('parent') && !routeRoles['POST /report-card/template']!.includes('faculty'))
})

test('PDF a long list of subjects wraps onto further pages and keeps every Indic name', async () => {
  const c = await campus()
  await publishMarks(c)
  await saveEntry(c, 'art', 'a')
  await publication(c)
  const base = await reportOf(c, c.pupil)
  const long = 'অভিষেক চট্টোপাধ্যায়ের বিজ্ঞান ও প্রযুক্তি বিষয়ক অতিরিক্ত দীর্ঘ পাঠ্যক্রমের নাম '.repeat(3)
  const subjects = Array.from({ length: 30 }, (_, i) => ({ ...base.subjects[0]!, courseCode: `S${i}`, title: `${long}${i}` }))
  const bytes = await api.reportCardPdf({ ...base, subjects })
  assert.ok((await PDFDocument.load(bytes)).getPageCount() > 1)
  const text = await printed(bytes)
  assert.ok(text.includes('29'), 'the last subject is printed')
  assert.ok(text.includes('Class teacher'), 'signature lines are printed')
})

test('the class teacher and the office write; the subject teacher, pupils and guardians cannot', async () => {
  const c = await campus()
  await saveEntry(c, 'art', 'b')
  await saveEntry(c, 'discipline', 'a', c.admin)
  for (const who of [c.teacher, c.otherTeacher, c.pupil, c.guardian]) {
    await assert.rejects(saveEntry(c, 'work', 'a', who), (e) => code(e) === 'forbidden' && status(e) === 403, who.role)
    await assert.rejects(publication(c, {}, who), (e) => code(e) === 'forbidden', who.role)
  }
  const other = await campus()
  await assert.rejects(saveEntry(c, 'work', 'a', other.admin), (e) => code(e) === 'no_such_school_pupil')
  const e = await entryOf(c)
  assert.deepEqual(e!.grades, { art: 'b', discipline: 'a' })
})

test('one value per save, strictly from the template; clear keeps an empty row; a repeat is a no-op', async () => {
  const c = await campus()
  assert.deepEqual(await saveEntry(c, 'art', 'a'), { changed: true, notice: 'Report card entry saved.' })
  assert.equal(await audits(c, 'report_card.entry_saved'), 1)
  assert.equal((await saveEntry(c, 'art', 'a')).changed, false)
  assert.equal(await audits(c, 'report_card.entry_saved'), 1, 'a repeat writes no audit row')
  for (const [area, value] of [['nope', 'a'], ['art', 'z'], ['art', ''], ['remark', 'a'], ['remark', 'nope']] as const)
    await assert.rejects(saveEntry(c, area, value), (e) => code(e) === 'unknown_report_card_value' && status(e) === 400, `${area}=${value}`)
  await saveEntry(c, 'remark', 'practice')
  assert.equal((await entryOf(c))!.remarkKey, 'practice')
  await saveEntry(c, 'art', '__clear')
  await saveEntry(c, 'remark', '__clear')
  const e = await entryOf(c)
  assert.deepEqual([e!.grades, e!.remarkKey], [{}, null], 'the row stays, empty')
  // Clearing what is not there creates nothing and audits nothing.
  const before = await audits(c)
  assert.equal((await saveEntry(c, 'health', '__clear', c.classTeacher, c.pupil2.id)).changed, false)
  assert.equal(await entryOf(c, c.pupil2.id), null)
  assert.equal(await audits(c), before)
  const [log] = await withTenant(c.id, (tx) => tx.select().from(auditLog).where(and(eq(auditLog.action, 'report_card.entry_saved'), eq(auditLog.entityId, `${c.termId}:${c.sectionId}:${c.pupil.id}`))).limit(1))
  assert.equal(log!.entity, 'exam_report_card_entries')
  assert.equal(log!.reason, 'school report entry saved')
  assert.deepEqual((log!.detail as { area: string; before: unknown; after: unknown }).area, 'art')
})

test('publication needs a reason and complete results, locks the ratings, and unpublishing reopens them', async () => {
  const c = await campus()
  await publishMarks(c)
  await assert.rejects(publication(c, { reason: 'short' }), (e) => (e as Error).name === 'ZodError')
  await assert.rejects(publication(c, { reason: 'x'.repeat(241) }), (e) => (e as Error).name === 'ZodError')
  // The second pupil has no marks yet: incomplete, not published.
  await assert.rejects(publication(c, { studentId: c.pupil2.id }), (e) => code(e) === 'report_card_incomplete' && status(e) === 409)
  assert.equal(await entryOf(c, c.pupil2.id), null)
  assert.equal((await publication(c, { reason: '   Verified by the class teacher   ' })).notice, 'Report card published.')
  assert.ok((await entryOf(c))!.publishedAt)
  await assert.rejects(saveEntry(c, 'art', 'a'), (e) => code(e) === 'report_card_published' && status(e) === 409)
  const done = await publication(c, { published: 'false', reason: 'Correction needed to the art grade' })
  assert.equal(done.notice, 'Report card unpublished.')
  assert.equal((await entryOf(c))!.publishedAt, null)
  await saveEntry(c, 'art', 'a')
  // Unpublishing what was never published creates no row.
  assert.equal((await publication(c, { published: false, studentId: c.pupil2.id })).changed, false)
  assert.equal(await entryOf(c, c.pupil2.id), null)
  assert.equal(await audits(c, 'report_card.published'), 1)
  assert.equal(await audits(c, 'report_card.unpublished'), 1)
})

test('an observation class publishes when every scholastic area is rated', async () => {
  const c = await campus({ programCode: 'CLASS-2' })
  const t = defaultSchoolTemplate(2)!
  assert.equal((await saveTemplate(c, { template: t })).revision, 1)
  await assert.rejects(publication(c), (e) => code(e) === 'report_card_incomplete')
  for (const a of t.areas.filter((x) => x.group === 'scholastic')) await saveEntry(c, a.key, 'proficient')
  await publication(c)
  const r = await reportOf(c, c.pupil)
  assert.deepEqual([r.mode, r.subjects.length, r.templateName], ['observations', 0, 'Foundational progress'])
  assert.equal(r.areas.filter((x) => x.group === 'co_scholastic').every((x) => x.grade === null), true)
  assert.ok((await printed(await api.reportCardPdf(r))).includes('Language and literacy'))
})

test('who is a pupil: the section, the term and the roster decide, and an erased pupil has no report', async () => {
  const c = await campus()
  await publishMarks(c)
  await saveEntry(c, 'art', 'a')
  await assert.rejects(api.reportCard(c.admin, c.otherPupil.id, c.termId, c.sectionId), (e) => code(e) === 'no_such_school_pupil', 'not in this section')
  await assert.rejects(api.reportCard(c.admin, c.pupil.id, c.otherTermId, c.sectionId), (e) => code(e) === 'no_such_school_pupil', 'no offering in that term')
  await assert.rejects(api.reportCard(c.admin, c.pupil.id, c.termId, crypto.randomUUID()), (e) => code(e) === 'no_such_school_pupil')
  await assert.rejects(api.reportCard(c.admin, c.teacher.id, c.termId, c.sectionId), (e) => code(e) === 'no_such_school_pupil', 'a teacher is not a pupil')
  await publication(c)
  await authDb.update(users).set({ erasedAt: new Date() }).where(eq(users.id, c.pupil.id))
  await assert.rejects(api.reportCard(c.admin, c.pupil.id, c.termId, c.sectionId), (e) => code(e) === 'no_such_school_pupil')
  // A college programme is no school class.
  const college = await campus({ level: 'undergraduate', programCode: 'BTECH' })
  await assert.rejects(api.reportCard(college.admin, college.pupil.id, college.termId, college.sectionId), (e) => code(e) === 'no_such_school_pupil')
})

test('template precedence: no pupil, then no template, then unpublished, then incomplete', async () => {
  const c = await campus({ programCode: 'LAB-6' })
  await assert.rejects(api.reportCard(c.admin, c.otherPupil.id, c.termId, c.sectionId), (e) => code(e) === 'no_such_school_pupil')
  await assert.rejects(reportOf(c, c.admin), (e) => code(e) === 'no_report_card_template' && status(e) === 409)
  await saveTemplate(c, { template: { ...defaultSchoolTemplate(6)! } })
  await assert.rejects(reportOf(c, c.admin), (e) => code(e) === 'report_card_unpublished')
})

// --- the lock -----------------------------------------------------------------

async function advisoryWaiters(inst: string) {
  return withTenant(inst, async (tx) => Number((await tx.execute(sql`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and wait_event = 'advisory'`)).rows[0]!.n))
}
async function until(fn: () => Promise<boolean>) {
  const deadline = Date.now() + 10_000
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 25))
  }
}
/** A transaction that takes the cohort lock, runs `inside`, and holds it until `release`. */
function holder(c: C, inside: (tx: Parameters<Parameters<typeof withTenant>[1]>[0]) => Promise<void>) {
  let release!: () => void
  let locked!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const ready = new Promise<void>((r) => (locked = r))
  const done = withTenant(c.id, async (tx) => {
    await lockReportCard(tx, c.id, c.termId, c.programId)
    await inside(tx)
    locked()
    await gate
  })
  return { ready, release, done }
}

test('the template save waits for a first draft in flight and then finds the format frozen', async () => {
  const c = await campus()
  const h = holder(c, async (tx) => {
    await tx.insert(reportCardEntries).values({ institutionId: c.id, termId: c.termId, sectionId: c.sectionId, studentId: c.pupil.id })
  })
  await h.ready
  const attempt = saveTemplate(c).then(() => null, (e: unknown) => e)
  try {
    await until(async () => (await advisoryWaiters(c.id)) >= 1)
  } finally {
    h.release()
  }
  await h.done
  const err = await attempt
  assert.equal(code(err), 'report_card_template_locked')
  assert.equal(await revisionOf(c), 0)
})

test('two entry saves behind one lock both survive', async () => {
  const c = await campus()
  const h = holder(c, async () => {})
  await h.ready
  const a = saveEntry(c, 'art', 'a')
  const b = saveEntry(c, 'discipline', 'b', c.admin)
  try {
    await until(async () => (await advisoryWaiters(c.id)) >= 2)
  } finally {
    h.release()
  }
  await h.done
  await Promise.all([a, b])
  assert.deepEqual((await entryOf(c))!.grades, { art: 'a', discipline: 'b' })
})

// --- the portal ----------------------------------------------------------------

const page = (path: string) => reportCardPages.find((p) => p.path === path)!
const req = (qs: string) => new Request(`http://t.test/m/examinations/report-cards?${qs}`)
const forms = (sections: unknown) => (sections as { kind: string; path?: string }[]).filter((s) => s.kind === 'form')

test('the staff page offers a class teacher only their own sections, and the template only to the office', async () => {
  const c = await campus({ extraOffering: true })
  const foreign = await campus({ extraOffering: true })
  await publishMarks(c)
  const p = page('/report-cards')
  assert.deepEqual(p.roles.sort(), ['faculty', 'hod', 'institution_admin', 'super_admin'])

  const mine = await p.load(c.classTeacher as never, req(''))
  assert.deepEqual((mine.sectionOptions as { value: string }[]).map((o) => o.value), [c.sectionId])
  assert.ok(!(mine.sectionOptions as { value: string }[]).some((o) => o.value === c.sectionBId))
  const none = await p.load(c.otherTeacher as never, req(''))
  assert.deepEqual(none.sectionOptions, [])

  const all = await p.load(c.admin as never, req(''))
  assert.equal((all.sectionOptions as unknown[]).length, 2)
  assert.equal(all.sectionId, '', 'no section is preselected')

  const q = `termId=${c.termId}&sectionId=${c.sectionId}&studentId=${c.pupil.id}`
  const adminData = await p.load(c.admin as never, req(q))
  const teacherData = await p.load(c.classTeacher as never, req(q))
  const adminSections = p.sections(adminData)
  const teacherSections = p.sections(teacherData)
  const adminView = forms(adminSections)
  const teacherView = forms(teacherSections)
  const table = adminSections.find((s) => s.kind === 'table' && s.title === 'Offerings with no exams')
  assert.ok(table?.kind === 'table')
  assert.deepEqual(table.columns.map((c) => c.label), ['Section', 'Course', 'Offering ID'])
  const eligible = JSON.stringify(adminData[table.rows])
  assert.ok(eligible.includes(c.craftAId!))
  for (const id of [c.offeringId, c.craftBId!, foreign.craftAId!]) assert.ok(!eligible.includes(id), id)
  assert.ok(adminSections.some((s) => s.kind === 'note' && s.text === 'Add offering IDs to excludedOfferingIds to print Not assessed.'))
  assert.ok(!teacherSections.some((s) => s.kind === 'table' && s.title === table.title))
  assert.ok(!JSON.stringify(teacherData).includes(c.craftAId!))
  assert.ok(adminView.some((f) => f.path === '/report-card/template'))
  assert.ok(!teacherView.some((f) => f.path === '/report-card/template'))
  for (const path of ['/report-card/entry', '/report-card/publication']) assert.ok(teacherView.some((f) => f.path === path), path)

  // A section the teacher does not lead is not theirs to open by guessing its id.
  const guess = await p.load(c.classTeacher as never, req(`termId=${c.termId}&sectionId=${c.sectionBId}&studentId=${c.otherPupil.id}`))
  assert.equal(guess.sectionId, '')
  assert.ok(!forms(p.sections(guess)).some((f) => f.path === '/report-card/entry'))
})

test('the staff page hides the rating forms once published and links the download', async () => {
  const c = await campus()
  await publishMarks(c)
  await saveEntry(c, 'art', 'a')
  const p = page('/report-cards')
  const q = `termId=${c.termId}&sectionId=${c.sectionId}&studentId=${c.pupil.id}`
  const draft = p.sections(await p.load(c.classTeacher as never, req(q)))
  assert.ok(!JSON.stringify(draft).includes('report-card.pdf'))
  await publication(c)
  const live = p.sections(await p.load(c.classTeacher as never, req(q)))
  assert.ok(!forms(live).some((f) => f.path === '/report-card/entry'))
  assert.ok(JSON.stringify(live).includes(`report-card.pdf?termId=${c.termId}&sectionId=${c.sectionId}&studentId=${encodeURIComponent(c.pupil.id)}`))
})

test('a pupil and a guardian list only published reports, with no draft link', async () => {
  const c = await campus()
  await publishMarks(c, [c.pupil.id, c.pupil2.id])
  await saveEntry(c, 'art', 'a')
  await saveEntry(c, 'art', 'a', c.classTeacher, c.pupil2.id)
  const p = page('/my-report-cards')
  assert.deepEqual(p.roles.sort(), ['parent', 'student'])
  const empty = await p.load(c.pupil as never, req(''))
  assert.deepEqual(empty.rows, [])
  assert.ok(JSON.stringify(p.sections(empty)).includes('No published school report cards.'))
  await publication(c)
  const mine = (await p.load(c.pupil as never, req(''))).rows as { href: string; name: string }[]
  assert.equal(mine.length, 1)
  assert.ok(mine[0]!.href.includes('report-card.pdf') && mine[0]!.href.includes(encodeURIComponent(c.pupil.id)))
  const kids = (await p.load(c.guardian as never, req(''))).rows as { name: string }[]
  assert.deepEqual(kids.map((r) => r.name), [NAME])
  assert.deepEqual((await p.load(c.stranger as never, req(''))).rows, [], 'a guardian of another child sees nothing of this one')
  assert.ok(!JSON.stringify(mine).includes(c.pupil2.id), 'the other pupil’s draft is not listed')
})

test('the cohort lock is one lock whatever the case of the ids (NEW-212)', async () => {
  const c = await campus()
  let release!: () => void
  let locked!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const ready = new Promise<void>((r) => (locked = r))
  const done = withTenant(c.id, async (tx) => {
    await lockReportCard(tx, c.id, c.termId.toUpperCase(), c.programId.toUpperCase())
    locked()
    await gate
  })
  await ready
  try {
    const second = await withTenant(c.id, async (tx) => {
      await tx.execute(sql`set local lock_timeout = '300ms'`)
      return lockReportCard(tx, c.id, c.termId, c.programId).then(() => null, (e: unknown) => e)
    })
    assert.ok(second, 'the lower-case ids took a different lock')
  } finally {
    release()
  }
  await done
})

// --- what an issue captures (P1-13b.3) -------------------------------------------

const enableAttendance = (c: C, enabled = true) =>
  authDb.insert(institutionModules).values({ institutionId: c.id, moduleId: 'attendance', enabled }).onConflictDoUpdate({ target: [institutionModules.institutionId, institutionModules.moduleId], set: { enabled } })
const mark = (c: C, sectionId: string, studentId: string, on: string, present: boolean) =>
  withTenant(c.id, (tx) => tx.execute(sql`insert into attendance_daily_marks (institution_id, section_id, on_date, student_id, present) values (${c.id}, ${sectionId}, ${on}, ${studentId}, ${present})`))
const inputs = (c: C, studentId = c.pupil.id, register?: boolean) => withTenant(c.id, (tx) => snapshot(tx, c.termId, c.sectionId, studentId, register))

test('issue inputs include only recorded section days', async () => {
  const c = await campus()
  await enableAttendance(c)
  // Two present and one absent inside the term (both boundaries count); everything else is noise.
  await mark(c, c.sectionId, c.pupil.id, '2026-04-01', true)
  await mark(c, c.sectionId, c.pupil.id, '2026-06-10', false)
  await mark(c, c.sectionId, c.pupil.id, '2026-09-30', true)
  await mark(c, c.sectionId, c.pupil.id, '2026-03-31', true)
  await mark(c, c.sectionId, c.pupil.id, '2026-10-01', true)
  await mark(c, c.sectionBId, c.pupil.id, '2026-05-05', true)
  await mark(c, c.sectionId, c.pupil2.id, '2026-05-05', true)
  assert.deepEqual((await inputs(c)).attendance, { present: 2, held: 3 })
  assert.deepEqual((await inputs(c, c.pupil2.id)).attendance, { present: 1, held: 1 })
  const none = await campus()
  await enableAttendance(none)
  assert.deepEqual((await inputs(none)).attendance, { present: 0, held: 0 }, 'no register entries is zero, not unavailable')
  await enableAttendance(c, false)
  assert.equal((await inputs(c)).attendance, null, 'a disabled module is unavailable')
  assert.equal((await inputs(none, none.pupil.id, false)).attendance, null, 'a missing register table is unavailable')
  const cardOf = async (k: C) => (await import('./api/report-card-input')).attendanceOf(await inputs(k))
  assert.deepEqual(await cardOf(none), { state: 'recorded', present: 0, held: 0 })
  assert.deepEqual(await cardOf(c), { state: 'unavailable' })
})

test('first effective write preserves the default', async () => {
  const c = await campus()
  const rows = () => withTenant(c.id, (tx) => tx.select().from(reportCardTemplates))
  // A no-op, a refusal and a read create nothing.
  assert.equal((await saveEntry(c, 'health', '__clear')).changed, false)
  await assert.rejects(saveEntry(c, 'art', 'zzz'), (e) => code(e) === 'unknown_report_card_value')
  assert.equal((await rows()).length, 0)
  assert.equal(await audits(c, 'report_card.template_saved'), 0)
  await saveEntry(c, 'art', 'a')
  assert.deepEqual((await rows()).map((r) => [r.revision, r.template]), [[1, defaultSchoolTemplate(6)]])
  await saveEntry(c, 'art', 'b')
  assert.equal((await rows()).length, 1)
  assert.equal(await audits(c, 'report_card.template_saved'), 1)
  const [log] = await withTenant(c.id, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, 'report_card.template_saved')))
  assert.equal(log!.reason, 'Built-in report card template fixed at first use')
  assert.equal(log!.actorId, c.classTeacher.id)
  assert.equal(log!.entityId, `${c.termId}:${c.programId}`)
  await assert.rejects(saveTemplate(c, { expectedRevision: 1, template: { ...defaultSchoolTemplate(6)!, name: 'Changed later' } }), (e) => code(e) === 'report_card_template_locked')

  // An observation class keeps the labels it started with.
  const o = await campus({ programCode: 'CLASS-2' })
  await saveEntry(o, 'language', 'proficient').catch(() => null)
  const key = defaultSchoolTemplate(2)!.areas[0]!
  await saveEntry(o, key.key, key.grades[0]!.key)
  const [row] = await withTenant(o.id, (tx) => tx.select().from(reportCardTemplates))
  assert.equal(row!.revision, 1)
  assert.deepEqual(row!.template, defaultSchoolTemplate(2))
})

// --- issue, withdraw and correct (P1-13b.3) ----------------------------------------

const versionsOf = (c: C, studentId = c.pupil.id) =>
  withTenant(c.id, (tx) => tx.select().from(reportCardVersions).where(and(eq(reportCardVersions.studentId, studentId), eq(reportCardVersions.termId, c.termId))).orderBy(asc(reportCardVersions.version)))
const republishAs = (c: C, expectedVersion: number, who: A = c.classTeacher, reason = 'Marks corrected after re-evaluation') =>
  publication(c, { republish: true, expectedVersion, reason }, who)

/** A card with published marks, rated, and issued as version 1. */
async function issued(opts: Parameters<typeof campus>[0] = {}) {
  const c = await campus(opts)
  await publishMarks(c)
  await saveEntry(c, 'art', 'a')
  await publication(c)
  return c
}

/** Approve a revision of the term mark so a correction would print different figures. */
async function approveRevision(c: C, obtained = 80) {
  const p = await api.reviseMark(c.teacher, { examId: c.exams.term, studentId: c.pupil.id, obtained, expectedRevision: 0, reason: 'Re-evaluated answer script' })
  await api.decideMarkReview(c.admin, { requestId: p.requestId, decision: 'approve', reason: 'checked against the script' })
}

async function waitingOn(kind: 'advisory' | 'row') {
  return withTenant((await authDb.select({ id: institutions.id }).from(institutions).limit(1))[0]!.id, async (tx) =>
    Number((await tx.execute(sql`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and wait_event = ${kind === 'advisory' ? 'advisory' : 'transactionid'}`)).rows[0]!.n))
}

test('publication outcomes: first issue, retry, withdrawal, reissue and refusals', async () => {
  const c = await issued()
  assert.deepEqual((await versionsOf(c)).map((v) => v.version), [1])
  assert.equal((await publication(c)).changed, false, 'a repeat of the first issue is a no-op')
  assert.equal((await versionsOf(c)).length, 1)
  assert.equal(await audits(c, 'report_card.published'), 1)

  for (const bad of [{ expectedVersion: -1 }, { expectedVersion: 'abc' }, { expectedVersion: 1.5 }, { expectedVersion: 2_147_483_647 }, { expectedVersion: undefined }, { published: false }, { reason: 'short' }, { republish: 'maybe' }])
    await assert.rejects(publication(c, { republish: true, expectedVersion: 1, reason: 'Marks corrected after re-evaluation', ...bad }), (e) => code(e) === 'invalid_report_card_republication' && status(e) === 400, JSON.stringify(bad))
  await assert.rejects(publication(c, { expectedVersion: 5 }), (e) => code(e) === 'report_card_version_stale', 'an ordinary publish with a version is compared too')
  await assert.rejects(publication(c, { published: false, expectedVersion: 5, reason: 'Withdrawn for a rating correction' }), (e) => code(e) === 'report_card_version_stale')
  assert.equal((await publication(c, { expectedVersion: '1' })).changed, false, 'a decimal string is a version')

  for (const who of [c.teacher, c.otherTeacher, c.pupil, c.guardian]) await assert.rejects(republishAs(c, 1, who), (e) => code(e) === 'forbidden', who.role)
  const other = await campus()
  await assert.rejects(republishAs(c, 1, other.admin), (e) => code(e) === 'no_such_school_pupil')
  assert.deepEqual((await versionsOf(c)).map((v) => v.version), [1], 'every refusal above changed nothing')
  assert.equal((await republishAs(c, 1)).notice, 'Report card republished.')
  assert.deepEqual((await versionsOf(c)).map((v) => v.version), [1, 2])
  assert.equal(await audits(c, 'report_card.republished'), 1)

  // Withdraw keeps the history; publishing again appends the next version and is a reissue.
  const done = await publication(c, { published: false, reason: 'Correction needed to the art grade' })
  assert.equal(done.notice, 'Report card unpublished.')
  assert.deepEqual((await versionsOf(c)).map((v) => v.version), [1, 2])
  await saveEntry(c, 'art', 'b')
  const back = await publication(c, { reason: 'Art grade corrected and checked' })
  assert.deepEqual([back.changed, back.notice], [true, 'Report card published.'])
  assert.deepEqual((await versionsOf(c)).map((v) => v.version), [1, 2, 3])
  const [log] = await withTenant(c.id, (tx) => tx.select().from(auditLog).where(and(eq(auditLog.action, 'report_card.republished'), sql`${auditLog.detail}->>'version' = '3'`)))
  assert.deepEqual([(log!.detail as { previousVersion: number }).previousVersion, log!.reason], [2, 'Art grade corrected and checked'])
  assert.equal(await audits(c, 'report_card.unpublished'), 1)
})

test('corrections serialize by expected version', async () => {
  const c = await issued()
  await approveRevision(c)
  const h = holder(c, async () => {})
  await h.ready
  const a = republishAs(c, 1).then(() => null, (e: unknown) => e)
  const b = republishAs(c, 1, c.admin, 'The same correction, sent twice').then(() => null, (e: unknown) => e)
  try {
    await until(async () => (await advisoryWaiters(c.id)) >= 2)
  } finally {
    h.release()
  }
  await h.done
  const results = await Promise.all([a, b])
  assert.equal(results.filter((r) => r === null).length, 1, 'exactly one correction succeeds')
  assert.equal(results.filter((r) => r !== null && code(r) === 'report_card_version_stale' && status(r) === 409).length, 1)
  assert.deepEqual((await versionsOf(c)).map((v) => v.version), [1, 2])
  assert.equal(await audits(c, 'report_card.republished'), 1)
})

test('issue uses the report it validated', async () => {
  const c = await issued()
  await approveRevision(c)
  // Pause the publication after it has read its inputs, on the entry row it must write.
  let release!: () => void
  let locked!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const ready = new Promise<void>((r) => (locked = r))
  const held = withTenant(c.id, async (tx) => {
    await tx.execute(sql`select 1 from exam_report_card_entries where student_id = ${c.pupil.id} and term_id = ${c.termId}::uuid for update`)
    locked()
    await gate
  })
  await ready
  const attempt = republishAs(c, 1).then(() => null, (e: unknown) => e)
  try {
    await until(async () => (await waitingOn('row')) >= 1)
    await api.unpublishExam(c.admin, { examId: c.exams.term, reason: 'Withdrawn while the card is being issued' })
  } finally {
    release()
  }
  await held
  assert.equal(await attempt, null, 'the issue completes with the inputs it validated')
  const [v2] = (await versionsOf(c)).slice(1)
  const subject = (v2!.payload as { report: { subjects: { total: number }[] } }).report.subjects[0]!
  assert.equal(subject.total, 97)
  await assert.rejects(republishAs(c, 2), (e) => code(e) === 'report_card_incomplete', 'the next correction sees the withdrawn exam')
  assert.equal((await versionsOf(c)).length, 2)

  // Withdrawn before the inputs are read: no issue at all.
  const d = await issued()
  await approveRevision(d)
  const h = holder(d, async () => {})
  await h.ready
  const second = republishAs(d, 1).then(() => null, (e: unknown) => e)
  try {
    await until(async () => (await advisoryWaiters(d.id)) >= 1)
    await api.unpublishExam(d.admin, { examId: d.exams.term, reason: 'Withdrawn before the card is issued' })
  } finally {
    h.release()
  }
  await h.done
  assert.equal(code(await second), 'report_card_incomplete')
  assert.equal((await versionsOf(d)).length, 1)
})

test('failed audit preserves current issue', async () => {
  const c = await issued()
  await approveRevision(c)
  const before = await entryOf(c)
  const owner = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL })
  await owner.connect()
  const fn = `rc_fail_audit_${n}_${Date.now()}`
  try {
    await owner.query(`create function ${fn}() returns trigger language plpgsql as $$ begin if new.action = 'report_card.republished' and new.institution_id = '${c.id}' then raise exception 'audit refused'; end if; return new; end $$`)
    await owner.query(`create trigger ${fn} before insert on audit_log for each row execute function ${fn}()`)
    await assert.rejects(republishAs(c, 1), (e) => /audit refused/.test(`${(e as Error).message} ${((e as Error).cause as Error | undefined)?.message ?? ''}`))
  } finally {
    await owner.query(`drop trigger if exists ${fn} on audit_log`)
    await owner.query(`drop function if exists ${fn}()`)
    await owner.end()
  }
  assert.deepEqual((await versionsOf(c)).map((v) => v.version), [1])
  assert.equal((await entryOf(c))!.publishedAt!.getTime(), before!.publishedAt!.getTime())
  assert.equal(await audits(c, 'report_card.republished'), 0)
  assert.equal((await republishAs(c, 1)).changed, true, 'the correction works once the fault is gone')
})

test('an office withdrawal of a stranded legacy entry hides it and keeps the old timestamp', async () => {
  const c = await campus()
  const legacy = new Date('2026-05-05T10:20:30.123Z')
  await withTenant(c.id, (tx) => tx.insert(reportCardEntries).values({ institutionId: c.id, termId: c.termId, sectionId: c.sectionId, studentId: c.pupil.id, publishedAt: legacy }))
  await withTenant(c.id, (tx) => tx.execute(sql`delete from academic_section_members where user_id = ${c.pupil.id} and section_id = ${c.sectionId}::uuid`))
  const withdraw = (who: A) => publication(c, { published: false, reason: 'Withdrawn after the pupil moved' }, who)
  await assert.rejects(withdraw(c.classTeacher), (e) => code(e) === 'no_such_school_pupil')
  await assert.rejects(withdraw(c.otherTeacher), (e) => code(e) === 'no_such_school_pupil')
  const other = await campus()
  await assert.rejects(withdraw(other.admin), (e) => code(e) === 'no_such_school_pupil')
  assert.ok((await entryOf(c))!.publishedAt, 'refusals change nothing')
  assert.equal((await withdraw(c.admin)).changed, true)
  assert.equal((await entryOf(c))!.publishedAt, null)
  const [log] = await withTenant(c.id, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, 'report_card.unpublished')))
  assert.equal((log!.detail as { legacyPublishedAt: string }).legacyPublishedAt, legacy.toISOString())
  assert.equal((await withdraw(c.admin)).changed, false)
  // Hiding is all it may do: publishing for a pupil outside the section creates nothing.
  await assert.rejects(publication(c, {}, c.admin), (e) => code(e) === 'no_such_school_pupil')
  assert.equal((await versionsOf(c)).length, 0)
})

test('a visible legacy card is reissued as version 1, once, with the old timestamp in the audit', async () => {
  const c = await campus()
  await publishMarks(c)
  await saveEntry(c, 'art', 'a')
  const legacy = new Date('2026-05-05T10:20:30.123Z')
  await withTenant(c.id, (tx) => tx.update(reportCardEntries).set({ publishedAt: legacy }).where(eq(reportCardEntries.studentId, c.pupil.id)))
  assert.equal((await publication(c)).changed, false, 'an ordinary publish leaves a legacy row alone')
  assert.equal((await versionsOf(c)).length, 0)
  await assert.rejects(republishAs(c, 1), (e) => code(e) === 'report_card_version_stale')
  await assert.rejects(republishAs(c, 0), (e) => code(e) === 'forbidden' && status(e) === 403, 'the class teacher may not reissue a legacy card (decision 1196)')
  assert.equal((await versionsOf(c)).length, 0)
  assert.equal((await republishAs(c, 0, c.admin, 'Reviewed against the school copy')).notice, 'Report card republished.')
  assert.deepEqual((await versionsOf(c)).map((v) => v.version), [1])
  assert.equal((await entryOf(c))!.publishedAt!.getTime(), (await versionsOf(c))[0]!.issuedAt.getTime(), 'one timestamp for the issue and its visibility')
  const [log] = await withTenant(c.id, (tx) => tx.select().from(auditLog).where(eq(auditLog.action, 'report_card.republished')))
  assert.deepEqual([(log!.detail as { previousVersion: number }).previousVersion, (log!.detail as { legacyPublishedAt: string }).legacyPublishedAt], [0, legacy.toISOString()])
  await assert.rejects(republishAs(c, 0), (e) => code(e) === 'report_card_version_stale')
})

// --- serving the issued card (P1-13b.3) --------------------------------------------

test('an issued observation card keeps its labels', async () => {
  const c = await campus({ programCode: 'CLASS-2' })
  const t = defaultSchoolTemplate(2)!
  await enableAttendance(c)
  for (const day of ['2026-04-01', '2026-04-02']) await mark(c, c.sectionId, c.pupil.id, day, true)
  await mark(c, c.sectionId, c.pupil.id, '2026-04-03', false)
  for (const a of t.areas.filter((x) => x.group === 'scholastic')) await saveEntry(c, a.key, 'proficient')
  await publication(c)
  const text = async () => {
    const res = await download(c, c.pupil)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-disposition')!, /-v1\.pdf"$/)
    return printed(new Uint8Array(await res.arrayBuffer()))
  }
  const original = await text()
  for (const want of [NAME, 'Language and literacy', 'Proficient', 'Issue version 1', 'Daily attendance: 2 present out of 3 recorded days']) assert.ok(original.includes(want), want)

  // Everything the card was built from changes; the issued card does not.
  await authDb.update(users).set({ name: 'Renamed Later' }).where(eq(users.id, c.pupil.id))
  await mark(c, c.sectionId, c.pupil.id, '2026-04-04', true)
  await withTenant(c.id, (tx) => tx.update(reportCardTemplates).set({ template: { ...t, name: 'A different template', areas: [] } }).where(eq(reportCardTemplates.termId, c.termId)))
  await withTenant(c.id, (tx) => tx.execute(sql`delete from academic_section_members where user_id = ${c.pupil.id} and section_id = ${c.sectionId}::uuid`))
  const before = await audits(c)
  assert.equal(await text(), original)
  const issuedReport = (await versionsOf(c))[0]!.payload as { report: Record<string, unknown> }
  const { version, issuedAt, ...served } = await reportOf(c, c.pupil)
  assert.deepEqual(served, issuedReport.report)
  assert.deepEqual([version, issuedAt.length > 20], [1, true])
  assert.equal(await audits(c), before, 'reprinting writes no audit event')

  const quiet = console.error
  console.error = () => {}
  try {
    await assert.rejects(download(c, c.otherPupil, c.pupil.id), (e) => status(e) === 403)
    await assert.rejects(download(c, c.stranger, c.pupil.id), (e) => status(e) === 403)
    const other = await campus()
    await assert.rejects(download(c, other.admin, c.pupil.id), (e) => status(e) === 404)
  } finally {
    console.error = quiet
  }
  assert.equal((await download(c, c.guardian, c.pupil.id)).status, 200)

  // Withdrawal hides it at once; an erased pupil has no card.
  await publication(c, { published: false, reason: 'Withdrawn to correct a rating' }, c.admin)
  await assert.rejects(download(c, c.pupil), (e) => code(e) === 'report_card_unpublished' && status(e) === 409)
  await assert.rejects(publication(c, { reason: 'Reissued after the rating was corrected' }, c.admin), (e) => code(e) === 'no_such_school_pupil', 'the pupil left the section: no new issue')
  await authDb.update(users).set({ erasedAt: new Date() }).where(eq(users.id, c.pupil.id))
  await assert.rejects(reportOf(c, c.admin), (e) => code(e) === 'no_such_school_pupil' && status(e) === 404)
})

test('a published legacy entry with no issue is not rendered from live data', async () => {
  const c = await campus()
  await publishMarks(c)
  await saveEntry(c, 'art', 'a')
  await assert.rejects(reportOf(c, c.admin), (e) => code(e) === 'report_card_unpublished')
  await withTenant(c.id, (tx) => tx.update(reportCardEntries).set({ publishedAt: new Date('2026-05-05T00:00:00Z') }).where(eq(reportCardEntries.studentId, c.pupil.id)))
  for (const who of [c.admin, c.pupil, c.guardian])
    await assert.rejects(reportOf(c, who), (e) => code(e) === 'report_card_legacy_unversioned' && status(e) === 409 && (e as Error).message === 'This report has no stored issue. The school office must review it.', who.role)
  await assert.rejects(download(c, c.pupil), (e) => code(e) === 'report_card_legacy_unversioned')
})

// --- the staff form and the family list (P1-13b.3) ----------------------------------

type FormSection = { kind: string; title?: string; path?: string; submit?: string; fields?: { name: string; value?: string }[] }
const postRoute = routes.find((r) => r.method === 'POST' && r.path === '/report-card/publication')!
/** Submit a rendered form exactly as the portal would: its fields, plus what the person typed. */
const submitForm = (c: C, form: FormSection, typed: Record<string, string>, who: A) => {
  const body = Object.fromEntries((form.fields ?? []).map((f) => [f.name, f.value ?? ''])) as Record<string, string>
  return postRoute.handler(who as never, new Request('http://t.test/report-card/publication', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, ...typed }) }))
}
const staffView = async (c: C, who: A = c.classTeacher) => {
  const p = page('/report-cards')
  const data = await p.load(who as never, req(`termId=${c.termId}&sectionId=${c.sectionId}&studentId=${c.pupil.id}`))
  const sections = p.sections(data) as unknown as FormSection[]
  return { sections, text: JSON.stringify(sections), form: (title: string) => sections.find((s) => s.kind === 'form' && s.title === title) }
}
const familyRows = async (c: C, who: A = c.pupil) => (await page('/my-report-cards').load(who as never, req(''))).rows as { name: string; term: string; section: string; href: string }[]

test('the correction form and family list agree with issued state', async () => {
  const c = await campus({ extraOffering: true })
  const template = defaultSchoolTemplate(6)!
  const subjectOverrides = [{ courseCode: 'CRAFT', components: [{ key: 'paper', label: 'Craft exam', weight: 100, selectors: [{ kind: 'final' }] }] }]
  await publishMarks(c)
  await saveTemplate(c, { template: { ...template, subjectOverrides, excludedOfferingIds: [c.craftAId!] } })
  await saveEntry(c, 'art', 'a')

  // Draft: no correction form, no download, nothing listed.
  let view = await staffView(c)
  assert.ok(!view.form('Republish report card') && !view.text.includes('report-card.pdf'))
  assert.deepEqual(await familyRows(c), [])

  // Visible v1: the correction form, the version and the link.
  await publication(c)
  view = await staffView(c)
  const form = view.form('Republish report card')!
  assert.deepEqual(form.fields!.filter((f) => f.name !== 'reason').map((f) => [f.name, f.value]).filter(([n]) => ['published', 'republish', 'expectedVersion'].includes(n!)), [['published', 'true'], ['republish', 'true'], ['expectedVersion', '1']])
  assert.ok(view.text.includes('issue version 1') && view.text.includes('report-card.pdf'))
  assert.equal((await familyRows(c)).length, 1)

  // Parent and unrelated faculty cannot post the form; the office and class teacher can.
  for (const who of [c.guardian, c.otherTeacher, c.pupil]) await assert.rejects(submitForm(c, form, { reason: 'Marks corrected after re-evaluation' }, who), (e) => code(e) === 'forbidden', who.role)

  // An exam added to the excluded offering makes a correction incomplete; v1 stays visible and listed.
  const exam = await api.createExam(c.teacher, { offeringId: c.craftAId!, name: 'Craft final', kind: 'final', maxMarks: 100, weightPercent: 100 })
  await assert.rejects(submitForm(c, form, { reason: 'Craft examination now assessed' }, c.classTeacher), (e) => code(e) === 'report_card_incomplete')
  assert.equal((await familyRows(c)).length, 1, 'a changed offering never removes the link')
  assert.ok((await staffView(c)).text.includes('issue version 1'))
  await api.enterMarks(c.teacher, { examId: exam.id, marks: [{ studentId: c.pupil.id, obtained: 80 }] })
  await api.publishExam(c.teacher, { examId: exam.id })
  const done = (await submitForm(c, form, { reason: 'Craft examination now assessed' }, c.classTeacher)) as { notice: string }
  assert.equal(done.notice, 'Report card republished.')
  view = await staffView(c)
  assert.ok(view.text.includes('issue version 2') && view.form('Republish report card')!.fields!.some((f) => f.name === 'expectedVersion' && f.value === '2'))
  assert.equal((await familyRows(c)).length, 1, 'one card, at the same link')
  // The old form, still open in another tab, is stale.
  await assert.rejects(submitForm(c, form, { reason: 'Craft examination now assessed' }, c.admin), (e) => code(e) === 'report_card_version_stale')
  // An assessment withdrawn later does not remove the link either.
  await api.unpublishExam(c.admin, { examId: exam.id, reason: 'Withdrawn for a recheck of the paper' })
  assert.equal((await familyRows(c)).length, 1)
  assert.ok((await staffView(c)).text.includes('report-card.pdf'))

  // Withdrawn: no link, no correction form, the ratings are editable again.
  await publication(c, { published: false, reason: 'Withdrawn to correct a rating' })
  view = await staffView(c)
  assert.ok(!view.text.includes('report-card.pdf') && !view.form('Republish report card'))
  assert.deepEqual(await familyRows(c), [])
})

test('a timestamp-only legacy card shows the office-review message and an office-only action', async () => {
  const c = await campus()
  await publishMarks(c)
  await saveEntry(c, 'art', 'a')
  await withTenant(c.id, (tx) => tx.update(reportCardEntries).set({ publishedAt: new Date('2026-05-05T00:00:00Z') }).where(eq(reportCardEntries.studentId, c.pupil.id)))
  const message = 'This report has no stored issue. The school office must review it.'
  const office = await staffView(c, c.admin)
  assert.ok(office.text.includes(message) && !office.text.includes('report-card.pdf'))
  const legacy = office.form('Issue legacy report card')!
  assert.equal(legacy.submit, 'Issue legacy report card')
  const teacher = await staffView(c)
  assert.ok(teacher.text.includes(message) && !teacher.form('Issue legacy report card') && !teacher.text.includes('report-card.pdf'))
  assert.deepEqual(await familyRows(c), [], 'no link is advertised for a card with no issue')
  assert.equal(((await submitForm(c, legacy, { reason: 'Reviewed against the school copy' }, c.admin)) as { notice: string }).notice, 'Report card republished.')
  assert.equal((await familyRows(c)).length, 1)
  assert.ok((await staffView(c, c.admin)).text.includes('issue version 1'))
})
