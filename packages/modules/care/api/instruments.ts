import * as z from 'zod'

/**
 * The self-checks a student can take.
 *
 * Two ship with the product, because they are free to use and validated as
 * screens: the PHQ-9 (low mood) and the GAD-7 (anxiety), word for word, scored
 * as published. Others in KIIT's list -- OCD, grief, loneliness, personality
 * -- are proprietary or not validated as screens, so they are not shipped; an
 * institution may add its own checks, and must say where each comes from,
 * which the student is shown.
 *
 * A check is screening, not diagnosis, and every result page says so.
 */

export interface CheckOption {
  label: string
  score: number
}

export interface CheckItem {
  text: string
  /** The item's own answers; absent means the check's scale. */
  options?: CheckOption[]
  /** False for a question asked but not counted, like the PHQ-9's last. */
  scored?: boolean
  /** Any answer scoring above nothing here shows the crisis line at once. */
  safety?: boolean
  optional?: boolean
}

export interface CheckBand {
  from: number
  to: number
  label: string
  /** What it means and what to do, in plain words. */
  advice: string
}

export interface Check {
  code: string
  name: string
  about: string
  /** The question the items answer: "Over the last 2 weeks, how often ...". */
  stem: string
  source: string
  options: CheckOption[]
  items: CheckItem[]
  bands: CheckBand[]
  builtIn: boolean
  /** The institution's own check's row; null for a built-in one. */
  id: string | null
}

const OFTEN: CheckOption[] = [
  { label: 'Not at all', score: 0 },
  { label: 'Several days', score: 1 },
  { label: 'More than half the days', score: 2 },
  { label: 'Nearly every day', score: 3 },
]

const PFIZER =
  'Developed by Drs. Robert L. Spitzer, Janet B.W. Williams, Kurt Kroenke and colleagues, with an educational grant from Pfizer Inc. No permission required to reproduce, translate, display or distribute.'

const difficulty = (text: string): CheckItem => ({
  text,
  scored: false,
  optional: true,
  options: [
    { label: 'Not difficult at all', score: 0 },
    { label: 'Somewhat difficult', score: 0 },
    { label: 'Very difficult', score: 0 },
    { label: 'Extremely difficult', score: 0 },
  ],
})

const KEEP_AN_EYE =
  'It may pass, and it is worth noticing: sleep, food, moving about, and time with people you trust all help. Take this check again in two weeks, and talk to a counsellor if it stays or grows.'

export const PHQ9: Check = {
  code: 'PHQ-9',
  name: 'Low mood (PHQ-9)',
  about: 'Nine questions about the last two weeks, used widely to screen for depression.',
  stem: 'Over the last 2 weeks, how often have you been bothered by any of the following problems?',
  source: `Patient Health Questionnaire (PHQ-9). ${PFIZER}`,
  options: OFTEN,
  items: [
    { text: 'Little interest or pleasure in doing things' },
    { text: 'Feeling down, depressed, or hopeless' },
    { text: 'Trouble falling or staying asleep, or sleeping too much' },
    { text: 'Feeling tired or having little energy' },
    { text: 'Poor appetite or overeating' },
    { text: 'Feeling bad about yourself — or that you are a failure or have let yourself or your family down' },
    { text: 'Trouble concentrating on things, such as reading the newspaper or watching television' },
    {
      text: 'Moving or speaking so slowly that other people could have noticed? Or the opposite — being so fidgety or restless that you have been moving around a lot more than usual',
    },
    { text: 'Thoughts that you would be better off dead or of hurting yourself in some way', safety: true },
    difficulty(
      'If you checked off any problems, how difficult have these problems made it for you to do your work, take care of things at home, or get along with other people?',
    ),
  ],
  bands: [
    {
      from: 0,
      to: 4,
      label: 'Minimal',
      advice: 'Your answers show few signs of low mood over the last two weeks. If something is still on your mind, a counsellor will talk it through with you all the same.',
    },
    { from: 5, to: 9, label: 'Mild', advice: `Your answers show some signs of low mood. ${KEEP_AN_EYE}` },
    {
      from: 10,
      to: 14,
      label: 'Moderate',
      advice: 'Your answers show low mood that is probably affecting your days. This is common, and it gets better with help: a counsellor can help you make sense of it and what to do. We encourage you to ask for an appointment.',
    },
    {
      from: 15,
      to: 19,
      label: 'Moderately severe',
      advice: 'Your answers show low mood that is weighing on you a good deal. Please talk to a counsellor soon: ask for an appointment below, and say how soon you need it.',
    },
    {
      from: 20,
      to: 27,
      label: 'Severe',
      advice: 'Your answers show low mood that is weighing on you heavily. Please talk to someone today: ask for a counsellor below and choose "today", or call the helpline shown on this page.',
    },
  ],
  builtIn: true,
  id: null,
}

export const GAD7: Check = {
  code: 'GAD-7',
  name: 'Anxiety (GAD-7)',
  about: 'Seven questions about the last two weeks, used widely to screen for anxiety.',
  stem: 'Over the last 2 weeks, how often have you been bothered by the following problems?',
  source: `Generalized Anxiety Disorder scale (GAD-7). ${PFIZER}`,
  options: OFTEN,
  items: [
    { text: 'Feeling nervous, anxious, or on edge' },
    { text: 'Not being able to stop or control worrying' },
    { text: 'Worrying too much about different things' },
    { text: 'Trouble relaxing' },
    { text: 'Being so restless that it is hard to sit still' },
    { text: 'Becoming easily annoyed or irritable' },
    { text: 'Feeling afraid, as if something awful might happen' },
    difficulty(
      'If you checked any problems, how difficult have they made it for you to do your work, take care of things at home, or get along with other people?',
    ),
  ],
  bands: [
    {
      from: 0,
      to: 4,
      label: 'Minimal',
      advice: 'Your answers show few signs of anxiety over the last two weeks. If something is still on your mind, a counsellor will talk it through with you all the same.',
    },
    { from: 5, to: 9, label: 'Mild', advice: `Your answers show some signs of anxiety. ${KEEP_AN_EYE}` },
    {
      from: 10,
      to: 14,
      label: 'Moderate',
      advice: 'Your answers show anxiety that is probably affecting your days. This is common, and it gets better with help: a counsellor can help you make sense of it and what to do. We encourage you to ask for an appointment.',
    },
    {
      from: 15,
      to: 21,
      label: 'Severe',
      advice: 'Your answers show anxiety that is weighing on you heavily. Please talk to a counsellor soon: ask for an appointment below, and choose "today" if you need it.',
    },
  ],
  builtIn: true,
  id: null,
}

export const BUILT_IN: Check[] = [PHQ9, GAD7]
export const BUILT_IN_CODES = BUILT_IN.map((c) => c.code)

export const optionsOf = (check: Check, item: CheckItem) => item.options ?? check.options

/** The most a check can score: every counted item at its top answer. */
export const maxScore = (check: Check) =>
  check.items
    .filter((i) => i.scored !== false)
    .reduce((n, i) => n + Math.max(...optionsOf(check, i).map((o) => o.score)), 0)

export class CheckError extends Error {}

export interface Scored {
  score: number
  max: number
  band: CheckBand
  /** Its place among the check's bands, 0 the lowest: what the statistics count. */
  rank: number
  safety: boolean
}

/**
 * Score a set of answers: each the index of the answer chosen, or null for an
 * optional question left alone.
 */
export function score(check: Check, answers: (number | null)[]): Scored {
  if (answers.length !== check.items.length) throw new CheckError(`answer each of the ${check.items.length} questions`)
  let total = 0
  let safety = false
  check.items.forEach((item, i) => {
    const a = answers[i]
    const options = optionsOf(check, item)
    if (a === null || a === undefined) {
      if (!item.optional) throw new CheckError(`question ${i + 1} is not answered`)
      return
    }
    if (!Number.isInteger(a) || a < 0 || a >= options.length) throw new CheckError(`question ${i + 1} has no such answer`)
    const s = options[a]!.score
    if (item.scored !== false) total += s
    if (item.safety && s > 0) safety = true
  })
  const rank = check.bands.findIndex((b) => total >= b.from && total <= b.to)
  if (rank < 0) throw new CheckError(`no band covers a score of ${total}`)
  return { score: total, max: maxScore(check), band: check.bands[rank]!, rank, safety }
}

// --- an institution's own check, as an office writes it --------------------------

const optionSchema = z.object({ label: z.string().trim().min(1).max(60), score: z.number().int().min(0).max(10) })
const itemSchema = z.object({
  text: z.string().trim().min(3).max(300),
  safety: z.boolean().optional(),
})
const bandSchema = z.object({
  from: z.number().int().min(0),
  to: z.number().int().min(0),
  label: z.string().trim().min(1).max(40),
  advice: z.string().trim().min(10).max(800),
})

/**
 * `Never=0, Sometimes=1, Often=2` -- the scale as a form's one line, or as
 * the API's list.
 */
const scale = z.preprocess(
  (v) =>
    typeof v === 'string'
      ? v
          .split(/[,;\n]/)
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => {
            const m = /^(.*?)\s*=\s*(\d+)$/.exec(s)
            return m ? { label: m[1], score: Number(m[2]) } : { label: s, score: Number.NaN }
          })
      : v,
  z.array(optionSchema).min(2).max(7),
)

/** One question a line; a line starting `!` is a safety question. */
const questions = z.preprocess(
  (v) =>
    typeof v === 'string'
      ? v
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => (s.startsWith('!') ? { text: s.slice(1).trim(), safety: true } : { text: s }))
      : v,
  z.array(itemSchema).min(1).max(40),
)

/** `0-4: Low: what it means` a line. */
const bandLines = z.preprocess(
  (v) =>
    typeof v === 'string'
      ? v
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => {
            const m = /^(\d+)\s*[-–]\s*(\d+)\s*:\s*([^:]+?)\s*:\s*(.+)$/.exec(s)
            return m ? { from: Number(m[1]), to: Number(m[2]), label: m[3], advice: m[4] } : { label: s }
          })
      : v,
  z.array(bandSchema).min(1).max(8),
)

export const instrumentSchema = z
  .object({
    code: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9-]{1,19}$/, 'a short code: letters, digits and hyphens')
      .refine((c) => !BUILT_IN_CODES.includes(c.toUpperCase()), 'that code is a built-in check'),
    name: z.string().trim().min(3).max(80),
    about: z.string().trim().min(10).max(300),
    stem: z.string().trim().min(10).max(300),
    source: z.string().trim().min(10).max(500),
    options: scale,
    items: questions,
    bands: bandLines,
  })
  .superRefine((d, ctx) => {
    const check: Check = { ...d, builtIn: false, id: null }
    const max = maxScore(check)
    const sorted = [...d.bands].sort((a, b) => a.from - b.from)
    let next = 0
    for (const b of sorted) {
      if (b.to < b.from || b.from !== next) {
        ctx.addIssue({ code: 'custom', path: ['bands'], message: `the bands must cover 0 to ${max} without gaps or overlaps` })
        return
      }
      next = b.to + 1
    }
    if (next !== max + 1) ctx.addIssue({ code: 'custom', path: ['bands'], message: `the bands must cover 0 to ${max} without gaps or overlaps` })
  })
  .meta({ id: 'CareInstrument' })

export type InstrumentInput = z.infer<typeof instrumentSchema>
