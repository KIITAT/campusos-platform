/**
 * Presence rules, pure: no database, no clock of their own.
 *
 * The facts are gathered elsewhere (`presence.ts`); these functions only decide
 * what a set of facts means. Library and class facts count only when the
 * resident's `hostel_presence` consent is given (`sharing`).
 */
export type PresenceStatus = 'in_hostel' | 'in_library' | 'in_class' | 'out_of_campus' | 'unknown'

export interface PresenceFacts {
  sharing: boolean // consent given
  checkedIn: boolean // check-in row tonight, present or on_leave
  onLeave: boolean // hostel_leaves covers today
  lateUntil: Date | null // latest approved late pass end for tonight
  libraryOpen: boolean // open library session
  libraryLastExit: Date | null // latest non-auto exit
  inClass: boolean
  pastCurfew: boolean
}

export type Evidence = 'checked_in' | 'leave' | 'late_pass' | 'library' | 'library_exit' | 'class'

/** Precedence: open library session, class now, leave now, check-in tonight, unknown (D1323). */
export function derivePresence(f: PresenceFacts): { status: PresenceStatus; label: string } {
  if (f.sharing && f.libraryOpen) {
    return { status: 'in_library', label: f.pastCurfew ? 'In Library (authorized)' : 'In Library' }
  }
  if (f.sharing && f.inClass) return { status: 'in_class', label: 'In Class' }
  if (f.onLeave) return { status: 'out_of_campus', label: 'Out of Campus' }
  if (f.checkedIn) return { status: 'in_hostel', label: 'In Hostel' }
  return { status: 'unknown', label: 'Unknown' }
}

/** What accounts for a student after curfew, first match wins (D1322); null means nothing does. */
export function curfewEvidence(f: PresenceFacts, now: Date, walkBackMin: number): Evidence | null {
  if (f.checkedIn) return 'checked_in'
  if (f.onLeave) return 'leave'
  if (f.lateUntil && f.lateUntil.getTime() > now.getTime()) return 'late_pass'
  if (!f.sharing) return null
  if (f.libraryOpen) return 'library'
  if (f.libraryLastExit && now.getTime() - f.libraryLastExit.getTime() <= walkBackMin * 60_000) return 'library_exit'
  if (f.inClass) return 'class'
  return null
}

export type Step = 'nudge' | 'warden' | 'guardian'

/** The steps of the ladder that are due and not yet stamped, in order. */
export function ladderDue(
  c: { curfewAt: Date; nudgeAt: Date | null; wardenAt: Date | null; guardianAt: Date | null },
  now: Date,
  offsets: { nudge: number; warden: number; guardian: number },
): Step[] {
  const due = (stamp: Date | null, min: number) => stamp === null && c.curfewAt.getTime() + min * 60_000 <= now.getTime()
  const out: Step[] = []
  if (due(c.nudgeAt, offsets.nudge)) out.push('nudge')
  if (due(c.wardenAt, offsets.warden)) out.push('warden')
  if (due(c.guardianAt, offsets.guardian)) out.push('guardian')
  return out
}
