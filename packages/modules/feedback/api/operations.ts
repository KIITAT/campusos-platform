import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { cancelDocument, submitDocument, withTenant } from '@campusos/db'
import type { Role } from '@campusos/module-framework'
import { courses, offerings, sections, terms } from '@campusos/module-academic/schema'
import { answers, forms, questions, responses, submissions, windows, type Question, type Window } from '../schema'
import {
  addQuestionSchema,
  addScaleQuestionsSchema,
  createFormSchema,
  createWindowSchema,
  formRefSchema,
  giveSchema,
  removeQuestionsSchema,
  retireFormSchema,
  windowRefSchema,
  withdrawWindowSchema,
} from './schemas'
import { assertZone, instant, wallClock, ZoneError } from './time'

const MODULE = 'feedback'

export interface Actor {
  id: string
  email?: string | null
  role: Role
  institutionId: string | null
}

export class FeedbackError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]

const tenantOf = (actor: Actor) => {
  if (!actor.institutionId) throw new FeedbackError(400, 'no_institution', 'no institution for this session')
  return actor.institutionId
}
const isAdmin = (r: Role) => r === 'institution_admin' || r === 'super_admin'
/** Runs feedback, and reads every class's results. */
const runs = (r: Role) => isAdmin(r) || r === 'hod'
const requireRunner = (actor: Actor) => {
  const t = tenantOf(actor)
  if (!runs(actor.role)) throw new FeedbackError(403, 'forbidden', 'not permitted')
  return t
}
const requireStudent = (actor: Actor) => {
  const t = tenantOf(actor)
  if (actor.role !== 'student') throw new FeedbackError(403, 'forbidden', 'feedback is given by students')
  return t
}
const who = (actor: Actor, tenant: string) => ({
  institutionId: tenant,
  actorId: actor.id,
  actorEmail: actor.email ?? null,
  moduleId: MODULE,
})

/** Named refusals raised by this module's triggers and constraints. */
const REFUSALS: Record<string, [number, string]> = {
  feedback_forms_name: [409, 'there is already a questionnaire with that name'],
  feedback_question_frozen: [409, 'a published questionnaire is not changed; write a new one'],
  feedback_questions_options: [400, 'a choice question needs two to twelve options, one per line'],
  feedback_form_empty: [409, 'add a question before publishing'],
  feedback_window_form: [409, 'that questionnaire is not published'],
  feedback_window_closed: [409, 'that window has already closed; set its dates again'],
  feedback_windows_span: [400, 'a window must close after it opens'],
  feedback_submissions_once: [409, 'you have already given this feedback'],
  feedback_submission_window: [409, 'that window is not taking feedback'],
  feedback_submission_not_open: [409, 'that window has not opened yet'],
  feedback_submission_closed: [409, 'that window has closed'],
  feedback_submission_student: [403, 'feedback is given by students'],
  feedback_submission_class: [403, 'that is not one of your classes this term'],
  feedback_submission_kept: [409, 'given feedback is kept'],
  feedback_response_unmatched: [409, 'a response needs a student who has just given it'],
  feedback_response_incomplete: [400, 'answer every required question'],
  feedback_response_kept: [409, 'what was said is kept as it was said'],
  feedback_answer_question: [400, 'that question is not on this questionnaire'],
  feedback_answer_value: [400, 'that answer does not fit the question'],
  feedback_answer_kept: [409, 'what was said is kept as it was said'],
}

async function named<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    const constraint =
      (e as { cause?: { constraint?: string }; constraint?: string }).cause?.constraint ??
      (e as { constraint?: string }).constraint
    const known = constraint ? REFUSALS[constraint] : undefined
    if (known) throw new FeedbackError(known[0] as 400 | 403 | 409, constraint!, known[1])
    if (e instanceof ZoneError) throw new FeedbackError(400, 'bad_time_zone', e.message)
    throw e
  }
}

const rows = async <T>(tx: Tx, q: ReturnType<typeof sql>) => (await tx.execute(q)).rows as T[]
const round2 = (n: number) => Math.round(n * 100) / 100 + 0

/** Where a window stands for a reader. */
export type Phase = 'draft' | 'upcoming' | 'open' | 'closed' | 'withdrawn'
export const phaseOf = (w: Pick<Window, 'docstatus' | 'opensAt' | 'closesAt'>, now = new Date()): Phase =>
  w.docstatus === 'draft'
    ? 'draft'
    : w.docstatus === 'cancelled'
      ? 'withdrawn'
      : now < w.opensAt
        ? 'upcoming'
        : now < w.closesAt
          ? 'open'
          : 'closed'

// --- questionnaires -----------------------------------------------------------

export async function createForm(actor: Actor, input: unknown) {
  const tenant = requireRunner(actor)
  const d = createFormSchema.parse(input)
  return named(() =>
    withTenant(tenant, async (tx) => {
      const [f] = await tx
        .insert(forms)
        .values({ institutionId: tenant, ...d, createdBy: actor.id })
        .returning()
      return { ...f!, notice: 'Questionnaire started. Add its questions, then publish it.', link: `/m/feedback/form?formId=${f!.id}` }
    }),
  )
}

async function draftForm(tx: Tx, formId: string) {
  const [f] = await tx.select().from(forms).where(eq(forms.id, formId))
  if (!f) throw new FeedbackError(404, 'no_such_form', 'no such questionnaire')
  return f
}

async function nextPosition(tx: Tx, formId: string) {
  const [r] = await tx
    .select({ top: sql<number>`coalesce(max(${questions.position}), 0)::int` })
    .from(questions)
    .where(eq(questions.formId, formId))
  return (r?.top ?? 0) + 1
}

export async function addQuestion(actor: Actor, input: unknown) {
  const tenant = requireRunner(actor)
  const d = addQuestionSchema.parse(input)
  return named(() =>
    withTenant(tenant, async (tx) => {
      await draftForm(tx, d.formId)
      const [q] = await tx
        .insert(questions)
        .values({
          institutionId: tenant,
          formId: d.formId,
          position: await nextPosition(tx, d.formId),
          section: d.section || null,
          prompt: d.prompt,
          kind: d.kind,
          options: d.kind === 'choice' ? (d.options ?? []) : [],
          required: d.kind === 'text' ? false : d.required,
        })
        .returning()
      return { ...q!, notice: 'Question added.' }
    }),
  )
}

/** Comments are always optional: making somebody write something is how a form fills with full stops. */
export async function addScaleQuestions(actor: Actor, input: unknown) {
  const tenant = requireRunner(actor)
  const d = addScaleQuestionsSchema.parse(input)
  return named(() =>
    withTenant(tenant, async (tx) => {
      await draftForm(tx, d.formId)
      let at = await nextPosition(tx, d.formId)
      const added = await tx
        .insert(questions)
        .values(
          d.prompts.map((prompt) => ({
            institutionId: tenant,
            formId: d.formId,
            position: at++,
            section: d.section || null,
            prompt,
            kind: 'scale' as const,
            required: true,
          })),
        )
        .returning({ id: questions.id })
      return { added: added.length, notice: `${added.length} statement${added.length === 1 ? '' : 's'} added.` }
    }),
  )
}

export async function removeQuestions(actor: Actor, input: unknown) {
  const tenant = requireRunner(actor)
  const d = removeQuestionsSchema.parse(input)
  return named(() =>
    withTenant(tenant, async (tx) => {
      const gone = await tx
        .delete(questions)
        .where(and(eq(questions.formId, d.formId), inArray(questions.id, d.questionIds)))
        .returning({ id: questions.id })
      return { removed: gone.length, notice: `${gone.length} removed.` }
    }),
  )
}

export async function publishForm(actor: Actor, input: unknown) {
  const tenant = requireRunner(actor)
  const d = formRefSchema.parse(input)
  return named(() =>
    withTenant(tenant, async (tx) => {
      await submitDocument(tx, forms, d.formId, who(actor, tenant))
      return { id: d.formId, notice: 'Published. It can now be opened to students in a window; its questions are fixed.' }
    }),
  )
}

export async function retireForm(actor: Actor, input: unknown) {
  const tenant = requireRunner(actor)
  const d = retireFormSchema.parse(input)
  return named(() =>
    withTenant(tenant, async (tx) => {
      await cancelDocument(tx, forms, d.formId, { ...who(actor, tenant), reason: d.reason })
      return { id: d.formId, notice: 'Retired. Windows already open carry on; no new ones can use it.' }
    }),
  )
}

export async function listForms(actor: Actor) {
  const tenant = requireRunner(actor)
  return withTenant(tenant, (tx) =>
    tx
      .select({
        id: forms.id,
        name: forms.name,
        audience: forms.audience,
        docstatus: forms.docstatus,
        questions: sql<number>`(select count(*)::int from feedback_questions q where q.form_id = feedback_forms.id)`,
        windows: sql<number>`(select count(*)::int from feedback_windows w where w.form_id = feedback_forms.id)`,
        createdAt: forms.createdAt,
      })
      .from(forms)
      .orderBy(asc(forms.docstatus), asc(forms.name)),
  )
}

export async function formView(actor: Actor, formId: string) {
  const tenant = requireRunner(actor)
  return withTenant(tenant, async (tx) => {
    const f = await draftForm(tx, formId)
    const qs = await tx.select().from(questions).where(eq(questions.formId, formId)).orderBy(asc(questions.position))
    const ws = await tx
      .select({ id: windows.id, title: windows.title, term: terms.code, opensAt: windows.opensAt, closesAt: windows.closesAt, timeZone: windows.timeZone, docstatus: windows.docstatus })
      .from(windows)
      .innerJoin(terms, eq(terms.id, windows.termId))
      .where(eq(windows.formId, formId))
      .orderBy(desc(windows.opensAt))
    return {
      form: f,
      questions: qs,
      windows: ws.map((w) => ({ ...w, phase: phaseOf(w), opens: wallClock(w.opensAt, w.timeZone) })),
    }
  })
}

export async function formChoices(actor: Actor) {
  const tenant = requireRunner(actor)
  return withTenant(tenant, async (tx) => {
    const fs = await tx
      .select({ id: forms.id, name: forms.name, audience: forms.audience })
      .from(forms)
      .where(eq(forms.docstatus, 'submitted'))
      .orderBy(asc(forms.name))
    return fs.map((f) => ({ value: f.id, label: `${f.name} (${f.audience === 'teaching' ? 'every class' : 'once per student'})` }))
  })
}

export async function termChoices(actor: Actor) {
  const tenant = requireRunner(actor)
  return withTenant(tenant, async (tx) => {
    const ts = await tx.select({ id: terms.id, code: terms.code, name: terms.name }).from(terms).orderBy(desc(terms.startsOn))
    return ts.map((t) => ({ value: t.id, label: `${t.code} — ${t.name}` }))
  })
}

// --- windows ------------------------------------------------------------------

export async function createWindow(actor: Actor, input: unknown) {
  const tenant = requireRunner(actor)
  const d = createWindowSchema.parse(input)
  return named(() =>
    withTenant(tenant, async (tx) => {
      const zone = assertZone(d.timeZone)
      const opensAt = instant(d.opensAt, zone)
      const closesAt = instant(d.closesAt, zone)
      if (closesAt <= opensAt) throw new FeedbackError(400, 'feedback_windows_span', 'a window must close after it opens')
      const [w] = await tx
        .insert(windows)
        .values({
          institutionId: tenant,
          formId: d.formId,
          termId: d.termId,
          title: d.title,
          opensAt,
          closesAt,
          timeZone: zone,
          required: d.required,
          minResponses: d.minResponses,
          createdBy: actor.id,
        })
        .returning()
      return { ...w!, notice: 'Window drafted. Publish it to open it to students.', link: `/m/feedback/window?windowId=${w!.id}` }
    }),
  )
}

export async function publishWindow(actor: Actor, input: unknown) {
  const tenant = requireRunner(actor)
  const d = windowRefSchema.parse(input)
  return named(() =>
    withTenant(tenant, async (tx) => {
      await submitDocument(tx, windows, d.windowId, who(actor, tenant))
      return { id: d.windowId, notice: 'Published. Students see it from when it opens.' }
    }),
  )
}

export async function withdrawWindow(actor: Actor, input: unknown) {
  const tenant = requireRunner(actor)
  const d = withdrawWindowSchema.parse(input)
  return named(() =>
    withTenant(tenant, async (tx) => {
      await cancelDocument(tx, windows, d.windowId, { ...who(actor, tenant), reason: d.reason })
      return { id: d.windowId, notice: 'Withdrawn. Nobody owes it any more; what was already said is kept.' }
    }),
  )
}

/**
 * Who owes a window: for a teaching window, every (student, class) pair in the
 * term; for a general one, every student with a class that term.
 */
const owedSql = (windowId: string) => sql`
  with w as (
    select fw.id, fw.term_id, ff.audience from feedback_windows fw
      join feedback_forms ff on ff.id = fw.form_id where fw.id = ${windowId}
  ), pairs as (
    select m.user_id as student_id, ao.id as offering_id
      from w join academic_offerings ao on ao.term_id = w.term_id
      join academic_section_members m on m.section_id = ao.section_id
      join users u on u.id = m.user_id and u.role = 'student'
     where w.audience = 'teaching'
    union
    select distinct m.user_id, null::uuid
      from w join academic_offerings ao on ao.term_id = w.term_id
      join academic_section_members m on m.section_id = ao.section_id
      join users u on u.id = m.user_id and u.role = 'student'
     where w.audience = 'general'
  )`

export async function listWindows(actor: Actor) {
  const tenant = requireRunner(actor)
  return withTenant(tenant, async (tx) => {
    const ws = await tx
      .select({
        id: windows.id,
        title: windows.title,
        form: forms.name,
        audience: forms.audience,
        term: terms.code,
        opensAt: windows.opensAt,
        closesAt: windows.closesAt,
        timeZone: windows.timeZone,
        required: windows.required,
        docstatus: windows.docstatus,
        given: sql<number>`(select count(*)::int from feedback_submissions s where s.window_id = feedback_windows.id)`,
      })
      .from(windows)
      .innerJoin(forms, eq(forms.id, windows.formId))
      .innerJoin(terms, eq(terms.id, windows.termId))
      .orderBy(desc(windows.opensAt))
    const out = []
    for (const w of ws) {
      const [o] = await rows<{ owed: number }>(tx, sql`${owedSql(w.id)} select count(*)::int as owed from pairs`)
      const owed = o?.owed ?? 0
      out.push({
        ...w,
        phase: phaseOf(w),
        opens: wallClock(w.opensAt, w.timeZone),
        closes: wallClock(w.closesAt, w.timeZone),
        owed,
        pct: owed ? Math.round((w.given / owed) * 1000) / 10 : null,
      })
    }
    return out
  })
}

export type Aggregate = {
  questionId: string
  position: number
  section: string | null
  prompt: string
  kind: 'scale' | 'choice' | 'text'
  answered: number
  mean: number | null
  /** Scale: how many gave each point, 1 first. Choice: per option. */
  spread: { label: string; count: number }[]
  comments: string[]
}

/**
 * What a class said, or the whole window when `offeringId` is undefined.
 * Nothing at all below the window's threshold: too few answers and an average
 * is one person's opinion with their name rubbed off.
 */
async function aggregate(tx: Tx, w: Window, offeringId: string | null | undefined) {
  const [f] = await tx.select().from(forms).where(eq(forms.id, w.formId))
  const qs = await tx.select().from(questions).where(eq(questions.formId, w.formId)).orderBy(asc(questions.position))
  const scope = offeringId === undefined ? sql`true` : offeringId === null ? sql`r.offering_id is null` : sql`r.offering_id = ${offeringId}`
  const [n] = await rows<{ n: number }>(
    tx,
    sql`select count(*)::int as n from feedback_responses r where r.window_id = ${w.id} and ${scope}`,
  )
  const count = n?.n ?? 0
  if (count < w.minResponses) return { responses: count, shown: false, questions: [] as Aggregate[], scaleMean: null as number | null }
  const raw = await rows<{ question_id: string; score: number | null; choice: string | null; comment: string | null }>(
    tx,
    sql`select a.question_id, a.score, a.choice, a.comment
          from feedback_answers a join feedback_responses r on r.id = a.response_id
         where r.window_id = ${w.id} and ${scope}
         order by a.comment nulls last, a.choice nulls last, a.score nulls last`,
  )
  const out: Aggregate[] = qs.map((q: Question) => {
    const mine = raw.filter((a) => a.question_id === q.id)
    const scores = mine.map((a) => a.score).filter((s): s is number => s !== null)
    return {
      questionId: q.id,
      position: q.position,
      section: q.section,
      prompt: q.prompt,
      kind: q.kind,
      answered: mine.length,
      mean: q.kind === 'scale' && scores.length ? round2(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
      spread:
        q.kind === 'scale'
          ? Array.from({ length: f!.scalePoints }, (_, i) => ({ label: String(i + 1), count: scores.filter((s) => s === i + 1).length }))
          : q.kind === 'choice'
            ? q.options.map((o) => ({ label: o, count: mine.filter((a) => a.choice === o).length }))
            : [],
      // Sorted by their own text, not by when they came: order is a clue.
      comments: q.kind === 'text' ? mine.map((a) => a.comment!).sort((a, b) => a.localeCompare(b)) : [],
    }
  })
  const all = raw.map((a) => a.score).filter((s): s is number => s !== null)
  return {
    responses: count,
    shown: true,
    questions: out,
    scaleMean: all.length ? round2(all.reduce((a, b) => a + b, 0) / all.length) : null,
  }
}

async function windowIn(tx: Tx, windowId: string) {
  const [w] = await tx.select().from(windows).where(eq(windows.id, windowId))
  if (!w) throw new FeedbackError(404, 'no_such_window', 'no such window')
  return w
}

export async function windowView(actor: Actor, windowId: string) {
  const tenant = requireRunner(actor)
  return withTenant(tenant, async (tx) => {
    const w = await windowIn(tx, windowId)
    const [f] = await tx.select().from(forms).where(eq(forms.id, w.formId))
    const [t] = await tx.select().from(terms).where(eq(terms.id, w.termId))
    const phase = phaseOf(w)
    const closed = phase === 'closed' || phase === 'withdrawn'

    // Progress per class: who has given, as a count. Never what they said.
    const classes = await rows<{
      offering_id: string | null
      course: string | null
      title: string | null
      section: string | null
      teacher: string | null
      owed: number
      given: number
    }>(
      tx,
      sql`${owedSql(w.id)}
          select p.offering_id, c.code as course, c.title, s.label as section, coalesce(fu.name, fu.email) as teacher,
                 count(*)::int as owed,
                 count(fs.id)::int as given
            from pairs p
            left join academic_offerings ao on ao.id = p.offering_id
            left join academic_courses c on c.id = ao.course_id
            left join academic_sections s on s.id = ao.section_id
            left join users fu on fu.id = ao.faculty_user_id
            left join feedback_submissions fs
              on fs.window_id = ${w.id} and fs.student_id = p.student_id
             and fs.offering_id is not distinct from p.offering_id
           group by p.offering_id, c.code, c.title, s.label, fu.name, fu.email
           order by c.code nulls first, s.label`,
    )
    const results = []
    for (const c of classes) {
      const a = closed ? await aggregate(tx, w, f!.audience === 'teaching' ? c.offering_id : null) : null
      results.push({
        offeringId: c.offering_id,
        course: c.course ? `${c.course} ${c.title}` : 'Every student',
        section: c.section,
        teacher: c.teacher,
        owed: c.owed,
        given: c.given,
        pct: c.owed ? Math.round((c.given / c.owed) * 1000) / 10 : null,
        mean: a?.shown ? a.scaleMean : null,
        resultText: !closed ? 'after the close' : a?.shown ? String(a.scaleMean ?? '—') : `too few (${a?.responses ?? 0} of ${w.minResponses} needed)`,
      })
    }

    // Students who still owe something, to chase -- names, never answers.
    const pending = await rows<{ student_id: string; name: string | null; email: string | null; outstanding: number }>(
      tx,
      sql`${owedSql(w.id)}
          select p.student_id, u.name, u.email, count(*)::int as outstanding
            from pairs p join users u on u.id = p.student_id
           where not exists (select 1 from feedback_submissions fs
                              where fs.window_id = ${w.id} and fs.student_id = p.student_id
                                and fs.offering_id is not distinct from p.offering_id)
           group by p.student_id, u.name, u.email
           order by u.name`,
    )
    const overall = closed ? await aggregate(tx, w, undefined) : null
    const owed = classes.reduce((n, c) => n + c.owed, 0)
    const given = classes.reduce((n, c) => n + c.given, 0)
    return {
      window: { ...w, phase, opens: wallClock(w.opensAt, w.timeZone), closes: wallClock(w.closesAt, w.timeZone) },
      form: f!,
      term: t!,
      summary: { owed, given, pct: owed ? Math.round((given / owed) * 1000) / 10 : null, pending: pending.length },
      classes: results,
      pending: pending.map((p) => ({ studentId: p.student_id, name: p.name ?? p.email ?? p.student_id, outstanding: p.outstanding })),
      overall,
    }
  })
}

/** One class's results, for the institution or the class's own teacher. */
export async function classResults(actor: Actor, windowId: string, offeringId: string) {
  const tenant = tenantOf(actor)
  if (!runs(actor.role) && actor.role !== 'faculty') throw new FeedbackError(403, 'forbidden', 'not permitted')
  return withTenant(tenant, async (tx) => {
    const w = await windowIn(tx, windowId)
    const [o] = await tx
      .select({ id: offerings.id, teacherId: offerings.facultyUserId, course: courses.code, title: courses.title, section: sections.label, termId: offerings.termId })
      .from(offerings)
      .innerJoin(courses, eq(courses.id, offerings.courseId))
      .innerJoin(sections, eq(sections.id, offerings.sectionId))
      .where(eq(offerings.id, offeringId))
    if (!o || o.termId !== w.termId) throw new FeedbackError(404, 'no_such_class', 'no such class in that window')
    if (!runs(actor.role) && o.teacherId !== actor.id) throw new FeedbackError(403, 'forbidden', 'that is not your class')
    const phase = phaseOf(w)
    if (phase !== 'closed' && phase !== 'withdrawn') {
      return { window: w, class: o, phase, open: true as const, result: null }
    }
    const [f] = await tx.select().from(forms).where(eq(forms.id, w.formId))
    return { window: w, class: o, phase, open: false as const, form: f!, result: await aggregate(tx, w, o.id) }
  })
}

/** A teacher's classes in closed teaching windows, with how they were seen. */
export async function myClassResults(actor: Actor) {
  const tenant = tenantOf(actor)
  if (actor.role !== 'faculty' && !runs(actor.role)) throw new FeedbackError(403, 'forbidden', 'not permitted')
  return withTenant(tenant, async (tx) => {
    const list = await tx
      .select({ w: windows, offeringId: offerings.id, course: courses.code, title: courses.title, section: sections.label })
      .from(windows)
      .innerJoin(forms, eq(forms.id, windows.formId))
      .innerJoin(offerings, eq(offerings.termId, windows.termId))
      .innerJoin(courses, eq(courses.id, offerings.courseId))
      .innerJoin(sections, eq(sections.id, offerings.sectionId))
      .where(and(eq(forms.audience, 'teaching'), eq(offerings.facultyUserId, actor.id), eq(windows.docstatus, 'submitted')))
      .orderBy(desc(windows.closesAt), asc(courses.code))
    const out = []
    for (const r of list) {
      const phase = phaseOf(r.w)
      const a = phase === 'closed' ? await aggregate(tx, r.w, r.offeringId) : null
      out.push({
        windowId: r.w.id,
        offeringId: r.offeringId,
        window: r.w.title,
        course: `${r.course} ${r.title}`,
        section: r.section,
        phase,
        responses: a?.responses ?? null,
        mean: a?.shown ? a.scaleMean : null,
        resultText: phase !== 'closed' ? `after ${wallClock(r.w.closesAt, r.w.timeZone)}` : a?.shown ? `${a.scaleMean ?? '—'}` : 'too few answers to show',
      })
    }
    return out
  })
}

// --- students -----------------------------------------------------------------

type Owed = { windowId: string; window: string; offeringId: string | null; course: string; teacher: string | null; done: boolean }

/** Every item a student owes or gave, in windows of terms they have classes in. */
async function itemsFor(tx: Tx, studentId: string, termId?: string) {
  const ws = await rows<{
    id: string
    title: string
    audience: 'teaching' | 'general'
    term_id: string
    term: string
    opens_at: Date
    closes_at: Date
    time_zone: string
    required: boolean
    docstatus: string
  }>(
    tx,
    sql`select fw.id, fw.title, ff.audience, fw.term_id, t.code as term, fw.opens_at, fw.closes_at, fw.time_zone, fw.required, fw.docstatus
          from feedback_windows fw
          join feedback_forms ff on ff.id = fw.form_id
          join academic_terms t on t.id = fw.term_id
         where fw.docstatus = 'submitted'
           and (${termId ?? null}::uuid is null or fw.term_id = ${termId ?? null}::uuid)
           and exists (select 1 from academic_offerings ao
                         join academic_section_members m on m.section_id = ao.section_id
                        where ao.term_id = fw.term_id and m.user_id = ${studentId})
         order by fw.closes_at`,
  )
  const out: (Owed & { phase: Phase; required: boolean; opens: string; closes: string; term: string; termId: string })[] = []
  for (const w of ws) {
    const phase = phaseOf({ docstatus: w.docstatus as never, opensAt: new Date(w.opens_at), closesAt: new Date(w.closes_at) })
    const base = {
      windowId: w.id,
      window: w.title,
      phase,
      required: w.required,
      opens: wallClock(new Date(w.opens_at), w.time_zone),
      closes: wallClock(new Date(w.closes_at), w.time_zone),
      term: w.term,
      termId: w.term_id,
    }
    if (w.audience === 'general') {
      const [s] = await rows<{ id: string }>(
        tx,
        sql`select id from feedback_submissions where window_id = ${w.id} and student_id = ${studentId} and offering_id is null`,
      )
      out.push({ ...base, offeringId: null, course: 'Once, for the term', teacher: null, done: !!s })
      continue
    }
    const cls = await rows<{ id: string; code: string; title: string; teacher: string | null; done: boolean }>(
      tx,
      sql`select ao.id, c.code, c.title, coalesce(fu.name, fu.email) as teacher,
                 exists (select 1 from feedback_submissions fs
                          where fs.window_id = ${w.id} and fs.student_id = ${studentId} and fs.offering_id = ao.id) as done
            from academic_offerings ao
            join academic_section_members m on m.section_id = ao.section_id and m.user_id = ${studentId}
            join academic_courses c on c.id = ao.course_id
            left join users fu on fu.id = ao.faculty_user_id
           where ao.term_id = ${w.term_id}
           order by c.code`,
    )
    for (const c of cls) out.push({ ...base, offeringId: c.id, course: `${c.code} ${c.title}`, teacher: c.teacher, done: c.done })
  }
  return out
}

export async function myFeedback(actor: Actor) {
  const tenant = requireStudent(actor)
  return withTenant(tenant, async (tx) => {
    const items = await itemsFor(tx, actor.id)
    const state = (i: (typeof items)[number]) => (i.done ? 'given' : i.phase === 'open' ? 'due' : i.phase === 'upcoming' ? 'upcoming' : 'missed')
    return {
      items: items.map((i) => ({ ...i, state: state(i) })),
      due: items.filter((i) => !i.done && i.phase === 'open').length,
    }
  })
}

/**
 * Whether a student has finished the required feedback for a term -- the
 * question other modules ask before, say, releasing a grade report. `owed` is
 * what is open and not given; `missed` closed before it was.
 */
export async function completion(actor: Actor, studentId: string, termId: string) {
  const tenant = tenantOf(actor)
  if (actor.role === 'student' ? actor.id !== studentId : !runs(actor.role) && actor.role !== 'faculty') {
    throw new FeedbackError(403, 'forbidden', 'not permitted')
  }
  return withTenant(tenant, async (tx) => {
    const items = (await itemsFor(tx, studentId, termId)).filter((i) => i.required && !i.done)
    const owed = items.filter((i) => i.phase === 'open')
    const missed = items.filter((i) => i.phase === 'closed')
    return { complete: owed.length === 0 && missed.length === 0, owed, missed }
  })
}

export async function giveView(actor: Actor, windowId: string, offeringId: string | null) {
  const tenant = requireStudent(actor)
  return withTenant(tenant, async (tx) => {
    const item = (await itemsFor(tx, actor.id)).find((i) => i.windowId === windowId && i.offeringId === offeringId)
    if (!item) throw new FeedbackError(404, 'not_yours', 'there is no such feedback for you to give')
    const w = await windowIn(tx, windowId)
    const [f] = await tx.select().from(forms).where(eq(forms.id, w.formId))
    const qs = await tx.select().from(questions).where(eq(questions.formId, w.formId)).orderBy(asc(questions.position))
    return { item, form: f!, questions: qs }
  })
}

type Given = string | number | null

export async function give(actor: Actor, input: unknown) {
  const tenant = requireStudent(actor)
  const d = giveSchema.parse(input)
  const given: Record<string, Given> = { ...(d.answers as Record<string, Given>) }
  for (const [k, v] of Object.entries(d)) if (k.startsWith('q_')) given[k.slice(2)] = v as Given
  return named(() =>
    withTenant(tenant, async (tx) => {
      const w = await windowIn(tx, d.windowId)
      const [f] = await tx.select().from(forms).where(eq(forms.id, w.formId))
      const qs = await tx.select().from(questions).where(eq(questions.formId, w.formId)).orderBy(asc(questions.position))

      const rowsToWrite: { questionId: string; score?: number; choice?: string; comment?: string }[] = []
      for (const q of qs) {
        const raw = given[q.id]
        const blank = raw === null || raw === undefined || String(raw).trim() === ''
        if (blank) {
          if (q.required) throw new FeedbackError(400, 'feedback_response_incomplete', `answer: ${q.prompt}`)
          continue
        }
        if (q.kind === 'scale') {
          const n = Number(raw)
          if (!Number.isInteger(n) || n < 1 || n > f!.scalePoints) throw new FeedbackError(400, 'feedback_answer_value', `answer 1 to ${f!.scalePoints}: ${q.prompt}`)
          rowsToWrite.push({ questionId: q.id, score: n })
        } else if (q.kind === 'choice') {
          if (!q.options.includes(String(raw))) throw new FeedbackError(400, 'feedback_answer_value', `choose one of the options: ${q.prompt}`)
          rowsToWrite.push({ questionId: q.id, choice: String(raw) })
        } else {
          rowsToWrite.push({ questionId: q.id, comment: String(raw).trim().slice(0, 2000) })
        }
      }
      const unknown = Object.keys(given).filter((id) => !qs.some((q) => q.id === id))
      if (unknown.length) throw new FeedbackError(400, 'feedback_answer_question', 'that question is not on this questionnaire')

      // Who, then what -- in one transaction, with nothing joining the two.
      await tx.insert(submissions).values({
        institutionId: tenant,
        windowId: w.id,
        studentId: actor.id,
        offeringId: d.offeringId ?? null,
      })
      const [r] = await tx
        .insert(responses)
        .values({ institutionId: tenant, windowId: w.id, offeringId: d.offeringId ?? null })
        .returning({ id: responses.id })
      if (rowsToWrite.length) {
        await tx.insert(answers).values(rowsToWrite.map((a) => ({ institutionId: tenant, responseId: r!.id, ...a })))
      }
      // The commit-time check runs now, inside the error mapping, not after it.
      await tx.execute(sql`set constraints all immediate`)
      return { notice: 'Thank you. Your feedback is recorded, without your name on it.', link: '/m/feedback/me' }
    }),
  )
}
