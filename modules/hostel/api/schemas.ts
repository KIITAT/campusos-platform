import * as z from 'zod'
import { blockKindEnum, checkInStatusEnum } from '../schema'

const uuid = z.uuid()
const day = z.iso.date()

export const createBlockSchema = z
  .object({
    code: z.string().trim().min(1).max(20),
    name: z.string().trim().min(1).max(120),
    kind: z.enum(blockKindEnum.enumValues).default('any'),
    wardenUserId: z.string().min(1).nullish(),
  })
  .meta({ id: 'HostelBlockCreate' })

export const addRoomsSchema = z
  .object({
    blockId: uuid,
    /** One per room. A floor's worth is typed at once, as it is built. */
    numbers: z.array(z.string().trim().min(1).max(20)).min(1).max(500),
    floor: z.coerce.number().int().min(-2).max(60).default(0),
    capacity: z.coerce.number().int().min(1).max(20).default(2),
  })
  .meta({ id: 'HostelRoomsAdd' })

export const allocateSchema = z
  .object({
    roomId: uuid,
    studentId: z.string().min(1),
    allocatedOn: day.nullish(),
  })
  .meta({ id: 'HostelAllocate' })

export const vacateSchema = z
  .object({
    allocationId: uuid,
    vacatedOn: day.nullish(),
    reason: z.string().trim().min(5).max(500),
  })
  .meta({ id: 'HostelVacate' })

export const grantLeaveSchema = z
  .object({
    studentId: z.string().min(1),
    fromOn: day,
    toOn: day,
    reason: z.string().trim().min(5).max(500),
  })
  .meta({ id: 'HostelLeaveGrant' })

export const markSchema = z
  .object({
    blockId: uuid,
    studentId: z.string().min(1),
    onNight: day.nullish(),
    status: z.enum(checkInStatusEnum.enumValues).default('present'),
    note: z.string().trim().max(500).nullish(),
  })
  .meta({ id: 'HostelCheckInMark' })

export const scanSchema = z
  .object({
    /** `blockId.window.token`, as printed on the gate screen. */
    code: z.string().min(3).max(200),
    blockId: uuid,
    onNight: day.nullish(),
  })
  .meta({ id: 'HostelCheckInScan' })

export const visitorInSchema = z
  .object({
    blockId: uuid,
    studentId: z.string().min(1).nullish(),
    name: z.string().trim().min(1).max(120),
    phone: z.string().trim().max(20).nullish(),
    relation: z.string().trim().max(60).nullish(),
    purpose: z.string().trim().max(200).nullish(),
  })
  .meta({ id: 'HostelVisitorIn' })

export const visitorOutSchema = z
  .object({ visitorId: uuid })
  .meta({ id: 'HostelVisitorOut' })

// --- reads -----------------------------------------------------------------

export const roomRowSchema = z
  .object({
    id: uuid,
    blockId: uuid,
    blockCode: z.string(),
    number: z.string(),
    floor: z.number().int(),
    capacity: z.number().int(),
    occupied: z.number().int(),
    residents: z.array(
      z.object({
        allocationId: uuid,
        studentId: z.string(),
        name: z.string().nullable(),
        email: z.string().nullable(),
        allocatedOn: z.string(),
      }),
    ),
  })
  .meta({ id: 'HostelRoom' })

export const rollCallRowSchema = z
  .object({
    studentId: z.string(),
    name: z.string().nullable(),
    email: z.string().nullable(),
    roomNumber: z.string(),
    status: z.enum(checkInStatusEnum.enumValues).nullable(),
    method: z.string().nullable(),
    note: z.string().nullable(),
    /** Leave granted in advance, so an empty bed is expected not missing. */
    onLeave: z.boolean(),
  })
  .meta({ id: 'HostelRollCallRow' })

export const rollCallSchema = z
  .object({
    blockId: uuid,
    blockCode: z.string(),
    onNight: z.string(),
    /** 'scan' when Attendance is enabled for this institution, else 'manual'. */
    mode: z.enum(['scan', 'manual']),
    rows: z.array(rollCallRowSchema),
    present: z.number().int(),
    absent: z.number().int(),
    onLeave: z.number().int(),
    unmarked: z.number().int(),
  })
  .meta({ id: 'HostelRollCall' })

export const visitorRowSchema = z
  .object({
    id: uuid,
    name: z.string(),
    phone: z.string().nullable(),
    relation: z.string().nullable(),
    purpose: z.string().nullable(),
    studentName: z.string().nullable(),
    enteredAt: z.string(),
    exitedAt: z.string().nullable(),
  })
  .meta({ id: 'HostelVisitor' })

export const myHostelSchema = z
  .object({
    allocated: z.boolean(),
    blockCode: z.string().nullable(),
    blockName: z.string().nullable(),
    roomNumber: z.string().nullable(),
    floor: z.number().int().nullable(),
    roommates: z.array(z.object({ studentId: z.string(), name: z.string().nullable() })),
    allocatedOn: z.string().nullable(),
    recentNights: z.array(
      z.object({
        onNight: z.string(),
        status: z.enum(checkInStatusEnum.enumValues),
        method: z.string(),
      }),
    ),
    upcomingLeave: z.array(
      z.object({ fromOn: z.string(), toOn: z.string(), reason: z.string() }),
    ),
  })
  .meta({ id: 'HostelMyStatus' })

export type RoomRow = z.infer<typeof roomRowSchema>
export type RollCall = z.infer<typeof rollCallSchema>
export type VisitorRow = z.infer<typeof visitorRowSchema>
export type MyHostel = z.infer<typeof myHostelSchema>
