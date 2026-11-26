import { gradePointAverage, round2, type Attempt, type GpaPolicyVersion } from '@campusos/module-academic/gpa'
import type { examKindEnum } from '../schema'
import type { SchoolTemplate } from './school-policy'

/**
 * Grade computation, kept pure so it is testable without a database and
 * identical wherever it runs.
 *
 * Everything is done in tenths of a percent as integers where rounding matters.
 * Floating point on marks is how a 39.999 becomes a fail that the student can
 * see is a 40 on their own arithmetic, and that is precisely the conversation
 * this module exists to avoid.
 */

export interface Band {
  minPercent: number
  label: string
  points: number | null
  isPass: boolean
}

export interface ExamResult {
  examId: string
  maxMarks: number
  weightPercent: number
  obtained: number | null
  absent: boolean
}

export { round2 }

export type CoursePercent =
  | { kind: 'complete'; percent: number }
  | { kind: 'incomplete'; percent: number; missingWeight: number }

/**
 * Weighted percentage across a course's exams.
 *
 * An absent student scores zero for that component -- they sat out a weighted
 * part of the course. A pending mark (null, not absent) is different: it is
 * excluded and reported as missing weight, because presenting a partial total
 * as if it were final is how a provisional grade becomes a dispute.
 */
export function coursePercent(results: ExamResult[]): CoursePercent {
  let earned = 0
  let counted = 0
  let missing = 0

  for (const r of results) {
    if (r.absent) {
      counted += r.weightPercent
      continue
    }
    if (r.obtained === null) {
      missing += r.weightPercent
      continue
    }
    const fraction = r.maxMarks > 0 ? r.obtained / r.maxMarks : 0
    earned += fraction * r.weightPercent
    counted += r.weightPercent
  }

  if (counted === 0) {
    return { kind: 'incomplete', percent: 0, missingWeight: round2(missing) }
  }

  // Normalised over the weight actually counted, so a course whose exams do
  // not sum to 100 still yields a percentage rather than a fraction of one.
  const percent = round2((earned / counted) * 100)
  return missing > 0
    ? { kind: 'incomplete', percent, missingWeight: round2(missing) }
    : { kind: 'complete', percent }
}

/**
 * The band a percentage falls into: the highest floor at or below it. Bands are
 * floors only, so gaps and overlaps are not expressible.
 */
export function bandFor(bands: Band[], percent: number): Band | null {
  let best: Band | null = null
  for (const b of bands) {
    if (percent >= b.minPercent && (!best || b.minPercent > best.minPercent)) best = b
  }
  return best
}

export interface CourseGrade {
  percent: number
  complete: boolean
  label: string | null
  points: number | null
  passed: boolean
  credits: number
}

export function gradeCourse(
  bands: Band[],
  credits: number,
  results: ExamResult[],
): CourseGrade {
  const p = coursePercent(results)
  const band = bandFor(bands, p.percent)
  return {
    percent: p.percent,
    complete: p.kind === 'complete',
    label: band?.label ?? null,
    points: band?.points ?? null,
    // No band means no verdict. Defaulting to a pass would be generous in the
    // one direction nobody audits.
    passed: band?.isPass ?? false,
    credits,
  }
}

/**
 * How an institution grades a course and averages the results: the university
 * grade-point policy, or the school's marks-and-grade policy (P1-13b), chosen
 * by `gradingPolicyFor` without touching its callers.
 */
export interface GradingPolicy {
  readonly id: 'university-grade-points' | 'school-marks'
  gradeCourse(bands: Band[], credits: number, results: ExamResult[]): CourseGrade
  average(attempts: Attempt[], versions: GpaPolicyVersion[]): { value: number | null; credits: number }
}

export const UNIVERSITY_GRADE_POINTS: GradingPolicy = {
  id: 'university-grade-points',
  gradeCourse,
  average: gradePointAverage,
}

/** A school grades marks into a band label: no points and no credits, so no average. */
export const SCHOOL_MARKS: GradingPolicy = {
  id: 'school-marks',
  gradeCourse: (bands, _credits, results) => ({ ...gradeCourse(bands, 0, results), points: null, credits: 0 }),
  average: () => ({ value: null, credits: 0 }),
}

export function gradingPolicyFor(kind: 'percentage' | 'gpa' | 'custom' | 'school'): GradingPolicy {
  return kind === 'school' ? SCHOOL_MARKS : UNIVERSITY_GRADE_POINTS
}

/** A sane default an institution can adopt or replace. Indian 10-point scale. */
export const DEFAULT_GPA_BANDS: Band[] = [
  { minPercent: 90, label: 'O', points: 10, isPass: true },
  { minPercent: 80, label: 'A+', points: 9, isPass: true },
  { minPercent: 70, label: 'A', points: 8, isPass: true },
  { minPercent: 60, label: 'B+', points: 7, isPass: true },
  { minPercent: 50, label: 'B', points: 6, isPass: true },
  { minPercent: 45, label: 'C', points: 5, isPass: true },
  { minPercent: 40, label: 'P', points: 4, isPass: true },
  { minPercent: 0, label: 'F', points: 0, isPass: false },
]

// --- school subjects (P1-13b) ----------------------------------------------------

export type SchoolExam = ExamResult & { kind: (typeof examKindEnum.enumValues)[number]; name: string; published: boolean }

export interface SchoolSubject {
  components: { key: string; label: string; value: number | null; max: number; absent: boolean }[]
  total: number | null
  grade: string | null
}

/** Exact fractions of bigints: marks are hundredths, and nothing divides until the one rounding. */
type Frac = { n: bigint; d: bigint }
const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b))
const frac = (n: bigint, d: bigint): Frac => {
  const g = gcd(n < 0n ? -n : n, d) || 1n
  return { n: n / g, d: d / g }
}
const add = (a: Frac, b: Frac) => frac(a.n * b.d + b.n * a.d, a.d * b.d)
const hundredths = (x: number) => BigInt(Math.round(x * 100))
/** Round half up to hundredths. */
const roundH = (f: Frac) => (f.n * 200n + f.d) / (2n * f.d)
const norm = (s: string) => s.trim().toLowerCase()

/**
 * One subject's marks under a template. A component is the weighted share of
 * the exams that map to it (a named selector first, then one that names only
 * the kind); a component with nothing to count, an unpublished exam or a mark
 * not yet entered is pending, and so is the subject. An exam no component
 * names makes the subject pending too: a total that silently ignored an
 * assessment would be wrong. Absent counts as zero.
 */
export function schoolSubject(template: SchoolTemplate, courseCode: string, exams: SchoolExam[]): SchoolSubject {
  const set = template.subjectOverrides.find((o) => norm(o.courseCode) === norm(courseCode))?.components ?? template.components
  const home = (e: SchoolExam) => {
    const named = set.find((c) => c.selectors.some((s) => s.kind === e.kind && s.name !== undefined && norm(s.name) === norm(e.name)))
    return named ?? set.find((c) => c.selectors.some((s) => s.kind === e.kind && s.name === undefined))
  }
  const mapped = new Map<string, SchoolExam[]>()
  let stray = false
  for (const e of exams) {
    const c = home(e)
    if (!c) stray = true
    else mapped.set(c.key, [...(mapped.get(c.key) ?? []), e])
  }
  let total: Frac | null = { n: 0n, d: 1n }
  const components = set.map((c) => {
    const rows = mapped.get(c.key) ?? []
    const base = { key: c.key, label: c.label, max: c.weight }
    if (!rows.length || rows.some((e) => !e.published || (!e.absent && e.obtained === null))) {
      total = null
      return { ...base, value: null, absent: false }
    }
    let earned: Frac = { n: 0n, d: 1n }
    let weights = 0n
    for (const e of rows) {
      const w = hundredths(e.weightPercent)
      weights += w
      if (!e.absent) earned = add(earned, frac(w * hundredths(e.obtained!), hundredths(e.maxMarks)))
    }
    const share = weights === 0n ? { n: 0n, d: 1n } : frac(earned.n * BigInt(c.weight), earned.d * weights)
    if (total) total = add(total, share)
    return { ...base, value: Number(roundH(share)) / 100, absent: rows.every((e) => e.absent) }
  })
  if (stray || !total) return { components, total: null, grade: null }
  const percent = Number(roundH(total)) / 100
  const bands = template.bands.map((b) => ({ minPercent: b.floor, label: b.grade, points: null, isPass: true }))
  const graded = SCHOOL_MARKS.gradeCourse(bands, 0, [{ examId: 'total', maxMarks: 100, weightPercent: 100, obtained: percent, absent: false }])
  return { components, total: percent, grade: graded.label }
}
