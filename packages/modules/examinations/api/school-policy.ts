import * as z from 'zod'
import { examKindEnum } from '../schema'

/**
 * A school's term report template (FUNC-03, P1-13b): which exams make up which
 * component of a subject's marks, the grade bands, and the teacher-observed
 * areas. One validated version-1 document per tenant, term and programme.
 */

const KEY = /^[a-z][a-z0-9_-]{0,31}$/
const text = (max: number) => z.string().trim().min(1).max(max)
const key = z.string().trim().regex(KEY)
const kinds = examKindEnum.enumValues

const selector = z.strictObject({ kind: z.enum(kinds), name: text(80).optional() })
const component = z.strictObject({
  key,
  label: text(80),
  weight: z.number().int().min(1).max(100),
  selectors: z.array(selector).min(1).max(12),
})
const area = z.strictObject({
  key: key.refine((k) => k !== 'remark', 'remark is reserved'),
  label: text(80),
  group: z.enum(['scholastic', 'co_scholastic']),
  grades: z.array(z.strictObject({ key, label: text(80) })).min(1).max(8),
})

export type Component = z.infer<typeof component>

const norm = (s: string) => s.trim().toLowerCase()

/** Unique keys, unique selectors, weights summing to 100: one set of components. */
function checkComponents(set: Component[], path: (string | number)[], ctx: z.RefinementCtx) {
  if (new Set(set.map((c) => c.key)).size !== set.length) ctx.addIssue({ code: 'custom', path, message: 'component keys must be unique' })
  const seen = new Set<string>()
  set.forEach((c, i) =>
    c.selectors.forEach((s, j) => {
      const k = `${s.kind}|${s.name === undefined ? '' : norm(s.name)}`
      if (seen.has(k)) ctx.addIssue({ code: 'custom', path: [...path, i, 'selectors', j], message: 'a selector can map to one component only' })
      seen.add(k)
    }),
  )
  if (set.reduce((n, c) => n + c.weight, 0) !== 100) ctx.addIssue({ code: 'custom', path, message: 'component weights must sum to 100' })
}

export const schoolTemplateSchema = z
  .strictObject({
    version: z.literal(1),
    classNumber: z.number().int().min(1).max(10),
    name: text(70),
    mode: z.enum(['observations', 'marks']),
    components: z.array(component).max(6),
    subjectOverrides: z.array(z.strictObject({ courseCode: text(32), components: z.array(component).max(6) })).max(20),
    bands: z.array(z.strictObject({ floor: z.number().min(0).max(100), grade: text(20) })).max(12),
    areas: z.array(area).max(16),
    remarks: z.array(z.strictObject({ key, label: text(80) })).max(8),
  })
  .superRefine((t, ctx) => {
    const dup = (xs: string[], path: string, msg: string) => {
      if (new Set(xs).size !== xs.length) ctx.addIssue({ code: 'custom', path: [path], message: msg })
    }
    dup(t.areas.map((a) => a.key), 'areas', 'area keys must be unique')
    t.areas.forEach((a, i) => dup(a.grades.map((g) => g.key), `areas.${i}.grades`, 'grade keys must be unique'))
    dup(t.remarks.map((r) => r.key), 'remarks', 'remark keys must be unique')
    dup(t.subjectOverrides.map((o) => norm(o.courseCode)), 'subjectOverrides', 'subject codes must be unique')
    dup(t.bands.map((b) => String(b.floor)), 'bands', 'band floors must be unique')
    if (t.mode === 'observations') {
      if (t.components.length || t.subjectOverrides.length || t.bands.length)
        ctx.addIssue({ code: 'custom', path: ['mode'], message: 'an observation template has no components, overrides or bands' })
      if (!t.areas.some((a) => a.group === 'scholastic')) ctx.addIssue({ code: 'custom', path: ['areas'], message: 'an observation template needs a scholastic area' })
    } else {
      if (!t.components.length) ctx.addIssue({ code: 'custom', path: ['components'], message: 'a marks template needs a component' })
      else checkComponents(t.components, ['components'], ctx)
      t.subjectOverrides.forEach((o, i) => {
        if (!o.components.length) ctx.addIssue({ code: 'custom', path: ['subjectOverrides', i, 'components'], message: 'an override needs a component' })
        else checkComponents(o.components, ['subjectOverrides', i, 'components'], ctx)
      })
      if (!t.bands.some((b) => b.floor === 0)) ctx.addIssue({ code: 'custom', path: ['bands'], message: 'bands need a floor of zero' })
      if (t.areas.some((a) => a.group === 'scholastic')) ctx.addIssue({ code: 'custom', path: ['areas'], message: 'a marks template has no scholastic observation area' })
    }
  })

export type SchoolTemplate = z.infer<typeof schoolTemplateSchema>

const grades3 = [
  { key: 'beginner', label: 'Beginner' },
  { key: 'progressing', label: 'Progressing' },
  { key: 'proficient', label: 'Proficient' },
]
const REMARKS = [
  { key: 'steady', label: 'Steady progress this term.' },
  { key: 'practice', label: 'Regular practice will help build confidence.' },
]

const areas = (group: 'scholastic' | 'co_scholastic', rows: [string, string][], grades: { key: string; label: string }[]) =>
  rows.map(([k, label]) => ({ key: k, label, group, grades }))

const letters = (n: number) => 'abcde'.slice(0, n).split('').map((c) => ({ key: c, label: c.toUpperCase() }))

/** CBSE Circular 35/2017 Annexure 2 marks bands, kept as the local default for VI to X. */
const BANDS = [
  { floor: 91, grade: 'A1' },
  { floor: 81, grade: 'A2' },
  { floor: 71, grade: 'B1' },
  { floor: 61, grade: 'B2' },
  { floor: 51, grade: 'C1' },
  { floor: 41, grade: 'C2' },
  { floor: 33, grade: 'D' },
  { floor: 0, grade: 'E' },
]

const sel = (kind: Component['selectors'][number]['kind'], name?: string) => (name === undefined ? { kind } : { kind, name })
const comp = (k: string, label: string, weight: number, ...selectors: Component['selectors']): Component => ({ key: k, label, weight, selectors })
const term = comp('term_exam', 'Term examination', 80, sel('midterm'), sel('final'))
const periodic = (w: number) => comp('periodic', 'Periodic test', w, sel('quiz', 'Periodic Test'))

/** The built-in template for a class, or null where none is defined (XI and XII). */
export function defaultSchoolTemplate(classNumber: number): SchoolTemplate | null {
  if (!Number.isInteger(classNumber) || classNumber < 1 || classNumber > 10) return null
  const base = { version: 1 as const, classNumber, remarks: REMARKS }
  if (classNumber <= 2)
    return {
      ...base,
      name: 'Foundational progress',
      mode: 'observations',
      components: [],
      subjectOverrides: [],
      bands: [],
      areas: [
        ...areas('scholastic', [['language', 'Language and literacy'], ['numeracy', 'Numeracy'], ['exploration', 'Exploration']], grades3),
        ...areas('co_scholastic', [['creative', 'Creative expression'], ['physical', 'Physical development'], ['social', 'Social participation']], grades3),
      ],
    }
  if (classNumber <= 5)
    return {
      ...base,
      name: 'Preparatory progress',
      mode: 'observations',
      components: [],
      subjectOverrides: [],
      bands: [],
      areas: [
        ...areas('scholastic', [['languages', 'Languages'], ['maths', 'Mathematics'], ['world', 'The world around us']], grades3),
        ...areas('co_scholastic', [['arts', 'Arts'], ['physical', 'Physical education'], ['work', 'Work and projects'], ['participation', 'Participation']], grades3),
      ],
    }
  if (classNumber <= 8)
    return {
      ...base,
      name: 'Middle school term report',
      mode: 'marks',
      components: [
        periodic(10),
        comp('notebook', 'Notebook', 5, sel('assignment', 'Notebook')),
        comp('enrichment', 'Subject enrichment', 5, sel('assignment', 'Subject Enrichment')),
        term,
      ],
      subjectOverrides: [],
      bands: BANDS,
      areas: areas('co_scholastic', [['work', 'Work Education'], ['art', 'Art Education'], ['health', 'Health and Physical Education'], ['discipline', 'Discipline']], letters(3)),
    }
  const secondary = (rows: [string, string][]): SchoolTemplate => ({
    ...base,
    name: 'Secondary school term report',
    mode: 'marks',
    components: [
      periodic(5),
      comp('multiple', 'Multiple assessment', 5, sel('assignment', 'Multiple Assessment')),
      comp('portfolio', 'Portfolio', 5, sel('assignment', 'Portfolio')),
      comp('enrichment', 'Subject enrichment', 5, sel('assignment', 'Subject Enrichment'), sel('practical', 'Lab Practical')),
      term,
    ],
    subjectOverrides: [],
    bands: BANDS,
    areas: areas('co_scholastic', rows, letters(5)),
  })
  return classNumber === 9
    ? secondary([['art', 'Art Education'], ['wellbeing', 'Physical Education and Well-being'], ['discipline', 'Discipline']])
    : secondary([['work', 'Work Education'], ['art', 'Art Education'], ['health', 'Health and Physical Education'], ['discipline', 'Discipline']])
}

/** The class a programme code names: CLASS-1 to CLASS-10, any case. */
export function classNumberOf(programCode: string): number | null {
  const m = /^CLASS-(10|[1-9])$/i.exec(programCode.trim())
  return m ? Number(m[1]) : null
}

/** Stable text for comparing two templates, key order aside. */
export function canonicalTemplate(t: SchoolTemplate): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, sort(x)])) : v
  return JSON.stringify(sort(t))
}
