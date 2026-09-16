import { and, asc, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm'
import { audit, users, withTenant } from '@campusos/db'
import { moduleEnabled, type Role } from '@campusos/module-framework'
import { manifest as attendanceManifest } from '@campusos/module-attendance/manifest'
import { manifest as hostelManifest } from '../manifest'
import { allocations, blocks, checkIns, leaves, rooms, visitors } from '../schema'
import {
  ROLL_CALL_WINDOW_SECONDS,
  decodeQr,
  rollCallKey,
  rollCallQr,
  rollCallSecret,
  verifyToken,
  type RollCallMode,
} from './rollcall'
import {
  addRoomsSchema,
  allocateSchema,
  createBlockSchema,
  grantLeaveSchema,
  markSchema,
  scanSchema,
  vacateSchema,
  visitorInSchema,
  visitorOutSchema,
  type MyHostel,
  type RollCall,
  type RoomRow,
  type VisitorRow,
} from './schemas'

const MODULE = 'hostel'

export interface Actor {
  id: string
  email?: string | null
  role: Role
  institutionId: string | null
}

export class HostelError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]

const tenantOf = (actor: Actor): string => {
  if (!actor.institutionId) {
    throw new HostelError(400, 'no_institution', 'no institution for this session')
  }
  return actor.institutionId
}

/** The warden's desk, plus the administrators above it. */
const isWarden = (r: Role) =>
  r === 'hostel_staff' || r === 'institution_admin' || r === 'super_admin'

const requireWarden = (actor: Actor) => {
  const tenant = tenantOf(actor)
  if (!isWarden(actor.role)) throw new HostelError(403, 'forbidden', 'not permitted')
  return tenant
}

/** Allocating and vacating beds is an administrative act, not a gate one. */
const requireAdmin = (actor: Actor) => {
  const tenant = tenantOf(actor)
  if (!isWarden(actor.role)) throw new HostelError(403, 'forbidden', 'not permitted')
  return tenant
}

const today = () => new Date().toISOString().slice(0, 10)

/**
 * The soft dependency, in one function.
 *
 * Only these two manifests are passed, not the app's registry: a module cannot
 * import the registry without a cycle, and it does not need to -- it depends on
 * the Attendance package already, so it can name the manifest directly.
 */
export async function rollCallMode(institutionId: string): Promise<RollCallMode> {
  const on = await moduleEnabled(
    [hostelManifest, attendanceManifest],
    'attendance',
    institutionId,
  )
  return on ? 'scan' : 'manual'
}

// --- inventory -------------------------------------------------------------

export async function createBlock(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = createBlockSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const [row] = await tx
      .insert(blocks)
      .values({
        institutionId: tenant,
        code: d.code,
        name: d.name,
        kind: d.kind,
        wardenUserId: d.wardenUserId ?? null,
      })
      .onConflictDoNothing()
      .returning()
    if (!row) throw new HostelError(409, 'exists', 'that block code is already in use')
    return row
  })
}

export async function addRooms(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = addRoomsSchema.parse(input)

  const unique = [...new Set(d.numbers)]
  if (unique.length !== d.numbers.length) {
    throw new HostelError(400, 'duplicate_number', 'that list repeats a room number')
  }

  return withTenant(tenant, async (tx) => {
    const [block] = await tx.select().from(blocks).where(eq(blocks.id, d.blockId))
    if (!block) throw new HostelError(404, 'no_such_block', 'no such block')

    const rows = await tx
      .insert(rooms)
      .values(
        unique.map((number) => ({
          institutionId: tenant,
          blockId: d.blockId,
          number,
          floor: d.floor,
          capacity: d.capacity,
        })),
      )
      .onConflictDoNothing()
      .returning()

    if (rows.length !== unique.length) {
      throw new HostelError(409, 'room_exists', 'one of those room numbers already exists')
    }
    return rows
  })
}

export async function listRooms(actor: Actor, blockId?: string): Promise<RoomRow[]> {
  const tenant = requireWarden(actor)

  return withTenant(tenant, async (tx): Promise<RoomRow[]> => {
    const roomRows = await tx
      .select({
        id: rooms.id,
        blockId: rooms.blockId,
        blockCode: blocks.code,
        number: rooms.number,
        floor: rooms.floor,
        capacity: rooms.capacity,
      })
      .from(rooms)
      .innerJoin(blocks, eq(blocks.id, rooms.blockId))
      .where(blockId ? eq(rooms.blockId, blockId) : undefined)
      .orderBy(asc(blocks.code), asc(rooms.floor), asc(rooms.number))

    const living = await tx
      .select({
        allocationId: allocations.id,
        roomId: allocations.roomId,
        studentId: allocations.studentId,
        allocatedOn: allocations.allocatedOn,
        name: users.name,
        email: users.email,
      })
      .from(allocations)
      .innerJoin(users, eq(users.id, allocations.studentId))
      .where(isNull(allocations.vacatedOn))

    const byRoom = new Map<string, typeof living>()
    for (const a of living) {
      byRoom.set(a.roomId, [...(byRoom.get(a.roomId) ?? []), a])
    }

    return roomRows.map((r) => {
      const residents = byRoom.get(r.id) ?? []
      return {
        ...r,
        occupied: residents.length,
        residents: residents.map((a) => ({
          allocationId: a.allocationId,
          studentId: a.studentId,
          name: a.name,
          email: a.email,
          allocatedOn: a.allocatedOn,
        })),
      }
    })
  })
}

export async function listBlocks(actor: Actor) {
  const tenant = tenantOf(actor)
  return withTenant(tenant, (tx) =>
    tx
      .select({
        id: blocks.id,
        code: blocks.code,
        name: blocks.name,
        kind: blocks.kind,
        wardenUserId: blocks.wardenUserId,
      })
      .from(blocks)
      .orderBy(asc(blocks.code)),
  )
}

// --- residence -------------------------------------------------------------

export async function allocate(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = allocateSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const [student] = await tx
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, d.studentId))
    if (!student) throw new HostelError(404, 'no_such_student', 'no such student')
    if (student.role !== 'student') {
      throw new HostelError(400, 'not_a_student', 'only students are allocated beds')
    }

    const [open] = await tx
      .select({ id: allocations.id })
      .from(allocations)
      .where(and(eq(allocations.studentId, d.studentId), isNull(allocations.vacatedOn)))
    if (open) {
      throw new HostelError(
        409,
        'already_allocated',
        'that student already has a bed; vacate it first',
      )
    }

    const [row] = await tx
      .insert(allocations)
      .values({
        institutionId: tenant,
        roomId: d.roomId,
        studentId: d.studentId,
        allocatedOn: d.allocatedOn ?? today(),
        allocatedBy: actor.id,
      })
      .returning()
    return row!
  })
}

/**
 * Vacating is audited: a bed changing hands mid-term is a decision somebody
 * made, and "why was I moved" is asked often enough to be worth answering.
 */
export async function vacate(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = vacateSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const [row] = await tx
      .select()
      .from(allocations)
      .where(eq(allocations.id, d.allocationId))
    if (!row) throw new HostelError(404, 'no_such_allocation', 'no such allocation')
    if (row.vacatedOn) throw new HostelError(409, 'already_vacated', 'already vacated')

    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: 'hostel.vacated',
      entity: 'hostel_allocations',
      entityId: row.id,
      reason: d.reason,
      detail: { studentId: row.studentId, roomId: row.roomId, since: row.allocatedOn },
    })

    const [updated] = await tx
      .update(allocations)
      .set({ vacatedOn: d.vacatedOn ?? today() })
      .where(eq(allocations.id, d.allocationId))
      .returning()
    return updated!
  })
}

export async function grantLeave(actor: Actor, input: unknown) {
  const tenant = requireWarden(actor)
  const d = grantLeaveSchema.parse(input)
  if (d.toOn < d.fromOn) {
    throw new HostelError(400, 'bad_dates', 'leave cannot end before it starts')
  }

  return withTenant(tenant, async (tx) => {
    const [row] = await tx
      .insert(leaves)
      .values({
        institutionId: tenant,
        studentId: d.studentId,
        fromOn: d.fromOn,
        toOn: d.toOn,
        reason: d.reason,
        approvedBy: actor.id,
      })
      .returning()
    return row!
  })
}

// --- roll call -------------------------------------------------------------

/**
 * The QR for a gate screen, when Attendance is enabled. Refuses rather than
 * silently returning a code nobody can scan when it is not: a blank screen with
 * an explanation beats a QR that does nothing.
 */
export async function rollCallCode(actor: Actor, blockId: string, secret?: string) {
  const tenant = requireWarden(actor)
  if ((await rollCallMode(tenant)) !== 'scan') {
    throw new HostelError(
      409,
      'attendance_not_enabled',
      'scan roll call needs the Attendance module; take the manual register instead',
    )
  }
  return rollCallQr(secret ?? rollCallSecret(tenant), blockId, today())
}

export async function scanCheckIn(actor: Actor, input: unknown, secret?: string) {
  const tenant = tenantOf(actor)
  const d = scanSchema.parse(input)
  const night = d.onNight ?? today()

  if ((await rollCallMode(tenant)) !== 'scan') {
    throw new HostelError(
      409,
      'attendance_not_enabled',
      'scan roll call needs the Attendance module',
    )
  }

  const presented = decodeQr(d.code)
  if (!presented) throw new HostelError(400, 'malformed_code', 'that code is not readable')
  if (presented.sessionId !== rollCallKey(d.blockId, night)) {
    throw new HostelError(400, 'wrong_block', 'that code belongs to another block or night')
  }

  const verdict = verifyToken(
    secret ?? rollCallSecret(tenant),
    presented.sessionId,
    ROLL_CALL_WINDOW_SECONDS,
    presented,
  )
  if (verdict !== 'ok') {
    throw new HostelError(409, verdict === 'stale' ? 'stale_code' : 'invalid_code', 'that code is no longer valid')
  }

  return recordNight(tenant, {
    blockId: d.blockId,
    studentId: actor.id,
    onNight: night,
    status: 'present',
    method: 'scan',
    note: null,
    recordedBy: actor.id,
  })
}

/** The manual register: a warden ticking names off a list. */
export async function mark(actor: Actor, input: unknown) {
  const tenant = requireWarden(actor)
  const d = markSchema.parse(input)
  return recordNight(tenant, {
    blockId: d.blockId,
    studentId: d.studentId,
    onNight: d.onNight ?? today(),
    status: d.status,
    method: 'manual',
    note: d.note ?? null,
    recordedBy: actor.id,
  })
}

async function recordNight(
  tenant: string,
  v: {
    blockId: string
    studentId: string
    onNight: string
    status: 'present' | 'absent' | 'on_leave'
    method: 'scan' | 'manual'
    note: string | null
    recordedBy: string
  },
) {
  return withTenant(tenant, async (tx) => {
    const [row] = await tx
      .insert(checkIns)
      .values({ institutionId: tenant, ...v })
      .onConflictDoUpdate({
        target: [checkIns.studentId, checkIns.onNight],
        // A scan cannot overwrite a warden's manual decision: the register is
        // the record of last resort. A manual mark may always correct a scan.
        set: {
          status: v.status,
          method: v.method,
          note: v.note,
          recordedBy: v.recordedBy,
          recordedAt: new Date(),
        },
        setWhere: sql`${checkIns.method} <> 'manual' or excluded.method = 'manual'`,
      })
      .returning()
    if (!row) {
      throw new HostelError(409, 'already_marked', 'that night is already recorded')
    }
    return row
  })
}

export async function rollCall(
  actor: Actor,
  blockId: string,
  night?: string,
): Promise<RollCall> {
  const tenant = requireWarden(actor)
  const onNight = night ?? today()
  const mode = await rollCallMode(tenant)

  return withTenant(tenant, async (tx): Promise<RollCall> => {
    const [block] = await tx.select().from(blocks).where(eq(blocks.id, blockId))
    if (!block) throw new HostelError(404, 'no_such_block', 'no such block')

    const residents = await tx
      .select({
        studentId: allocations.studentId,
        name: users.name,
        email: users.email,
        roomNumber: rooms.number,
      })
      .from(allocations)
      .innerJoin(rooms, eq(rooms.id, allocations.roomId))
      .innerJoin(users, eq(users.id, allocations.studentId))
      .where(
        and(
          eq(rooms.blockId, blockId),
          lte(allocations.allocatedOn, onNight),
          // Strictly greater: vacating on the 6th means sleeping elsewhere on
          // the night of the 6th. The check-in trigger agrees.
          sql`(${allocations.vacatedOn} is null or ${allocations.vacatedOn} > ${onNight})`,
        ),
      )
      .orderBy(asc(rooms.number), asc(users.name))

    const marked = await tx
      .select({
        studentId: checkIns.studentId,
        status: checkIns.status,
        method: checkIns.method,
        note: checkIns.note,
      })
      .from(checkIns)
      .where(and(eq(checkIns.blockId, blockId), eq(checkIns.onNight, onNight)))

    const onLeaveRows = await tx
      .select({ studentId: leaves.studentId })
      .from(leaves)
      .where(and(lte(leaves.fromOn, onNight), gte(leaves.toOn, onNight)))

    const byStudent = new Map(marked.map((m) => [m.studentId, m]))
    const leaveSet = new Set(onLeaveRows.map((l) => l.studentId))

    const rows = residents.map((r) => {
      const m = byStudent.get(r.studentId)
      return {
        studentId: r.studentId,
        name: r.name,
        email: r.email,
        roomNumber: r.roomNumber,
        status: m?.status ?? null,
        method: m?.method ?? null,
        note: m?.note ?? null,
        onLeave: leaveSet.has(r.studentId),
      }
    })

    return {
      blockId,
      blockCode: block.code,
      onNight,
      mode,
      rows,
      present: rows.filter((r) => r.status === 'present').length,
      absent: rows.filter((r) => r.status === 'absent').length,
      onLeave: rows.filter((r) => r.onLeave || r.status === 'on_leave').length,
      unmarked: rows.filter((r) => r.status === null && !r.onLeave).length,
    }
  })
}

// --- visitors --------------------------------------------------------------

export async function visitorIn(actor: Actor, input: unknown) {
  const tenant = requireWarden(actor)
  const d = visitorInSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const [row] = await tx
      .insert(visitors)
      .values({
        institutionId: tenant,
        blockId: d.blockId,
        studentId: d.studentId ?? null,
        name: d.name,
        phone: d.phone ?? null,
        relation: d.relation ?? null,
        purpose: d.purpose ?? null,
        recordedBy: actor.id,
      })
      .returning()
    return row!
  })
}

export async function visitorOut(actor: Actor, input: unknown) {
  const tenant = requireWarden(actor)
  const d = visitorOutSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const [row] = await tx.select().from(visitors).where(eq(visitors.id, d.visitorId))
    if (!row) throw new HostelError(404, 'no_such_visitor', 'no such visitor')
    if (row.exitedAt) throw new HostelError(409, 'already_out', 'already signed out')

    const [updated] = await tx
      .update(visitors)
      .set({ exitedAt: new Date() })
      .where(eq(visitors.id, d.visitorId))
      .returning()
    return updated!
  })
}

export async function visitorLog(
  actor: Actor,
  blockId?: string,
  openOnly = false,
): Promise<VisitorRow[]> {
  const tenant = requireWarden(actor)

  return withTenant(tenant, async (tx): Promise<VisitorRow[]> => {
    const rows = await tx
      .select({
        id: visitors.id,
        name: visitors.name,
        phone: visitors.phone,
        relation: visitors.relation,
        purpose: visitors.purpose,
        studentName: users.name,
        enteredAt: visitors.enteredAt,
        exitedAt: visitors.exitedAt,
      })
      .from(visitors)
      .leftJoin(users, eq(users.id, visitors.studentId))
      .where(
        and(
          blockId ? eq(visitors.blockId, blockId) : undefined,
          openOnly ? isNull(visitors.exitedAt) : undefined,
        ),
      )
      .orderBy(desc(visitors.enteredAt))
      .limit(300)

    return rows.map((r) => ({
      ...r,
      enteredAt: r.enteredAt.toISOString(),
      exitedAt: r.exitedAt?.toISOString() ?? null,
    }))
  })
}

// --- the student's own view ------------------------------------------------

export async function myHostel(actor: Actor, studentId?: string): Promise<MyHostel> {
  const tenant = tenantOf(actor)
  const target = studentId ?? actor.id
  if (!isWarden(actor.role) && target !== actor.id) {
    throw new HostelError(403, 'forbidden', 'not permitted')
  }

  return withTenant(tenant, async (tx): Promise<MyHostel> => {
    const [mine] = await tx
      .select({
        allocationId: allocations.id,
        roomId: allocations.roomId,
        allocatedOn: allocations.allocatedOn,
        roomNumber: rooms.number,
        floor: rooms.floor,
        blockCode: blocks.code,
        blockName: blocks.name,
      })
      .from(allocations)
      .innerJoin(rooms, eq(rooms.id, allocations.roomId))
      .innerJoin(blocks, eq(blocks.id, rooms.blockId))
      .where(and(eq(allocations.studentId, target), isNull(allocations.vacatedOn)))

    const nights = await tx
      .select({ onNight: checkIns.onNight, status: checkIns.status, method: checkIns.method })
      .from(checkIns)
      .where(eq(checkIns.studentId, target))
      .orderBy(desc(checkIns.onNight))
      .limit(30)

    const upcoming = await tx
      .select({ fromOn: leaves.fromOn, toOn: leaves.toOn, reason: leaves.reason })
      .from(leaves)
      .where(and(eq(leaves.studentId, target), gte(leaves.toOn, today())))
      .orderBy(asc(leaves.fromOn))

    if (!mine) {
      return {
        allocated: false,
        blockCode: null,
        blockName: null,
        roomNumber: null,
        floor: null,
        roommates: [],
        allocatedOn: null,
        recentNights: nights,
        upcomingLeave: upcoming,
      }
    }

    const roommates = await tx
      .select({ studentId: allocations.studentId, name: users.name })
      .from(allocations)
      .innerJoin(users, eq(users.id, allocations.studentId))
      .where(
        and(
          eq(allocations.roomId, mine.roomId),
          isNull(allocations.vacatedOn),
          sql`${allocations.studentId} <> ${target}`,
        ),
      )

    return {
      allocated: true,
      blockCode: mine.blockCode,
      blockName: mine.blockName,
      roomNumber: mine.roomNumber,
      floor: mine.floor,
      roommates,
      allocatedOn: mine.allocatedOn,
      recentNights: nights,
      upcomingLeave: upcoming,
    }
  })
}

export type { Tx }
