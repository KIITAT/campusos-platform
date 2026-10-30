import { gradePointAverage, round2, type Attempt, type GpaPolicyVersion } from '@campusos/module-academic/gpa'

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
 * How an institution grades a course and averages the results. One
 * implementation today, the university grade-point policy; school grading
 * (marks, percentage, board grade points) adds a second and a branch in
 * `gradingPolicyFor` without touching its callers.
 */
export interface GradingPolicy {
  readonly id: 'university-grade-points'
  gradeCourse(bands: Band[], credits: number, results: ExamResult[]): CourseGrade
  average(attempts: Attempt[], versions: GpaPolicyVersion[]): { value: number | null; credits: number }
}

export const UNIVERSITY_GRADE_POINTS: GradingPolicy = {
  id: 'university-grade-points',
  gradeCourse,
  average: gradePointAverage,
}

export function gradingPolicyFor(kind: 'percentage' | 'gpa' | 'custom'): GradingPolicy {
  void kind
  return UNIVERSITY_GRADE_POINTS
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
