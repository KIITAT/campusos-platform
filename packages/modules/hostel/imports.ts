import { and, eq, isNull, sql } from 'drizzle-orm'
import { users, withTenant } from '@campusos/db'
import type { ImportSpec, PluginActor } from '@campusos/module-framework'
import { allocations, blocks, rooms } from './schema'
import { addRooms, allocate, createBlock } from './api'

/**
 * Halls, their rooms and who sleeps in which, from the warden's register.
 * Each through the operation the hostel screens use: a room is never filled
 * past its beds and a student holds one bed at a time.
 */

const WARDENS = ['hostel_staff', 'institution_admin', 'super_admin'] as const
const tenantOf = (actor: PluginActor) => actor.institutionId!
const blank = (v: string | undefined) => (v ? v : undefined)

const blockByCode = async (actor: PluginActor, code: string) => {
  const [row] = await withTenant(tenantOf(actor), (tx) => tx.select({ id: blocks.id }).from(blocks).where(sql`lower(${blocks.code}) = ${code.trim().toLowerCase()}`))
  if (!row) throw new Error(`no block ${code}`)
  return row.id
}
const roomIn = async (actor: PluginActor, blockId: string, number: string) => {
  const [row] = await withTenant(tenantOf(actor), (tx) => tx.select({ id: rooms.id }).from(rooms).where(and(eq(rooms.blockId, blockId), eq(rooms.number, number.trim()))))
  return row?.id
}
const personByEmail = async (actor: PluginActor, email: string) => {
  const [row] = await withTenant(tenantOf(actor), (tx) => tx.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email.trim().toLowerCase()}`))
  if (!row) throw new Error(`nobody here has the email ${email}`)
  return row.id
}

export const imports: ImportSpec[] = [
  {
    id: 'blocks',
    title: 'Blocks',
    note: 'One row per hostel block or hall.',
    roles: [...WARDENS],
    columns: [
      { name: 'code', required: true, note: 'Short code, unique here', example: 'GH-1' },
      { name: 'name', required: true, note: 'What it is called', example: 'Gargi Hall' },
      { name: 'kind', note: 'mens, womens or any; blank is any', example: 'womens' },
      { name: 'warden_email', note: 'Optional: the warden’s email address', example: 'warden@college.edu' },
    ],
    row: async (actor, { values: v }) => {
      const [existing] = await withTenant(tenantOf(actor), (tx) => tx.select({ id: blocks.id }).from(blocks).where(sql`lower(${blocks.code}) = ${v.code!.toLowerCase()}`))
      if (existing) return 'skipped'
      const wardenUserId = v.warden_email ? await personByEmail(actor, v.warden_email) : undefined
      await createBlock(actor, { code: v.code, name: v.name, kind: blank(v.kind?.toLowerCase()), wardenUserId })
      return 'created'
    },
  },
  {
    id: 'rooms',
    title: 'Rooms',
    note: 'One row per room, in a block that exists or was imported first.',
    roles: [...WARDENS],
    columns: [
      { name: 'block', required: true, note: 'The block code', example: 'GH-1' },
      { name: 'number', required: true, note: 'The room number, unique in its block', example: '204' },
      { name: 'floor', note: 'Blank is 0, the ground floor', example: '2' },
      { name: 'beds', note: 'How many it sleeps; blank is 2', example: '3' },
    ],
    row: async (actor, { values: v }) => {
      const blockId = await blockByCode(actor, v.block!)
      if (await roomIn(actor, blockId, v.number!)) return 'skipped'
      await addRooms(actor, { blockId, numbers: [v.number], floor: blank(v.floor), capacity: blank(v.beds) })
      return 'created'
    },
  },
  {
    id: 'allocations',
    title: 'Room allocations',
    note: 'Who is in which room. A student already in a room keeps it: vacate it on the hostel screens first to move them.',
    roles: [...WARDENS],
    columns: [
      { name: 'email', required: true, note: 'The student’s email address', example: 'priya@college.edu' },
      { name: 'block', required: true, note: 'The block code', example: 'GH-1' },
      { name: 'room', required: true, note: 'The room number', example: '204' },
      { name: 'allocated_on', note: 'YYYY-MM-DD; blank is today', example: '2026-07-18' },
    ],
    row: async (actor, { values: v }) => {
      const studentId = await personByEmail(actor, v.email!)
      const blockId = await blockByCode(actor, v.block!)
      const roomId = await roomIn(actor, blockId, v.room!)
      if (!roomId) throw new Error(`no room ${v.room} in ${v.block}`)
      const [open] = await withTenant(tenantOf(actor), (tx) =>
        tx.select({ roomId: allocations.roomId }).from(allocations).where(and(eq(allocations.studentId, studentId), isNull(allocations.vacatedOn))),
      )
      if (open?.roomId === roomId) return 'skipped'
      if (open) throw new Error(`${v.email} already holds a room; vacate it first`)
      await allocate(actor, { roomId, studentId, allocatedOn: blank(v.allocated_on) })
      return 'created'
    },
  },
]
