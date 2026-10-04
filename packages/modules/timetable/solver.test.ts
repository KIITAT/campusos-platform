import { test } from 'node:test'
import assert from 'node:assert/strict'
import { solve, type SolverInput, type SolverPeriod, type SolverResult } from './api/solver'

/**
 * The solver on its own: every hard rule checked on what it returns, the soft
 * ones where they decide something visible, and a timetable the size of a
 * real college placed whole.
 */

/** Monday to Saturday (or as given), periods of 50 minutes from 09:00, lunch after the fourth. */
function week(days = [1, 2, 3, 4, 5, 6], perDay = 7): SolverPeriod[] {
  const out: SolverPeriod[] = []
  const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
  for (const day of days) {
    let t = 9 * 60
    for (let index = 1; index <= perDay; index++) {
      out.push({ day, index, startsAt: hhmm(t), endsAt: hhmm(t + 50) })
      t += 50
      if (index === 4) t += 40 // lunch
    }
  }
  return out
}

/** Every hard rule, checked against the input rather than trusted. */
function assertSound(input: SolverInput, out: SolverResult) {
  const periods = [...input.periods].sort((a, b) => a.day - b.day || a.index - b.index)
  const at = (day: number, index: number) => periods.findIndex((p) => p.day === day && p.index === index)
  const off = new Map(input.offerings.map((o) => [o.id, o]))
  const need = new Map(input.needs.map((n) => [n.id, n]))
  const room = new Map(input.rooms.map((r) => [r.id, r]))
  const teacher = new Map(input.teachers.map((t) => [t.id, t]))
  const conflicts = new Set((input.sectionConflicts ?? []).flatMap(([a, b]) => [`${a}|${b}`, `${b}|${a}`]))
  const taken = new Map<string, string>()
  const perDay = new Map<string, number>()
  for (const p of out.placements) {
    const o = off.get(p.offeringId)!
    const n = need.get(p.needId)!
    const r = room.get(p.roomId)!
    assert.equal(p.length, n.length)
    const first = at(p.day, p.index)
    assert.ok(first >= 0, 'starts on a real period')
    for (let k = 0; k < p.length; k++) {
      const q = periods[first + k]!
      assert.equal(q.day, p.day, 'a block stays in one day')
      if (k > 0) assert.equal(periods[first + k - 1]!.endsAt, q.startsAt, 'a block never crosses a break')
      const slot = `${q.day}:${q.index}`
      for (const key of [`t:${p.teacherId}:${slot}`, `r:${p.roomId}:${slot}`, `s:${o.sectionId}:${slot}`]) {
        if (key.startsWith('t:null')) continue
        assert.ok(!taken.has(key), `double-booked: ${key}`)
        taken.set(key, p.needId)
      }
      for (const b of input.busy ?? []) {
        if (b.day !== q.day || (b.index != null && b.index !== q.index)) continue
        assert.ok(b.teacherId !== p.teacherId || !b.teacherId, 'teacher booked while unavailable')
        assert.ok(b.roomId !== p.roomId || !b.roomId, 'room booked while unavailable')
        assert.ok(b.sectionId !== o.sectionId || !b.sectionId, 'section booked while unavailable')
      }
    }
    if (n.roomId) assert.equal(p.roomId, n.roomId)
    else assert.equal(r.kind, n.roomKind, 'the room is of the kind needed')
    assert.ok(r.capacity === null || r.capacity >= o.size, 'the room seats the class')
    if (p.teacherId) {
      assert.ok(o.teacher ? o.teacher === p.teacherId : o.teachers.some((t) => t.id === p.teacherId), 'only an eligible or pinned teacher')
      const key = `${p.teacherId}:${p.day}`
      perDay.set(key, (perDay.get(key) ?? 0) + p.length)
      assert.ok(perDay.get(key)! <= teacher.get(p.teacherId)!.maxPerDay, 'within the teacher’s day')
    }
  }
  // Sections that share students never overlap either.
  for (const p of out.placements) {
    for (const q of out.placements) {
      if (p === q || p.day !== q.day) continue
      const a = off.get(p.offeringId)!.sectionId
      const b = off.get(q.offeringId)!.sectionId
      if (!conflicts.has(`${a}|${b}`)) continue
      const overlap = p.index < q.index + q.length && q.index < p.index + p.length
      assert.ok(!overlap, `sections ${a} and ${b} share students and overlap`)
    }
  }
  // One teacher per class, across all its blocks.
  for (const o of input.offerings) {
    const ts = new Set(out.placements.filter((p) => p.offeringId === o.id).map((p) => p.teacherId))
    assert.ok(ts.size <= 1, 'a class keeps one teacher')
  }
  // Teachers' weeks.
  const week = new Map<string, number>()
  for (const p of out.placements) if (p.teacherId) week.set(p.teacherId, (week.get(p.teacherId) ?? 0) + p.length)
  for (const [t, n] of week) {
    const pinnedOnly = input.offerings.filter((o) => o.teacher === t).length > 0
    if (!pinnedOnly) assert.ok(n <= teacher.get(t)!.maxPerWeek, 'within the teacher’s week')
  }
}

const T = (id: string, maxPerDay = 5, maxPerWeek = 24, maxConsecutive = 3) => ({ id, maxPerDay, maxPerWeek, maxConsecutive })

function college(): SolverInput {
  return {
    periods: week(),
    rooms: [
      { id: 'R101', capacity: 70, kind: 'classroom' },
      { id: 'R102', capacity: 70, kind: 'classroom' },
      { id: 'R201', capacity: 140, kind: 'classroom' },
      { id: 'LAB1', capacity: 40, kind: 'lab' },
    ],
    teachers: [T('rao'), T('sen'), T('das'), T('iyer')],
    offerings: [
      { id: 'A-DS', sectionId: 'A', size: 60, teachers: [{ id: 'rao', preference: 5 }, { id: 'das', preference: 2 }] },
      { id: 'A-PS', sectionId: 'A', size: 60, teachers: [{ id: 'sen', preference: 4 }] },
      { id: 'A-OS', sectionId: 'A', size: 60, teachers: [{ id: 'das', preference: 5 }, { id: 'iyer', preference: 3 }] },
      { id: 'A1-LAB', sectionId: 'A1', size: 30, teachers: [{ id: 'iyer', preference: 5 }] },
      { id: 'A2-LAB', sectionId: 'A2', size: 30, teachers: [{ id: 'rao', preference: 3 }, { id: 'iyer', preference: 5 }] },
      { id: 'B-DS', sectionId: 'B', size: 60, teachers: [{ id: 'rao', preference: 5 }, { id: 'das', preference: 3 }] },
      { id: 'B-PS', sectionId: 'B', size: 60, teachers: [{ id: 'sen', preference: 5 }] },
      { id: 'B-OS', sectionId: 'B', size: 60, teachers: [{ id: 'das', preference: 4 }] },
      { id: 'C-BIG', sectionId: 'C', size: 120, teachers: [{ id: 'sen', preference: 3 }] },
    ],
    needs: [
      { id: 'A-DS:l', offeringId: 'A-DS', kind: 'lecture', blocks: 4, length: 1, roomKind: 'classroom' },
      { id: 'A-PS:l', offeringId: 'A-PS', kind: 'lecture', blocks: 3, length: 1, roomKind: 'classroom' },
      { id: 'A-OS:l', offeringId: 'A-OS', kind: 'lecture', blocks: 3, length: 1, roomKind: 'classroom' },
      { id: 'A1-LAB:p', offeringId: 'A1-LAB', kind: 'lab', blocks: 1, length: 2, roomKind: 'lab' },
      { id: 'A2-LAB:p', offeringId: 'A2-LAB', kind: 'lab', blocks: 1, length: 3, roomKind: 'lab' },
      { id: 'B-DS:l', offeringId: 'B-DS', kind: 'lecture', blocks: 4, length: 1, roomKind: 'classroom' },
      { id: 'B-PS:l', offeringId: 'B-PS', kind: 'lecture', blocks: 3, length: 1, roomKind: 'classroom' },
      { id: 'B-OS:l', offeringId: 'B-OS', kind: 'lecture', blocks: 3, length: 1, roomKind: 'classroom' },
      { id: 'C-BIG:l', offeringId: 'C-BIG', kind: 'lecture', blocks: 2, length: 1, roomKind: 'classroom' },
    ],
    // A1 and A2 are the lab batches of A: each clashes with A, not with each other.
    sectionConflicts: [['A', 'A1'], ['A', 'A2']],
    options: { seed: 7, iterations: 4000 },
  }
}

test('a small college is placed whole, and every hard rule holds', () => {
  const input = college()
  const out = solve(input)
  assertSound(input, out)
  assert.deepEqual(out.unplaced, [])
  assert.equal(out.stats.placed, out.stats.blocks)
  assert.equal(out.issues.length, 0)
  // Each class has the teacher it most wants where nothing stands in the way.
  assert.equal(out.teachers['A-PS'], 'sen')
  assert.equal(out.teachers['A1-LAB'], 'iyer')
  // The 120-seat class only fits the big room.
  assert.ok(out.placements.filter((p) => p.offeringId === 'C-BIG').every((p) => p.roomId === 'R201'))
  // A three-period lab sits in the morning or the afternoon, never across lunch.
  const lab = out.placements.find((p) => p.offeringId === 'A2-LAB')!
  assert.ok(lab.index === 1 || lab.index === 2 || lab.index === 5, `lab starts at period ${lab.index}`)
  // A class's lectures fall on different days.
  for (const id of ['A-DS:l', 'B-DS:l', 'A-PS:l']) {
    const days = out.placements.filter((p) => p.needId === id).map((p) => p.day)
    assert.equal(new Set(days).size, days.length, `${id} meets twice in a day`)
  }
})

test('the same input and seed give the same timetable', () => {
  const a = solve(college())
  const b = solve(college())
  assert.deepEqual(a.placements, b.placements)
  assert.deepEqual(a.teachers, b.teachers)
  const c = solve({ ...college(), options: { seed: 99, iterations: 4000 } })
  assertSound(college(), c)
})

test('pins, unavailability and a pinned teacher are honoured', () => {
  const input = college()
  input.offerings.find((o) => o.id === 'B-DS')!.teacher = 'das'
  input.busy = [
    { teacherId: 'rao', day: 1 },               // Dr Rao never on Mondays
    { roomId: 'R201', day: 3, index: 1 },        // the big room is taken first thing Wednesday
    { sectionId: 'B', day: 5, index: 6 },        // B has sport late on Friday
    { sectionId: 'B', day: 5, index: 7 },
  ]
  input.fixed = [{ needId: 'A-OS:l', day: 2, index: 1, roomId: 'R102' }]
  const out = solve(input)
  assertSound(input, out)
  assert.deepEqual(out.unplaced, [])
  assert.equal(out.teachers['B-DS'], 'das')
  assert.ok(!out.placements.some((p) => p.teacherId === 'rao' && p.day === 1))
  const pinned = out.placements.filter((p) => p.fixed)
  assert.deepEqual(pinned.map((p) => [p.needId, p.day, p.index, p.roomId]), [['A-OS:l', 2, 1, 'R102']])
})

test('a teacher teaches several classes in a day, up to their limit and no further', () => {
  const input: SolverInput = {
    periods: week([1, 2], 7),
    rooms: [1, 2, 3, 4].map((n) => ({ id: `R${n}`, capacity: 60, kind: 'classroom' })),
    teachers: [T('rao', 6, 14, 3)],
    offerings: ['A', 'B', 'C', 'D'].map((s) => ({ id: `${s}-DS`, sectionId: s, size: 50, teachers: [{ id: 'rao', preference: 5 }] })),
    needs: ['A', 'B', 'C', 'D'].map((s) => ({ id: `${s}-DS:l`, offeringId: `${s}-DS`, kind: 'lecture', blocks: 3, length: 1, roomKind: 'classroom' })),
    options: { seed: 3, iterations: 3000 },
  }
  const out = solve(input)
  assertSound(input, out)
  assert.deepEqual(out.unplaced, [])
  const monday = out.placements.filter((p) => p.day === 1).length
  const tuesday = out.placements.filter((p) => p.day === 2).length
  assert.equal(monday + tuesday, 12)
  assert.ok(monday === 6 && tuesday === 6, 'twelve periods over two days, six a day')
})

test('what cannot be placed is said, with the reason, rather than placed badly', () => {
  const input: SolverInput = {
    periods: week([1], 4),
    rooms: [{ id: 'R1', capacity: 30, kind: 'classroom' }],
    teachers: [T('rao', 8, 40, 8)],
    offerings: [
      { id: 'A-DS', sectionId: 'A', size: 25, teachers: [{ id: 'rao', preference: 5 }] },
      { id: 'A-XX', sectionId: 'A', size: 25, teachers: [] },
      { id: 'B-BIG', sectionId: 'B', size: 90, teachers: [{ id: 'rao', preference: 5 }] },
      { id: 'C-LAB', sectionId: 'C', size: 20, teachers: [{ id: 'rao', preference: 5 }] },
    ],
    needs: [
      { id: 'A-DS:l', offeringId: 'A-DS', kind: 'lecture', blocks: 3, length: 1, roomKind: 'classroom' },
      { id: 'A-XX:l', offeringId: 'A-XX', kind: 'lecture', blocks: 2, length: 1, roomKind: 'classroom' },
      { id: 'B-BIG:l', offeringId: 'B-BIG', kind: 'lecture', blocks: 1, length: 1, roomKind: 'classroom' },
      { id: 'C-LAB:p', offeringId: 'C-LAB', kind: 'lab', blocks: 1, length: 2, roomKind: 'lab' },
    ],
    options: { seed: 1, iterations: 2000 },
  }
  const out = solve(input)
  assertSound(input, out)
  const why = Object.fromEntries(out.unplaced.map((u) => [u.needId, u]))
  assert.match(why['B-BIG:l']!.reason, /no classroom room seats 90/)
  assert.match(why['C-LAB:p']!.reason, /no lab room seats 20/)
  // Section A wants five periods of a four-period day: one is left over.
  assert.equal((why['A-DS:l']?.count ?? 0) + (why['A-XX:l']?.count ?? 0), 1)
  assert.match((why['A-DS:l'] ?? why['A-XX:l'])!.reason, /students have no free time/)
  // A class nobody may teach is still placed, unstaffed, and said.
  assert.deepEqual(out.issues.map((i) => [i.offeringId, i.code]), [['A-XX', 'no_eligible_teacher']])
  assert.equal(out.teachers['A-XX'], null)
})

test('a pin that cannot be honoured is refused and said', () => {
  const input = college()
  input.fixed = [
    { needId: 'A1-LAB:p', day: 1, index: 4 }, // a two-period lab across lunch
    { needId: 'A-DS:l', day: 9, index: 1 },   // a day that is not in the week
  ]
  const out = solve(input)
  assertSound(input, out)
  assert.deepEqual(out.issues.map((i) => i.code).sort(), ['pin_refused', 'pin_refused'])
  // The refused lab is not left out: it is placed somewhere it fits.
  assert.ok(!out.unplaced.some((u) => u.needId === 'A1-LAB:p'))
})

test('a college of thirty sections is timetabled whole in seconds', () => {
  const days = [1, 2, 3, 4, 5, 6]
  const sections = Array.from({ length: 30 }, (_, i) => `S${i + 1}`)
  const subjects = ['MATH', 'PHY', 'CHEM', 'ENG', 'CS', 'EE']
  const teachers = Array.from({ length: 28 }, (_, i) => T(`t${i + 1}`, 6, 26, 3))
  const offerings = sections.flatMap((s, si) =>
    subjects.map((sub, k) => ({
      id: `${s}-${sub}`,
      sectionId: s,
      size: 60,
      // Each subject has four or five teachers who can take it, some keener than others.
      teachers: [0, 1, 2, 3].map((j) => ({ id: `t${((k * 4 + j + si) % 28) + 1}`, preference: 5 - j })),
    })),
  )
  const needs = offerings.flatMap((o) => {
    const lab = o.id.endsWith('CS') || o.id.endsWith('PHY')
    return [
      { id: `${o.id}:l`, offeringId: o.id, kind: 'lecture', blocks: 3, length: 1, roomKind: 'classroom' },
      ...(lab ? [{ id: `${o.id}:p`, offeringId: o.id, kind: 'lab', blocks: 1, length: 2, roomKind: 'lab' }] : []),
    ]
  })
  const input: SolverInput = {
    periods: week(days, 7),
    rooms: [
      ...Array.from({ length: 20 }, (_, i) => ({ id: `C${i + 1}`, capacity: 70, kind: 'classroom' })),
      ...Array.from({ length: 6 }, (_, i) => ({ id: `L${i + 1}`, capacity: 70, kind: 'lab' })),
    ],
    teachers,
    offerings,
    needs,
    options: { seed: 11, iterations: 25_000 },
  }
  const t0 = Date.now()
  const out = solve(input)
  const ms = Date.now() - t0
  assertSound(input, out)
  assert.deepEqual(out.unplaced, [], `unplaced: ${JSON.stringify(out.unplaced.slice(0, 3))}`)
  assert.equal(out.stats.blocks, 30 * 6 * 3 + 30 * 2)
  // Twenty-eight teachers of 26 periods each cover the 660 the week needs: nobody is left unstaffed.
  assert.deepEqual(out.issues, [])
  assert.equal(out.cost.unstaffed, 0)
  assert.ok(ms < 30_000, `took ${ms} ms`)
})
