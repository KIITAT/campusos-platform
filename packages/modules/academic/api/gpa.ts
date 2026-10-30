/**
 * The one grade point average. Pure, so every document that prints one (the
 * degree audit, the transcripts, the grade report, placement eligibility)
 * computes it the same way, under the rules the institution had in force when
 * each term started.
 */

export type FailedCredits = 'exclude' | 'zero'
export type RepeatRule = 'all' | 'latest' | 'best'
export interface GpaRules {
  failedCredits: FailedCredits
  repeats: RepeatRule
}
export interface GpaPolicyVersion extends GpaRules {
  effectiveFrom: string
}
export interface Attempt {
  courseId: string
  termStartsOn: string | null
  credits: number
  points: number | null
  passed: boolean
}

export const CORRECTED_GPA_RULES: GpaRules = { failedCredits: 'zero', repeats: 'latest' }
export const LEGACY_GPA_RULES: GpaRules = { failedCredits: 'exclude', repeats: 'all' }
const EARLIEST = '0001-01-01'

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

/** The rules of the latest version in force on `day` (null: transfer, the earliest day). */
export function rulesOn(versions: GpaPolicyVersion[], day: string | null): GpaRules {
  const on = day ?? EARLIEST
  let best: GpaPolicyVersion | null = null
  for (const v of versions) if (v.effectiveFrom <= on && (!best || v.effectiveFrom > best.effectiveFrom)) best = v
  return best ? { failedCredits: best.failedCredits, repeats: best.repeats } : CORRECTED_GPA_RULES
}

/**
 * Credit-weighted average of points. An attempt with no points (pass/fail,
 * ungraded transfer credit) counts towards nothing. A failed attempt counts
 * its credits at zero points or not at all, and a repeated course counts its
 * latest, best or every attempt, by the rules in force for its latest attempt.
 */
export function gradePointAverage(
  attempts: Attempt[],
  versions: GpaPolicyVersion[],
): { value: number | null; credits: number } {
  const byCourse = new Map<string, Attempt[]>()
  for (const at of attempts) byCourse.set(at.courseId, [...(byCourse.get(at.courseId) ?? []), at])
  let weighted = 0
  let credits = 0
  for (const group of byCourse.values()) {
    group.sort((x, y) => (x.termStartsOn ?? EARLIEST).localeCompare(y.termStartsOn ?? EARLIEST))
    const latest = group[group.length - 1]!
    const rule = rulesOn(versions, latest.termStartsOn)
    let counted: Attempt[]
    if (rule.repeats === 'all') counted = group
    else if (rule.repeats === 'latest') counted = [latest]
    else {
      let top = group[0]!
      for (const at of group) if (at.points !== null && (top.points === null || at.points >= top.points)) top = at
      counted = [top]
    }
    for (const at of counted) {
      if (at.points === null) continue
      if (!at.passed && rulesOn(versions, at.termStartsOn).failedCredits === 'exclude') continue
      weighted += (at.passed ? at.points : 0) * at.credits
      credits += at.credits
    }
  }
  return credits === 0 ? { value: null, credits: 0 } : { value: round2(weighted / credits), credits }
}
