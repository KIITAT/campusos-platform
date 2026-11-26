import { test } from 'node:test'
import assert from 'node:assert/strict'
import { curfewEvidence, derivePresence, ladderDue, type PresenceFacts } from './api/presence-rules'

const base: PresenceFacts = {
  sharing: true, checkedIn: false, onLeave: false, lateUntil: null,
  libraryOpen: false, libraryLastExit: null, inClass: false, pastCurfew: false,
}
const facts = (p: Partial<PresenceFacts>): PresenceFacts => ({ ...base, ...p })
const now = new Date('2026-11-26T16:30:00Z')
const minutesBefore = (m: number) => new Date(now.getTime() - m * 60_000)

test('open library session before curfew shows In Library', () => {
  assert.deepEqual(derivePresence(facts({ libraryOpen: true })), { status: 'in_library', label: 'In Library' })
})

test('after curfew shows In Library (authorized)', () => {
  assert.equal(derivePresence(facts({ libraryOpen: true, pastCurfew: true })).label, 'In Library (authorized)')
})

test('class beats hostel check-in', () => {
  assert.equal(derivePresence(facts({ inClass: true, checkedIn: true })).status, 'in_class')
})

test('leave shows Out of Campus', () => {
  assert.deepEqual(derivePresence(facts({ onLeave: true })), { status: 'out_of_campus', label: 'Out of Campus' })
})

test('check-in shows In Hostel', () => {
  assert.deepEqual(derivePresence(facts({ checkedIn: true })), { status: 'in_hostel', label: 'In Hostel' })
})

test('nothing known shows Unknown', () => {
  assert.deepEqual(derivePresence(facts({})), { status: 'unknown', label: 'Unknown' })
})

test('without consent library and class are ignored', () => {
  const f = facts({ sharing: false, libraryOpen: true, inClass: true })
  assert.equal(derivePresence(f).status, 'unknown')
  assert.equal(curfewEvidence(f, now, 20), null)
})

test('library exit 19 minutes ago is evidence, 21 minutes ago is not (walkBack 20)', () => {
  assert.equal(curfewEvidence(facts({ libraryLastExit: minutesBefore(19) }), now, 20), 'library_exit')
  assert.equal(curfewEvidence(facts({ libraryLastExit: minutesBefore(21) }), now, 20), null)
})

test('an absent mark is not evidence', () => {
  assert.equal(curfewEvidence(facts({ checkedIn: false }), now, 20), null)
  assert.equal(curfewEvidence(facts({ checkedIn: true }), now, 20), 'checked_in')
})

const offsets = { nudge: 10, warden: 30, guardian: 60 }
const curfewAt = new Date('2026-11-26T16:00:00Z')
const at = (m: number) => new Date(curfewAt.getTime() + m * 60_000)
const open = { curfewAt, nudgeAt: null, wardenAt: null, guardianAt: null }

test('ladderDue at curfew+9 returns nothing, +10 returns nudge, +30 adds warden, +60 adds guardian', () => {
  assert.deepEqual(ladderDue(open, at(9), offsets), [])
  assert.deepEqual(ladderDue(open, at(10), offsets), ['nudge'])
  assert.deepEqual(ladderDue(open, at(30), offsets), ['nudge', 'warden'])
  assert.deepEqual(ladderDue(open, at(60), offsets), ['nudge', 'warden', 'guardian'])
})

test('ladderDue skips stamped steps', () => {
  assert.deepEqual(ladderDue({ ...open, nudgeAt: at(10) }, at(60), offsets), ['warden', 'guardian'])
})
