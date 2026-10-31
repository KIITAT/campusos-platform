import { and, desc, eq, gte, lt, sql } from 'drizzle-orm'
import { audit, auditLog, withTenant } from '@campusos/db'
import * as z from 'zod'
import { ticked } from '@campusos/module-framework'
import { sodSettings } from '../schema'
import { named, requireConfigure, requireRead, type Actor, type Tx } from './core'

/**
 * Segregation of duties (P0-07, ACC-01): the person who made a document does
 * not approve it or submit it. The database refuses the same acts (finance
 * 0011); this is the readable half, and single-officer mode, for an institution
 * with one accountant, which lifts the rule and leaves a trail of every use.
 */

export type SodAct = 'approve' | 'submit' | 'reconcile' | 'refund' | 'pay_payroll'

export const singleOfficerSchema = z
  .object({
    enabled: z.preprocess(ticked, z.boolean()),
    reason: z.string().trim().min(10).max(300),
  })
  .meta({ id: 'FinanceSingleOfficer' })

/** Whether single-officer mode is on for the institution. */
export async function singleOfficerOn(tx: Tx, institutionId: string): Promise<boolean> {
  const r = await tx.execute<{ on: boolean }>(sql`select finance_single_officer(${institutionId}::uuid) as on`)
  return r.rows[0]!.on
}

/** The creator of an approvable draft, or null. */
export async function creatorOf(tx: Tx, docType: string, docId: string): Promise<string | null> {
  const r = await tx.execute<{ who: string | null }>(sql`select finance_doc_creator(${docType}, ${docId}::uuid) as who`)
  return r.rows[0]!.who
}

/**
 * 'ok' when the actor may do this act on something another person made, or
 * when it is their own and single-officer mode is on (the use is written to
 * the trail in this transaction); 'refused' otherwise. The caller throws its
 * own typed error with its own message.
 */
export async function checkOtherPerson(
  tx: Tx,
  actor: { id: string; email?: string | null },
  institutionId: string,
  p: { creatorId: string | null | undefined; act: SodAct; moduleId: string; entity: string; entityId: string; docType?: string },
): Promise<'ok' | 'refused'> {
  if (!p.creatorId || p.creatorId !== actor.id) return 'ok'
  if (!(await singleOfficerOn(tx, institutionId))) return 'refused'
  await audit(tx, {
    institutionId,
    actorId: actor.id,
    actorEmail: actor.email ?? null,
    moduleId: p.moduleId,
    action: 'sod.single_officer_used',
    entity: p.entity,
    entityId: p.entityId,
    reason: `single-officer mode: ${p.act}`,
    detail: { act: p.act, docType: p.docType ?? null },
  })
  return 'ok'
}

/** An approval given by the document's own creator counts only in single-officer mode (existing data, D13). */
export const countsAsApproval = (decidedBy: string | null, creator: string | null, solo: boolean) =>
  solo || !creator || decidedBy !== creator

export async function sodStatus(actor: Actor) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) => {
    const [row] = await tx.select().from(sodSettings)
    return { enabled: row?.singleOfficer ?? false, changedBy: row?.changedBy ?? null, changedAt: row?.changedAt ?? null }
  })
}

export async function setSingleOfficer(actor: Actor, input: unknown) {
  const tenant = requireConfigure(actor)
  const data = singleOfficerSchema.parse(input)
  return withTenant(tenant, (tx) =>
    named(async () => {
      await tx
        .insert(sodSettings)
        .values({ institutionId: tenant, singleOfficer: data.enabled, changedBy: actor.id })
        .onConflictDoUpdate({
          target: sodSettings.institutionId,
          set: { singleOfficer: data.enabled, changedBy: actor.id, changedAt: sql`now()` },
        })
      await audit(tx, {
        institutionId: tenant,
        actorId: actor.id,
        actorEmail: actor.email ?? null,
        moduleId: 'finance',
        action: data.enabled ? 'sod.single_officer_enabled' : 'sod.single_officer_disabled',
        entity: 'finance_sod_settings',
        entityId: tenant,
        reason: data.reason,
      })
      return { enabled: data.enabled, notice: data.enabled ? 'Single-officer mode is on.' : 'Single-officer mode is off.' }
    }),
  )
}

const day = z.iso.date()

/** The acts single-officer mode let through, newest first. */
export async function listSodUses(actor: Actor, input: { from?: string; to?: string } = {}) {
  const tenant = requireRead(actor)
  const from = input.from ? day.parse(input.from) : null
  const to = input.to ? day.parse(input.to) : null
  return withTenant(tenant, async (tx) => {
    const rows = await tx
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.institutionId, tenant),
          eq(auditLog.action, 'sod.single_officer_used'),
          from ? gte(auditLog.at, sql`${from}::date`) : undefined,
          to ? lt(auditLog.at, sql`(${to}::date + 1)`) : undefined,
        ),
      )
      .orderBy(desc(auditLog.at), desc(auditLog.id))
      .limit(500)
    return rows.map((r) => {
      const d = (r.detail ?? {}) as { act?: string; docType?: string | null }
      return {
        at: r.at,
        actorId: r.actorId,
        actorEmail: r.actorEmail,
        act: d.act ?? null,
        docType: d.docType ?? null,
        entity: r.entity,
        entityId: r.entityId,
      }
    })
  })
}

/** Whether single-officer mode is on for the institution this transaction is for (row security picks the row). */
export async function singleOfficerHere(tx: Tx): Promise<boolean> {
  const r = await tx.execute<{ on: boolean }>(sql`select coalesce((select single_officer from finance_sod_settings), false) as on`)
  return r.rows[0]!.on
}
