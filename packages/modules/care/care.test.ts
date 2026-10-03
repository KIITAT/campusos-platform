import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { and, eq, like } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import { notifications } from '@campusos/module-notices/schema'
import {
  CareError,
  GAD7,
  PHQ9,
  accept,
  addCounsellor,
  addInstrument,
  addNote,
  ask,
  book,
  cancelAppointment,
  careHome,
  careSettings,
  caseView,
  closeCase,
  deleteResult,
  handover,
  instrumentSchema,
  maxScore,
  queue,
  recordAppointment,
  resultView,
  retireInstrument,
  saveSettings,
  score,
  setCounsellorActive,
  statistics,
  suppress,
  takeCheck,
  withdraw,
  type Actor,
} from './api'
import { instruments, notes, requests, results, shared } from './schema'

/**
 * Student care: a result is the student's; a request shows the counsellors
 * only what the student chose; a case is its counsellor's; the office reads
 * counts. And the safety question is never missed.
 */

const SLUG = 'care-test-'
let n = 0

async function campus() {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Care College', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const id = i!.id
  const rows = await authDb
    .insert(users)
    .values([
      { email: `office@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Office' },
      { email: `meena@${tag}.test`, institutionId: id, role: 'faculty', name: 'Ms Meena Das' },
      { email: `arjun@${tag}.test`, institutionId: id, role: 'hostel_staff', name: 'Mr Arjun Rao' },
      { email: `teacher@${tag}.test`, institutionId: id, role: 'faculty', name: 'Dr Teacher' },
      { email: `asha@${tag}.test`, institutionId: id, role: 'student', name: 'Asha' },
      { email: `bilal@${tag}.test`, institutionId: id, role: 'student', name: 'Bilal' },
      { email: `mum@${tag}.test`, institutionId: id, role: 'parent', name: 'A Parent' },
    ])
    .returning({ id: users.id })
  const [office, meena, arjun, teacher, asha, bilal, parent] = rows.map((r) => r.id) as string[]
  const as = (uid: string, role: Actor['role']): Actor => ({ id: uid, email: null, role, institutionId: id })
  const c = {
    id,
    office: as(office!, 'institution_admin'),
    meena: as(meena!, 'faculty'),
    arjun: as(arjun!, 'hostel_staff'),
    teacher: as(teacher!, 'faculty'),
    asha: as(asha!, 'student'),
    bilal: as(bilal!, 'student'),
    parent: as(parent!, 'parent'),
  }
  await saveSettings(c.office, { crisisLine: 'Tele-MANAS 14416', contact: 'Student Care Centre, ground floor', timeZone: 'Asia/Kolkata' })
  await addCounsellor(c.office, { userId: c.meena.id, title: 'Counsellor' })
  await addCounsellor(c.office, { userId: c.arjun.id, title: 'Counsellor' })
  return c
}

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

const code = (e: unknown) => (e as CareError).code
const status = (e: unknown) => (e as CareError).status
const db = (constraint: string) => (e: unknown) => {
  for (let x: unknown = e; x; x = (x as { cause?: unknown }).cause) {
    if ((x as { constraint?: string }).constraint === constraint || (x as { code?: string }).code === constraint) return true
  }
  return false
}

/** PHQ-9 answers: nine items scored, the last optional and uncounted. */
const phq = (items: number[], last: number | null = 1) => ({ code: 'PHQ-9', answers: [...items, last] })

// --- scoring ---------------------------------------------------------------------

test('the PHQ-9 and GAD-7 are scored as published', () => {
  assert.equal(maxScore(PHQ9), 27)
  assert.equal(maxScore(GAD7), 21)
  assert.equal(score(PHQ9, [0, 0, 0, 0, 0, 0, 0, 0, 0, null]).band.label, 'Minimal')
  assert.equal(score(PHQ9, [1, 1, 1, 1, 1, 0, 0, 0, 0, null]).band.label, 'Mild')
  const moderate = score(PHQ9, [2, 2, 1, 1, 1, 1, 1, 1, 0, 3])
  assert.deepEqual([moderate.score, moderate.band.label, moderate.safety], [10, 'Moderate', false], 'the last question is not counted')
  assert.equal(score(PHQ9, [3, 3, 3, 3, 3, 3, 3, 3, 3, 3]).band.label, 'Severe')
  assert.equal(score(GAD7, [2, 2, 2, 2, 2, 2, 3, null]).band.label, 'Severe')
})

test('any answer above "not at all" to the ninth question raises the safety flag, whatever the total', () => {
  const s = score(PHQ9, [0, 0, 0, 0, 0, 0, 0, 0, 1, null])
  assert.equal(s.band.label, 'Minimal')
  assert.equal(s.safety, true)
})

test('a check is answered whole', () => {
  assert.throws(() => score(PHQ9, [0, 0, 0]), /answer each/)
  assert.throws(() => score(PHQ9, [0, 0, 0, 0, null, 0, 0, 0, 0, null]), /question 5 is not answered/)
  assert.throws(() => score(PHQ9, [0, 0, 0, 0, 4, 0, 0, 0, 0, null]), /no such answer/)
})

test('an office writes a check in plain lines, and its bands must cover every score', () => {
  const d = instrumentSchema.parse({
    code: 'EXAM-STRESS',
    name: 'Exam stress',
    about: 'Five questions about the fortnight before exams.',
    stem: 'Over the last 2 weeks, how often have you felt the following?',
    source: 'Written by the Student Care Centre for reflection; not a validated screen.',
    options: 'Never=0, Sometimes=1, Often=2, Always=3',
    items: 'I could not stop thinking about exams\nI slept badly before a paper\n!I felt like giving up on everything',
    bands: '0-3: Low: Ordinary nerves.\n4-6: Some: Worth talking about.\n7-9: High: Please talk to a counsellor.',
  })
  assert.equal(d.items.length, 3)
  assert.equal(d.items[2]!.safety, true)
  assert.deepEqual(d.options[2], { label: 'Often', score: 2 })
  assert.throws(() => instrumentSchema.parse({ ...d, options: 'Never=0, Always=3', items: 'One\nTwo', bands: '0-2: Low: fine enough.\n4-6: High: talk to someone.' }), /without gaps/)
  assert.throws(() => instrumentSchema.parse({ ...d, code: 'phq-9' }), /built-in/)
})

// --- counts that name nobody ----------------------------------------------------------

test('small counts are hidden, and so is the one that would give a hidden one away', () => {
  assert.deepEqual(suppress([12, 7, 0]), [12, 7, 0], 'nothing small')
  assert.deepEqual(suppress([12, 7, 3]), [12, null, null], 'one small: the next smallest goes too')
  assert.deepEqual(suppress([12, 2, 3]), [12, null, null], 'two small: each covers the other')
  assert.deepEqual(suppress([0, 0, 4]), [0, 0, null])
  assert.deepEqual(suppress([]), [])
})

// --- what a student's result is -------------------------------------------------------

test('a result is the student’s: not the office’s, a teacher’s, a parent’s or a counsellor’s until shared', async () => {
  const c = await campus()
  const r = await takeCheck(c.asha, phq([2, 2, 2, 1, 1, 1, 1, 1, 0]))
  assert.deepEqual([r.score, r.band, r.safety], [11, 'Moderate', false])
  assert.equal(r.next, `/m/care/result?id=${r.id}`)

  const mine = await resultView(c.asha, r.id)
  assert.equal(mine.mine, true)
  assert.equal(mine.answers.length, 10)
  assert.equal(mine.answers[0]!.answer, 'More than half the days')

  for (const someone of [c.office, c.teacher, c.parent, c.meena, c.bilal]) {
    await assert.rejects(resultView(someone, r.id), (e) => status(e) === 404, `${someone.role} must not see it`)
  }
  await assert.rejects(takeCheck(c.meena, phq([0, 0, 0, 0, 0, 0, 0, 0, 0])), (e) => status(e) === 403)
  await assert.rejects(
    withTenant(c.id, (tx) => tx.update(results).set({ score: 0 }).where(eq(results.id, r.id))),
    db('care_result_fixed'),
  )
})

test('the safety question shows the helpline at once, and a request for today goes to the top', async () => {
  const c = await campus()
  const routine = await takeCheck(c.bilal, phq([1, 1, 1, 1, 1, 1, 1, 1, 0]))
  await ask(c.bilal, { urgency: 'routine', resultIds: [routine.id] })
  const r = await takeCheck(c.asha, phq([1, 1, 0, 0, 0, 0, 0, 0, 2]))
  assert.equal(r.safety, true)
  const v = await resultView(c.asha, r.id)
  assert.equal(v.safety, true)
  assert.equal(v.crisisLine, 'Tele-MANAS 14416')
  assert.equal(v.answers[8]!.flagged, true)

  await ask(c.asha, { urgency: 'today', mode: 'phone', topic: 'mood', resultIds: [r.id] })
  const q = await queue(c.arjun)
  assert.ok(q.counsellor)
  if (!q.counsellor) return
  assert.deepEqual(q.waiting.map((w) => [w.student, w.urgency, w.flagged]), [['Asha', 'today', true], ['Bilal', 'routine', false]])
  assert.equal(q.urgentWaiting, 1)

  // Every counsellor was told, in their inbox; the student's name is not in it.
  const told = await withTenant(c.id, (tx) => tx.select().from(notifications).where(eq(notifications.moduleId, 'care')))
  const forArjun = told.filter((t) => t.userId === c.arjun.id)
  assert.equal(forArjun.length, 2)
  assert.ok(forArjun.every((t) => !t.title.includes('Asha') && !t.body.includes('Asha')))
})

test('one request at a time: asking again adds to it, and it can only grow more urgent', async () => {
  const c = await campus()
  const first = await takeCheck(c.asha, { code: 'GAD-7', answers: [1, 1, 1, 1, 0, 0, 0, null] })
  const req = await ask(c.asha, { topic: 'anxiety', urgency: 'routine', resultIds: [first.id] })
  const later = await takeCheck(c.asha, { code: 'GAD-7', answers: [3, 3, 3, 2, 2, 2, 2, null] })
  assert.equal((await resultView(c.asha, first.id)).openRequest?.hasThis, true, 'the shared one says so')
  assert.equal((await resultView(c.asha, later.id)).openRequest?.hasThis, false)
  const again = await ask(c.asha, { urgency: 'soon', resultIds: [later.id] })
  assert.equal(again.id, req.id)
  const [row] = await withTenant(c.id, (tx) => tx.select().from(requests).where(eq(requests.id, req.id)))
  assert.equal(row!.urgency, 'soon')
  assert.equal((await withTenant(c.id, (tx) => tx.select().from(shared).where(eq(shared.requestId, req.id)))).length, 2)

  await ask(c.asha, { urgency: 'routine' })
  const [still] = await withTenant(c.id, (tx) => tx.select().from(requests).where(eq(requests.id, req.id)))
  assert.equal(still!.urgency, 'soon', 'asking again less urgently does not lower it')

  await assert.rejects(
    withTenant(c.id, (tx) => tx.insert(requests).values({ institutionId: c.id, studentId: c.asha.id })),
    db('care_request_open'),
  )
  await assert.rejects(
    withTenant(c.id, (tx) => tx.update(requests).set({ urgency: 'routine' }).where(eq(requests.id, req.id))),
    db('care_request_fixed'),
  )
  // Another student's result does not go with Asha's request.
  const theirs = await takeCheck(c.bilal, phq([0, 0, 0, 0, 0, 0, 0, 0, 0]))
  await assert.rejects(ask(c.asha, { resultIds: [theirs.id] }), (e) => code(e) === 'care_share_own')
})

test('a case is its counsellor’s: taken once, handed over with the reason in its notes, closed for good', async () => {
  const c = await campus()
  const r = await takeCheck(c.asha, phq([2, 2, 2, 2, 1, 1, 1, 1, 0]))
  const req = await ask(c.asha, { topic: 'studies', urgency: 'soon', mode: 'in_person', message: 'Exams are getting to me', resultIds: [r.id] })

  // While it waits, any counsellor reads it and the result shared with it; nobody else does.
  assert.equal((await caseView(c.arjun, req.id)).request.message, 'Exams are getting to me')
  assert.equal((await resultView(c.arjun, r.id)).student, 'Asha')
  await assert.rejects(caseView(c.teacher, req.id), (e) => code(e) === 'not_a_counsellor')
  await assert.rejects(caseView(c.office, req.id), (e) => code(e) === 'not_a_counsellor')

  await accept(c.meena, { requestId: req.id })
  await assert.rejects(accept(c.arjun, { requestId: req.id }), (e) => status(e) === 404, 'taken: the other counsellor no longer sees it')
  await assert.rejects(resultView(c.arjun, r.id), (e) => status(e) === 404)

  // Times: never two at once for one counsellor; recorded only once begun.
  const soon = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 16)
  const a = await book(c.meena, { requestId: req.id, startsAt: soon, minutes: 45, mode: 'in_person', place: 'Room 4, Student Care Centre' })
  await assert.rejects(
    book(c.meena, { requestId: req.id, startsAt: soon, minutes: 30, mode: 'phone', place: 'A call' }),
    (e) => code(e) === 'care_appointment_clash',
  )
  await assert.rejects(recordAppointment(c.meena, { appointmentId: a.id, status: 'held' }), (e) => code(e) === 'care_appointment_early')
  const home = await careHome(c.asha)
  assert.equal(home.appointments[0]!.place, 'Room 4, Student Care Centre')

  await addNote(c.meena, { requestId: req.id, body: 'First conversation: exam pressure, sleeping badly.' })
  await assert.rejects(addNote(c.arjun, { requestId: req.id, body: 'not mine' }), (e) => status(e) === 404)
  const [note] = await withTenant(c.id, (tx) => tx.select().from(notes).where(eq(notes.requestId, req.id)))
  await assert.rejects(
    withTenant(c.id, (tx) => tx.update(notes).set({ body: 'rewritten' }).where(eq(notes.id, note!.id))),
    db('care_note_kept'),
  )

  // A counsellor with an open case is not made inactive; it is handed over first.
  await assert.rejects(setCounsellorActive(c.office, { userId: c.meena.id, active: false }), (e) => code(e) === 'care_counsellor_cases')
  await handover(c.meena, { requestId: req.id, counsellorId: c.arjun.id, reason: 'Arjun runs the exam-stress group' })
  const v = await caseView(c.arjun, req.id)
  assert.equal(v.request.counsellor, 'Mr Arjun Rao')
  assert.ok(v.notes.some((x) => x.body.startsWith('Handed to Mr Arjun Rao: Arjun runs')))
  assert.equal(v.appointments[0]!.status, 'cancelled', 'the first counsellor’s time is cancelled')
  assert.deepEqual(
    v.timeline.map((t) => t.text).filter((t) => !t.startsWith('Appointment')).sort(),
    ['Asked: in the next few days', 'Handed to Mr Arjun Rao', 'Note', 'Taken by a counsellor'],
    'the case keeps its own history',
  )
  await assert.rejects(caseView(c.meena, req.id), (e) => status(e) === 404)

  await closeCase(c.arjun, { requestId: req.id, outcome: 'supported', note: 'Two sessions; coping well.' })
  await assert.rejects(addNote(c.asha, { requestId: req.id, body: 'a note by the student' }), (e) => code(e) === 'not_a_counsellor')
  await assert.rejects(
    withTenant(c.id, (tx) => tx.update(requests).set({ status: 'accepted' }).where(eq(requests.id, req.id))),
    db('care_request_final'),
  )
  await assert.rejects(
    withTenant(c.id, (tx) => tx.delete(requests).where(eq(requests.id, req.id))),
    db('care_request_kept'),
  )
})

test('the student withdraws, or cancels a time, and the counsellor is told', async () => {
  const c = await campus()
  const req = await ask(c.bilal, { urgency: 'routine' })
  await accept(c.arjun, { requestId: req.id })
  const at = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 16)
  const a = await book(c.arjun, { requestId: req.id, startsAt: at, mode: 'video', place: 'The meeting link sent by email' })
  await assert.rejects(cancelAppointment(c.asha, { appointmentId: a.id, reason: 'not mine' }), (e) => status(e) === 404)
  await cancelAppointment(c.bilal, { appointmentId: a.id, reason: 'I have a lab then' })
  await withdraw(c.bilal, { requestId: req.id, reason: 'Feeling better' })
  const told = await withTenant(c.id, (tx) =>
    tx.select().from(notifications).where(and(eq(notifications.moduleId, 'care'), eq(notifications.userId, c.arjun.id))),
  )
  assert.ok(told.some((t) => t.body.includes('I have a lab then')))
  assert.ok(told.some((t) => t.title.includes('withdrew')))
  assert.equal((await careHome(c.bilal)).requests[0]!.status, 'withdrawn')
})

test('a student deleting a result takes it back from the counsellors', async () => {
  const c = await campus()
  const r = await takeCheck(c.asha, phq([1, 1, 1, 1, 1, 1, 1, 1, 0]))
  await ask(c.asha, { resultIds: [r.id] })
  assert.equal((await resultView(c.meena, r.id)).id, r.id)
  await assert.rejects(deleteResult(c.bilal, { resultId: r.id }), (e) => status(e) === 404)
  await deleteResult(c.asha, { resultId: r.id })
  await assert.rejects(resultView(c.meena, r.id), (e) => status(e) === 404)
  await assert.rejects(resultView(c.asha, r.id), (e) => status(e) === 404)
})

test('the office sees counts and counsellors, never a person', async () => {
  const c = await campus()
  for (const s of [c.asha, c.bilal]) {
    const r = await takeCheck(s, phq([2, 2, 2, 2, 2, 0, 0, 0, 0]))
    await ask(s, { topic: 'studies', resultIds: [r.id] })
  }
  const stats = await statistics(c.office, '30d')
  assert.equal(stats.figures.requests, 2)
  assert.equal(stats.figures.students, 'fewer than 5')
  assert.equal(stats.topics.find((t) => t.topic === 'Studies and exams')!.count, 'fewer than 5')
  const phqRows = stats.checks.filter((r) => r.band === 'Moderate' || r.band === 'All')
  assert.ok(phqRows.every((r) => r.count === 'fewer than 5'))
  assert.ok(!JSON.stringify(stats).includes('Asha'), 'no student is named anywhere in the statistics')
  await assert.rejects(statistics(c.teacher), (e) => status(e) === 403)

  // A session written up after the fact starts before the request was made:
  // no wait, rather than a negative one.
  const [first] = await withTenant(c.id, (tx) => tx.select().from(requests).where(eq(requests.studentId, c.asha.id)))
  await accept(c.meena, { requestId: first!.id })
  await book(c.meena, { requestId: first!.id, startsAt: new Date(Date.now() - 3 * 86_400_000).toISOString(), mode: 'in_person', place: 'Room 4' })
  const later = await statistics(c.office, '30d')
  assert.equal(later.figures.medianToFirst, 'under an hour')
  assert.equal(later.figures.medianToTaken, 'under an hour')
  assert.equal((await statistics(c.meena)).figures.requests, 2, 'counsellors see the counts too')

  const s = await careSettings(c.office)
  assert.deepEqual(s.counsellors.map((x) => x.name).sort(), ['Mr Arjun Rao', 'Ms Meena Das'])
  assert.equal(s.checks.find((x) => x.code === 'PHQ-9')!.taken, 2)
  assert.ok(!JSON.stringify(s).includes('Asha'))
  const q = await queue(c.office)
  assert.equal(q.counsellor, false)
  await assert.rejects(careSettings(c.meena), (e) => status(e) === 403)
  await assert.rejects(addCounsellor(c.office, { userId: c.asha.id, title: 'Peer' }), (e) => code(e) === 'care_counsellor_staff')
})

test('an institution’s own check is offered, fixed once written, and retired rather than deleted', async () => {
  const c = await campus()
  const made = await addInstrument(c.office, {
    code: 'EXAM-STRESS',
    name: 'Exam stress',
    about: 'Three questions about the fortnight before exams.',
    stem: 'Over the last 2 weeks, how often have you felt the following?',
    source: 'Written by the Student Care Centre for reflection; not a validated screen.',
    options: 'Never=0, Sometimes=1, Often=2, Always=3',
    items: 'I could not stop thinking about exams\nI slept badly before a paper\n!I felt like giving up on everything',
    bands: '0-3: Low: Ordinary nerves.\n4-6: Some: Worth talking about.\n7-9: High: Please talk to a counsellor.',
  })
  const r = await takeCheck(c.asha, { code: 'exam-stress', answers: [2, 2, 1] })
  assert.deepEqual([r.score, r.band, r.safety], [5, 'Some', true])
  await assert.rejects(
    withTenant(c.id, (tx) => tx.update(instruments).set({ name: 'Renamed' }).where(eq(instruments.id, made.id))),
    db('care_instrument_fixed'),
  )
  await retireInstrument(c.office, { instrumentId: made.id })
  await assert.rejects(takeCheck(c.asha, { code: 'EXAM-STRESS', answers: [0, 0, 0] }), (e) => status(e) === 404)
  assert.equal((await resultView(c.asha, r.id)).name, 'Exam stress', 'a result outlives its check being retired')
  await assert.rejects(
    withTenant(c.id, (tx) => tx.delete(instruments).where(eq(instruments.id, made.id))),
    db('care_instrument_kept'),
  )
})

test('a counsellor who is not staff, or a parent at all, is refused by the database', async () => {
  const c = await campus()
  const [u] = await authDb.select().from(users).where(eq(users.id, c.parent.id))
  assert.equal(u!.role, 'parent')
  await assert.rejects(addCounsellor(c.office, { userId: c.parent.id, title: 'Helper' }), (e) => code(e) === 'care_counsellor_staff')
  await assert.rejects(careHome(c.parent), (e) => status(e) === 403)
})
