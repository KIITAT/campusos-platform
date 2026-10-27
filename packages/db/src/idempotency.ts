import { createHash } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { check, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { institutions, users } from './schema'
import { tenantPolicy } from './rls'
import type { withTenant } from './client'

/**
 * Idempotency keys: "these requests are the same act" (ACC-18, decision 187).
 *
 * A double-click, a form submitted again from the back button, or a retry after
 * a dropped connection arrives as a second request for something already done.
 * The caller says so with a key -- the `Idempotency-Key` header, or the nonce
 * the portal puts in every form -- and the host hands it to the operation on
 * the actor. The first request with a key does the work; a later one with the
 * same key, from the same person, for the same operation, gets the first one's
 * result back and changes nothing.
 *
 * The claim is a row written as the operation's first statement, in the
 * operation's own transaction:
 *
 *  - it commits together with what it guards, or not at all, so a request that
 *    failed is not remembered and its retry runs again;
 *  - a second request with the key while the first is still in flight waits on
 *    the primary key until the first ends, then replays it (or, if the first
 *    rolled back, does the work itself). It waits *before* touching anything
 *    else -- a receipt counter, a document number -- so it never takes one.
 *
 * Each module that opts in owns its claim table, made by
 * `idempotencyKeysTable()` in its schema and created by its own migration.
 * Plugins install and upgrade independently of the host, and nothing checks a
 * plugin's minimum core version, so a table in core could be missing exactly
 * where a new plugin needs it. A module's own table cannot be.
 *
 * Claims are kept for the life of what they produced: one small row of ids and
 * a hash per act, and a stale tab resubmitted next week is still a replay.
 */

/** A UUID fits; so does any opaque token a client is likely to mint. */
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/

export const idempotencyKeysTable = (name: string) =>
  pgTable(
    name,
    {
      institutionId: uuid('institution_id')
        .notNull()
        .references(() => institutions.id, { onDelete: 'cascade' }),
      actorId: text('actor_id')
        .notNull()
        .references(() => users.id, { onDelete: 'cascade' }),
      /** Which act the key is for, so one key cannot be a payment and a refund. */
      operation: text().notNull(),
      key: text().notNull(),
      /** sha256 of the request, so a key reused for a different one is refused. */
      requestHash: text('request_hash').notNull(),
      /** What the act produced; a replay reads it back. */
      resultId: uuid('result_id'),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      primaryKey({ name: `${name}_pkey`, columns: [t.institutionId, t.actorId, t.operation, t.key] }),
      check(`${name}_key`, sql`key ~ '^[A-Za-z0-9._:-]{8,128}$'`),
      tenantPolicy(name),
    ],
  )

export type IdempotencyKeysTable = ReturnType<typeof idempotencyKeysTable>

/** Shaped like every module's error, so the host's envelope maps it. */
export class IdempotencyError extends Error {
  constructor(
    readonly status: 400 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/** Absent and null are the same thing to a form; keys are sorted. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value instanceof Date) return value.toISOString()
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[k]
      if (v !== undefined && v !== null) out[k] = canonical(v)
    }
    return out
  }
  return value
}

/** sha256 of the canonical JSON of a parsed request. */
export const requestHash = (request: unknown): string =>
  createHash('sha256').update(JSON.stringify(canonical(request) ?? null)).digest('hex')

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]

export interface IdempotentCall {
  institutionId: string
  actorId: string
  operation: string
  /** The caller's key; absent means "no promise asked for", and `run` simply runs. */
  key: string | null | undefined
  /** The parsed input, hashed so that a reused key must carry the same request. */
  request: unknown
}

/**
 * Run `run` once per key. On a replay, `replay` reads back what the first
 * request produced. Must be called before the operation writes anything else.
 */
export async function withIdempotencyKey<T extends { id: string }>(
  tx: Tx,
  table: IdempotencyKeysTable,
  call: IdempotentCall,
  run: () => Promise<T>,
  replay: (resultId: string) => Promise<T | undefined>,
): Promise<{ value: T; replayed: boolean }> {
  if (call.key === undefined || call.key === null) return { value: await run(), replayed: false }
  if (!IDEMPOTENCY_KEY.test(call.key)) {
    throw new IdempotencyError(
      400,
      'invalid_idempotency_key',
      'an idempotency key is 8 to 128 letters, digits and . _ : -',
    )
  }

  const hash = requestHash(call.request)
  const mine = and(
    eq(table.institutionId, call.institutionId),
    eq(table.actorId, call.actorId),
    eq(table.operation, call.operation),
    eq(table.key, call.key),
  )

  // Waits here, on the primary key, while another transaction holds the same
  // claim uncommitted.
  const [claimed] = await tx
    .insert(table)
    .values({
      institutionId: call.institutionId,
      actorId: call.actorId,
      operation: call.operation,
      key: call.key,
      requestHash: hash,
    })
    .onConflictDoNothing()
    .returning({ key: table.key })

  if (claimed) {
    const value = await run()
    await tx.update(table).set({ resultId: value.id }).where(mine)
    return { value, replayed: false }
  }

  // Taken, by a transaction that has committed: a new statement sees it.
  const [prior] = await tx
    .select({ requestHash: table.requestHash, resultId: table.resultId })
    .from(table)
    .where(mine)
  if (prior && prior.requestHash !== hash) {
    throw new IdempotencyError(
      409,
      'idempotency_key_reused',
      'that was already submitted with different details; reload the form to make a new one',
    )
  }
  const value = prior?.resultId ? await replay(prior.resultId) : undefined
  if (!value) {
    throw new IdempotencyError(409, 'idempotent_result_gone', 'that was already submitted, and what it made no longer exists')
  }
  return { value, replayed: true }
}
