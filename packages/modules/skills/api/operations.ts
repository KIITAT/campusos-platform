import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { audit, users, withTenant } from '@campusos/db'
import type { Role } from '@campusos/module-framework'
import { assessments, frameworks, levels, skills, type Level } from '../schema'
import {
  addLevelSchema,
  assessSchema,
  createFrameworkSchema,
  createSkillSchema,
  selfAssessSchema,
  retireSkillsSchema,
} from './schemas'

const MODULE = 'skills'

export interface Actor {
  id: string
  email?: string | null
  role: Role
  institutionId: string | null
}

export class SkillError extends Error {
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
  if (!actor.institutionId) throw new SkillError(400, 'no_institution', 'no institution for this session')
  return actor.institutionId
}
const isAdmin = (r: Role) => r === 'institution_admin' || r === 'super_admin'
const isStaff = (r: Role) => isAdmin(r) || r === 'hod' || r === 'faculty'
const requireAdmin = (actor: Actor) => {
  const t = tenantOf(actor)
  if (!isAdmin(actor.role)) throw new SkillError(403, 'forbidden', 'not permitted')
  return t
}
const requireStaff = (actor: Actor) => {
  const t = tenantOf(actor)
  if (!isStaff(actor.role)) throw new SkillError(403, 'forbidden', 'not permitted')
  return t
}
const who = (actor: Actor, tenant: string) => ({
  institutionId: tenant,
  actorId: actor.id,
  actorEmail: actor.email ?? null,
  moduleId: MODULE,
})
const today = () => new Date().toISOString().slice(0, 10)

const REFUSALS: Record<string, [number, string]> = {
  skill_frameworks_name: [409, 'a framework by that name already exists'],
  skill_skills_code: [409, 'a skill with that code already exists'],
  skill_level_in_use: [409, 'students have been judged against that level; it is not changed'],
  skill_assessment_level: [400, "that level is not on this skill's scale"],
  skill_assessment_retired: [409, 'that skill is retired'],
  skill_assessment_student: [400, 'skills are recorded for students'],
  skill_assessment_self: [403, 'a self-assessment is by the student'],
  skill_assessment_assessor: [403, "a teacher's judgement is by a member of staff"],
  skill_assessment_date: [400, 'a judgement is not dated in the future'],
  skill_assessment_final: [409, 'a judgement is kept as written; record a new one instead'],
}

async function named<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    const constraint = (e as { cause?: { constraint?: string } }).cause?.constraint
    const known = constraint ? REFUSALS[constraint] : undefined
    if (known) throw new SkillError(known[0] as 400 | 403 | 409, constraint!, known[1])
    throw e
  }
}

// --- frameworks and their scales ---------------------------------------------

export async function createFramework(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = createFrameworkSchema.parse(input)
  return named(() =>
    withTenant(tenant, async (tx) => {
      const [f] = await tx
        .insert(frameworks)
        .values({ institutionId: tenant, name: d.name, description: d.description || null })
        .returning()
      await tx.insert(levels).values(
        d.levels.map((l, i) => ({ institutionId: tenant, frameworkId: f!.id, rank: i + 1, name: l.name, descriptor: l.descriptor })),
      )
      return { ...f!, notice: `${d.name} created with ${d.levels.length} levels.`, link: `/m/skills/framework?frameworkId=${f!.id}` }
    }),
  )
}

/** A new top level. The existing ones keep their meaning. */
export async function addLevel(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = addLevelSchema.parse(input)
  return named(() =>
    withTenant(tenant, async (tx) => {
      const [f] = await tx.select().from(frameworks).where(eq(frameworks.id, d.frameworkId))
      if (!f) throw new SkillError(404, 'no_such_framework', 'no such framework')
      const [{ top } = { top: 0 }] = await tx
        .select({ top: sql<number>`coalesce(max(${levels.rank}), 0)::int` })
        .from(levels)
        .where(eq(levels.frameworkId, f.id))
      if (top >= 10) throw new SkillError(409, 'too_many_levels', 'a scale has at most ten levels')
      const [row] = await tx
        .insert(levels)
        .values({ institutionId: tenant, frameworkId: f.id, rank: top + 1, name: d.name, descriptor: d.descriptor })
        .returning()
      return { ...row!, notice: `Level ${top + 1} added.` }
    }),
  )
}

export async function createSkill(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = createSkillSchema.parse(input)
  return named(() =>
    withTenant(tenant, async (tx) => {
      const [f] = await tx.select({ id: frameworks.id }).from(frameworks).where(eq(frameworks.id, d.frameworkId))
      if (!f) throw new SkillError(404, 'no_such_framework', 'no such framework')
      const [row] = await tx
        .insert(skills)
        .values({
          institutionId: tenant,
          frameworkId: f.id,
          code: d.code,
          name: d.name,
          category: d.category || null,
          description: d.description || null,
        })
        .returning()
      return { ...row!, notice: `${d.code} added.` }
    }),
  )
}

export async function retireSkill(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = retireSkillsSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const found = await tx.select().from(skills).where(inArray(skills.id, d.skillIds))
    if (found.length !== new Set(d.skillIds).size) throw new SkillError(404, 'no_such_skill', 'no such skill')
    const live = found.filter((s) => !s.retiredAt)
    if (!live.length) throw new SkillError(409, 'retired', 'already retired')
    await tx.update(skills).set({ retiredAt: new Date() }).where(inArray(skills.id, live.map((s) => s.id)))
    return {
      retired: live.length,
      notice: `${live.map((s) => s.code).join(', ')} retired. The history stays; no new judgements are taken.`,
    }
  })
}

export async function listFrameworks(actor: Actor) {
  const tenant = requireStaff(actor)
  return withTenant(tenant, (tx) =>
    tx
      .select({
        id: frameworks.id,
        name: frameworks.name,
        description: frameworks.description,
        levels: sql<number>`(select count(*)::int from skill_levels l where l.framework_id = ${frameworks.id})`,
        skills: sql<number>`(select count(*)::int from skill_skills s where s.framework_id = ${frameworks.id} and s.retired_at is null)`,
        students: sql<number>`(select count(distinct a.student_id)::int from skill_assessments a join skill_skills s on s.id = a.skill_id where s.framework_id = ${frameworks.id})`,
      })
      .from(frameworks)
      .orderBy(asc(frameworks.name)),
  )
}

export async function frameworkView(actor: Actor, frameworkId: string) {
  const tenant = requireStaff(actor)
  return withTenant(tenant, async (tx) => {
    const [f] = await tx.select().from(frameworks).where(eq(frameworks.id, frameworkId))
    if (!f) throw new SkillError(404, 'no_such_framework', 'no such framework')
    const scale = await tx.select().from(levels).where(eq(levels.frameworkId, f.id)).orderBy(asc(levels.rank))
    const list = await tx
      .select({
        id: skills.id,
        code: skills.code,
        name: skills.name,
        category: skills.category,
        description: skills.description,
        retiredAt: skills.retiredAt,
        judged: sql<number>`(select count(distinct a.student_id)::int from skill_assessments a where a.skill_id = ${skills.id} and a.source = 'faculty')`,
        selfJudged: sql<number>`(select count(distinct a.student_id)::int from skill_assessments a where a.skill_id = ${skills.id} and a.source = 'self')`,
      })
      .from(skills)
      .where(eq(skills.frameworkId, f.id))
      .orderBy(asc(skills.retiredAt), asc(skills.category), asc(skills.code))
    return { framework: f, levels: scale, skills: list }
  })
}

// --- judgements ----------------------------------------------------------------

async function studentIn(tx: Tx, studentId: string) {
  const [s] = await tx.select({ id: users.id, name: users.name, email: users.email, role: users.role }).from(users).where(eq(users.id, studentId))
  if (!s || s.role !== 'student') throw new SkillError(404, 'no_such_student', 'no such student')
  return s
}

async function levelName(tx: Tx, skillId: string, rank: number) {
  const [row] = await tx
    .select({ name: levels.name })
    .from(levels)
    .innerJoin(skills, eq(skills.frameworkId, levels.frameworkId))
    .where(and(eq(skills.id, skillId), eq(levels.rank, rank)))
  return row?.name ?? String(rank)
}

/** A teacher's judgement, with the evidence it rests on. */
export async function assess(actor: Actor, input: unknown) {
  const tenant = requireStaff(actor)
  const d = assessSchema.parse(input)
  return named(() =>
    withTenant(tenant, async (tx) => {
      const s = await studentIn(tx, d.studentId)
      const [row] = await tx
        .insert(assessments)
        .values({
          institutionId: tenant,
          studentId: s.id,
          skillId: d.skillId,
          rank: d.rank,
          source: 'faculty',
          assessorId: actor.id,
          evidence: d.evidence,
          assessedOn: d.assessedOn ?? today(),
        })
        .returning()
      await audit(tx, {
        ...who(actor, tenant),
        action: 'skills.assessed',
        entity: 'skill_assessments',
        entityId: row!.id,
        reason: d.evidence.slice(0, 200),
        detail: { studentId: s.id, skillId: d.skillId, rank: d.rank },
      })
      return { ...row!, notice: `Recorded: ${s.name ?? s.email} at ${await levelName(tx, d.skillId, d.rank)}.` }
    }),
  )
}

/** A student's own judgement. Recorded beside the teacher's, never over it. */
export async function selfAssess(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  if (actor.role !== 'student') throw new SkillError(403, 'forbidden', 'a self-assessment is by the student')
  const d = selfAssessSchema.parse(input)
  return named(() =>
    withTenant(tenant, async (tx) => {
      const [row] = await tx
        .insert(assessments)
        .values({
          institutionId: tenant,
          studentId: actor.id,
          skillId: d.skillId,
          rank: d.rank,
          source: 'self',
          assessorId: actor.id,
          evidence: d.evidence || null,
        })
        .returning()
      return { ...row!, notice: `Recorded: you put yourself at ${await levelName(tx, d.skillId, d.rank)}.` }
    }),
  )
}

/**
 * A student's skills: for each live skill, the latest judgement from each
 * side, the gap between them, and the whole history. The student sees their
 * own; staff see anybody's.
 */
export async function profile(actor: Actor, studentId: string) {
  const tenant = tenantOf(actor)
  if (!isStaff(actor.role) && actor.id !== studentId) throw new SkillError(403, 'forbidden', 'not permitted')
  return withTenant(tenant, async (tx) => {
    const student = await studentIn(tx, studentId)
    const live = await tx
      .select({ id: skills.id, code: skills.code, name: skills.name, category: skills.category, frameworkId: skills.frameworkId, retiredAt: skills.retiredAt })
      .from(skills)
      .orderBy(asc(skills.category), asc(skills.code))
    const allLevels = await tx.select().from(levels).orderBy(asc(levels.rank))
    const history = await tx
      .select({ a: assessments, assessor: users.name })
      .from(assessments)
      .leftJoin(users, eq(users.id, assessments.assessorId))
      .where(eq(assessments.studentId, studentId))
      .orderBy(desc(assessments.assessedOn), desc(assessments.createdAt))

    const name = (frameworkId: string, rank: number | null) =>
      rank === null ? null : (allLevels.find((l) => l.frameworkId === frameworkId && l.rank === rank)?.name ?? String(rank))
    const top = (frameworkId: string) => Math.max(0, ...allLevels.filter((l) => l.frameworkId === frameworkId).map((l) => l.rank))

    const rows = live
      .filter((s) => !s.retiredAt || history.some((h) => h.a.skillId === s.id))
      .map((s) => {
        const mine = history.filter((h) => h.a.skillId === s.id)
        const self = mine.find((h) => h.a.source === 'self')
        const staff = mine.find((h) => h.a.source === 'faculty')
        const selfRank = self?.a.rank ?? null
        const staffRank = staff?.a.rank ?? null
        return {
          skillId: s.id,
          code: s.code,
          name: s.name,
          category: s.category,
          outOf: top(s.frameworkId),
          self: name(s.frameworkId, selfRank),
          selfRank,
          selfOn: self?.a.assessedOn ?? null,
          teacher: name(s.frameworkId, staffRank),
          teacherRank: staffRank,
          teacherOn: staff?.a.assessedOn ?? null,
          teacherBy: staff?.assessor ?? null,
          evidence: staff?.a.evidence ?? null,
          // Positive: the teacher sees more than the student claims.
          gap: selfRank !== null && staffRank !== null ? staffRank - selfRank : null,
          judgements: mine.length,
          retired: !!s.retiredAt,
        }
      })

    return {
      student: { id: student.id, name: student.name ?? student.email ?? student.id },
      skills: rows,
      history: history.map(({ a, assessor }) => {
        const s = live.find((x) => x.id === a.skillId)
        return {
          id: a.id,
          code: s?.code ?? '',
          skill: s?.name ?? '',
          level: s ? name(s.frameworkId, a.rank) : String(a.rank),
          rank: a.rank,
          source: a.source,
          by: a.source === 'self' ? 'self' : (assessor ?? ''),
          evidence: a.evidence,
          assessedOn: a.assessedOn,
        }
      }),
    }
  })
}

export async function listStudents(actor: Actor) {
  const tenant = requireStaff(actor)
  return withTenant(tenant, (tx) =>
    tx
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        judgements: sql<number>`(select count(*)::int from skill_assessments a where a.student_id = ${users.id} and a.source = 'faculty')`,
        selfJudgements: sql<number>`(select count(*)::int from skill_assessments a where a.student_id = ${users.id} and a.source = 'self')`,
        lastOn: sql<string | null>`(select max(a.assessed_on)::text from skill_assessments a where a.student_id = ${users.id})`,
      })
      .from(users)
      .where(eq(users.role, 'student'))
      .orderBy(asc(users.name)),
  )
}

/**
 * Across the institution, per skill: how many students a teacher has judged,
 * and the average level each side gives -- the gap between how students see
 * themselves and how they are seen, which is what a skills programme acts on.
 */
export async function coverage(actor: Actor) {
  const tenant = requireStaff(actor)
  return withTenant(tenant, async (tx) => {
    // Only each student's latest judgement from each side counts.
    const rows = await tx.execute(sql`
      with latest as (
        select distinct on (student_id, skill_id, source) student_id, skill_id, source, rank
          from skill_assessments
         order by student_id, skill_id, source, assessed_on desc, created_at desc
      )
      select s.id, s.code, s.name,
             count(distinct l.student_id) filter (where l.source = 'faculty')::int as judged,
             round(avg(l.rank) filter (where l.source = 'self'), 2)::float as self_avg,
             round(avg(l.rank) filter (where l.source = 'faculty'), 2)::float as teacher_avg
        from skill_skills s
        left join latest l on l.skill_id = s.id
       where s.retired_at is null
       group by s.id, s.code, s.name
       order by s.code`)
    return (rows.rows as { id: string; code: string; name: string; judged: number; self_avg: number | null; teacher_avg: number | null }[]).map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      judged: r.judged,
      selfAvg: r.self_avg,
      teacherAvg: r.teacher_avg,
    }))
  })
}

/** Skills a judgement may be recorded against, for the pickers. */
export async function skillChoices(actor: Actor) {
  const tenant = tenantOf(actor)
  return withTenant(tenant, (tx) =>
    tx
      .select({ id: skills.id, code: skills.code, name: skills.name, frameworkId: skills.frameworkId })
      .from(skills)
      .where(isNull(skills.retiredAt))
      .orderBy(asc(skills.code)),
  )
}

/**
 * The levels, as one list of ranks for a picker: most institutions have one
 * scale, and where there are several a rank reads as each scale's name for it.
 * The database checks the rank against the skill's own scale.
 */
export async function levelChoices(actor: Actor) {
  const tenant = tenantOf(actor)
  const all: Level[] = await withTenant(tenant, (tx) => tx.select().from(levels).orderBy(asc(levels.rank)))
  const ranks = [...new Set(all.map((l) => l.rank))]
  return ranks.map((r) => ({
    value: String(r),
    label: `${r}. ${[...new Set(all.filter((l) => l.rank === r).map((l) => l.name))].join(' / ')}`,
  }))
}

export async function frameworkChoices(actor: Actor) {
  const tenant = requireAdmin(actor)
  return withTenant(tenant, (tx) => tx.select({ id: frameworks.id, name: frameworks.name }).from(frameworks).orderBy(asc(frameworks.name)))
}

export type Profile = Awaited<ReturnType<typeof profile>>
