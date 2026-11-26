import { eq, sql } from 'drizzle-orm'
import * as z from 'zod'
import { audit, users, withTenant } from '@campusos/db'
import { blocks, wardenScopes } from '../schema'
import { HostelError, requireAdmin, type Actor } from './operations'

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]

const MODULE = 'hostel'

export const addScopeSchema = z
  .object({
    userId: z.string().min(1),
    level: z.enum(['floor', 'block', 'chief', 'estate']),
    blockId: z.uuid().nullish(),
    floor: z.coerce.number().int().min(-2).max(60).nullish(),
  })
  .refine(
    (d) =>
      (d.level === 'floor' && d.blockId && d.floor != null) ||
      (d.level === 'block' && d.blockId && d.floor == null) ||
      ((d.level === 'chief' || d.level === 'estate') && !d.blockId && d.floor == null),
    { message: 'a floor scope needs a block and a floor; a block scope a block; chief and estate neither' },
  )
  .meta({ id: 'HostelScopeAdd' })

export const removeScopeSchema = z.object({ scopeId: z.uuid() }).meta({ id: 'HostelScopeRemove' })

/** Who holds which scope: administrators only until 22b brings enforcement (D1342). */
export async function listScopes(actor: Actor) {
  const tenant = requireAdmin(actor)
  return withTenant(tenant, (tx) =>
    tx
      .select({
        id: wardenScopes.id,
        userId: wardenScopes.userId,
        name: users.name,
        level: wardenScopes.level,
        blockId: wardenScopes.blockId,
        blockCode: blocks.code,
        floor: wardenScopes.floor,
      })
      .from(wardenScopes)
      .innerJoin(users, eq(users.id, wardenScopes.userId))
      .leftJoin(blocks, eq(blocks.id, wardenScopes.blockId))
      .orderBy(wardenScopes.level, users.name),
  )
}

export async function addScope(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = addScopeSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [who] = await tx.select({ role: users.role }).from(users).where(eq(users.id, d.userId))
    if (!who || who.role !== 'hostel_staff') {
      throw new HostelError(400, 'not_hostel_staff', 'a scope can only be held by hostel staff')
    }
    const [row] = await tx
      .insert(wardenScopes)
      .values({
        institutionId: tenant,
        userId: d.userId,
        level: d.level,
        blockId: d.blockId ?? null,
        floor: d.floor ?? null,
        createdBy: actor.id,
      })
      .returning()
    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: 'hostel.scope_added',
      entity: 'hostel_warden_scopes',
      entityId: row!.id,
      reason: 'warden scope added',
      detail: { userId: d.userId, level: d.level, blockId: d.blockId ?? null, floor: d.floor ?? null },
    })
    return row!
  })
}

export async function removeScope(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = removeScopeSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [row] = await tx.delete(wardenScopes).where(eq(wardenScopes.id, d.scopeId)).returning()
    if (!row) throw new HostelError(404, 'no_such_scope', 'no such scope')
    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: 'hostel.scope_removed',
      entity: 'hostel_warden_scopes',
      entityId: row.id,
      reason: 'warden scope removed',
      detail: { userId: row.userId, level: row.level },
    })
    return { removed: true }
  })
}

export interface Recipients {
  studentName: string
  blockCode: string
  room: string
  floor: number | null
  blockKind: string | null
  userIds: string[]
}

/** Where a resident sleeps, as the ladder needs it. */
export interface Home {
  studentName: string
  blockId: string | null
  blockCode: string
  blockKind: string | null
  wardenUserId: string | null
  room: string
  floor: number | null
}

const ids = (rows: { id: string }[]) => rows.map((r) => r.id)

/** The homes of many residents in one query; a person without a bed has an empty home. */
export async function homesOf(tx: Tx, studentIds: string[]): Promise<Map<string, Home>> {
  if (studentIds.length === 0) return new Map()
  const rows = (await tx.execute(sql`
    select u.id, u.name as student_name, b.id as block_id, b.code as block_code, b.kind::text as block_kind,
           b.warden_user_id, r.number as room, r.floor
      from users u
      left join hostel_allocations a on a.student_id = u.id and a.vacated_on is null
      left join hostel_rooms r on r.id = a.room_id
      left join hostel_blocks b on b.id = r.block_id
     where u.id = any(${`{${studentIds.join(',')}}`}::text[])`)).rows as {
    id: string
    student_name: string | null
    block_id: string | null
    block_code: string | null
    block_kind: string | null
    warden_user_id: string | null
    room: string | null
    floor: number | null
  }[]
  return new Map(
    rows.map((h) => [
      h.id,
      {
        studentName: h.student_name ?? '',
        blockId: h.block_id,
        blockCode: h.block_code ?? '',
        blockKind: h.block_kind,
        wardenUserId: h.warden_user_id,
        room: h.room ?? '',
        floor: h.floor,
      },
    ]),
  )
}

/**
 * Who should be told about a resident living at `home` (D1327). Never a silent no-op and never an empty list:
 * floor scope rows, else block scope rows, else the block's warden, else every hostel_staff user, else every
 * administrator. Chief recipients are the chief-level scope rows, else the administrators. A scope row counts only
 * while its holder is still hostel staff and not erased (a role change must not keep routing alerts to them).
 */
export async function recipientsAt(tx: Tx, tenant: string, home: Pick<Home, 'blockId' | 'floor' | 'wardenUserId'>, level: 'floor' | 'block' | 'chief'): Promise<string[]> {
  const scoped = async (cond: ReturnType<typeof sql>) =>
    ids(
      (await tx.execute(sql`
        select distinct s.user_id as id from hostel_warden_scopes s
          join users u on u.id = s.user_id and u.role = 'hostel_staff' and u.erased_at is null
         where s.institution_id = ${tenant} and ${cond}`)).rows as { id: string }[],
    )

  let userIds: string[] = []
  if (level === 'chief') {
    userIds = await scoped(sql`s.level = 'chief'`)
  } else {
    if (level === 'floor' && home.blockId && home.floor != null) {
      userIds = await scoped(sql`s.level = 'floor' and s.block_id = ${home.blockId} and s.floor = ${home.floor}`)
    }
    if (userIds.length === 0 && home.blockId) userIds = await scoped(sql`s.level = 'block' and s.block_id = ${home.blockId}`)
    if (userIds.length === 0 && home.wardenUserId) userIds = [home.wardenUserId]
    if (userIds.length === 0) {
      userIds = ids((await tx.execute(sql`select id from users where institution_id = ${tenant} and role = 'hostel_staff'`)).rows as { id: string }[])
    }
  }
  if (userIds.length === 0) {
    userIds = ids((await tx.execute(sql`select id from users where institution_id = ${tenant} and role = 'institution_admin'`)).rows as { id: string }[])
  }
  return userIds
}

/** One resident's recipients; the ladder uses `homesOf` and `recipientsAt` so it asks once per floor, not once per case. */
export async function recipientsFor(
  tx: Tx,
  tenant: string,
  studentId: string,
  level: 'floor' | 'block' | 'chief',
): Promise<Recipients> {
  const home = (await homesOf(tx, [studentId])).get(studentId)
  const h: Home = home ?? { studentName: '', blockId: null, blockCode: '', blockKind: null, wardenUserId: null, room: '', floor: null }
  return { studentName: h.studentName, blockCode: h.blockCode, room: h.room, floor: h.floor, blockKind: h.blockKind, userIds: await recipientsAt(tx, tenant, h, level) }
}
