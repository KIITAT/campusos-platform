import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, sql } from 'drizzle-orm'
import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { authDb, withTenant } from './client'
import { auditLog, recordTrail } from './audit'
import {
  DocStatusError,
  amendDocument,
  cancelDocument,
  docStatusColumns,
  docStatusDdl,
  submitDocument,
} from './docstatus'
import { institutions, users } from './schema'
import { tenantPolicy } from './rls'

/**
 * A table opting in, the way a module's would. Created here, not by a
 * migration, because no core table needs the lifecycle: modules do.
 */
const probe = pgTable(
  'docstatus_probe',
  {
    id: uuid().primaryKey().defaultRandom(),
    institutionId: uuid('institution_id').notNull(),
    title: text().notNull(),
    amount: integer().notNull(),
    madeBy: text('made_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    ...docStatusColumns(),
  },
  () => [tenantPolicy('docstatus_probe')],
)

const SLUG = 'docstatus-test'
let inst = ''
let actor = ''
const who = () => ({ institutionId: inst, actorId: actor, moduleId: 'probe' })
const named = (constraint: string) => (e: unknown) =>
  String((e as { cause?: { constraint?: string } }).cause?.constraint) === constraint
const code = (c: string) => (e: unknown) => (e as DocStatusError).code === c

before(async () => {
  await authDb.execute(
    sql.raw(`
    drop table if exists docstatus_probe;
    create table docstatus_probe (
      id uuid primary key default gen_random_uuid(),
      institution_id uuid not null references institutions(id) on delete cascade,
      title text not null,
      amount integer not null,
      made_by text references users(id) on delete set null,
      created_at timestamptz not null default now(),
      docstatus text not null default 'draft',
      submitted_at timestamptz, submitted_by text,
      cancelled_at timestamptz, cancelled_by text, cancel_reason text,
      amended_from uuid
    );
    alter table docstatus_probe enable row level security;
    create policy docstatus_probe_tenant_isolation on docstatus_probe as permissive for all to campusos_app
      using (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid)
      with check (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
    grant select, insert, update, delete on docstatus_probe to campusos_app;
  `),
  )
  for (const stmt of docStatusDdl('docstatus_probe').split('--> statement-breakpoint')) {
    await authDb.execute(sql.raw(stmt.trim().replace(/;$/, '')))
  }
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: SLUG, name: 'Docstatus College', allowedEmailDomains: ['docstatus.test'] })
    .returning({ id: institutions.id })
  inst = i!.id
  const [u] = await authDb
    .insert(users)
    .values({ email: 'clerk@docstatus.test', institutionId: inst, role: 'accounts_staff' })
    .returning({ id: users.id })
  actor = u!.id
})

beforeEach(async () => {
  await authDb.execute(sql`alter table docstatus_probe disable trigger docstatus_probe_docstatus`)
  await authDb.execute(sql`delete from docstatus_probe`)
  await authDb.execute(sql`alter table docstatus_probe enable trigger docstatus_probe_docstatus`)
})

after(async () => {
  await authDb.execute(sql`drop table if exists docstatus_probe`)
  await authDb.delete(institutions).where(eq(institutions.slug, SLUG))
})

const draft = (title = 'PO-1', amount = 100) =>
  withTenant(inst, async (tx) => {
    const [row] = await tx
      .insert(probe)
      .values({ institutionId: inst, title, amount, madeBy: actor })
      .returning()
    return row!
  })

test('a draft changes freely and can be deleted', async () => {
  const d = await draft()
  await withTenant(inst, (tx) => tx.update(probe).set({ amount: 250 }).where(eq(probe.id, d.id)))
  await withTenant(inst, (tx) => tx.delete(probe).where(eq(probe.id, d.id)))
})

test('once submitted, nothing changes and nothing is deleted -- the database says so', async () => {
  const d = await draft()
  const s = await withTenant(inst, (tx) => submitDocument(tx, probe, d.id, who()))
  assert.equal(s.docstatus, 'submitted')
  assert.equal(s.submitted_by, actor)

  await assert.rejects(
    withTenant(inst, (tx) => tx.update(probe).set({ amount: 1 }).where(eq(probe.id, d.id))),
    named('docstatus_locked'),
  )
  await assert.rejects(
    withTenant(inst, (tx) => tx.update(probe).set({ docstatus: 'draft' }).where(eq(probe.id, d.id))),
    named('docstatus_locked'),
    'no going back to draft',
  )
  await assert.rejects(
    withTenant(inst, (tx) => tx.delete(probe).where(eq(probe.id, d.id))),
    named('docstatus_locked'),
  )
  // Cancelling while also editing is still an edit.
  await assert.rejects(
    withTenant(inst, (tx) =>
      tx.update(probe).set({ docstatus: 'cancelled', cancelReason: 'x', amount: 5 }).where(eq(probe.id, d.id)),
    ),
    named('docstatus_locked'),
  )
  await assert.rejects(
    withTenant(inst, (tx) => tx.update(probe).set({ docstatus: 'cancelled' }).where(eq(probe.id, d.id))),
    named('docstatus_cancel_reason'),
  )
})

test('cancel needs a submitted record and a reason; a cancelled one is final', async () => {
  const d = await draft()
  await assert.rejects(
    withTenant(inst, (tx) => cancelDocument(tx, probe, d.id, { ...who(), reason: 'nope' })),
    code('not_submitted'),
    'a draft is deleted, not cancelled',
  )
  await assert.rejects(
    withTenant(inst, (tx) =>
      tx.update(probe).set({ docstatus: 'cancelled', cancelReason: 'x' }).where(eq(probe.id, d.id)),
    ),
    named('docstatus_draft_cancel'),
  )

  await withTenant(inst, (tx) => submitDocument(tx, probe, d.id, who()))
  const c = await withTenant(inst, (tx) => cancelDocument(tx, probe, d.id, { ...who(), reason: 'wrong supplier' }))
  assert.equal(c.docstatus, 'cancelled')
  assert.equal(c.cancel_reason, 'wrong supplier')

  await assert.rejects(
    withTenant(inst, (tx) => tx.update(probe).set({ title: 'sneaky' }).where(eq(probe.id, d.id))),
    named('docstatus_final'),
  )
  await assert.rejects(withTenant(inst, (tx) => submitDocument(tx, probe, d.id, who())), code('not_a_draft'))
})

test('amending a cancelled record makes one new draft that names it, with overrides', async () => {
  const d = await draft('PO-7', 700)
  await withTenant(inst, (tx) => submitDocument(tx, probe, d.id, who()))
  await withTenant(inst, (tx) => cancelDocument(tx, probe, d.id, { ...who(), reason: 'price changed' }))

  const a = await withTenant(inst, (tx) => amendDocument(tx, probe, d.id, who(), { title: 'PO-7-1' }))
  assert.equal(a.docstatus, 'draft')
  assert.equal(a.amended_from, d.id)
  assert.equal(a.title, 'PO-7-1')
  assert.equal(a.amount, 700, 'the rest is copied')
  assert.equal(a.submitted_at, null, 'the lifecycle is not')
  assert.notEqual(a.id, d.id)

  await assert.rejects(withTenant(inst, (tx) => amendDocument(tx, probe, d.id, who())), code('already_amended'))
  await assert.rejects(
    withTenant(inst, (tx) => amendDocument(tx, probe, String(a.id), who())),
    code('not_cancelled'),
  )
})

test('every move is audited against the record', async () => {
  const d = await draft()
  await withTenant(inst, (tx) => submitDocument(tx, probe, d.id, who()))
  await withTenant(inst, (tx) => cancelDocument(tx, probe, d.id, { ...who(), reason: 'duplicate' }))
  const trail = await withTenant(inst, (tx) =>
    tx.select().from(auditLog).where(eq(auditLog.entityId, d.id)).orderBy(auditLog.at),
  )
  assert.deepEqual(
    trail.map((t) => t.action),
    ['probe.submitted', 'probe.cancelled'],
  )
  assert.equal(trail[1]!.reason, 'duplicate')

  // What a form view's timeline reads: newest first, who and why, no detail.
  const shown = await recordTrail(inst, 'docstatus_probe', d.id)
  assert.deepEqual(shown.map((t) => t.action), ['probe.cancelled', 'probe.submitted'])
  assert.deepEqual(Object.keys(shown[0]!).sort(), ['action', 'at', 'reason', 'who'])
})

test('a cascade from elsewhere is not an edit', async () => {
  const [u] = await authDb
    .insert(users)
    .values({ email: 'temp@docstatus.test', institutionId: inst, role: 'accounts_staff' })
    .returning({ id: users.id })
  const d = await withTenant(inst, async (tx) => {
    const [row] = await tx
      .insert(probe)
      .values({ institutionId: inst, title: 'PO-9', amount: 9, madeBy: u!.id })
      .returning()
    return row!
  })
  await withTenant(inst, (tx) => submitDocument(tx, probe, d.id, who()))
  await authDb.delete(users).where(eq(users.id, u!.id))
  const [row] = await withTenant(inst, (tx) => tx.select().from(probe).where(eq(probe.id, d.id)))
  assert.equal(row!.madeBy, null)
  assert.equal(row!.docstatus, 'submitted')
})

test('a record cannot be born cancelled, and an unknown id is named', async () => {
  await assert.rejects(
    withTenant(inst, (tx) =>
      tx
        .insert(probe)
        .values({ institutionId: inst, title: 'x', amount: 1, docstatus: 'cancelled', cancelReason: 'x' }),
    ),
    named('docstatus_draft_cancel'),
  )
  await assert.rejects(
    withTenant(inst, (tx) => submitDocument(tx, probe, '00000000-0000-0000-0000-000000000000', who())),
    code('no_such_record'),
  )
})
