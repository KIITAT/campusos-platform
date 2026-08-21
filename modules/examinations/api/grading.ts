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

/**
 * Two decimal places, half away from zero, the way a person would.
 *
 * Two separate corrections, both load-bearing:
 *
 * `toFixed(6)` first, to shed the representation noise. 79.99/200*100 is
 * exactly 39.995 in decimal but 39.994999999999997 as a double, and rounding
 * that directly gives 39.99 -- a fail the student can see, on their own
 * arithmetic, is a 40. Six places is far coarser than the error and far finer
 * than any real mark, so it cannot move a genuine value.
 *
 * Then scaling through a decimal string rather than by multiplying: `39.995 *
 * 100` is 3999.4999999999995, whereas `Number('39.995e2')` is exactly 3999.5,
 * because the literal parser works in decimal.
 */
export function round2(n: number): number {
  if (!Number.isFinite(n)) return 0
  const settled = Number(n.toFixed(6))
  const scaled = Number(`${settled}e2`)
  if (!Number.isFinite(scaled)) return settled
  const rounded = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled)
  return Number(`${rounded}e-2`)
}

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
 * Credit-weighted average of points. Only courses that yielded points count:
 * a failed or pending course contributes neither points nor credits, which is
 * the usual convention and the only one that does not silently drag an average
 * down for work not yet marked.
 */
export function gpa(grades: CourseGrade[]): { value: number | null; credits: number } {
  let weighted = 0
  let credits = 0
  for (const g of grades) {
    if (g.points === null || !g.passed || !g.complete) continue
    weighted += g.points * g.credits
    credits += g.credits
  }
  return credits === 0
    ? { value: null, credits: 0 }
    : { value: round2(weighted / credits), credits }
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
