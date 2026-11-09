export type Schedule = 'none' | 'daily' | 'weekly' | 'monthly'
const IST = 330 * 60_000
const at = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d, 7, 0) - IST)

/** The next 07:00 Asia/Kolkata strictly after `after` (decision 496). India keeps no daylight saving. */
export function nextRunAt(schedule: Schedule, after: Date): Date | null {
  if (schedule === 'none') return null
  const ist = new Date(after.getTime() + IST)
  const y = ist.getUTCFullYear(), m = ist.getUTCMonth(), d = ist.getUTCDate()
  if (schedule === 'daily') { const t = at(y, m, d); return t > after ? t : at(y, m, d + 1) }
  if (schedule === 'weekly') { const add = (8 - ist.getUTCDay()) % 7; const t = at(y, m, d + add); return t > after ? t : at(y, m, d + add + 7) }
  const t = at(y, m, 1); return t > after ? t : at(y, m + 1, 1)
}

/** Today's date in India as YYYY-MM-DD. */
export const istToday = (now = new Date()) => new Date(now.getTime() + IST).toISOString().slice(0, 10)
