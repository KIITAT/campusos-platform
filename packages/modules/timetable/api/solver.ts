/**
 * The timetable solver: who teaches each class, and when and where each of its
 * periods meets.
 *
 * Pure and local. It takes the week's periods, the rooms, the teachers and what
 * each may teach, and every class's weekly need, and returns placements. No
 * database, no clock beyond an optional time limit, no network: the same input
 * and seed give the same timetable, which is what lets an office rerun it,
 * compare, and trust a test.
 *
 * Hard rules -- never broken by a placement it returns:
 * - a teacher, a room, and a group of students are each in one place at a time
 *   (groups that share students, or a batch and its parent section, count as one);
 * - a teacher teaches only what they are eligible for, or what they are pinned to;
 * - nobody is booked when they said they are unavailable;
 * - a room has the seats and is of the kind the class needs;
 * - a block of several periods (a lab) sits in consecutive periods of one day,
 *   never across a break;
 * - a teacher's periods stay within their day's and week's limits;
 * - pinned periods stay where they were pinned.
 *
 * What cannot be placed under those rules is returned as unplaced, with the
 * reason, rather than placed badly.
 *
 * Soft rules, weighed against each other: teachers' preferences, a class's
 * periods spread over different days, few idle periods in a section's or a
 * teacher's day, no teacher taught past their consecutive limit, and teaching
 * shared out evenly.
 *
 * Method: assign teachers (most constrained class first), place pins, place
 * every other block greedily (hardest first, cheapest position), repair what
 * did not fit by moving one block out of its way, then improve by simulated
 * annealing over moves, swaps, room changes and teacher changes, keeping the
 * best timetable seen.
 */

export interface SolverPeriod {
  day: number
  index: number
  startsAt: string
  endsAt: string
}

export interface SolverRoom {
  id: string
  capacity: number | null
  kind: string
}

export interface SolverTeacher {
  id: string
  maxPerDay: number
  maxPerWeek: number
  maxConsecutive: number
}

export interface SolverOffering {
  id: string
  sectionId: string
  size: number
  /** Who may teach it, with a preference from 1 (would rather not) to 5 (asked for it). */
  teachers: { id: string; preference: number }[]
  /** A teacher it must have: pinned by the office, or already assigned and kept. */
  teacher?: string | null
}

export interface SolverNeed {
  id: string
  offeringId: string
  kind: string
  /** How many blocks a week. */
  blocks: number
  /** Periods in each block: 1 for a lecture, 2 or 3 for a lab. */
  length: number
  roomKind: string
  /** A room it must have. */
  roomId?: string | null
}

/** Somebody or somewhere not to be booked: a whole day when index is absent. */
export interface SolverBusy {
  teacherId?: string
  roomId?: string
  sectionId?: string
  day: number
  index?: number | null
}

/** A block that must sit at a position: a pin, or a meeting with history that cannot move. */
export interface SolverFixed {
  needId: string
  day: number
  index: number
  roomId?: string | null
  /** A meeting with attendance taken against it: kept as it is, room and all. */
  locked?: boolean
}

export interface SolverOptions {
  seed?: number
  /** Improvement steps. Default 150 per block, at most 300 000. */
  iterations?: number
  /** A ceiling on wall time, whatever the iterations. Default 20 s. */
  timeLimitMs?: number
}

export interface SolverInput {
  periods: SolverPeriod[]
  rooms: SolverRoom[]
  teachers: SolverTeacher[]
  offerings: SolverOffering[]
  needs: SolverNeed[]
  busy?: SolverBusy[]
  fixed?: SolverFixed[]
  /** Pairs of different sections that share students and so may not overlap. */
  sectionConflicts?: [string, string][]
  options?: SolverOptions
}

export interface SolverPlacement {
  needId: string
  offeringId: string
  teacherId: string | null
  roomId: string
  day: number
  /** The first period's index. */
  index: number
  length: number
  startsAt: string
  endsAt: string
  fixed: boolean
  locked: boolean
}

export interface SolverUnplaced {
  needId: string
  offeringId: string
  count: number
  reason: string
}

export interface SolverIssue {
  offeringId: string
  code: 'no_eligible_teacher' | 'teachers_full' | 'pin_refused'
  message: string
}

export interface SolverResult {
  placements: SolverPlacement[]
  unplaced: SolverUnplaced[]
  /** offeringId -> the teacher it was given, or null. */
  teachers: Record<string, string | null>
  issues: SolverIssue[]
  cost: {
    total: number
    preference: number
    sameDay: number
    sectionGaps: number
    teacherGaps: number
    consecutive: number
    balance: number
    unstaffed: number
  }
  stats: {
    blocks: number
    placed: number
    iterations: number
    ms: number
    seed: number
    /** Per kind of move: tried, then accepted. */
    moves: Record<'place' | 'move' | 'swap' | 'teacher', [number, number]>
  }
}

const W = {
  unplaced: 1_000_000,
  unstaffed: 20_000,
  preference: 40,
  sameDay: 300,
  sectionGap: 25,
  teacherGap: 6,
  consecutive: 150,
  balance: 60,
  sectionBalance: 3,
}

/** A small seeded generator (mulberry32): the same seed, the same timetable. */
function random(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const popcount = (n: number) => {
  let c = 0
  while (n) {
    n &= n - 1
    c++
  }
  return c
}

interface Block {
  need: number
  offering: number
  length: number
  /** Index into the period list of its first period, or -1 unplaced. */
  pos: number
  room: number
  fixed: boolean
  locked: boolean
  /** A pinned room, for a pin that named one. */
  fixedRoom: number
}

export function solve(input: SolverInput): SolverResult {
  const started = Date.now()
  const seed = (input.options?.seed ?? 1) >>> 0
  const rand = random(seed)

  // --- the week ----------------------------------------------------------------
  const periods = [...input.periods].sort((a, b) => a.day - b.day || a.index - b.index)
  const P = periods.length
  const days = [...new Set(periods.map((p) => p.day))]
  const dayOf = periods.map((p) => days.indexOf(p.day))
  /** Bit position of each period within its day. */
  const bitOf: number[] = []
  const perDay: number[] = days.map(() => 0)
  for (let i = 0; i < P; i++) bitOf.push(perDay[dayOf[i]!]!++)
  if (Math.max(0, ...perDay) > 30) throw new Error('at most 30 periods a day')
  /** Periods i and i+1 run on without a break. */
  const joins = periods.map((p, i) => i + 1 < P && periods[i + 1]!.day === p.day && periods[i + 1]!.startsAt === p.endsAt)
  /** Per day, bit k set when period k and k+1 are NOT joined (a break, or the day's end). */
  const breaks = days.map(() => 0)
  for (let i = 0; i < P; i++) if (!joins[i]) breaks[dayOf[i]!]! |= 1 << bitOf[i]!
  const periodAt = new Map(periods.map((p, i) => [`${p.day}:${p.index}`, i]))
  /** Start positions for a block of each length. */
  const startsFor = new Map<number, number[]>()
  const starts = (length: number) => {
    let s = startsFor.get(length)
    if (!s) {
      s = []
      for (let i = 0; i < P; i++) {
        let ok = true
        for (let k = 0; k < length - 1; k++) if (!joins[i + k]) ok = false
        if (ok && i + length - 1 < P) s.push(i)
      }
      startsFor.set(length, s)
    }
    return s
  }

  // --- who and where -------------------------------------------------------------
  const rooms = input.rooms
  const roomIx = new Map(rooms.map((r, i) => [r.id, i]))
  const teacherIx = new Map(input.teachers.map((t, i) => [t.id, i]))
  const teachers = input.teachers
  const offerings = input.offerings
  const offIx = new Map(offerings.map((o, i) => [o.id, i]))
  const sectionIds = [...new Set(offerings.map((o) => o.sectionId))]
  const secIx = new Map(sectionIds.map((s, i) => [s, i]))
  const secOf = offerings.map((o) => secIx.get(o.sectionId)!)
  /** Each section with the sections it may not overlap, itself first. */
  const conflicts: number[][] = sectionIds.map((_, i) => [i])
  for (const [a, b] of input.sectionConflicts ?? []) {
    const x = secIx.get(a)
    const y = secIx.get(b)
    if (x === undefined || y === undefined || x === y) continue
    if (!conflicts[x]!.includes(y)) conflicts[x]!.push(y)
    if (!conflicts[y]!.includes(x)) conflicts[y]!.push(x)
  }
  const needs = input.needs.filter((n) => offIx.has(n.offeringId))
  const needIx = new Map(needs.map((n, i) => [n.id, i]))
  const needOff = needs.map((n) => offIx.get(n.offeringId)!)
  const periodsOf = offerings.map(() => 0)
  needs.forEach((n, i) => (periodsOf[needOff[i]!]! += n.blocks * n.length))

  /** Rooms each need may use, smallest that fits first. */
  const roomsFor = needs.map((n, i) => {
    const size = offerings[needOff[i]!]!.size
    if (n.roomId) {
      const r = roomIx.get(n.roomId)
      return r === undefined ? [] : [r]
    }
    return rooms
      .map((r, ri) => ({ r, ri }))
      .filter(({ r }) => r.kind === n.roomKind && (r.capacity === null || r.capacity >= size))
      .sort((a, b) => (a.r.capacity ?? 1e9) - (b.r.capacity ?? 1e9) || a.r.id.localeCompare(b.r.id))
      .map(({ ri }) => ri)
  })

  // --- occupancy -----------------------------------------------------------------
  const tOcc = teachers.map(() => new Int32Array(P))
  const rOcc = rooms.map(() => new Int32Array(P))
  const sOcc = sectionIds.map(() => new Int32Array(P))
  const tBusy = teachers.map(() => new Uint8Array(P))
  const rBusy = rooms.map(() => new Uint8Array(P))
  const sBusy = sectionIds.map(() => new Uint8Array(P))
  for (const b of input.busy ?? []) {
    const target = b.teacherId !== undefined ? tBusy[teacherIx.get(b.teacherId) ?? -1]
      : b.roomId !== undefined ? rBusy[roomIx.get(b.roomId) ?? -1]
        : b.sectionId !== undefined ? sBusy[secIx.get(b.sectionId) ?? -1]
          : undefined
    if (!target) continue
    for (let i = 0; i < P; i++) {
      if (periods[i]!.day !== b.day) continue
      if (b.index === null || b.index === undefined || periods[i]!.index === b.index) target[i] = 1
    }
  }
  /** Per teacher per day, periods taught. */
  const tDay = teachers.map(() => new Int32Array(days.length))
  const tMask = teachers.map(() => new Int32Array(days.length))
  const sMask = sectionIds.map(() => new Int32Array(days.length))
  const nDay = needs.map(() => new Int32Array(days.length))
  const load = teachers.map(() => 0)
  const teacherOf = offerings.map(() => -1)

  // --- the blocks ----------------------------------------------------------------
  const blocks: Block[] = []
  needs.forEach((n, i) => {
    for (let k = 0; k < n.blocks; k++) {
      blocks.push({ need: i, offering: needOff[i]!, length: n.length, pos: -1, room: -1, fixed: false, locked: false, fixedRoom: -1 })
    }
  })
  const blocksOf = offerings.map(() => [] as number[])
  blocks.forEach((b, i) => blocksOf[b.offering]!.push(i))
  const issues: SolverIssue[] = []

  // --- costs ---------------------------------------------------------------------
  const gaps = (mask: number) => {
    if (!mask) return 0
    const low = mask & -mask
    const span = 31 - Math.clz32(mask) - (31 - Math.clz32(low)) + 1
    return span - popcount(mask)
  }
  const overrun = (mask: number, brk: number, max: number) => {
    let over = 0
    let run = 0
    for (let k = 0; k < 31; k++) {
      if (mask & (1 << k)) {
        run++
        if (run > max) over++
      } else run = 0
      if (brk & (1 << k)) run = 0
    }
    return over
  }
  const sectionDayCost = (s: number, d: number) => {
    const m = sMask[s]![d]!
    const c = popcount(m)
    return gaps(m) * W.sectionGap + c * c * W.sectionBalance
  }
  const teacherDayCost = (t: number, d: number) => {
    const m = tMask[t]![d]!
    return gaps(m) * W.teacherGap + overrun(m, breaks[d]!, teachers[t]!.maxConsecutive) * W.consecutive
  }
  const needDayCost = (n: number, d: number) => {
    const c = nDay[n]![d]!
    return c > 1 ? (c - 1) * W.sameDay : 0
  }
  const prefOf = (o: number, t: number) => {
    if (t < 0) return 0
    const tid = teachers[t]!.id
    return offerings[o]!.teachers.find((x) => x.id === tid)?.preference ?? 3
  }
  const offeringCost = (o: number) => (teacherOf[o]! < 0 ? (periodsOf[o]! > 0 ? W.unstaffed : 0) : (5 - prefOf(o, teacherOf[o]!)) * W.preference)
  const loadCost = (t: number) => {
    const r = load[t]! / Math.max(1, teachers[t]!.maxPerWeek)
    return Math.round(r * r * W.balance)
  }

  // --- placing and lifting -------------------------------------------------------
  function mark(b: Block, sign: 1 | -1) {
    const t = teacherOf[b.offering]!
    const s = secOf[b.offering]!
    const d = dayOf[b.pos]!
    for (let k = 0; k < b.length; k++) {
      const i = b.pos + k
      if (t >= 0) tOcc[t]![i]! += sign
      rOcc[b.room]![i]! += sign
      sOcc[s]![i]! += sign
      const bit = 1 << bitOf[i]!
      if (sign > 0) {
        if (t >= 0) tMask[t]![d]! |= bit
        sMask[s]![d]! |= bit
      } else {
        if (t >= 0 && tOcc[t]![i] === 0) tMask[t]![d]! &= ~bit
        if (sOcc[s]![i] === 0) sMask[s]![d]! &= ~bit
      }
    }
    if (t >= 0) tDay[t]![d]! += sign * b.length
    nDay[b.need]![d]! += sign
  }

  /** Whether block b may sit at pos in room r, taught by t (its offering's teacher by default). */
  function fits(b: Block, pos: number, r: number, t = teacherOf[b.offering]!): boolean {
    const s = secOf[b.offering]!
    const d = dayOf[pos]!
    if (t >= 0 && tDay[t]![d]! + b.length > teachers[t]!.maxPerDay) return false
    for (let k = 0; k < b.length; k++) {
      const i = pos + k
      if (rOcc[r]![i] || rBusy[r]![i]) return false
      if (t >= 0 && (tOcc[t]![i] || tBusy[t]![i])) return false
      if (sBusy[s]![i]) return false
      for (const c of conflicts[s]!) if (sOcc[c]![i]) return false
    }
    return true
  }
  /** As fits, ignoring the room: the time works for the teacher and the students. */
  function timeFits(b: Block, pos: number, t = teacherOf[b.offering]!): boolean {
    const s = secOf[b.offering]!
    const d = dayOf[pos]!
    if (t >= 0 && tDay[t]![d]! + b.length > teachers[t]!.maxPerDay) return false
    for (let k = 0; k < b.length; k++) {
      const i = pos + k
      if (t >= 0 && (tOcc[t]![i] || tBusy[t]![i])) return false
      if (sBusy[s]![i]) return false
      for (const c of conflicts[s]!) if (sOcc[c]![i]) return false
    }
    return true
  }
  const roomFor = (b: Block, pos: number) => {
    if (b.fixedRoom >= 0) return fits(b, pos, b.fixedRoom) ? b.fixedRoom : -1
    for (const r of roomsFor[b.need]!) if (fits(b, pos, r)) return r
    return -1
  }

  /** The parts of the timetable a change touches: section-days, teacher-days, need-days, teachers, classes. */
  interface Keys {
    sd: Set<number>
    td: Set<number>
    nd: Set<number>
    t: Set<number>
    o: Set<number>
  }
  const keys = (): Keys => ({ sd: new Set(), td: new Set(), nd: new Set(), t: new Set(), o: new Set() })
  function touch(k: Keys, b: Block, pos: number, t = teacherOf[b.offering]!) {
    if (pos < 0) return k
    const d = dayOf[pos]!
    k.sd.add(secOf[b.offering]! * 64 + d)
    if (t >= 0) k.td.add(t * 64 + d)
    k.nd.add(b.need * 64 + d)
    return k
  }
  function costOf(k: Keys): number {
    let c = 0
    for (const x of k.sd) c += sectionDayCost(Math.floor(x / 64), x % 64)
    for (const x of k.td) c += teacherDayCost(Math.floor(x / 64), x % 64)
    for (const x of k.nd) c += needDayCost(Math.floor(x / 64), x % 64)
    for (const t of k.t) c += loadCost(t)
    for (const o of k.o) c += offeringCost(o)
    return c
  }

  function put(bi: number, pos: number, room: number) {
    const b = blocks[bi]!
    b.pos = pos
    b.room = room
    mark(b, 1)
  }
  function lift(bi: number) {
    const b = blocks[bi]!
    mark(b, -1)
    const was = { pos: b.pos, room: b.room }
    b.pos = -1
    b.room = -1
    return was
  }

  // --- 1. teachers ---------------------------------------------------------------
  const order = offerings
    .map((o, i) => ({ o, i }))
    .sort((a, b) => a.o.teachers.length - b.o.teachers.length || periodsOf[b.i]! - periodsOf[a.i]! || a.o.id.localeCompare(b.o.id))
  for (const { o, i } of order) {
    if (periodsOf[i] === 0) continue
    if (o.teacher) {
      const t = teacherIx.get(o.teacher)
      if (t !== undefined) {
        teacherOf[i] = t
        load[t]! += periodsOf[i]!
        continue
      }
    }
    let best = -1
    let bestScore = -Infinity
    for (const c of o.teachers) {
      const t = teacherIx.get(c.id)
      if (t === undefined) continue
      if (load[t]! + periodsOf[i]! > teachers[t]!.maxPerWeek) continue
      const score = c.preference * 10 - (load[t]! / Math.max(1, teachers[t]!.maxPerWeek)) * 25 + rand()
      if (score > bestScore) {
        bestScore = score
        best = t
      }
    }
    if (best >= 0) {
      teacherOf[i] = best
      load[best]! += periodsOf[i]!
    }
  }

  /**
   * Make room in teacher t's week for `need` more periods by handing some of
   * their classes to other eligible teachers -- who may in turn hand on one of
   * theirs -- up to `depth` steps: an augmenting path, as in matching.
   */
  function freeUp(t: number, need: number, depth: number, seen: Set<number>): boolean {
    const spare = () => teachers[t]!.maxPerWeek - load[t]!
    if (spare() >= need) return true
    if (depth === 0) return false
    seen.add(t)
    const theirs = offerings.map((_, o) => o).filter((o) => teacherOf[o] === t && !offerings[o]!.teacher)
    for (const o2 of theirs) {
      for (const c of offerings[o2]!.teachers) {
        const t2 = teacherIx.get(c.id)
        if (t2 === undefined || seen.has(t2)) continue
        if (freeUp(t2, periodsOf[o2]!, depth - 1, seen)) {
          load[t]! -= periodsOf[o2]!
          load[t2]! += periodsOf[o2]!
          teacherOf[o2] = t2
          break
        }
      }
      if (spare() >= need) break
    }
    // A teacher once searched stays searched: each is tried at most once per
    // path, which keeps the search linear rather than exponential.
    return spare() >= need
  }
  for (const { o, i } of order) {
    if (periodsOf[i] === 0 || teacherOf[i]! >= 0) continue
    for (const c of o.teachers) {
      const t = teacherIx.get(c.id)
      if (t === undefined || !freeUp(t, periodsOf[i]!, 8, new Set())) continue
      teacherOf[i] = t
      load[t]! += periodsOf[i]!
      break
    }
    if (teacherOf[i]! < 0) {
      issues.push(
        o.teachers.length === 0
          ? { offeringId: o.id, code: 'no_eligible_teacher', message: 'nobody is eligible to teach it' }
          : { offeringId: o.id, code: 'teachers_full', message: 'everybody eligible to teach it is at their weekly limit' },
      )
    }
  }

  // --- 2. pins and meetings that cannot move -------------------------------------
  for (const f of input.fixed ?? []) {
    const n = needIx.get(f.needId)
    const pos = periodAt.get(`${f.day}:${f.index}`)
    const bi = n === undefined ? -1 : blocksOf[needOff[n]!]!.find((x) => blocks[x]!.need === n && !blocks[x]!.fixed) ?? -1
    if (bi < 0 || pos === undefined) {
      if (n !== undefined) {
        issues.push({ offeringId: needs[n]!.offeringId, code: 'pin_refused', message: `nothing to pin at day ${f.day}, period ${f.index}` })
      }
      continue
    }
    const b = blocks[bi]!
    if (f.roomId) b.fixedRoom = roomIx.get(f.roomId) ?? -1
    const valid = starts(b.length).includes(pos)
    const room = valid ? roomFor(b, pos) : -1
    if (room < 0) {
      // Refused: the block is placed like any other, and the office is told.
      b.fixedRoom = -1
      issues.push({
        offeringId: needs[n!]!.offeringId,
        code: 'pin_refused',
        message: valid
          ? `pinned to day ${f.day}, period ${f.index}, which clashes or has no room`
          : `a block of ${b.length} periods cannot start at day ${f.day}, period ${f.index}`,
      })
      continue
    }
    b.fixed = true
    b.locked = !!f.locked
    put(bi, pos, room)
  }

  // --- 3. everything else, hardest first -----------------------------------------
  const freeRooms = (bi: number) => roomsFor[blocks[bi]!.need]!.length
  const pending = blocks
    .map((_, i) => i)
    .filter((i) => blocks[i]!.pos < 0 && !blocks[i]!.fixed)
    .sort((a, b) => {
      const x = blocks[a]!
      const y = blocks[b]!
      const tx = teacherOf[x.offering]!
      const ty = teacherOf[y.offering]!
      return (
        y.length - x.length ||
        freeRooms(a) - freeRooms(b) ||
        (ty >= 0 ? load[ty]! : 0) - (tx >= 0 ? load[tx]! : 0) ||
        x.offering - y.offering ||
        a - b
      )
    })

  /**
   * The cheapest position for block bi (lifted for the search, put back after),
   * from every start or a random sample of them. The delta is what inserting it
   * there adds, so candidates compare like with like.
   */
  function bestPosition(bi: number, sample = 0): { pos: number; room: number; delta: number } | null {
    const b = blocks[bi]!
    let candidates = starts(b.length)
    if (sample > 0 && candidates.length > sample) {
      const pick: number[] = []
      for (let k = 0; k < sample; k++) pick.push(candidates[Math.floor(rand() * candidates.length)]!)
      candidates = pick
    }
    let best: { pos: number; room: number; delta: number } | null = null
    const was = b.pos >= 0 ? lift(bi) : null
    for (const pos of candidates) {
      if (!timeFits(b, pos)) continue
      const room = roomFor(b, pos)
      if (room < 0) continue
      const k = touch(keys(), b, pos)
      const before = costOf(k)
      put(bi, pos, room)
      const after = costOf(k)
      lift(bi)
      const delta = after - before + rand() * 0.5
      if (!best || delta < best.delta) best = { pos, room, delta }
    }
    if (was) put(bi, was.pos, was.room)
    return best
  }

  for (const bi of pending) {
    const at = bestPosition(bi)
    if (at) put(bi, at.pos, at.room)
  }

  // --- 4. repair: move one block out of the way ----------------------------------
  function eject(bi: number): boolean {
    const b = blocks[bi]!
    for (const pos of starts(b.length)) {
      // Which placed, movable blocks stand in the way here?
      const s = secOf[b.offering]!
      const t = teacherOf[b.offering]!
      const d = dayOf[pos]!
      if (t >= 0 && tDay[t]![d]! + b.length > teachers[t]!.maxPerDay) continue
      let blocked = false
      for (let k = 0; k < b.length && !blocked; k++) {
        if ((t >= 0 && tBusy[t]![pos + k]) || sBusy[s]![pos + k]) blocked = true
      }
      if (blocked) continue
      const inWay = new Set<number>()
      for (let k = 0; k < b.length; k++) {
        const i = pos + k
        for (let x = 0; x < blocks.length; x++) {
          const o = blocks[x]!
          if (o.pos < 0 || x === bi || i < o.pos || i >= o.pos + o.length) continue
          const ot = teacherOf[o.offering]!
          const os = secOf[o.offering]!
          if ((t >= 0 && ot === t) || conflicts[s]!.includes(os)) inWay.add(x)
        }
      }
      if (inWay.size !== 1) continue
      const x = [...inWay][0]!
      if (blocks[x]!.fixed) continue
      const was = lift(x)
      const room = timeFits(b, pos) ? roomFor(b, pos) : -1
      if (room >= 0) {
        put(bi, pos, room)
        const elsewhere = bestPosition(x)
        if (elsewhere) {
          put(x, elsewhere.pos, elsewhere.room)
          return true
        }
        lift(bi)
      }
      put(x, was.pos, was.room)
    }
    return false
  }
  for (const bi of pending) if (blocks[bi]!.pos < 0) eject(bi)

  // --- 5. improve ----------------------------------------------------------------
  const totalCost = () => {
    let c = 0
    for (let s = 0; s < sectionIds.length; s++) for (let d = 0; d < days.length; d++) c += sectionDayCost(s, d)
    for (let t = 0; t < teachers.length; t++) {
      for (let d = 0; d < days.length; d++) c += teacherDayCost(t, d)
      c += loadCost(t)
    }
    for (let n = 0; n < needs.length; n++) for (let d = 0; d < days.length; d++) c += needDayCost(n, d)
    for (let o = 0; o < offerings.length; o++) c += offeringCost(o)
    for (const b of blocks) if (b.pos < 0) c += W.unplaced
    return c
  }

  let current = totalCost()
  let best = current
  let bestState = snapshot()
  function snapshot() {
    return { pos: blocks.map((b) => b.pos), room: blocks.map((b) => b.room), teacher: [...teacherOf] }
  }
  function restore(st: ReturnType<typeof snapshot>) {
    for (let i = 0; i < blocks.length; i++) if (blocks[i]!.pos >= 0) lift(i)
    for (let o = 0; o < offerings.length; o++) {
      const t = teacherOf[o]!
      if (t >= 0) load[t]! -= periodsOf[o]!
      teacherOf[o] = st.teacher[o]!
      if (st.teacher[o]! >= 0) load[st.teacher[o]!]! += periodsOf[o]!
    }
    for (let i = 0; i < blocks.length; i++) if (st.pos[i]! >= 0) put(i, st.pos[i]!, st.room[i]!)
  }

  const movable = blocks.map((_, i) => i).filter((i) => !blocks[i]!.fixed)
  const iterations = Math.min(input.options?.iterations ?? Math.max(2000, 150 * blocks.length), 300_000)
  const timeLimit = input.options?.timeLimitMs ?? 20_000
  // The greedy timetable is already good: anneal gently from it, not from chaos.
  const T0 = 15
  const T1 = 0.3
  let it = 0
  const accept = (delta: number, temp: number) => delta <= 0 || rand() < Math.exp(-delta / temp)
  const isUnplaced = (i: number) => blocks[i]!.pos < 0
  const moves: Record<'place' | 'move' | 'swap' | 'teacher', [number, number]> = { place: [0, 0], move: [0, 0], swap: [0, 0], teacher: [0, 0] }

  for (; it < iterations && movable.length > 0; it++) {
    if ((it & 255) === 0 && Date.now() - started > timeLimit) break
    const temp = T0 * Math.pow(T1 / T0, it / iterations)
    const r = rand()

    if (r < 0.15) {
      // Place an unplaced block, by moving one out of its way if need be.
      const unplaced = movable.filter(isUnplaced)
      if (unplaced.length === 0) continue
      const bi = unplaced[Math.floor(rand() * unplaced.length)]!
      moves.place[0]++
      const at = bestPosition(bi)
      if (at) put(bi, at.pos, at.room)
      else eject(bi)
      if (blocks[bi]!.pos >= 0) moves.place[1]++
      current = totalCost()
    } else if (r < 0.55) {
      // Move one block to a better time and room.
      const bi = movable[Math.floor(rand() * movable.length)]!
      const b = blocks[bi]!
      if (b.pos < 0) continue
      const from = { pos: b.pos, room: b.room }
      const at = bestPosition(bi, 12)
      if (!at || (at.pos === from.pos && at.room === from.room)) continue
      moves.move[0]++
      const k = touch(touch(keys(), b, from.pos), b, at.pos)
      const before = costOf(k)
      lift(bi)
      put(bi, at.pos, at.room)
      const delta = costOf(k) - before
      if (accept(delta, temp)) {
        current += delta
        moves.move[1]++
      } else {
        lift(bi)
        put(bi, from.pos, from.room)
      }
    } else if (r < 0.85) {
      // Swap the times of two blocks of the same length.
      const a = movable[Math.floor(rand() * movable.length)]!
      const c = movable[Math.floor(rand() * movable.length)]!
      const A = blocks[a]!
      const C = blocks[c]!
      if (a === c || A.pos < 0 || C.pos < 0 || A.length !== C.length || A.pos === C.pos) continue
      const fa = { pos: A.pos, room: A.room }
      const fc = { pos: C.pos, room: C.room }
      moves.swap[0]++
      const k = touch(touch(touch(touch(keys(), A, fa.pos), A, fc.pos), C, fc.pos), C, fa.pos)
      const before = costOf(k)
      lift(a)
      lift(c)
      let ok = false
      const ra = timeFits(A, fc.pos) ? roomFor(A, fc.pos) : -1
      if (ra >= 0) {
        put(a, fc.pos, ra)
        const rc = timeFits(C, fa.pos) ? roomFor(C, fa.pos) : -1
        if (rc >= 0) {
          put(c, fa.pos, rc)
          ok = true
        } else lift(a)
      }
      if (!ok) {
        put(a, fa.pos, fa.room)
        put(c, fc.pos, fc.room)
        continue
      }
      const delta = costOf(k) - before
      if (accept(delta, temp)) {
        current += delta
        moves.swap[1]++
      } else {
        lift(a)
        lift(c)
        put(a, fa.pos, fa.room)
        put(c, fc.pos, fc.room)
      }
    } else {
      // Give a class to another eligible teacher.
      const o = Math.floor(rand() * offerings.length)
      const off = offerings[o]!
      if (off.teacher || periodsOf[o] === 0 || off.teachers.length === 0) continue
      if (blocksOf[o]!.some((x) => blocks[x]!.fixed)) continue
      const choice = off.teachers[Math.floor(rand() * off.teachers.length)]!
      const nt = teacherIx.get(choice.id)
      const ot = teacherOf[o]!
      if (nt === undefined || nt === ot || load[nt]! + periodsOf[o]! > teachers[nt]!.maxPerWeek) continue
      moves.teacher[0]++
      const mine = blocksOf[o]!.filter((x) => blocks[x]!.pos >= 0)
      const saved = mine.map((x) => ({ x, pos: blocks[x]!.pos, room: blocks[x]!.room }))
      const k = keys()
      for (const s of saved) {
        touch(k, blocks[s.x]!, s.pos, nt)
        if (ot >= 0) touch(k, blocks[s.x]!, s.pos, ot)
      }
      k.t.add(nt)
      if (ot >= 0) k.t.add(ot)
      k.o.add(o)
      const before = costOf(k)
      for (const x of mine) lift(x)
      const ok = saved.every((s) => fits(blocks[s.x]!, s.pos, s.room, nt))
      if (ok) {
        if (ot >= 0) load[ot]! -= periodsOf[o]!
        teacherOf[o] = nt
        load[nt]! += periodsOf[o]!
      }
      for (const s of saved) put(s.x, s.pos, s.room)
      if (!ok) continue
      const delta = costOf(k) - before
      if (accept(delta, temp)) {
        current += delta
        moves.teacher[1]++
      } else {
        for (const x of mine) lift(x)
        load[nt]! -= periodsOf[o]!
        teacherOf[o] = ot
        if (ot >= 0) load[ot]! += periodsOf[o]!
        for (const s of saved) put(s.x, s.pos, s.room)
      }
    }
    if ((it & 4095) === 0) current = totalCost()
    if (current < best) {
      current = totalCost()
      if (current < best) {
        best = current
        bestState = snapshot()
      }
    }
  }
  restore(bestState)

  // --- the answer ----------------------------------------------------------------
  const placements: SolverPlacement[] = []
  for (const b of blocks) {
    if (b.pos < 0) continue
    const first = periods[b.pos]!
    const last = periods[b.pos + b.length - 1]!
    const t = teacherOf[b.offering]!
    placements.push({
      needId: needs[b.need]!.id,
      offeringId: offerings[b.offering]!.id,
      teacherId: t >= 0 ? teachers[t]!.id : null,
      roomId: rooms[b.room]!.id,
      day: first.day,
      index: first.index,
      length: b.length,
      startsAt: first.startsAt,
      endsAt: last.endsAt,
      fixed: b.fixed,
      locked: b.locked,
    })
  }
  placements.sort((a, b) => a.day - b.day || a.index - b.index || a.offeringId.localeCompare(b.offeringId))

  const missing = new Map<number, number>()
  for (const b of blocks) if (b.pos < 0) missing.set(b.need, (missing.get(b.need) ?? 0) + 1)
  const unplaced: SolverUnplaced[] = [...missing].map(([n, count]) => ({
    needId: needs[n]!.id,
    offeringId: needs[n]!.offeringId,
    count,
    reason: whyNot(n),
  }))

  function whyNot(n: number): string {
    const need = needs[n]!
    const o = needOff[n]!
    const off = offerings[o]!
    if (roomsFor[n]!.length === 0) {
      return need.roomId
        ? 'the room it must have does not exist'
        : `no ${need.roomKind} room seats ${off.size}`
    }
    const b: Block = { need: n, offering: o, length: need.length, pos: -1, room: -1, fixed: false, locked: false, fixedRoom: -1 }
    const all = starts(need.length)
    if (all.length === 0) return `no ${need.length} periods in a row on any day`
    const t = teacherOf[o]!
    const section = all.filter((pos) => timeFits(b, pos, -1))
    if (section.length === 0) return 'the students have no free time left for it'
    if (t >= 0 && !section.some((pos) => timeFits(b, pos))) return 'its teacher has no free time left that the students also have'
    return 'every time that suits the teacher and the students has no room free'
  }

  const breakdown = { preference: 0, sameDay: 0, sectionGaps: 0, teacherGaps: 0, consecutive: 0, balance: 0, unstaffed: 0 }
  for (let o = 0; o < offerings.length; o++) {
    if (teacherOf[o]! < 0) breakdown.unstaffed += periodsOf[o]! > 0 ? W.unstaffed : 0
    else breakdown.preference += (5 - prefOf(o, teacherOf[o]!)) * W.preference
  }
  for (let n = 0; n < needs.length; n++) for (let d = 0; d < days.length; d++) breakdown.sameDay += needDayCost(n, d)
  for (let s = 0; s < sectionIds.length; s++) for (let d = 0; d < days.length; d++) breakdown.sectionGaps += gaps(sMask[s]![d]!) * W.sectionGap
  for (let t = 0; t < teachers.length; t++) {
    breakdown.balance += loadCost(t)
    for (let d = 0; d < days.length; d++) {
      breakdown.teacherGaps += gaps(tMask[t]![d]!) * W.teacherGap
      breakdown.consecutive += overrun(tMask[t]![d]!, breaks[d]!, teachers[t]!.maxConsecutive) * W.consecutive
    }
  }

  return {
    placements,
    unplaced,
    teachers: Object.fromEntries(offerings.map((o, i) => [o.id, teacherOf[i]! >= 0 ? teachers[teacherOf[i]!]!.id : null])),
    issues,
    cost: { total: totalCost(), ...breakdown },
    stats: { blocks: blocks.length, placed: placements.length, iterations: it, ms: Date.now() - started, seed, moves },
  }
}
