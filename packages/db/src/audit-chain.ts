import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { authDb } from './client'

/**
 * The audit chain, checked from outside the database (AUD-01).
 *
 * Core migration 0008 seals every audit row into a hash chain per institution,
 * and every platform event into one more. This file is the second, independent
 * implementation of that hash format: it rebuilds each link in Node from the
 * raw columns and never calls the database's own hash function, because a
 * verifier that lives in the database proves nothing to anyone who doubts the
 * database. Whoever can rewrite rows can rewrite a function.
 *
 * On its own the walk finds an edited, deleted or unsealed row. A chain
 * rewritten consistently from some row onwards verifies on its own, so the
 * other half is the anchor: the chain heads, written off the server by
 * `anchorDocument()`, and compared here with what the database holds now.
 *
 * Reads run through `authDb`, so in practice as the owner: the anchor and
 * verify CLI runs in the one-shot ops mode, as migrate and install do.
 */

export const ANCHOR_FORMAT = 'campusos-audit-anchor/1'
const HASH_FORMAT = 'campusos-audit-v1'
const BATCH = 5000

export type ChainProblemKind =
  /** A recomputed hash differs from the sealed one: the row was edited. */
  | 'altered'
  /** A seq gap, or a link whose audit row is gone: rows were deleted. */
  | 'missing'
  /** An audit row with no link: written with the seal switched off. */
  | 'unsealed'
  /** A link that does not point at the one before it. */
  | 'broken_link'
  /** The database no longer has the (seq, hash) an anchor recorded. */
  | 'anchor_mismatch'
  /** An anchor recorded a lower seq than an earlier anchor did. */
  | 'anchor_regressed'
  /** An anchor document that does not match its own digest. */
  | 'anchor_corrupt'
  /** An anchored chain is gone, and no deleted institution explains it. */
  | 'chain_vanished'

export interface ChainProblem {
  kind: ChainProblemKind
  /** `tenant:<institution id>`, `platform`, or `anchor:<run id>` for a bad anchor. */
  chain: string
  seq?: number
  message: string
}

export interface ChainHead {
  chain: string
  slug?: string | null
  seq: number
  /** Hex. */
  hash: string
}

export interface AnchorDocument {
  format: string
  runId: string
  at: string
  server: string
  chains: ChainHead[]
  /** Hex sha256 over everything above, so a damaged or edited anchor shows. */
  digest: string
}

export interface VerifyOptions {
  /** One institution's chain. */
  institutionId?: string
  /** The platform chain. Without either option, every chain is checked. */
  platform?: boolean
  /** Anchor documents, in any order; they are compared in their own time order. */
  anchors?: AnchorDocument[]
}

export interface VerifyReport {
  chains: { chain: string; rows: number; head: { seq: number; hash: string } | null }[]
  problems: ChainProblem[]
}

const sha256 = (...parts: Buffer[]) => createHash('sha256').update(Buffer.concat(parts)).digest()

/** One field: `<byte length>:<text>`, or `~` for NULL, so no escaping is needed. */
const field = (v: string | null) => (v === null ? '~' : `${Buffer.byteLength(v, 'utf8')}:${v}`)

/** The `prev_hash` of a chain's first link. */
export const genesis = (chain: string) => sha256(Buffer.from(`campusos-audit-genesis:${chain}`, 'utf8'))

/** A row as the verifier reads it: every value as text, as the hash sees it. */
type ChainRow = {
  seq: string
  prev_hash: Buffer
  hash: Buffer
  /** NULL when the link survives its audit row. */
  id: string | null
  /** `YYYY-MM-DDTHH:MM:SS.ffffffZ` in UTC, formatted by Postgres as the seal formats it; NULL if not finite. */
  at_text: string | null
  institution_id: string | null
  actor_id: string | null
  module_id: string | null
  action: string | null
  entity: string | null
  entity_id: string | null
  actor_email: string | null
  reason: string | null
  detail: string | null
  salt: Buffer | null
}

/** Rebuilds one link's hash. `chain` is the institution id, or 'platform'. */
export function rowHash(prev: Buffer, chain: string, r: ChainRow): Buffer {
  const header =
    field(HASH_FORMAT) + field(chain) + field(r.seq) + field(r.id) + field(r.at_text) +
    field(r.institution_id) + field(r.actor_id) + field(r.module_id) + field(r.action) + field(r.entity) + field(r.entity_id)
  const content = sha256(r.salt ?? Buffer.alloc(0), Buffer.from(field(r.actor_email) + field(r.reason) + field(r.detail), 'utf8'))
  return sha256(prev, Buffer.from(header, 'utf8'), content)
}

const COLUMNS = sql.raw(`
  a.id::text as id, to_char(a.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at_text,
  a.institution_id::text as institution_id, a.actor_id, a.module_id, a.action, a.entity, a.entity_id,
  a.actor_email, a.reason, a.detail::text as detail, a.salt`)

/** A tenant chain's links with their audit rows, in seq order, one batch after `after`. */
const tenantBatch = (institutionId: string, after: number) =>
  authDb.execute<ChainRow>(sql`
    select c.seq::text as seq, c.prev_hash, c.hash, ${COLUMNS}
      from audit_chain c left join audit_log a on a.id = c.audit_id
     where c.institution_id = ${institutionId} and c.seq > ${after}
     order by c.seq limit ${BATCH}`)

const platformBatch = (after: number) =>
  authDb.execute<ChainRow>(sql`
    select a.seq::text as seq, a.prev_hash, a.hash, ${COLUMNS}
      from platform_audit_log a
     where a.seq > ${after}
     order by a.seq limit ${BATCH}`)

interface Walked {
  rows: number
  head: { seq: number; hash: string } | null
  /** The hashes at the seqs some anchor asked about. */
  at: Map<number, string>
}

/**
 * Walks one chain from seq 1: recomputes every link from its stored
 * `prev_hash`, so an edited row is reported once rather than poisoning
 * everything after it. Nothing in the database can excuse a missing prefix:
 * a purge (P1-08) will have to carry its checkpoint in the anchors.
 */
async function walk(
  name: string,
  chain: string,
  next: (after: number) => Promise<{ rows: ChainRow[] }>,
  wanted: Set<number>,
  problems: ChainProblem[],
): Promise<Walked> {
  const out: Walked = { rows: 0, head: null, at: new Map() }
  let expected = 1
  let prev: Buffer = genesis(chain)
  for (let after = 0; ; ) {
    const { rows } = await next(after)
    for (const r of rows) {
      const seq = Number(r.seq)
      if (seq !== expected) {
        problems.push({
          kind: 'missing',
          chain: name,
          seq: expected,
          message: seq - expected === 1 ? `seq ${expected} is missing` : `seq ${expected} to ${seq - 1} are missing`,
        })
      } else if (!r.prev_hash.equals(prev)) {
        problems.push({ kind: 'broken_link', chain: name, seq, message: `seq ${seq} does not link to seq ${seq - 1}` })
      }
      if (r.id === null) {
        problems.push({ kind: 'missing', chain: name, seq, message: `the audit row sealed at seq ${seq} is gone` })
      } else if (!rowHash(r.prev_hash, chain, r).equals(r.hash)) {
        problems.push({ kind: 'altered', chain: name, seq, message: `audit row ${r.id} at seq ${seq} was changed after it was sealed` })
      }
      if (wanted.has(seq)) out.at.set(seq, r.hash.toString('hex'))
      prev = r.hash
      expected = seq + 1
      out.rows++
      out.head = { seq, hash: r.hash.toString('hex') }
      after = seq
    }
    if (rows.length < BATCH) return out
  }
}

/** The digest an anchor document carries: sha256 over its fields in a fixed order. */
function anchorDigest(doc: Omit<AnchorDocument, 'digest'>): string {
  const chains = [...doc.chains]
    .sort((a, b) => (a.chain < b.chain ? -1 : a.chain > b.chain ? 1 : 0))
    .map((c) => [c.chain, c.slug ?? null, c.seq, c.hash])
  return createHash('sha256')
    .update(JSON.stringify([doc.format, doc.runId, doc.at, doc.server, chains]), 'utf8')
    .digest('hex')
}

/** The document the anchor run sends off the server. */
export function anchorDocument(heads: ChainHead[], opts: { runId: string; server: string; at?: string }): AnchorDocument {
  const chains = [...heads]
    .map((h) => ({ chain: h.chain, ...(h.slug !== undefined ? { slug: h.slug } : {}), seq: h.seq, hash: h.hash }))
    .sort((a, b) => (a.chain < b.chain ? -1 : a.chain > b.chain ? 1 : 0))
  const doc = { format: ANCHOR_FORMAT, runId: opts.runId, at: opts.at ?? new Date().toISOString(), server: opts.server, chains }
  return { ...doc, digest: anchorDigest(doc) }
}

/** The head of every institution's chain (or one), and of the platform chain when no institution is named. */
export async function chainHeads(opts: { institutionId?: string } = {}): Promise<ChainHead[]> {
  const tenants = await authDb.execute<{ id: string; slug: string; seq: string; hash: Buffer }>(sql`
    select i.id::text as id, i.slug, h.seq::text as seq, h.hash
      from institutions i
     cross join lateral (select c.seq, c.hash from audit_chain c where c.institution_id = i.id order by c.seq desc limit 1) h
     ${opts.institutionId ? sql`where i.id = ${opts.institutionId}` : sql``}
     order by i.id`)
  const heads: ChainHead[] = tenants.rows.map((r) => ({ chain: `tenant:${r.id}`, slug: r.slug, seq: Number(r.seq), hash: r.hash.toString('hex') }))
  if (!opts.institutionId) {
    const p = await authDb.execute<{ seq: string; hash: Buffer }>(sql`select seq::text as seq, hash from platform_audit_log order by seq desc limit 1`)
    if (p.rows[0]) heads.push({ chain: 'platform', seq: Number(p.rows[0].seq), hash: p.rows[0].hash.toString('hex') })
  }
  return heads
}

/**
 * Checks every chain in scope, and the anchors against them. Returns what it
 * found; an empty `problems` is the only passing result.
 */
export async function verifyChains(opts: VerifyOptions = {}): Promise<VerifyReport> {
  const problems: ChainProblem[] = []
  const all = !opts.institutionId && !opts.platform
  const inScope = (chain: string) =>
    all || (opts.platform && chain === 'platform') || (!!opts.institutionId && chain === `tenant:${opts.institutionId}`)

  // Anchors first: a corrupt one is reported and then ignored.
  const anchors: AnchorDocument[] = []
  for (const a of opts.anchors ?? []) {
    if (a.format !== ANCHOR_FORMAT || anchorDigest(a) !== a.digest) {
      problems.push({ kind: 'anchor_corrupt', chain: `anchor:${a.runId}`, message: `anchor ${a.runId} does not match its own digest` })
    } else {
      anchors.push(a)
    }
  }
  anchors.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  const anchored = new Map<string, { runId: string; at: string; seq: number; hash: string }[]>()
  for (const a of anchors) {
    for (const c of a.chains) {
      if (!inScope(c.chain)) continue
      const list = anchored.get(c.chain) ?? []
      const last = list.at(-1)
      if (last && c.seq < last.seq) {
        problems.push({
          kind: 'anchor_regressed',
          chain: c.chain,
          seq: c.seq,
          message: `anchor ${a.runId} (${a.at}) has seq ${c.seq}, below seq ${last.seq} in the earlier anchor ${last.runId}`,
        })
      }
      list.push({ runId: a.runId, at: a.at, seq: c.seq, hash: c.hash })
      anchored.set(c.chain, list)
    }
  }

  // Deletions the platform chain records (NEW-09). Since 0009 only the
  // institutions trigger can write one, but the owner can switch triggers off,
  // so a record counts only if the institution really is gone, and only the
  // first record for it.
  const events = await authDb.execute<{ institution_id: string; detail: Record<string, unknown> | null }>(sql`
    select p.institution_id::text as institution_id, p.detail from platform_audit_log p
     where p.action = 'institution.deleted' and p.institution_id is not null
       and not exists (select 1 from institutions i where i.id = p.institution_id)
     order by p.seq`)
  const deleted = new Map<string, { finalSeq: number | null; finalHash: string | null }>()
  for (const e of events.rows) {
    const name = `tenant:${e.institution_id}`
    if (deleted.has(name)) continue
    deleted.set(name, {
      finalSeq: typeof e.detail?.finalSeq === 'number' ? e.detail.finalSeq : null,
      finalHash: typeof e.detail?.finalHash === 'string' ? e.detail.finalHash : null,
    })
  }

  // Which chains to walk: those in the database, and any an anchor names.
  const names = new Set<string>()
  if (opts.institutionId) names.add(`tenant:${opts.institutionId}`)
  if (opts.platform || all) names.add('platform')
  if (all) {
    const t = await authDb.execute<{ id: string }>(sql`
      select distinct institution_id::text as id from audit_chain
      union select distinct institution_id::text from audit_log`)
    for (const r of t.rows) names.add(`tenant:${r.id}`)
  }
  for (const chain of anchored.keys()) names.add(chain)

  // Audit rows with no link, in one pass rather than one per institution.
  if (all || opts.institutionId) {
    const unsealed = await authDb.execute<{ institution_id: string; id: string }>(sql`
      select a.institution_id::text as institution_id, a.id::text as id from audit_log a
       where ${opts.institutionId ? sql`a.institution_id = ${opts.institutionId} and` : sql``}
             not exists (select 1 from audit_chain c where c.audit_id = a.id)
       order by a.at, a.id limit 1000`)
    for (const r of unsealed.rows) {
      problems.push({ kind: 'unsealed', chain: `tenant:${r.institution_id}`, message: `audit row ${r.id} was never sealed into the chain` })
    }
  }

  const chains: VerifyReport['chains'] = []
  for (const name of [...names].sort()) {
    const id = name === 'platform' ? 'platform' : name.slice('tenant:'.length)
    const wanted = new Set((anchored.get(name) ?? []).map((a) => a.seq))
    const walked = await walk(
      name,
      id,
      name === 'platform' ? platformBatch : (after) => tenantBatch(id, after),
      wanted,
      problems,
    )
    chains.push({ chain: name, rows: walked.rows, head: walked.head })

    for (const a of anchored.get(name) ?? []) {
      const have = walked.at.get(a.seq)
      if (have !== undefined) {
        if (have !== a.hash) {
          problems.push({ kind: 'anchor_mismatch', chain: name, seq: a.seq, message: `seq ${a.seq} differs from anchor ${a.runId} (${a.at})` })
        }
        continue
      }
      const gone = deleted.get(name)
      if (walked.rows === 0 && gone) {
        if (gone.finalSeq === null || gone.finalSeq < a.seq || (gone.finalSeq === a.seq && gone.finalHash !== a.hash)) {
          problems.push({
            kind: 'anchor_mismatch',
            chain: name,
            seq: a.seq,
            message: `the institution was deleted at seq ${gone.finalSeq}, which does not match anchor ${a.runId} (${a.at})`,
          })
        }
      } else if (walked.rows === 0) {
        problems.push({
          kind: 'chain_vanished',
          chain: name,
          seq: a.seq,
          message: `anchor ${a.runId} (${a.at}) recorded seq ${a.seq}, and the chain is gone with no record of its institution's deletion`,
        })
      } else {
        problems.push({
          kind: 'anchor_mismatch',
          chain: name,
          seq: a.seq,
          message: `anchor ${a.runId} (${a.at}) recorded seq ${a.seq}, which the chain no longer has`,
        })
      }
    }
  }
  return { chains, problems }
}
