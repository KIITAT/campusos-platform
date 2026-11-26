import { sql } from 'drizzle-orm'
import * as z from 'zod'
import { audit, withTenant } from '@campusos/db'
import { logSensitiveRead } from '@campusos/db/sensitive-reads'
import { cursorColumn, finishPage, keyset, orderKeys, readPage, type SortSpec } from '@campusos/module-framework'
import { notify, notifyEach } from '@campusos/module-notices/api'
import { entitled, localParts, nightOf, zoneIn } from './clock'
import { loadPolicy } from './policy'
import { derivePresence, curfewEvidence, ladderDue, type Evidence, type Step } from './presence-rules'
import { literal, loadFacts } from './presence'
import { HostelError, requireWarden, type Actor } from './operations'
import { homesOf, recipientsAt, type Home } from './wardens'

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]

const MODULE = 'hostel'
const LINK = '/m/hostel/presence'

interface BlockCurfew {
  id: string
  code: string
  kind: string
  curfewAt: Date
}

/**
 * The curfew sweep (P2-22a, D1321, D1326, D1338), run every minute.
 *
 * Opens a case for a resident nobody can account for, then walks each open
 * case up the ladder: nudge the student, alert the floor warden, tell the
 * guardians (consent permitting) and the block and chief wardens. The clock is
 * the `now` argument, never SQL `now()`.
 *
 * Safe under two workers: a case is unique per resident and night, only rows the
 * insert returned are announced, and open cases are taken `FOR UPDATE SKIP LOCKED`.
 * A pass holder's ladder starts at the end of the pass (D1321).
 *
 * A case is resolved only by lasting evidence (a check-in, leave) or by a warden. A pass, an open library session
 * or a class running now only holds it: the ladder is restarted at the end of that evidence, so nobody is left
 * unwatched once it lapses (review BLOCKER 1). When the night is over, a case nobody resolved lapses and an
 * undecided pass expires (review HIGH 4). The ladder works a step at a time over every due case: one set-based
 * write per step, not a handful of statements per case (review HIGH 3), inside a savepoint that falls back to one
 * savepoint per case, so a single resident's failure never rolls back the tick (review BLOCKER 2).
 */
export async function curfewSweep(
  tx: Tx,
  tenant: string,
  now = new Date(),
): Promise<{ opened: number; resolved: number; nudged: number; warded: number; guardians: number }> {
  const out = { opened: 0, resolved: 0, nudged: 0, warded: 0, guardians: 0 }
  if (!(await entitled(tx, tenant, 'hostel'))) return out

  const zone = await zoneIn(tx, tenant)
  const night = await nightOf(tx, now, zone)
  const p = await loadPolicy(tx, tenant)
  const nowIso = now.toISOString()

  // Each block's curfew tonight: its own or the policy's, raised by a late-stay window, never lowered (D1321).
  const blockRows = (await tx.execute(sql`
    select b.id, b.code, b.kind::text as kind,
           ((${night}::date + greatest(coalesce(b.curfew_time, ${p.curfewTime}::time),
              coalesce((select max(w.until_time) from hostel_late_stay_windows w
                         where w.cancelled_at is null and ${night}::date between w.from_on and w.to_on
                           and (w.block_id is null or w.block_id = b.id)), '00:00'::time))) at time zone ${zone}) as curfew_at
      from hostel_blocks b where b.institution_id = ${tenant}`)).rows as { id: string; code: string; kind: string; curfew_at: Date | string }[]
  const blocks = new Map<string, BlockCurfew>(blockRows.map((b) => [b.id, { id: b.id, code: b.code, kind: b.kind, curfewAt: new Date(b.curfew_at) }]))

  // --- 0. close the nights that are over -----------------------------------------
  const lapsed = (await tx.execute(sql`
    update hostel_curfew_cases set resolved_at = ${nowIso}::timestamptz, resolution = 'lapsed'
     where institution_id = ${tenant} and night < ${night}::date and resolved_at is null
    returning id, student_id`)).rows as { id: string; student_id: string }[]
  if (lapsed.length > 0) {
    await tx.execute(sql`
      insert into hostel_presence_log (institution_id, student_id, at, kind, source, detail)
      select ${tenant}, t.s, ${nowIso}::timestamptz, 'case_resolved', 'hostel', jsonb_build_object('resolution', 'lapsed', 'caseId', t.c)
        from unnest(${literal(lapsed.map((l) => l.student_id))}::text[], ${literal(lapsed.map((l) => l.id))}::text[]) as t(s, c)`)
  }
  await tx.execute(sql`
    update hostel_late_passes set status = 'lapsed'
     where institution_id = ${tenant} and night < ${night}::date and status = 'requested'`)

  // --- 1. open cases for residents nobody can account for ---------------------
  // The window is measured from the personal curfew, so a pass that ends late still gets its case; the block
  // filter looks as far as the latest approved pass tonight, the per-resident check below is exact.
  const [latest] = (await tx.execute(sql`
    select max(until_at) as t from hostel_late_passes where institution_id = ${tenant} and night = ${night}::date and status = 'approved'`)).rows as { t: Date | string | null }[]
  const latestPass = latest?.t ? new Date(latest.t) : null
  const windowMs = p.caseWindowHours * 3_600_000
  const active = [...blocks.values()].filter((b) => {
    const from = latestPass && latestPass > b.curfewAt ? latestPass : b.curfewAt
    return now.getTime() >= b.curfewAt.getTime() + p.nudgeAfterMin * 60_000 && now.getTime() < from.getTime() + windowMs
  })
  if (active.length > 0) {
    const residents = (await tx.execute(sql`
      select a.student_id, r.block_id
        from hostel_allocations a join hostel_rooms r on r.id = a.room_id
       where a.institution_id = ${tenant} and a.vacated_on is null and a.allocated_on <= ${night}::date
         and r.block_id = any(${literal(active.map((b) => b.id))}::uuid[])
         and not exists (select 1 from hostel_curfew_cases c where c.student_id = a.student_id and c.night = ${night}::date)`)).rows as { student_id: string; block_id: string }[]
    if (residents.length > 0) {
      const facts = await loadFacts(tx, tenant, residents.map((r) => r.student_id), now, night)
      const due: { studentId: string; blockId: string; curfewAt: Date }[] = []
      for (const r of residents) {
        const f = facts.get(r.student_id)!
        const block = blocks.get(r.block_id)!
        // A resident with an approved pass is counted from the end of the pass.
        const personal = f.lateUntil && f.lateUntil > block.curfewAt ? f.lateUntil : block.curfewAt
        if (now.getTime() < personal.getTime() + p.nudgeAfterMin * 60_000) continue
        if (now.getTime() >= personal.getTime() + windowMs) continue
        if (curfewEvidence({ ...f, pastCurfew: true }, now, p.walkBackMin) !== null) continue
        due.push({ studentId: r.student_id, blockId: r.block_id, curfewAt: personal })
      }
      if (due.length > 0) {
        const opened = (await tx.execute(sql`
          insert into hostel_curfew_cases (institution_id, student_id, block_id, night, curfew_at, opened_at, nudge_at)
          select ${tenant}, s, b, ${night}::date, c, ${nowIso}::timestamptz, ${nowIso}::timestamptz
            from unnest(${literal(due.map((d) => d.studentId))}::text[], ${literal(due.map((d) => d.blockId))}::uuid[], ${literal(due.map((d) => d.curfewAt.toISOString()))}::timestamptz[]) as t(s, b, c)
          on conflict (student_id, night) do nothing
          returning student_id, block_id`)).rows as { student_id: string; block_id: string }[]
        out.opened = opened.length
        out.nudged = opened.length
        if (opened.length > 0) {
          // One row for the opening and the nudge that goes with it: at 5,000 residents a second row each cost
          // about a third of the tick (D1345); a later nudge, if any, is logged on its own.
          await tx.execute(sql`
            insert into hostel_presence_log (institution_id, student_id, at, kind, source, detail)
            select ${tenant}, s, ${nowIso}::timestamptz, 'case_opened', 'hostel', '{"nudged": true}'::jsonb
              from unnest(${literal(opened.map((o) => o.student_id))}::text[]) as t(s)`)
          const byBlock = new Map<string, string[]>()
          for (const o of opened) byBlock.set(o.block_id, [...(byBlock.get(o.block_id) ?? []), o.student_id])
          for (const [blockId, students] of byBlock) {
            await notify(tx, tenant, {
              userIds: students,
              moduleId: 'hostel_safety',
              title: 'Hostel check-in',
              body: `You have not checked in at ${blocks.get(blockId)!.code} yet. Check in now, or tell your warden where you are.`,
              link: '/m/hostel/me',
            })
          }
        }
      }
    }
  }

  // --- 2. the ladder for open cases of tonight --------------------------------
  const cases = (await tx.execute(sql`
    select c.id, c.student_id, c.block_id, c.curfew_at, c.nudge_at, c.warden_at, c.guardian_at
      from hostel_curfew_cases c
     where c.institution_id = ${tenant} and c.night = ${night}::date and c.resolved_at is null
       -- A case opened at this very instant has nothing due yet (every later step is offset by minutes).
       and c.opened_at < ${nowIso}::timestamptz
     order by c.opened_at, c.id
       for update of c skip locked`)).rows as unknown as OpenCase[]
  if (cases.length === 0) return out

  const facts = await loadFacts(tx, tenant, cases.map((c) => c.student_id), now, night)
  const resolve: { c: OpenCase; why: Evidence }[] = []
  const hold: { c: OpenCase; until: Date }[] = []
  const nudges: OpenCase[] = []
  const wardens: OpenCase[] = []
  const guardians: OpenCase[] = []
  for (const c of cases) {
    const f = facts.get(c.student_id)!
    const evidence = curfewEvidence({ ...f, pastCurfew: true }, now, p.walkBackMin)
    if (evidence === 'checked_in' || evidence === 'leave') {
      resolve.push({ c, why: evidence })
      continue
    }
    if (evidence) {
      // Evidence that will end: the ladder starts again where it ends (D1321), a pass at its own end time.
      hold.push({ c, until: evidence === 'late_pass' ? f.lateUntil! : now })
      continue
    }
    const block = blocks.get(c.block_id)
    const steps = ladderDue(
      {
        curfewAt: new Date(c.curfew_at),
        nudgeAt: c.nudge_at ? new Date(c.nudge_at) : null,
        wardenAt: c.warden_at ? new Date(c.warden_at) : null,
        guardianAt: c.guardian_at ? new Date(c.guardian_at) : null,
      },
      now,
      { nudge: p.nudgeAfterMin, warden: block?.kind === 'womens' ? p.womensWardenAfterMin : p.wardenAfterMin, guardian: p.guardianAfterMin },
    )
    c.sharing = f.sharing
    if (steps.includes('nudge')) nudges.push(c)
    if (steps.includes('warden')) wardens.push(c)
    if (steps.includes('guardian')) guardians.push(c)
  }

  if (resolve.length > 0) {
    await tx.execute(sql`
      update hostel_curfew_cases c set resolved_at = ${nowIso}::timestamptz, resolution = t.r
        from unnest(${literal(resolve.map((r) => r.c.id))}::uuid[], ${literal(resolve.map((r) => r.why))}::text[]) as t(id, r)
       where c.id = t.id`)
    await tx.execute(sql`
      insert into hostel_presence_log (institution_id, student_id, at, kind, source, detail)
      select ${tenant}, t.s, ${nowIso}::timestamptz, 'case_resolved', 'hostel', jsonb_build_object('resolution', t.r, 'caseId', t.c)
        from unnest(${literal(resolve.map((r) => r.c.student_id))}::text[], ${literal(resolve.map((r) => r.why))}::text[], ${literal(resolve.map((r) => r.c.id))}::text[]) as t(s, r, c)`)
    out.resolved += resolve.length
  }
  if (hold.length > 0) {
    await tx.execute(sql`
      update hostel_curfew_cases c set curfew_at = greatest(c.curfew_at, t.u), warden_at = null, guardian_at = null
        from unnest(${literal(hold.map((h) => h.c.id))}::uuid[], ${literal(hold.map((h) => h.until.toISOString()))}::timestamptz[]) as t(id, u)
       where c.id = t.id`)
  }
  if (nudges.length > 0) {
    await tx.execute(sql`update hostel_curfew_cases set nudge_at = ${nowIso}::timestamptz where id = any(${literal(nudges.map((c) => c.id))}::uuid[])`)
  }
  if (wardens.length === 0 && guardians.length === 0) return out

  const homes = await homesOf(tx, [...new Set([...wardens, ...guardians].map((c) => c.student_id))])
  const hhmm = (await localParts(tx, now, zone)).time.slice(0, 5)
  const cache = new Map<string, Promise<string[]>>()
  const team = (level: 'floor' | 'block' | 'chief', h: Home) => {
    const key = `${level}|${level === 'chief' ? '' : h.blockId}|${level === 'floor' ? h.floor : ''}|${level === 'chief' ? '' : h.wardenUserId}`
    if (!cache.has(key)) cache.set(key, recipientsAt(tx, tenant, h, level))
    return cache.get(key)!
  }
  const wardenText = (c: OpenCase, h: Home) => ({
    title: 'Resident not checked in',
    body: `${h.studentName} (${h.blockCode}-${h.room}) has not checked in, ${Math.max(0, Math.floor((now.getTime() - new Date(c.curfew_at).getTime()) / 60_000))} minutes after curfew.`,
  })

  out.warded += await guarded(wardens, async (sp, xs) => {
    const items: { userId: string; title: string; body: string; link: string }[] = []
    const counts: number[] = []
    for (const c of xs) {
      const h = homes.get(c.student_id)!
      const to = await team('floor', h)
      counts.push(to.length)
      for (const userId of to) items.push({ userId, ...wardenText(c, h), link: LINK })
    }
    await notifyEach(sp, tenant, 'hostel_safety', items)
    await sp.execute(sql`update hostel_curfew_cases set warden_at = ${nowIso}::timestamptz where id = any(${literal(xs.map((c) => c.id))}::uuid[])`)
    await sp.execute(sql`
      insert into hostel_presence_log (institution_id, student_id, at, kind, source, detail)
      select ${tenant}, t.s, ${nowIso}::timestamptz, 'warden_alerted', 'hostel', jsonb_build_object('caseId', t.c, 'recipients', t.n)
        from unnest(${literal(xs.map((c) => c.student_id))}::text[], ${literal(xs.map((c) => c.id))}::text[], ${literal(counts.map(String))}::int[]) as t(s, c, n)`)
    return xs.length
  }, tx, 'warden')

  out.guardians += await guarded(guardians, async (sp, xs) => {
    // The parents module owns the guardian function; without it nobody is a guardian (the notices module does the same).
    const [fn] = (await sp.execute(sql`select to_regprocedure('public.campusos_guardians_of(text[])') is not null as ok`)).rows as { ok: boolean }[]
    const sharing = xs.filter((c) => c.sharing)
    const guardianOf = new Map<string, string[]>()
    if (fn?.ok && sharing.length > 0) {
      const rows = (await sp.execute(sql`
        select distinct student_id, guardian_id from public.campusos_guardians_of(${literal(sharing.map((c) => c.student_id))}::text[])`)).rows as { student_id: string; guardian_id: string }[]
      for (const r of rows) if (r.guardian_id !== r.student_id) guardianOf.set(r.student_id, [...(guardianOf.get(r.student_id) ?? []), r.guardian_id])
    }
    const items: { userId: string; title: string; body: string; link: string }[] = []
    const detail: Record<string, unknown>[] = []
    for (const c of xs) {
      const h = homes.get(c.student_id)!
      const staff = [...new Set([...(await team('block', h)), ...(await team('chief', h))])]
      const gIds = guardianOf.get(c.student_id) ?? []
      const where = `${h.studentName} (${h.blockCode}-${h.room})`
      if (gIds.length > 0) {
        for (const userId of gIds) {
          items.push({
            userId,
            title: 'Hostel check-in missing',
            body: `${h.studentName} has not checked in at the hostel as of ${hhmm}. Please contact them or the hostel office.`,
            link: '/m/parents',
          })
        }
        for (const userId of staff) items.push({ userId, ...wardenText(c, h), link: LINK })
        detail.push({ caseId: c.id, sent: true, count: gIds.length })
      } else {
        // No consent, or consent and nobody to tell: the wardens make the call themselves.
        for (const userId of staff) {
          items.push({
            userId,
            title: "Call a resident's guardian",
            body: `${where} is still not checked in. Guardian alerts are off for this student. Open the case for the emergency contact.`,
            link: LINK,
          })
        }
        detail.push({ caseId: c.id, sent: false, reason: c.sharing ? "no_guardians" : "no_consent" })
      }
    }
    await notifyEach(sp, tenant, 'hostel_safety', items)
    await sp.execute(sql`update hostel_curfew_cases set guardian_at = ${nowIso}::timestamptz where id = any(${literal(xs.map((c) => c.id))}::uuid[])`)
    await sp.execute(sql`
      insert into hostel_presence_log (institution_id, student_id, at, kind, source, detail)
      select ${tenant}, a.s, ${nowIso}::timestamptz, 'guardian_alerted', 'hostel', b.d
        from unnest(${literal(xs.map((c) => c.student_id))}::text[]) with ordinality as a(s, o)
        join jsonb_array_elements(${JSON.stringify(detail)}::jsonb) with ordinality as b(d, o) on b.o = a.o`)
    return xs.length
  }, tx, 'guardian')
  return out
}

interface OpenCase {
  id: string
  student_id: string
  block_id: string
  curfew_at: Date | string
  nudge_at: Date | string | null
  warden_at: Date | string | null
  guardian_at: Date | string | null
  sharing?: boolean
}

/**
 * Run one ladder step for a set of cases in a savepoint. If the set fails, take the cases one at a time, each in
 * its own savepoint, so one resident's failure costs only that case (it is retried on the next tick).
 */
async function guarded(items: OpenCase[], run: (sp: Tx, xs: OpenCase[]) => Promise<number>, tx: Tx, step: string): Promise<number> {
  if (items.length === 0) return 0
  try {
    return await tx.transaction((sp) => run(sp, items))
  } catch (e) {
    if (items.length > 1) {
      let n = 0
      for (const one of items) {
        try {
          n += await tx.transaction((sp) => run(sp, [one]))
        } catch (e2) {
          console.warn(JSON.stringify({ event: 'hostel.ladder_case_failed', step, caseId: one.id, error: (e2 as Error).message }))
        }
      }
      return n
    }
    console.warn(JSON.stringify({ event: 'hostel.ladder_case_failed', step, caseId: items[0]!.id, error: (e as Error).message }))
    return 0
  }
}

async function logRow(tx: Tx, tenant: string, studentId: string, at: Date, kind: string, detail: Record<string, unknown>) {
  await tx.execute(sql`
    insert into hostel_presence_log (institution_id, student_id, at, kind, source, detail)
    values (${tenant}, ${studentId}, ${at.toISOString()}::timestamptz, ${kind}, 'hostel', ${JSON.stringify(detail)}::jsonb)`)
}

// --- the warden's reads and the hand resolution -------------------------------

const CASE_SORTS: SortSpec = {
  opened: { dir: 'desc', keys: [{ sql: sql`c.opened_at`, type: 'timestamptz' }, { sql: sql`c.id`, type: 'uuid' }] },
}
export const casePage = (req: Request, prefix: string) => readPage(req, prefix, CASE_SORTS, 'opened', 50)

export interface CaseRow {
  id: string
  studentId: string
  name: string
  blockCode: string
  night: string
  curfewAt: Date
  openedAt: Date
  nudgeAt: Date | null
  wardenAt: Date | null
  guardianAt: Date | null
  resolvedAt: Date | null
  resolution: string | null
  note: string | null
}

/** Cases, open ones by default, newest first, a page at a time. */
export async function listCases(
  actor: Actor,
  filter: { resolved?: boolean } = {},
  page = casePage(new Request('https://x/'), ''),
) {
  const tenant = requireWarden(actor)
  const keys = CASE_SORTS[page.sort]!.keys
  const resolvedCond = filter.resolved ? sql`c.resolved_at is not null` : sql`c.resolved_at is null`
  return withTenant(tenant, async (tx) => {
    const rows = (await tx.execute(sql`
      select c.id, c.student_id as "studentId", u.name, b.code as "blockCode", c.night::text as night,
             c.curfew_at as "curfewAt", c.opened_at as "openedAt", c.nudge_at as "nudgeAt", c.warden_at as "wardenAt",
             c.guardian_at as "guardianAt", c.resolved_at as "resolvedAt", c.resolution, c.note, ${cursorColumn(keys)} as _cursor
        from hostel_curfew_cases c
        join users u on u.id = c.student_id
        join hostel_blocks b on b.id = c.block_id
       where ${resolvedCond} and ${keyset(keys, page) ?? sql`true`}
       order by ${sql.join(orderKeys(keys, page.dir), sql`, `)}
       limit ${page.limit + 1}`)).rows as unknown as (CaseRow & { _cursor: string[] })[]
    const n = ((await tx.execute(sql`select count(*)::int as n from hostel_curfew_cases c where ${resolvedCond}`)).rows as { n: number }[])[0]?.n ?? 0
    return finishPage(rows, page, Number(n))
  })
}

export const resolveCaseSchema = z
  .object({
    caseId: z.uuid(),
    resolution: z.enum(['warden_verified', 'warden_closed']),
    note: z.string().trim().min(5).max(300).nullish(),
  })
  .refine((d) => d.resolution !== 'warden_closed' || !!d.note, { message: 'closing a case needs a note', path: ['note'] })
  .meta({ id: 'HostelCaseResolve' })

/** A warden resolves a case by hand: verified in person, or closed with a note (D1328). */
export async function resolveCase(actor: Actor, input: unknown) {
  const tenant = requireWarden(actor)
  const d = resolveCaseSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [c] = (await tx.execute(sql`select id, student_id, resolved_at from hostel_curfew_cases where id = ${d.caseId} for update`)).rows as { id: string; student_id: string; resolved_at: Date | null }[]
    if (!c) throw new HostelError(404, 'no_such_case', 'no such case')
    if (c.resolved_at) throw new HostelError(409, 'case_closed', 'this case is already resolved')
    await tx.execute(sql`
      update hostel_curfew_cases set resolved_at = now(), resolution = ${d.resolution}, resolved_by = ${actor.id}, note = ${d.note ?? null}
       where id = ${d.caseId}`)
    await logRow(tx, tenant, c.student_id, new Date(), 'case_resolved', { caseId: d.caseId, resolution: d.resolution })
    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: 'hostel.case_resolved',
      entity: 'hostel_curfew_cases',
      entityId: d.caseId,
      reason: d.note ?? d.resolution,
      detail: { studentId: c.student_id, resolution: d.resolution },
    })
    return { id: d.caseId, resolution: d.resolution }
  })
}

const EVIDENCE_WORDS: Record<Evidence, string> = {
  checked_in: 'checked in tonight',
  leave: 'on approved leave',
  late_pass: 'holds an approved late-stay pass',
  library: 'inside the library',
  library_exit: 'left the library a few minutes ago',
  class: 'in a class that is running now',
}

/** One resident's presence for a warden: status, why, recent cases and log, and the emergency contact. Reading it is logged (D1340). */
export async function studentPresence(actor: Actor, studentId: string, now = new Date()) {
  const tenant = requireWarden(actor)
  return withTenant(tenant, async (tx) => {
    const [who] = (await tx.execute(sql`select id, name from users where id = ${studentId} and role = 'student'`)).rows as { id: string; name: string }[]
    if (!who) throw new HostelError(404, 'no_such_student', 'no such student')
    await logSensitiveRead(tx, {
      institutionId: tenant,
      readerId: actor.id,
      subjectId: studentId,
      moduleId: MODULE,
      kind: 'hostel.presence',
      entity: 'users',
      entityId: studentId,
      purpose: 'warden follow-up',
    })
    const zone = await zoneIn(tx, tenant)
    const night = await nightOf(tx, now, zone)
    const f = (await loadFacts(tx, tenant, [studentId], now, night)).get(studentId)!
    const p = await loadPolicy(tx, tenant)
    const evidence = curfewEvidence({ ...f, pastCurfew: true }, now, p.walkBackMin)
    const { time } = await localParts(tx, now, zone)
    const shown = derivePresence({ ...f, pastCurfew: time >= p.curfewTime })
    const cases = (await tx.execute(sql`
      select c.id, c.night::text as night, c.curfew_at as "curfewAt", c.resolved_at as "resolvedAt", c.resolution, c.note
        from hostel_curfew_cases c where c.student_id = ${studentId} and c.night >= (${night}::date - 30)
       order by c.night desc`)).rows
    const log = (await tx.execute(sql`
      select at, kind, source from hostel_presence_log
       where student_id = ${studentId} and at >= ${now.toISOString()}::timestamptz - interval '7 days'
       order by at desc limit 200`)).rows
    const [prof] = (await tx.execute(sql`select to_regclass('public.academic_student_profiles') is not null as there`)).rows as { there: boolean }[]
    const contact = prof?.there
      ? ((await tx.execute(sql`select emergency_contact from academic_student_profiles where student_id = ${studentId}`)).rows as { emergency_contact: string | null }[])[0]?.emergency_contact ?? null
      : null
    return {
      studentId,
      name: who.name,
      status: shown.status,
      label: shown.label,
      sharing: f.sharing,
      accountedFor: evidence ? EVIDENCE_WORDS[evidence] : null,
      cases,
      log,
      emergencyContact: contact,
    }
  })
}

export type { Step }
