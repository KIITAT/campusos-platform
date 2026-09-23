/**
 * Auto-scoring. Pure: a question's key, a student's answer, the marks the quiz
 * gives the question and its penalty for a wrong answer -- and what that earns.
 *
 * Only questions with one right answer a machine can check are asked here.
 * An essay is not auto-scored by pretending; it belongs to Examinations, where
 * a person marks it.
 */

export type QuestionKind = 'single' | 'multiple' | 'true_false' | 'short' | 'numeric'

export const KINDS: readonly QuestionKind[] = ['single', 'multiple', 'true_false', 'short', 'numeric']

export interface Choice {
  id: string
  label: string
  correct: boolean
}

export interface AnswerKey {
  kind: QuestionKind
  choices: Choice[]
  acceptedAnswers: string[]
  numericAnswer: string | number | null
  tolerance: string | number | null
  partialCredit: boolean
}

/** A choice id, several, some text, or a number -- as posted, before reading. */
export type Answer = string | number | string[] | null | undefined

export interface Scored {
  /** Null when left blank: not wrong, not right, and never penalised. */
  correct: boolean | null
  awarded: number
}

// `+ 0` turns a negative zero -- no penalty on no marks -- into a plain one.
const round2 = (n: number) => Math.round(n * 100) / 100 + 0

/** How two short answers are compared: case, spacing and Unicode forms aside. */
export const normalise = (s: string) => s.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ')

const asList = (a: Answer): string[] =>
  a === null || a === undefined
    ? []
    : Array.isArray(a)
      ? a.map(String).filter((s) => s !== '')
      : String(a) === ''
        ? []
        : String(a).split(',').map((s) => s.trim()).filter(Boolean)

export const isBlank = (a: Answer): boolean => asList(a).length === 0

/**
 * Score one answer.
 *
 * `penaltyPercent` is the share of the question's marks taken away for a wrong
 * answer to an objective question -- negative marking, which some institutions
 * use and most do not; the quiz says which. A blank is never penalised, and a
 * partly right answer to a question giving partial credit earns what it earns
 * rather than a penalty. The quiz total is floored at zero elsewhere.
 */
export function scoreAnswer(key: AnswerKey, answer: Answer, points: number, penaltyPercent = 0): Scored {
  if (isBlank(answer)) return { correct: null, awarded: 0 }
  const wrong = (): Scored => ({ correct: false, awarded: round2(-(points * penaltyPercent) / 100) })
  const right = (): Scored => ({ correct: true, awarded: round2(points) })

  switch (key.kind) {
    case 'single':
    case 'true_false': {
      const picked = asList(answer)
      if (picked.length !== 1) return wrong()
      const choice = key.choices.find((c) => c.id === picked[0])
      return choice?.correct ? right() : wrong()
    }

    case 'multiple': {
      const picked = new Set(asList(answer))
      const correct = new Set(key.choices.filter((c) => c.correct).map((c) => c.id))
      const hits = [...picked].filter((id) => correct.has(id)).length
      const misses = [...picked].filter((id) => !correct.has(id)).length
      if (hits === correct.size && misses === 0) return right()
      if (key.partialCredit) {
        // Each right choice earns its share; each wrong one takes a share back.
        const share = Math.max(0, (hits - misses) / correct.size)
        if (share > 0) return { correct: false, awarded: round2(points * share) }
      }
      return wrong()
    }

    case 'short': {
      // Taken whole: a comma in a short answer is part of the answer.
      const given = normalise(Array.isArray(answer) ? answer.join(', ') : String(answer))
      return key.acceptedAnswers.some((a) => normalise(a) === given) ? right() : wrong()
    }

    case 'numeric': {
      const raw = String(Array.isArray(answer) ? answer[0] : answer).trim()
      const x = Number(raw)
      if (raw === '' || !Number.isFinite(x)) return wrong()
      const target = Number(key.numericAnswer)
      const tol = Math.abs(Number(key.tolerance ?? 0))
      // A hair of slack for binary fractions: 0.1 + 0.2 is an answer of 0.3.
      return Math.abs(x - target) <= tol + 1e-9 ? right() : wrong()
    }
  }
}

/** The whole attempt: the sum of what each answer earned, never below zero. */
export const total = (awarded: number[]): number => round2(Math.max(0, awarded.reduce((s, n) => s + n, 0)))

/**
 * Options typed one per line, the right ones marked with a leading `*`:
 *
 *     * Paris
 *     Lyon
 *
 * which is how a teacher writes a question on paper, and needs no editor.
 */
export function parseChoices(text: string): Choice[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line, i) => {
      const correct = line.startsWith('*')
      return {
        id: String.fromCharCode(97 + i),
        label: correct ? line.slice(1).trim() : line,
        correct,
      }
    })
}

/** What a student is shown: the choices, and nothing about which are right. */
export const choicesForTaker = (choices: Choice[]) => choices.map(({ id, label }) => ({ id, label }))

/** The key, written out for a reader allowed to see it. */
export function describeKey(key: AnswerKey): string {
  switch (key.kind) {
    case 'single':
    case 'multiple':
    case 'true_false':
      return key.choices.filter((c) => c.correct).map((c) => c.label).join('; ')
    case 'short':
      return key.acceptedAnswers.join(' / ')
    case 'numeric': {
      const tol = Number(key.tolerance ?? 0)
      return tol ? `${key.numericAnswer} ± ${tol}` : String(key.numericAnswer)
    }
  }
}

/** A student's answer, written out: choice labels rather than ids. */
export function describeAnswer(key: AnswerKey, answer: Answer): string {
  if (isBlank(answer)) return ''
  if (key.kind === 'short' || key.kind === 'numeric') return Array.isArray(answer) ? answer.join(', ') : String(answer)
  const ids = new Set(asList(answer))
  return key.choices.filter((c) => ids.has(c.id)).map((c) => c.label).join('; ')
}
