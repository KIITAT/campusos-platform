import * as z from 'zod'

const uuid = z.uuid()

/**
 * Levels typed one per line, lowest first, each as `Name: what it means` --
 *
 *     Beginner: needs guidance on routine tasks
 *     Practitioner: works unaided on routine tasks
 *
 * which is how a rubric is written on paper.
 */
const levelLines = z.preprocess(
  (v) =>
    typeof v === 'string'
      ? v
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => {
            const at = l.indexOf(':')
            return at > 0 ? { name: l.slice(0, at).trim(), descriptor: l.slice(at + 1).trim() } : { name: l, descriptor: '' }
          })
      : v,
  z
    .array(z.object({ name: z.string().trim().min(1).max(40), descriptor: z.string().trim().min(5).max(500) }))
    .min(2)
    .max(10),
)

export const createFrameworkSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    description: z.string().trim().max(1000).optional(),
    levels: levelLines,
  })
  .meta({ id: 'SkillFrameworkCreate' })

export const addLevelSchema = z
  .object({
    frameworkId: uuid,
    name: z.string().trim().min(1).max(40),
    descriptor: z.string().trim().min(5).max(500),
  })
  .meta({ id: 'SkillLevelAdd' })

export const createSkillSchema = z
  .object({
    frameworkId: uuid,
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9][A-Z0-9_-]{0,23}$/, 'letters, digits, - and _; up to 24'),
    name: z.string().trim().min(2).max(80),
    category: z.string().trim().max(40).optional(),
    description: z.string().trim().max(1000).optional(),
  })
  .meta({ id: 'SkillCreate' })

/** One skill, or the ticked rows of a list. */
export const retireSkillsSchema = z
  .object({
    skillIds: z.preprocess(
      (v) => (typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter(Boolean) : v),
      z.array(uuid).min(1),
    ),
  })
  .meta({ id: 'SkillRetire' })

export const assessSchema = z
  .object({
    studentId: z.string().min(1),
    skillId: uuid,
    rank: z.coerce.number().int().min(1).max(10),
    evidence: z.string().trim().min(10).max(2000),
    assessedOn: z.iso.date().optional(),
  })
  .meta({ id: 'SkillAssess' })

export const selfAssessSchema = z
  .object({
    skillId: uuid,
    rank: z.coerce.number().int().min(1).max(10),
    evidence: z.string().trim().max(2000).optional(),
  })
  .meta({ id: 'SkillSelfAssess' })
