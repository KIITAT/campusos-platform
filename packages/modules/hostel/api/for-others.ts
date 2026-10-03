import { and, eq, isNull } from 'drizzle-orm'
import type { withTenant } from '@campusos/db'
import { allocations, blocks, leaves, rooms } from '../schema'

/**
 * What another module may ask of the hostel, inside its own transaction:
 * where a student lives, and leave granted elsewhere -- by a mentor -- that the
 * roll call should expect.
 */

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]

/** The block and room a student lives in now, or null if they are not housed. */
export async function housingOf(tx: Tx, studentId: string) {
  const [h] = await tx
    .select({ block: blocks.code, blockName: blocks.name, room: rooms.number })
    .from(allocations)
    .innerJoin(rooms, eq(rooms.id, allocations.roomId))
    .innerJoin(blocks, eq(blocks.id, rooms.blockId))
    .where(and(eq(allocations.studentId, studentId), isNull(allocations.vacatedOn)))
  return h ?? null
}

/**
 * Record leave approved elsewhere, so the roll call expects the empty bed.
 * Null when the student is not housed: there is no bed to expect empty.
 */
export async function recordLeaveWithin(
  tx: Tx,
  tenant: string,
  approverId: string,
  l: { studentId: string; fromOn: string; toOn: string; reason: string },
) {
  if (!(await housingOf(tx, l.studentId))) return null
  const [row] = await tx
    .insert(leaves)
    .values({ institutionId: tenant, studentId: l.studentId, fromOn: l.fromOn, toOn: l.toOn, reason: l.reason, approvedBy: approverId })
    .returning({ id: leaves.id })
  return row!.id
}

/** Take back leave recorded elsewhere, when it is cancelled there. */
export async function withdrawLeaveWithin(tx: Tx, leaveId: string) {
  await tx.delete(leaves).where(eq(leaves.id, leaveId))
}
