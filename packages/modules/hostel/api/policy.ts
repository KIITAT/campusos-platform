import { eq } from 'drizzle-orm'
import * as z from 'zod'
import { audit, withTenant } from '@campusos/db'
import { blocks, policy } from '../schema'
import { HostelError, requireAdmin, requireWarden, type Actor } from './operations'

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]

const MODULE = 'hostel'

/** What a hostel works with the day it is enabled (D1320). Times are `HH:MM:SS`. */
export interface Policy {
  curfewTime: string
  nudgeAfterMin: number
  wardenAfterMin: number
  womensWardenAfterMin: number
  guardianAfterMin: number
  walkBackMin: number
  caseWindowHours: number
  latePassLatestTime: string
  notifyWardenOnLibraryEntry: boolean
  presenceRetentionDays: number
}

export const DEFAULT_POLICY: Policy = {
  curfewTime: '21:30:00',
  nudgeAfterMin: 10,
  wardenAfterMin: 30,
  womensWardenAfterMin: 15,
  guardianAfterMin: 60,
  walkBackMin: 20,
  caseWindowHours: 6,
  latePassLatestTime: '01:00:00',
  notifyWardenOnLibraryEntry: false,
  presenceRetentionDays: 90,
}

/** The institution's policy, or the defaults when no row has been written. */
export async function loadPolicy(tx: Tx, tenant: string): Promise<Policy> {
  const [row] = await tx.select().from(policy).where(eq(policy.institutionId, tenant))
  if (!row) return DEFAULT_POLICY
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { institutionId, updatedAt, ...rest } = row
  return rest
}

export async function getPolicy(actor: Actor): Promise<Policy> {
  const tenant = requireWarden(actor)
  return withTenant(tenant, (tx) => loadPolicy(tx, tenant))
}

const clock = z.string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'a time as HH:MM')

export const setPolicySchema = z
  .object({
    curfewTime: clock.refine((v) => v >= '17:00', 'curfew is between 17:00 and 23:59'),
    nudgeAfterMin: z.coerce.number().int().min(0).max(120),
    wardenAfterMin: z.coerce.number().int().min(1).max(360),
    womensWardenAfterMin: z.coerce.number().int().min(1).max(360),
    guardianAfterMin: z.coerce.number().int().min(2).max(360),
    walkBackMin: z.coerce.number().int().min(0).max(90),
    caseWindowHours: z.coerce.number().int().min(1).max(12),
    latePassLatestTime: clock.refine((v) => v <= '04:00', 'the latest pass time is at most 04:00'),
    notifyWardenOnLibraryEntry: z.preprocess((v) => (v === 'false' ? false : v === 'on' || v === 'true' ? true : v), z.boolean()),
    presenceRetentionDays: z.coerce.number().int().min(30).max(730),
    reason: z.string().trim().min(5).max(500),
  })
  .refine(
    (d) =>
      d.wardenAfterMin > d.nudgeAfterMin &&
      d.womensWardenAfterMin > d.nudgeAfterMin &&
      d.guardianAfterMin > d.wardenAfterMin &&
      d.guardianAfterMin > d.womensWardenAfterMin,
    { message: 'each step of the ladder must come after the one before it', path: ['guardianAfterMin'] },
  )
  .meta({ id: 'HostelPolicySet' })

/** The institution's presence policy: administrators only, audited (D1340). */
export async function setPolicy(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const { reason, ...d } = setPolicySchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const from = await loadPolicy(tx, tenant)
    const values = { institutionId: tenant, ...d, updatedAt: new Date() }
    await tx.insert(policy).values(values).onConflictDoUpdate({ target: policy.institutionId, set: values })
    const to = await loadPolicy(tx, tenant)
    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: 'hostel.policy_set',
      entity: 'hostel_policy',
      entityId: tenant,
      reason,
      detail: { from, to },
    })
    return to
  })
}

export const setBlockCurfewSchema = z
  .object({
    blockId: z.uuid(),
    curfewTime: clock.refine((v) => v >= '17:00', 'curfew is between 17:00 and 23:59').nullable(),
  })
  .meta({ id: 'HostelBlockCurfewSet' })

/** One block's own curfew, or null to follow the institution's. */
export async function setBlockCurfew(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = setBlockCurfewSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [row] = await tx.update(blocks).set({ curfewTime: d.curfewTime }).where(eq(blocks.id, d.blockId)).returning()
    if (!row) throw new HostelError(404, 'no_such_block', 'no such block')
    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: 'hostel.policy_set',
      entity: 'hostel_blocks',
      entityId: d.blockId,
      reason: 'block curfew',
      detail: { curfewTime: d.curfewTime },
    })
    return row
  })
}
