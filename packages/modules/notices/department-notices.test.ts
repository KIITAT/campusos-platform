import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { and, eq, gte, inArray, sql } from 'drizzle-orm'
import { auditLog, authDb, claimJob, institutions, jobActor, runClaimedJob, users, withTenant } from '@campusos/db'
import * as academic from '@campusos/module-academic/api'
import {
  NoticeError,
  addAttachment,
  attachmentFile,
  createNotice,
  departmentChoices,
  inbox,
  markRead,
  noticeView,
  publishNotice,
  readNotice,
  registerNotificationChannel,
  removeAttachment,
  setMandatory,
  setPreference,
  withdrawNotice,
  type Actor,
} from './api'
import { pages } from './pages'
import { plugin } from './plugin'
import { noticeAttachments, notices, notificationMandatory, notificationOptOuts, notifications } from './schema'

/**
 * Department notices (FUNC-06) and the audit of what publishers write
 * (AUD-06). A fresh fixture of two departments, one term around today in
 * Kolkata, and people placed by declaration, section, class teacher, head and
 * offering. Deliberately not shared with notices.test.ts.
 */

const SLUG = 'notice-dept-1'
const FOREIGN = 'notice-dept-2'
let inst: string
let foreign: string
let deptA = ''
let deptB = ''
let foreignDept = ''
let progA = ''
let progB = ''
let secA = ''
let secB = ''
const p: Record<string, string> = {}

const istDay = async (offset: number) =>
  (await authDb.execute<{ d: string }>(sql`select (((now() at time zone 'Asia/Kolkata')::date) + ${offset}::int)::text as d`)).rows[0]!.d
const watermark = async () =>
  new Date(Math.floor(Number((await authDb.execute<{ ms: string }>(sql`select extract(epoch from clock_timestamp()) * 1000 as ms`)).rows[0]!.ms)))

const act = (key: string, role: Actor['role'], email?: string, institutionId = inst): Actor => ({ id: p[key]!, role, email: email ?? null, institutionId })
const adm = () => act('adm', 'institution_admin', 'adm@dept.test')
const hodA = () => act('hodA', 'hod', 'hoda@dept.test')
const ctA = () => act('ctA', 'faculty', 'cta@dept.test')
const facB = () => act('facB', 'faculty', 'facb@dept.test')
const stu = (key: string) => act(key, 'student')
const code = (e: unknown) => (e as NoticeError).code
const status = (e: unknown) => (e as NoticeError).status
const notFound = (c: string) => (e: unknown) => status(e) === 404 && code(e) === c

const pdf = (name = 'circular.pdf') => ({
  name,
  type: 'application/pdf',
  size: 0,
  base64: Buffer.from(`%PDF-1.4\n% ${name}\n%%EOF\n`).toString('base64'),
})

const recipients = async (noticeId: string) =>
  (await withTenant(inst, (tx) => tx.select({ u: notifications.userId }).from(notifications).where(eq(notifications.noticeId, noticeId)))).map((r) => r.u).sort()
const ids = (...keys: string[]) => keys.map((k) => p[k]!).sort()
const allStudents = async () =>
  (await authDb.select({ id: users.id }).from(users).where(and(eq(users.institutionId, inst), eq(users.role, 'student')))).map((r) => r.id).sort()
const board1 = async (actor: Actor) =>
  (await plugin.routes.find((r) => r.method === 'GET' && r.path === '/board')!.handler(actor as never, new Request('http://x/board'))) as { rows: { id: string }[]; total: number }
const trail = (since: Date, instId = inst) =>
  withTenant(instId, (tx) => tx.select().from(auditLog).where(and(eq(auditLog.moduleId, 'notices'), gte(auditLog.at, since))).orderBy(auditLog.at))

const send = (who: Actor, over: Record<string, unknown> = {}) =>
  createNotice(who, { title: 'Department notice', body: 'For the department.', ...over })

const moveOut = async (studentId: string, from = progA, to = progB) => {
  const mine = await academic.listStudentPrograms(adm(), { studentId })
  const live = mine.find((m) => m.programId === from && m.status === 'active')
  if (live) await academic.endStudentProgram(adm(), { studentProgramId: live.id, status: 'transferred_out', endedOn: await istDay(0) })
  await academic.declareProgram(adm(), { studentId, programId: to, declaredOn: await istDay(0) })
}

before(async () => {
  const rows = await authDb
    .insert(institutions)
    .values([
      { slug: SLUG, name: 'Dept Notice College', allowedEmailDomains: ['dept.test'] },
      { slug: FOREIGN, name: 'Foreign College', allowedEmailDomains: ['deptforeign.test'] },
    ])
    .returning({ id: institutions.id })
  inst = rows[0]!.id
  foreign = rows[1]!.id

  const keys: [string, string, Actor['role']][] = [
    ['adm', 'adm', 'institution_admin'], ['hodA', 'hoda', 'hod'], ['ctA', 'cta', 'faculty'], ['facA', 'faca', 'faculty'],
    ['facB', 'facb', 'faculty'], ['s1', 's1', 'student'], ['s2', 's2', 'student'], ['s3', 's3', 'student'], ['s4', 's4', 'student'],
    ['pend', 'pend', 'pending'], ['parV', 'parv', 'parent'], ['parU', 'paru', 'parent'],
  ]
  const made = await authDb
    .insert(users)
    .values(keys.map(([, mail, role]) => ({ email: `${mail}@dept.test`, institutionId: inst, role, name: mail })))
    .returning({ id: users.id })
  keys.forEach(([k], i) => (p[k] = made[i]!.id))
  const [fa] = await authDb.insert(users).values({ email: 'fadm@deptforeign.test', institutionId: foreign, role: 'institution_admin' }).returning({ id: users.id })
  p.fadm = fa!.id

  const a = adm()
  deptA = (await academic.createDepartment(a, { code: 'dna', name: 'Dept A' })).id
  deptB = (await academic.createDepartment(a, { code: 'dnb', name: 'Dept B' })).id
  progA = (await academic.createProgram(a, { departmentId: deptA, code: 'pa', name: 'Programme A', level: 'undergraduate', durationTerms: 6 })).id
  progB = (await academic.createProgram(a, { departmentId: deptB, code: 'pb', name: 'Programme B', level: 'undergraduate', durationTerms: 6 })).id
  const term = await academic.createTerm(a, { code: 'dterm', name: 'Dept term', startsOn: await istDay(-1), endsOn: await istDay(1) })
  const courseA = await academic.createCourse(a, { departmentId: deptA, code: 'ca1', title: 'A course', credits: 3 })
  const courseB = await academic.createCourse(a, { departmentId: deptB, code: 'cb1', title: 'B course', credits: 3 })
  secA = (await academic.createSection(a, { programId: progA, label: 'a', admissionYear: 2026 })).id
  secB = (await academic.createSection(a, { programId: progB, label: 'b', admissionYear: 2026 })).id
  await academic.createOffering(a, { termId: term.id, courseId: courseA.id, sectionId: secA, facultyUserId: p.facA })
  await academic.createOffering(a, { termId: term.id, courseId: courseB.id, sectionId: secB, facultyUserId: p.facB })
  await academic.setClassTeacher(a, { sectionId: secA, email: 'cta@dept.test' })
  await academic.setDepartmentHead(a, { departmentId: deptA, email: 'hoda@dept.test' })

  // S1: active A declaration and a B elective membership. S2: B section only.
  // S3: an ended A declaration and an old A membership. S4: an A declaration that starts later.
  await academic.declareProgram(a, { studentId: p.s1!, programId: progA, declaredOn: await istDay(-10) })
  await academic.addSectionMember(a, { sectionId: secB, userId: p.s1! })
  await academic.addSectionMember(a, { sectionId: secB, userId: p.s2! })
  const old = await academic.declareProgram(a, { studentId: p.s3!, programId: progA, declaredOn: await istDay(-30) })
  await academic.endStudentProgram(a, { studentProgramId: old.id, status: 'withdrawn', endedOn: await istDay(-5) })
  await academic.addSectionMember(a, { sectionId: secA, userId: p.s3! })
  await academic.declareProgram(a, { studentId: p.s4!, programId: progA, declaredOn: await istDay(3) })

  await authDb.execute(sql`insert into parent_links (institution_id, parent_id, student_id, relation, verified_at) values (${inst}, ${p.parV}, ${p.s1}, 'mother', now())`)
  await authDb.execute(sql`insert into parent_links (institution_id, parent_id, student_id, relation, verified_at) values (${inst}, ${p.parU}, ${p.s1}, 'father', null)`)

  const fadmin: academic.Actor = { id: p.fadm!, role: 'institution_admin', institutionId: foreign }
  foreignDept = (await academic.createDepartment(fadmin, { code: 'dnf', name: 'Foreign dept' })).id
})

beforeEach(async () => {
  await withTenant(inst, async (tx) => {
    await tx.execute(sql`select set_config('app.audit_reason', 'test reset', true)`)
    await tx.delete(notifications)
    await tx.delete(notices)
    await tx.delete(notificationOptOuts)
    await tx.delete(notificationMandatory)
  })
})

after(async () => {
  await authDb.delete(institutions).where(eq(institutions.slug, SLUG))
  await authDb.delete(institutions).where(eq(institutions.slug, FOREIGN))
})

test('published notice goes to its department and selected roles', async () => {
  const n = await send(adm(), { departmentId: deptA, audienceRoles: ['student', 'faculty', 'parent'] })
  assert.deepEqual(await recipients(n.id), ids('s1', 'ctA', 'facA', 'parV'))

  // Nobody pending, unverified, ended, future or in the other department gets it.
  for (const k of ['pend', 'parU', 's2', 's3', 's4', 'facB', 'hodA', 'adm']) assert.ok(!(await recipients(n.id)).includes(p[k]!), k)

  // An empty role audience adds the head, and still no staff elsewhere.
  const all = await send(adm(), { departmentId: deptA, title: 'Everybody in A' })
  assert.deepEqual(await recipients(all.id), ids('s1', 'ctA', 'facA', 'parV', 'hodA'))

  // No department: the baseline student audience.
  const wide = await send(adm(), { title: 'Whole college', audienceRoles: ['student'] })
  assert.deepEqual(await recipients(wide.id), await allStudents())

  // A mute is honoured, and a mandatory category does not carry a notice out of its department.
  await setPreference(stu('s1'), { moduleId: 'notices', muted: true })
  const muted = await send(adm(), { departmentId: deptA, audienceRoles: ['student', 'faculty'], title: 'Muted' })
  assert.deepEqual(await recipients(muted.id), ids('ctA', 'facA'))
  await setMandatory(adm(), { moduleId: 'notices', mandatory: true, reason: 'circulars must reach everybody' })
  const forced = await send(adm(), { departmentId: deptA, audienceRoles: ['student', 'faculty'], title: 'Mandatory' })
  assert.deepEqual(await recipients(forced.id), ids('s1', 'ctA', 'facA'))
  assert.ok(!(await recipients(forced.id)).includes(p.facB!))
  assert.ok(!(await recipients(forced.id)).includes(p.s2!))
})

test('board, direct notice, files and old inbox copies obey the same scope', async () => {
  const draft = await send(ctA(), { departmentId: deptA, audienceRoles: ['student'], publish: false, attachment: pdf() })
  const [doc] = (await noticeView(ctA(), draft.id)).documents

  // A draft is for its author and the administrators.
  assert.equal((await readNotice(adm(), draft.id)).id, draft.id)
  await assert.rejects(readNotice(hodA(), draft.id), notFound('no_such_notice'))
  await assert.rejects(readNotice(stu('s1'), draft.id), notFound('no_such_notice'))
  assert.equal((await board1(stu('s1'))).total, 0)

  await publishNotice(ctA(), { noticeId: draft.id })
  assert.equal((await board1(stu('s1'))).total, 1)
  assert.equal((await noticeView(stu('s1'), draft.id)).notice.id, draft.id)
  assert.equal((await attachmentFile(stu('s1'), doc!.id)).id, doc!.id)
  for (const outsider of [stu('s2'), facB()]) {
    assert.equal((await board1(outsider)).total, 0, outsider.role + ' ' + JSON.stringify(await board1(outsider)))
    await assert.rejects(noticeView(outsider, draft.id), notFound('no_such_notice'))
    await assert.rejects(attachmentFile(outsider, doc!.id), notFound('no_such_document'))
  }

  // A copy delivered by mistake before the upgrade stays in storage and out of sight.
  await withTenant(inst, (tx) =>
    tx.insert(notifications).values({ institutionId: inst, userId: p.s2!, moduleId: 'notices', title: 'Legacy', body: 'b', link: `/m/notices/notice?id=${draft.id}`, noticeId: draft.id }),
  )
  const legacy = await inbox(stu('s2'))
  assert.equal(legacy.unread, 0)
  assert.equal(legacy.items.length, 0)
  const [stored] = await withTenant(inst, (tx) => tx.select().from(notifications).where(eq(notifications.userId, p.s2!)))
  assert.deepEqual(await markRead(stu('s2'), { notificationId: stored!.id }), { marked: 0 })
  assert.equal((await withTenant(inst, (tx) => tx.select().from(notifications).where(eq(notifications.id, stored!.id))))[0]!.readAt, null)

  // A student who leaves the department stops seeing its copy.
  const [m] = await authDb.insert(users).values({ email: 'mover@dept.test', institutionId: inst, role: 'student' }).returning({ id: users.id })
  try {
    await academic.declareProgram(adm(), { studentId: m!.id, programId: progA, declaredOn: await istDay(-2) })
    const more = await send(adm(), { departmentId: deptA, audienceRoles: ['student'], title: 'For A students' })
    const mover = act('mover', 'student')
    mover.id = m!.id
    assert.equal((await inbox(mover)).items.filter((i) => i.noticeId === more.id).length, 1)
    await moveOut(m!.id)
    assert.equal((await inbox(mover)).items.filter((i) => i.noticeId === more.id).length, 0)
    assert.equal((await inbox(mover)).unread, 0)
    await assert.rejects(noticeView(mover, more.id), notFound('no_such_notice'))
    assert.equal((await board1(mover)).total, 0)
  } finally {
    await authDb.delete(users).where(eq(users.id, m!.id))
  }
})

test('department and faculty publication checks never widen the audience', async () => {
  const mark = await watermark()
  const before = (await withTenant(inst, (tx) => tx.select().from(notices))).length
  await assert.rejects(send(adm(), { departmentId: foreignDept }), notFound('no_such_department'))
  await assert.rejects(
    createNotice({ id: p.fadm!, role: 'institution_admin', institutionId: foreign }, { title: 'x', body: 'y', departmentId: deptA }),
    notFound('no_such_department'),
  )
  assert.equal((await withTenant(inst, (tx) => tx.select().from(notices))).length, before)
  assert.deepEqual(await trail(mark), [])
  assert.equal((await withTenant(inst, (tx) => tx.select().from(notifications))).length, 0)

  // Another poster cannot touch an A draft they do not own.
  const draft = await send(ctA(), { departmentId: deptA, audienceRoles: ['student'], publish: false })
  const file = await addAttachment(ctA(), { noticeId: draft.id, file: pdf('mine.pdf') })
  await assert.rejects(publishNotice(hodA(), { noticeId: draft.id }), notFound('no_such_notice'))
  await assert.rejects(publishNotice(hodA(), { noticeId: draft.id, queued: true }), notFound('no_such_notice'))
  await assert.rejects(addAttachment(hodA(), { noticeId: draft.id, file: pdf('theirs.pdf') }), notFound('no_such_notice'))
  await assert.rejects(withdrawNotice(hodA(), { noticeId: draft.id, reason: 'not mine to withdraw' }), notFound('no_such_notice'))
  await assert.rejects(removeAttachment(hodA(), { attachmentId: file.id }), notFound('no_such_document'))
  assert.equal((await withTenant(inst, (tx) => tx.select().from(noticeAttachments).where(eq(noticeAttachments.id, file.id)))).length, 1)

  // A lecturer who names no audience reaches students only, now and on a legacy draft.
  const open = await send(ctA(), { title: 'No audience named' })
  assert.deepEqual(open.audienceRoles, ['student'])
  assert.deepEqual(await recipients(open.id), await allStudents())
  const [legacy] = await withTenant(inst, (tx) =>
    tx.insert(notices).values({ institutionId: inst, title: 'Legacy draft', body: 'b', authorId: p.ctA!, audienceRoles: [] }).returning({ id: notices.id }),
  )
  await publishNotice(ctA(), { noticeId: legacy!.id })
  assert.deepEqual(await recipients(legacy!.id), await allStudents())
})

test('create, attach and publish commit exactly one sanitized event each', async () => {
  const mark = await watermark()
  const n = await send(adm(), { departmentId: deptA, audienceRoles: ['student', 'faculty'], attachment: pdf(), title: 'Audited', body: 'private body text' })
  const events = await trail(mark)
  assert.deepEqual(events.map((e) => e.action), ['notice.created', 'notice.attachment_added', 'publish'])
  const [created, attached, published] = events
  assert.equal(created!.entityId, n.id)
  assert.deepEqual(created!.detail, { departmentId: deptA, kind: 'announcement', audienceRoles: ['student', 'faculty'], pinned: false })
  assert.equal(created!.actorEmail, 'adm@dept.test')
  assert.equal(attached!.entity, 'notice_attachments')
  const [doc] = (await noticeView(adm(), n.id)).documents
  assert.equal(attached!.entityId, doc!.id)
  assert.deepEqual(attached!.detail, { noticeId: n.id, type: 'application/pdf', size: doc!.size })
  const copies = await recipients(n.id)
  assert.deepEqual(published!.detail, { reach: copies.length, departmentId: deptA, audienceRoles: ['student', 'faculty'] })
  assert.equal(published!.actorEmail, 'adm@dept.test')
  assert.equal(new Set(copies).size, copies.length)
  assert.ok(!JSON.stringify(events).includes('private body text'))

  // A draft's document comes and goes with one event each.
  const mark2 = await watermark()
  const draft = await send(adm(), { publish: false, title: 'Draft with a file' })
  const added = await addAttachment(adm(), { noticeId: draft.id, file: pdf('draft.pdf') })
  await removeAttachment(adm(), { attachmentId: added.id })
  assert.deepEqual((await trail(mark2)).map((e) => e.action), ['notice.created', 'notice.attachment_added', 'notice.attachment_removed'])

  // A failing channel rolls the whole request back.
  const mark3 = await watermark()
  const off = registerNotificationChannel({
    id: 'department-test-rollback',
    async deliver() {
      throw new Error('test dispatch rollback')
    },
  })
  try {
    await assert.rejects(send(adm(), { departmentId: deptA, title: 'Rolled back', attachment: pdf('rolled.pdf') }), /test dispatch rollback/)
  } finally {
    off()
  }
  assert.deepEqual(await withTenant(inst, (tx) => tx.select().from(notices).where(eq(notices.title, 'Rolled back'))), [])
  assert.deepEqual(await withTenant(inst, (tx) => tx.select().from(noticeAttachments).where(eq(noticeAttachments.name, 'rolled.pdf'))), [])
  assert.deepEqual(await trail(mark3), [])
})

test('queued publication uses live membership and one publication audit', async () => {
  const [moving, joining] = await authDb
    .insert(users)
    .values([{ email: 'q-moving@dept.test', institutionId: inst, role: 'student' }, { email: 'q-joining@dept.test', institutionId: inst, role: 'student' }])
    .returning({ id: users.id })
  try {
    await academic.declareProgram(adm(), { studentId: moving!.id, programId: progA, declaredOn: await istDay(-2) })
    const draft = await send(adm(), { departmentId: deptA, audienceRoles: ['student'], publish: false, title: 'Queued for A' })
    const queued = await publishNotice(adm(), { noticeId: draft.id, queued: true })
    assert.equal((queued as { queued?: boolean }).queued, true)
    await moveOut(moving!.id)
    await academic.declareProgram(adm(), { studentId: joining!.id, programId: progA, declaredOn: await istDay(-1) })

    const mark = await watermark()
    const job = await claimJob(inst, 'notices-worker')
    assert.ok(job)
    const handler = plugin.jobs!.find((j) => j.kind === job.kind)!
    const run = (fail: boolean) =>
      runClaimedJob(inst, job.id, job.leaseToken!, async (tx, claimed) => {
        const current = await jobActor(tx, inst, claimed.actorId, 'notices', handler.roles, true)
        const result = await handler.run(current, tx, claimed.payload)
        if (fail) throw new Error('crash after the handler returned')
        return result
      })
    await assert.rejects(run(true), /crash after/)
    assert.deepEqual(await recipients(draft.id), [])
    assert.equal((await trail(mark)).filter((e) => e.action === 'publish').length, 0)
    await run(false)
    const eligible = await recipients(draft.id)
    assert.ok(eligible.includes(joining!.id))
    assert.ok(!eligible.includes(moving!.id))
    assert.ok(eligible.includes(p.s1!))
    const events = (await trail(mark)).filter((e) => e.action === 'publish')
    assert.equal(events.length, 1)
    assert.equal((events[0]!.detail as { reach: number }).reach, eligible.length)
    await assert.rejects(run(false), /lease/)
    assert.equal((await trail(mark)).filter((e) => e.action === 'publish').length, 1)
  } finally {
    await authDb.delete(users).where(inArray(users.id, [moving!.id, joining!.id]))
  }
})

test('without the guardians function no parent is inferred and students remain', async () => {
  const { departmentRecipientsSql, guardiansAvailable } = await import('./api/department-audience')
  const fn = (withGuardians: boolean) =>
    withTenant(inst, async (tx) => {
      const rows = (await tx.execute(sql`${departmentRecipientsSql(inst, sql`${deptA}::uuid`, withGuardians)}`)).rows as { user_id: string }[]
      return rows.map((r) => r.user_id).sort()
    })
  assert.ok(await withTenant(inst, (tx) => guardiansAvailable(tx)))
  assert.ok((await fn(true)).includes(p.parV!))
  assert.ok(!(await fn(false)).includes(p.parV!))
  assert.ok((await fn(false)).includes(p.s1!))

  // The same, with the function really absent: renamed inside a transaction that is rolled back.
  const sentinel = new Error('roll back')
  await assert.rejects(
    authDb.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.institution_id', ${inst}, true)`)
      await tx.execute(sql`alter function public.campusos_guardians_of(text[]) rename to campusos_guardians_of_absent`)
      const withGuardians = await guardiansAvailable(tx as never)
      assert.equal(withGuardians, false)
      const rows = (await tx.execute(sql`${departmentRecipientsSql(inst, sql`${deptA}::uuid`, withGuardians)}`)).rows as { user_id: string }[]
      const got = rows.map((r) => r.user_id)
      assert.ok(got.includes(p.s1!))
      assert.ok(!got.includes(p.parV!))
      throw sentinel
    }),
    (e: unknown) => e === sentinel,
  )
  assert.ok(await withTenant(inst, (tx) => guardiansAvailable(tx)), 'the function is back after the rollback')
})

test('memberDepartments, asked from the person, matches the delivery audience for every role', async () => {
  const { departmentRecipientsSql, guardiansAvailable, memberDepartments } = await import('./api/department-audience')
  // No scoped notice: nothing to answer.
  assert.deepEqual(await withTenant(inst, (tx) => memberDepartments(tx, inst, p.s1!)), [])
  await send(adm(), { departmentId: deptA })
  await send(adm(), { departmentId: deptB })
  await withTenant(inst, async (tx) => {
    const withGuardians = await guardiansAvailable(tx)
    const audience = async (dept: string) =>
      new Set(((await tx.execute(sql`${departmentRecipientsSql(inst, sql`${dept}::uuid`, withGuardians)}`)).rows as { user_id: string }[]).map((r) => r.user_id))
    const [a, b] = [await audience(deptA), await audience(deptB)]
    for (const [key, id] of Object.entries(p)) {
      if (key === 'fadm') continue
      const want = [deptA, deptB].filter((_, i) => (i === 0 ? a : b).has(id)).sort()
      assert.deepEqual((await memberDepartments(tx, inst, id)).sort(), want, key)
    }
    // The fixture exercises the rules: a declared student, a section-only student, a parent, a head, a teacher.
    assert.deepEqual(await memberDepartments(tx, inst, p.s1!), [deptA])
    assert.deepEqual(await memberDepartments(tx, inst, p.s2!), [deptB])
    assert.deepEqual(await memberDepartments(tx, inst, p.parV!), [deptA])
    assert.deepEqual(await memberDepartments(tx, inst, p.hodA!), [deptA])
    assert.deepEqual(await memberDepartments(tx, inst, p.facB!), [deptB])
  })
})

test('the board composer offers departments and routes a blank one to the whole institution', async () => {
  const page = pages.find((x) => x.path === '/')!
  const data = (await page.load(adm() as never, new Request('http://x/'))) as Record<string, unknown>
  const forms = page.sections!(data as never) as { kind: string; path?: string; fields?: { name: string; label: string; hint?: string; options?: unknown }[] }[]
  const compose = forms.find((f) => f.kind === 'form' && f.path === '/board')!
  const names = compose.fields!.map((f) => f.name)
  assert.equal(names[names.indexOf('audienceRoles') + 1], 'departmentId')
  const field = compose.fields!.find((f) => f.name === 'departmentId')!
  assert.equal(field.label, 'Department')
  assert.equal(field.hint, 'Leave blank for the whole institution.')
  const choices = data.departments as { value: string; label: string }[]
  assert.deepEqual(choices, [{ value: deptA, label: 'DNA — Dept A' }, { value: deptB, label: 'DNB — Dept B' }])
  assert.ok(!choices.some((c) => c.value === foreignDept))

  const route = plugin.routes.find((r) => r.method === 'POST' && r.path === '/board')!
  const body = (over: Record<string, unknown>) => new Request('http://x/board', { method: 'POST', body: JSON.stringify({ title: 'Route notice', body: 'b', audienceRoles: ['student'], ...over }) })
  const blank = (await route.handler(adm() as never, body({ departmentId: '' }))) as { id: string }
  const scoped = (await route.handler(adm() as never, body({ departmentId: deptA }))) as { id: string }
  const rows = await withTenant(inst, (tx) => tx.select({ id: notices.id, d: notices.departmentId }).from(notices).where(inArray(notices.id, [blank.id, scoped.id])))
  assert.equal(rows.find((r) => r.id === blank.id)!.d, null)
  assert.equal(rows.find((r) => r.id === scoped.id)!.d, deptA)
  assert.ok((await recipients(blank.id)).includes(p.s2!))
  assert.ok(!(await recipients(scoped.id)).includes(p.s2!))

  // A peer poster is offered neither the draft nor the notice of somebody else's department.
  const draft = await send(ctA(), { departmentId: deptA, audienceRoles: ['student'], publish: false, title: 'Peer draft' })
  const mine = (await page.load(hodA() as never, new Request('http://x/'))) as { drafts: { value: string }[]; all: { value: string }[] }
  assert.ok(!mine.drafts.some((d) => d.value === draft.id))
  assert.ok(!mine.all.some((d) => d.value === scoped.id))
})

test('a lecturer addresses department notices only to their own departments (NEW-163)', async () => {
  // facB teaches in B only: A is refused whatever the audience, B is fine even as the first notice of the department.
  await assert.rejects(send(facB(), { departmentId: deptA, audienceRoles: ['student'] }), (e) => status(e) === 403 && code(e) === 'department_not_yours')
  await assert.rejects(send(facB(), { departmentId: deptA, audienceRoles: ['student'], publish: false }), (e) => code(e) === 'department_not_yours')
  assert.equal((await withTenant(inst, (tx) => tx.select().from(notices))).length, 0)
  const own = await send(facB(), { departmentId: deptB, audienceRoles: ['student'] })
  assert.deepEqual(await recipients(own.id), ids('s1', 's2'))

  // The picker offers a lecturer their own departments only, and an administrator all of them.
  assert.deepEqual((await departmentChoices(facB())).map((c) => c.value), [deptB])
  assert.deepEqual((await departmentChoices(ctA())).map((c) => c.value), [deptA])
  assert.deepEqual((await departmentChoices(adm())).map((c) => c.value), [deptA, deptB])

  // Between terms: an offering in a term that has not started yet still counts; with no offering and no section, nothing.
  const [late] = await authDb.insert(users).values({ email: 'facc@dept.test', institutionId: inst, role: 'faculty', name: 'facc' }).returning({ id: users.id })
  const facC: Actor = { id: late!.id, role: 'faculty', email: 'facc@dept.test', institutionId: inst }
  await assert.rejects(send(facC, { departmentId: deptA, audienceRoles: ['student'] }), (e) => code(e) === 'department_not_yours')
  assert.deepEqual(await departmentChoices(facC), [])
  const next = await academic.createTerm(adm(), { code: 'dterm2', name: 'Next term', startsOn: await istDay(10), endsOn: await istDay(100) })
  const course = await academic.createCourse(adm(), { departmentId: deptA, code: 'ca2', title: 'A later course', credits: 3 })
  await academic.createOffering(adm(), { termId: next.id, courseId: course.id, sectionId: secA, facultyUserId: late!.id })
  assert.deepEqual((await departmentChoices(facC)).map((c) => c.value), [deptA])
  await send(facC, { departmentId: deptA, audienceRoles: ['student'] })
})

test('an administrator is not delivered a scoped notice they manage', async () => {
  const n = await send(hodA(), { departmentId: deptA, audienceRoles: ['student', 'faculty', 'hod', 'institution_admin'] })
  assert.ok(!(await recipients(n.id)).includes(p.adm!))
  assert.ok((await board1(adm())).rows.some((r) => r.id === n.id))
})
