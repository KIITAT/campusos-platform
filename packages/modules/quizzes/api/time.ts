/**
 * Wall-clock times in a named zone, without a date library.
 *
 * A teacher sets a quiz to close at "5 pm" in their own time; a browser's
 * datetime-local input sends exactly that, with no zone. The quiz carries its
 * zone, so the instant is found here, and times are shown back in it.
 */

export class ZoneError extends Error {}

export function assertZone(zone: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return zone
  } catch {
    throw new ZoneError(`${zone} is not a time zone`)
  }
}

const parts = (at: Date, zone: string) => {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]))
  return {
    y: Number(p.year),
    mo: Number(p.month),
    d: Number(p.day),
    h: Number(p.hour),
    mi: Number(p.minute),
    s: Number(p.second),
  }
}

/** How far the zone is ahead of UTC at that instant, in milliseconds. */
const offsetAt = (at: Date, zone: string) => {
  const p = parts(at, zone)
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(at.getTime() / 1000) * 1000
}

/**
 * The instant a string names: as given when it carries an offset, otherwise
 * as a wall-clock time in `zone`. Twice round, so a time either side of a
 * daylight-saving change lands on the right side of it.
 */
export function instant(value: string, zone: string): Date {
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(value)) return new Date(value)
  const [date, time = '00:00'] = value.split('T') as [string, string?]
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number]
  const [h, mi, s = 0] = time.split(':').map(Number) as [number, number, number?]
  const wall = Date.UTC(y, mo - 1, d, h, mi, Math.floor(s))
  let guess = wall - offsetAt(new Date(wall), zone)
  guess = wall - offsetAt(new Date(guess), zone)
  return new Date(guess)
}

/** `2026-10-05 17:00`, in the zone. */
export function wallClock(at: Date | string | null | undefined, zone: string): string {
  if (!at) return ''
  const p = parts(new Date(at), zone)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${p.y}-${pad(p.mo)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}`
}

/** The value a datetime-local input wants: `2026-10-05T17:00`. */
export const localInput = (at: Date | string | null | undefined, zone: string) =>
  wallClock(at, zone).replace(' ', 'T')
