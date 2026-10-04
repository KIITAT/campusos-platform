import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, inArray, like } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import {
  addSectionMember,
  changeClass,
  createCourse,
  createDepartment,
  createOffering,
  createProgram,
  createRoom,
  createSection,
  createTerm,
  getTimetable,
  setCurrentTerm,
  type Actor as Academic,
} from '@campusos/module-academic/api'
import { classChanges, offerings, slots } from '@campusos/module-academic/schema'
import {
  TimetableError,
  addEligibility,
  addPin,
  addUnavailable,
  applyRun,
  checkTerm,
  defaultNeeds,
  discardRun,
  generatePeriods,
  generateRun,
  importEligibility,
  listNeeds,
  listPeriods,
  listRuns,
  liveGrid,
  livePdf,
  myPdf,
  pinEntry,
  runDetail,
  runGrid,
  runPdf,
  setNeed,
  setRoom,
  setSection,
  setTeacher,
  workload,
  yearOfStudy,
  type Actor,
} from './api'
import { runEntries, runs } from './schema'

/**
 * The timetable end to end, against the database: a college set up, its week
 * drafted by the solver, checked against every rule the office gave it,
 * applied to the live slots, printed, and drafted again around a meeting that
 * has history.
 */

const SLUG = 'tt-test-'
let n = 0
const iso = (d: Date) => d.toISOString().slice(0, 10)
const addDays = (d: string, k: number) => iso(new Date(Date.parse(`${d}T00:00:00Z`) + k * 86_400_000))

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

async function college() {
  const tag = `${SLUG}${++n}-${Date.now()}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Timetable College', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const id = i!.id
  const names = ['adm', 'rao', 'sen', 'das', 'iyer', 'kaur', 'asha', 'bilal']
  const roles = ['institution_admin', 'faculty', 'faculty', 'faculty', 'faculty', 'faculty', 'student', 'student'] as const
  const people = await authDb
    .insert(users)
    .values(names.map((nm, k) => ({ email: `${nm}@${tag}.test`, institutionId: id, role: roles[k], name: `Dr ${nm[0]!.toUpperCase()}${nm.slice(1)}` })))
    .returning({ id: users.id, email: users.email })
  const u = Object.fromEntries(people.map((p) => [p.email!.split('@')[0]!, p.id])) as Record<string, string>
  const admin: Actor & Academic = { id: u.adm!, role: 'institution_admin', institutionId: id }
  const faculty = (who: string): Actor => ({ id: u[who]!, role: 'faculty', institutionId: id })

  const cse = await createDepartment(admin, { code: 'CSE', name: 'Computing' })
  const math = await createDepartment(admin, { code: 'MATH', name: 'Mathematics' })
  const bt = await createProgram(admin, { departmentId: cse.id, code: 'BT', name: 'B.Tech', level: 'undergraduate', durationTerms: 8 })
  const today = iso(new Date())
  const term = await createTerm(admin, { code: `T${n}`, name: 'Autumn', startsOn: addDays(today, -30), endsOn: addDays(today, 90) })
  await setCurrentTerm(admin, { termId: term.id })
  const room = async (code: string, capacity: number) => (await createRoom(admin, { code: `${code}-${n}`, capacity })).id
  const R = { r1: await room('R1', 70), r2: await room('R2', 70), r3: await room('R3', 70), lab: await room('LAB', 40), hall: await room('HALL', 150) }
  await setRoom(admin, { roomId: R.lab, kind: 'lab' })
  await setRoom(admin, { roomId: R.hall, kind: 'hall' })
  const course = async (code: string, dept: string, credits: number) =>
    (await createCourse(admin, { departmentId: dept, code: `${code}${n}`, title: code, credits })).id
  const C = {
    ds: await course('DS', cse.id, 4),
    os: await course('OS', cse.id, 3),
    m2: await course('MATH2', math.id, 3),
    lab: await course('DSLAB', cse.id, 2),
    m1: await course('MATH1', math.id, 4),
    intro: await course('INTRO', cse.id, 3),
  }
  const section = async (label: string, year: number) => (await createSection(admin, { programId: bt.id, label, admissionYear: year })).id
  const S = { a: await section('A', 2025), b: await section('B', 2025), a1: await section('A1', 2025), a2: await section('A2', 2025), f: await section('F', 2026) }
  await addSectionMember(admin, { sectionId: S.a, userId: u.asha! })
  await addSectionMember(admin, { sectionId: S.a1, userId: u.asha! })
  await addSectionMember(admin, { sectionId: S.a, userId: u.bilal! })
  await addSectionMember(admin, { sectionId: S.a2, userId: u.bilal! })
  await setSection(admin, { sectionId: S.a, expectedSize: 60 })
  await setSection(admin, { sectionId: S.a1, expectedSize: 30, parentSectionId: S.a })
  await setSection(admin, { sectionId: S.a2, expectedSize: 30, parentSectionId: S.a })
  await setSection(admin, { sectionId: S.b, expectedSize: 60 })
  await setSection(admin, { sectionId: S.f, expectedSize: 120 })
  const offer = async (c: string, s: string) => (await createOffering(admin, { termId: term.id, courseId: c, sectionId: s })).id
  const O = {
    aDs: await offer(C.ds, S.a),
    aOs: await offer(C.os, S.a),
    aM2: await offer(C.m2, S.a),
    a1Lab: await offer(C.lab, S.a1),
    a2Lab: await offer(C.lab, S.a2),
    bDs: await offer(C.ds, S.b),
    bOs: await offer(C.os, S.b),
    bM2: await offer(C.m2, S.b),
    fM1: await offer(C.m1, S.f),
    fIntro: await offer(C.intro, S.f),
  }
  return { id, u, admin, faculty, term, R, C, S, O, cse, math, bt }
}

test('the year of study turns over in the month the institution says', () => {
  assert.equal(yearOfStudy(2025, '2026-08-01', 7), 2)
  assert.equal(yearOfStudy(2025, '2026-01-05', 7), 1)
  assert.equal(yearOfStudy(2025, '2025-08-01', 7), 1)
  assert.equal(yearOfStudy(2024, '2026-03-01', 4), 2)
  assert.equal(yearOfStudy(2030, '2026-03-01', 7), 1)
})

test('a college is set up, drafted, checked against every rule, applied and printed', async () => {
  const k = await college()
  const { admin, u, R, C, S, O, term } = k

  // The week: Monday to Friday, seven periods of fifty minutes, a short break and lunch.
  await generatePeriods(admin, { days: ['1', '2', '3', '4', '5'], startsAt: '09:00', minutes: '50', count: '7', breaks: '2:10, 4:40' })
  const week = await listPeriods(admin, {})
  assert.equal(week.periods.length, 35)
  assert.deepEqual(week.periods.filter((p) => p.dayOfWeek === 1).map((p) => p.startsAt), ['09:00', '09:50', '10:50', '11:40', '13:10', '14:00', '14:50'])

  // Who may teach what: by course and year, by department, by programme and year.
  await addEligibility(admin, { userId: u.rao, courseId: C.ds, yearOfStudy: '2', preference: '5' })
  await addEligibility(admin, { userId: u.sen, departmentId: k.cse.id, preference: '3' })
  await addEligibility(admin, { userId: u.das, departmentId: k.math.id, preference: '4' })
  await addEligibility(admin, { userId: u.iyer, courseId: C.lab, preference: '5' })
  await addEligibility(admin, { userId: u.kaur, programId: k.bt.id, yearOfStudy: '1', preference: '4' })
  await setTeacher(admin, { userId: u.sen, maxPerWeek: '20' })

  // What each class needs: labs in double periods in a lab; the rest from credits.
  await setNeed(admin, { offeringId: O.a1Lab, kind: 'lab', periodsPerWeek: '2', blockLength: '2', roomKind: 'lab' })
  await setNeed(admin, { offeringId: O.a2Lab, kind: 'lab', periodsPerWeek: '2', blockLength: '2', roomKind: 'lab' })
  await setNeed(admin, { offeringId: O.fM1, periodsPerWeek: '4', roomKind: 'hall' })
  await setNeed(admin, { offeringId: O.fIntro, periodsPerWeek: '3', roomKind: 'hall' })
  const filled = await defaultNeeds(admin, { termId: term.id })
  assert.equal(filled.added, 6)
  const needs = await listNeeds(admin, { termId: term.id })
  assert.equal(needs.find((x) => x.offeringId === O.aDs)!.summary, '4 lecture')
  assert.equal(needs.find((x) => x.offeringId === O.a1Lab)!.summary, '1x2 lab')
  assert.equal(needs.find((x) => x.offeringId === O.fM1)!.yearOfStudy, 1)
  assert.equal(needs.find((x) => x.offeringId === O.aDs)!.yearOfStudy, 2)

  // Dr Das never teaches on Mondays; B's Operating Systems is Dr Sen's; one of
  // A's Data Structures lectures is Tuesday first thing in R1.
  await addUnavailable(admin, { userId: u.das, dayOfWeek: '1', reason: 'research day' })
  await addPin(admin, { offeringId: O.bOs, facultyUserId: u.sen })
  await addPin(admin, { offeringId: O.aDs, dayOfWeek: '2', period: '1', roomId: R.r1 })

  const check = await checkTerm(admin, { termId: term.id })
  assert.equal(check.ready, true, JSON.stringify(check.problems))
  assert.equal(check.periodsPerWeek, 35)

  const draft = await generateRun(admin, { termId: term.id, seed: '5', iterations: '3000' })
  assert.equal(draft.unplaced, 0, draft.notice)
  assert.match(draft.next, /^\/m\/timetable\/run\?id=/)

  const detail = await runDetail(admin, { runId: draft.id })
  assert.deepEqual(detail.unplaced, [])
  assert.deepEqual(detail.issues, [])
  const t = detail.run.teachers
  // Teachers by the rules: Dr Rao only second-year Data Structures, Dr Kaur only
  // first years, Dr Iyer the labs, Dr Das the mathematics, Dr Sen B's OS.
  assert.ok([u.rao, u.sen].includes(t[O.aDs]!))
  assert.equal(t[O.bOs], u.sen)
  assert.equal(t[O.a1Lab], u.iyer)
  assert.equal(t[O.a2Lab], u.iyer)
  assert.equal(t[O.aM2], u.das)
  assert.equal(t[O.bM2], u.das)
  assert.ok([u.das, u.kaur].includes(t[O.fM1]!), 'first-year maths: Dr Das (mathematics) or Dr Kaur (first years)')
  assert.ok([u.sen, u.kaur].includes(t[O.fIntro]!), 'first-year intro: Dr Sen (CSE) or Dr Kaur (first years), never Dr Rao')

  const entries = await withTenant(k.id, (tx) => tx.select().from(runEntries).where(eq(runEntries.runId, draft.id)))
  assert.equal(entries.length, 4 + 3 + 3 + 1 + 1 + 4 + 3 + 3 + 4 + 3)
  assert.ok(!entries.some((e) => e.facultyUserId === u.das && e.dayOfWeek === 1), 'Dr Das on a Monday')
  assert.ok(entries.some((e) => e.offeringId === O.aDs && e.dayOfWeek === 2 && e.period === 1 && e.roomId === R.r1 && e.fixed))
  for (const e of entries.filter((x) => x.needKind === 'lab')) {
    assert.equal(e.roomId, R.lab)
    assert.ok([1, 3, 5, 6].includes(e.period), `a double lab starting at period ${e.period} would cross a break`)
  }
  for (const e of entries.filter((x) => x.offeringId === O.fM1 || x.offeringId === O.fIntro)) assert.equal(e.roomId, R.hall)
  // A's lectures never meet A1's or A2's labs; the two labs may share a time.
  const at = (o: string) => entries.filter((e) => e.offeringId === o).flatMap((e) => Array.from({ length: e.length }, (_, j) => `${e.dayOfWeek}:${e.period + j}`))
  const aTimes = new Set([...at(O.aDs), ...at(O.aOs), ...at(O.aM2)])
  for (const x of [...at(O.a1Lab), ...at(O.a2Lab)]) assert.ok(!aTimes.has(x), `A meets during its batch's lab at ${x}`)

  // Read through each lens.
  const asA = await runGrid(admin, { runId: draft.id, sectionId: S.a })
  assert.ok(asA.grid)
  assert.equal(asA.grid!.rows.length, 7)
  assert.equal(asA.grid!.meetings.length, 10)
  assert.match(asA.grid!.rows[0]!.d2!, new RegExp(`DS${k.term.code.slice(1)}`))
  const asRao = await runGrid(admin, { runId: draft.id, teacherId: t[O.aDs]! })
  assert.ok(asRao.grid!.meetings.every((m) => m.facultyUserId === t[O.aDs]))
  assert.equal(asRao.index.sections.length, 5)
  const load = await workload(admin, { runId: draft.id })
  assert.ok(load.rows.every((r) => Number(r.busiestDay) <= Number(r.maxPerDay)))
  assert.equal(load.unstaffed, 0)

  // Printed, before and after.
  const paper = await runPdf(admin, { runId: draft.id, all: 'teachers' })
  assert.equal(new TextDecoder().decode(paper.bytes.slice(0, 5)), '%PDF-')

  // Applied: the live slots and the teachers are the draft's.
  const applied = await applyRun(admin, { runId: draft.id })
  assert.equal(applied.added, entries.length)
  const live = await getTimetable(admin)
  assert.equal(live.entries.length, entries.length)
  const offered = await withTenant(k.id, (tx) => tx.select().from(offerings).where(inArray(offerings.id, Object.values(O))))
  for (const o of offered) assert.equal(o.facultyUserId, t[o.id] ?? null)
  const iyerWeek = await liveGrid(k.faculty('iyer'), { sectionId: S.b }) // a teacher sees their own, whatever they ask
  assert.ok(iyerWeek.grid!.meetings.length === 2 && iyerWeek.grid!.meetings.every((m) => m.facultyUserId === u.iyer))
  const mine = await myPdf(k.faculty('iyer'))
  assert.equal(new TextDecoder().decode(mine.bytes.slice(0, 5)), '%PDF-')
  const everyone = await livePdf(admin, { all: 'sections' })
  assert.equal(new TextDecoder().decode(everyone.bytes.slice(0, 5)), '%PDF-')
  await assert.rejects(() => applyRun(admin, { runId: draft.id }), (e: unknown) => e instanceof TimetableError && e.code === 'not_a_draft')

  // A meeting gets history: a class change on it. The next draft keeps it,
  // locked, and applying that draft leaves it -- and its change -- in place.
  const [slot] = await withTenant(k.id, (tx) => tx.select().from(slots).where(eq(slots.offeringId, O.bDs)).limit(1))
  let on = addDays(iso(new Date()), 1)
  while (new Date(`${on}T00:00:00Z`).getUTCDay() !== slot!.dayOfWeek % 7) on = addDays(on, 1)
  await changeClass(admin, { slotId: slot!.id, onDate: on, kind: 'cancelled', reason: 'the teacher is at a conference' })
  const second = await generateRun(admin, { termId: term.id, seed: '9', iterations: '2000', keepTeachers: 'true' })
  assert.equal(second.unplaced, 0)
  const kept = await withTenant(k.id, (tx) => tx.select().from(runEntries).where(eq(runEntries.runId, second.id)))
  assert.ok(kept.some((e) => e.locked && e.offeringId === O.bDs && e.dayOfWeek === slot!.dayOfWeek && e.startsAt.startsWith(slot!.startsAt.slice(0, 5))))
  await applyRun(admin, { runId: second.id })
  const still = await withTenant(k.id, (tx) => tx.select().from(slots).where(eq(slots.id, slot!.id)))
  assert.equal(still.length, 1, 'a meeting with history is never removed')
  const change = await withTenant(k.id, (tx) => tx.select().from(classChanges).where(eq(classChanges.slotId, slot!.id)))
  assert.equal(change.length, 1)
  const history = await listRuns(admin, { termId: term.id })
  assert.deepEqual(history.map((r) => r.status), ['applied', 'superseded'])

  // A draft's meeting kept for the next run, and a draft thrown away.
  const third = await generateRun(admin, { termId: term.id, seed: '3', iterations: '500' })
  const [one] = await withTenant(k.id, (tx) => tx.select().from(runEntries).where(eq(runEntries.runId, third.id)).limit(1))
  await pinEntry(admin, { entryId: one!.id, keep: 'both' })
  await discardRun(admin, { runId: third.id })
  const [gone] = await withTenant(k.id, (tx) => tx.select().from(runs).where(eq(runs.id, third.id)))
  assert.equal(gone!.status, 'discarded')
})

test('only the office drafts and applies; a teacher marks only their own time', async () => {
  const k = await college()
  const rao = k.faculty('rao')
  await assert.rejects(() => generatePeriods(rao, { days: ['1'], startsAt: '09:00', minutes: '50', count: '6' }), (e: unknown) => e instanceof TimetableError && e.status === 403)
  await assert.rejects(() => generateRun(rao, { termId: k.term.id }), (e: unknown) => e instanceof TimetableError && e.status === 403)
  const own = await addUnavailable(rao, { dayOfWeek: '5', period: '7', reason: 'choir' })
  assert.equal(own.userId, k.u.rao)
  await assert.rejects(() => addUnavailable(rao, { roomId: k.R.r1, dayOfWeek: '5' }), (e: unknown) => e instanceof TimetableError && e.status === 403)
  await assert.rejects(() => addUnavailable(rao, { userId: k.u.sen, dayOfWeek: '5' }), (e: unknown) => e instanceof TimetableError && e.status === 403)
  // A term with no week laid out is not ready, and the solver says so.
  const check = await checkTerm(k.admin, { termId: k.term.id })
  assert.equal(check.ready, false)
  await assert.rejects(() => generateRun(k.admin, { termId: k.term.id }), (e: unknown) => e instanceof TimetableError && e.code === 'no_periods')
})

test('eligibility comes in from a spreadsheet, all of it or none', async () => {
  const k = await college()
  const csv = (s: string) => ({ file: { name: 'who.csv', type: 'text/csv', size: s.length, base64: Buffer.from(s).toString('base64') } })
  const tag = k.term.code.slice(1)
  const bad = `email,course,department,programme,year,preference\nrao@${k.id}.x,DS${tag},,,2,5\n`
  await assert.rejects(() => importEligibility(k.admin, csv(bad)), (e: unknown) => e instanceof TimetableError && e.code === 'bad_rows')
  const [rao] = await authDb.select({ email: users.email }).from(users).where(eq(users.id, k.u.rao!))
  const [sen] = await authDb.select({ email: users.email }).from(users).where(eq(users.id, k.u.sen!))
  const good = `email,course,department,programme,year,preference\n${rao!.email},DS${tag},,,2,5\n${sen!.email},,CSE,,,3\n${sen!.email},,,BT,1,4\n`
  const out = await importEligibility(k.admin, csv(good))
  assert.equal(out.imported, 3)
  // Importing the same file again changes nothing but the preferences.
  const again = await importEligibility(k.admin, csv(good.replace(',5\n', ',4\n')))
  assert.equal(again.imported, 3)
})
