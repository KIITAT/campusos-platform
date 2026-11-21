import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { and, eq, like, sql } from 'drizzle-orm'
import { PDFDocument } from 'pdf-lib'
import { auditLog, authDb, institutions, users, withTenant } from '@campusos/db'
import * as academic from '@campusos/module-academic/api'
import { printedText } from '@campusos/module-framework/pdf'
import * as api from './api'
import { lockReportCard } from './api/report-card-store'
import { defaultSchoolTemplate } from './api/school-policy'
import { reportCardPages } from './report-card-pages'
import { reportCardEntries, reportCardTemplates } from './schema'
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
const SLUG = 'exam-rc-'
let n = 0
const NAME = 'অভিষেক চট্টোপাধ্যায়'
const code = (e: unknown) => (e as api.ExamError).code
const status = (e: unknown) => (e as { status?: number }).status

type A = api.Actor & { viewerOf?: string[] }
const as = (id: string, role: api.Actor['role'], inst: string, over: Record<string, unknown> = {}) => ({ id, email: `${role}@rc.test`, role, institutionId: inst, ...over }) as A

async function campus(opts: { level?: 'school' | 'undergraduate'; programCode?: string } = {}) {
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
  return {
    id,
    tag,
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
  await assert.rejects(saveTemplate(c), (e) => code(e) === 'report_card_template_locked' && status(e) === 409)
  await saveTemplate(c, { termId: c.otherTermId })
  assert.equal(await revisionOf(c), 0)
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

test('PDF a draft refuses, a published one downloads, and a revised mark reprints', async () => {
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
  const first = await printed(new Uint8Array(await res.arrayBuffer()))
  assert.ok(first.includes('87.00') && first.includes(NAME))
  // P1-07c: a revision is a proposal; the card moves only when an administrator approves it.
  const p1 = await api.reviseMark(c.teacher, { examId: c.exams.term, studentId: c.pupil.id, obtained: 80, expectedRevision: 0, reason: 'Re-evaluated answer script' })
  assert.ok((await printed(new Uint8Array(await (await download(c, c.pupil)).arrayBuffer()))).includes('87.00'), 'a proposal changes nothing')
  await api.decideMarkReview(c.admin, { requestId: p1.requestId, decision: 'approve', reason: 'checked against the script' })
  const again = await printed(new Uint8Array(await (await download(c, c.pupil)).arrayBuffer()))
  assert.ok(again.includes('97.00') && again.includes('A1'), 'the reprint shows the revised value')
  const p2 = await api.reviseMark(c.teacher, { examId: c.exams.term, studentId: c.pupil.id, obtained: null, absent: true, expectedRevision: 1, reason: 'Absent at the re-evaluation sitting' })
  await api.decideMarkReview(c.admin, { requestId: p2.requestId, decision: 'approve', reason: 'checked against the script' })
  const absent = await printed(new Uint8Array(await (await download(c, c.pupil)).arrayBuffer()))
  assert.ok(!absent.includes('97.00'), 'an approved absence reprints the card without the old total')
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
  const c = await campus()
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
  const adminView = forms(p.sections(await p.load(c.admin as never, req(q))))
  const teacherView = forms(p.sections(await p.load(c.classTeacher as never, req(q))))
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
