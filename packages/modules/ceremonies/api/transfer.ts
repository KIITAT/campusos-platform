import { and, eq, sql } from 'drizzle-orm'
import { amendDocument, audit, cancelDocument, submitDocument, withTenant } from '@campusos/db'
import { MissingGlyphError, unprintable } from '@campusos/module-framework/pdf'
import { transferCertificates, transferPayloads, type TransferSnapshot } from '../transfer-schema'
import { CeremonyError, type Actor } from './operations'
import { assertCertificateClearanceWithin } from './clearance'
import { transferIssueSchema, transferListSchema, transferReissueSchema, transferRevokeSchema, type TransferFacts } from './transfer-input'

/**
 * The numbered school transfer certificate (P1-13d, decisions 975 to 983).
 *
 * Every mutation takes one lock per institution first, so serials are gapless
 * under concurrency and two clerks cannot both issue for one declaration. The
 * clearance check is the same one degree certificates use (P1-07d) and runs
 * after every field is validated and before the first document write, so a
 * refusal never consumes a number.
 */

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]

export interface TransferResult {
  id: string
  serial: string
  notice: string
}
export interface TransferListRow {
  id: string
  serial: string
  issuedOn: string
  docstatus: 'submitted' | 'cancelled'
  printable: boolean
  amendedFrom: string | null
}

const requireTransferOffice = (actor: Actor): string => {
  if (!actor.institutionId) throw new CeremonyError(400, 'no_institution', 'no institution for this session')
  if (actor.role !== 'institution_admin' && actor.role !== 'super_admin') throw new CeremonyError(403, 'forbidden', 'not permitted')
  return actor.institutionId
}
const who = (actor: Actor, tenant: string) => ({ institutionId: tenant, actorId: actor.id, actorEmail: actor.email ?? null, moduleId: 'ceremonies' })
export const formatSerial = (year: number, no: number) => `TC-${year}-${String(no).padStart(6, '0')}`

const noDeclaration = () => new CeremonyError(404, 'no_such_transfer_declaration', 'No such school declaration.')
const noCertificate = () => new CeremonyError(404, 'no_such_transfer_certificate', 'No such transfer certificate.')
const exists = () => new CeremonyError(409, 'transfer_certificate_exists', 'A transfer certificate is already recorded for this declaration.')

/** Serialise every allocator and every mutation for this institution. */
async function lockSeries(tx: Tx, tenant: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'ceremonies.tc:' + tenant}, 0))`)
}

interface Declaration {
  id: string
  student_id: string
  status: string
  declared_on: string
  ended_on: string | null
  program_code: string
  program_name: string
  pupil_name: string | null
  dob: string | null
  school_name: string
}

/** The declaration with its pupil and programme, locked so erasure cannot interleave with the snapshot. */
async function declarationIn(tx: Tx, tenant: string, id: string): Promise<Declaration> {
  const r = await tx.execute(sql`
    select sp.id, sp.student_id, sp.status, sp.declared_on::text as declared_on, sp.ended_on::text as ended_on,
           p.code as program_code, p.name as program_name, u.name as pupil_name, u.date_of_birth::text as dob, i.name as school_name
      from academic_student_programs sp
      join academic_programs p on p.id = sp.program_id and p.institution_id = sp.institution_id
      join users u on u.id = sp.student_id and u.institution_id = sp.institution_id
      join institutions i on i.id = sp.institution_id
     where sp.id = ${id} and sp.institution_id = ${tenant}::uuid and p.level = 'school' and u.role = 'student' and u.erased_at is null
       for update of sp for share of u`)
  const row = r.rows[0] as Declaration | undefined
  if (!row) throw noDeclaration()
  return row
}

/** Today's date as the institution counts it, read after the lock is held. */
async function istToday(tx: Tx): Promise<string> {
  return ((await tx.execute(sql`select (now() at time zone 'Asia/Kolkata')::date::text as d`)).rows[0] as { d: string }).d
}

const bad = (m: string) => new CeremonyError(400, 'invalid_transfer_fields', m)

/** Validate the entered facts against the records and build the stored snapshot (cbse_annexure_i_v1). */
function snapshotOf(d: TransferFacts | Omit<TransferFacts, 'studentProgramId'>, decl: Declaration, issuedOn: string, replacesSerial: string | null): TransferSnapshot {
  if (!decl.pupil_name?.trim() || !decl.dob || !decl.ended_on) {
    throw new CeremonyError(409, 'transfer_record_incomplete', 'Complete the pupil and admission records before issuing.')
  }
  const ordered: [string, string][] = [
    [decl.dob, d.firstAdmittedOn],
    [d.firstAdmittedOn, decl.declared_on],
    [decl.declared_on, decl.ended_on],
    [decl.ended_on, issuedOn],
    [d.firstAdmittedOn, d.appliedOn],
    [d.appliedOn, issuedOn],
  ]
  if (ordered.some(([a, b]) => a > b)) {
    throw bad('Dates must run: date of birth, first admission, declaration, exit, and the application and issue dates not before admission.')
  }
  if (d.paidThroughMonth && d.paidThroughMonth > issuedOn.slice(0, 7)) throw bad('Fees cannot be paid through a month after the issue date.')
  const { studentProgramId: _p, certificateId: _c, ...entered } = d as Record<string, unknown>
  void _p
  void _c
  const snap: TransferSnapshot = {
    ...entered,
    format: 'cbse_annexure_i_v1',
    schoolName: decl.school_name,
    pupilName: decl.pupil_name,
    birthOn: decl.dob,
    lastProgramCode: decl.program_code,
    lastProgramName: decl.program_name,
    endedOn: decl.ended_on,
    issuedOn,
    replacesSerial,
  }
  // A serial is spent on a document of record, so a character the fonts cannot print is refused before it.
  const strings = Object.values(snap).flatMap((v) => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []))
  for (const s of strings) {
    const glyph = unprintable(s)
    if (glyph) throw new MissingGlyphError(glyph)
  }
  return snap
}

/** The next serial in the issue year, under the lock; clearance follows, before any write. */
async function allocate(tx: Tx, tenant: string, studentId: string, issuedOn: string) {
  const year = Number(issuedOn.slice(0, 4))
  const r = await tx.execute(sql`select coalesce(max(serial_no), 0)::int as n from ceremony_transfer_certificates where institution_id = ${tenant}::uuid and issue_year = ${year}`)
  const no = (r.rows[0] as { n: number }).n + 1
  if (no > 999999) throw new CeremonyError(409, 'transfer_series_full', 'This year’s transfer certificate series is full.')
  await assertCertificateClearanceWithin(tx, tenant, studentId)
  return { year, no }
}

async function issuedAudit(tx: Tx, actor: Actor, tenant: string, id: string, reason: string) {
  await audit(tx, { ...who(actor, tenant), action: 'ceremonies.transfer_issued', entity: 'ceremony_transfer_certificates', entityId: id, reason })
}

export async function issueTransferCertificate(actor: Actor, input: unknown): Promise<TransferResult> {
  const tenant = requireTransferOffice(actor)
  const d = transferIssueSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    await lockSeries(tx, tenant)
    const issuedOn = await istToday(tx)
    const decl = await declarationIn(tx, tenant, d.studentProgramId)
    // The last school declaration, ended as transferred out; the office completes the withdrawal first.
    const later = await tx.execute(sql`
      select 1 from academic_student_programs sp join academic_programs p on p.id = sp.program_id
       where sp.student_id = ${decl.student_id} and sp.id <> ${decl.id}::uuid and p.level = 'school'
         and (sp.status = 'active' or (sp.declared_on, sp.id) > (${decl.declared_on}::date, ${decl.id}::uuid)) limit 1`)
    if (decl.status !== 'transferred_out' || !decl.ended_on || later.rows.length > 0) {
      throw new CeremonyError(409, 'transfer_required', 'End the school declaration as transferred out before issuing.')
    }
    const [have] = await tx.select({ id: transferCertificates.id }).from(transferCertificates).where(eq(transferCertificates.studentProgramId, decl.id))
    if (have) throw exists()
    const snap = snapshotOf(d, decl, issuedOn, null)
    const { year, no } = await allocate(tx, tenant, decl.student_id, issuedOn)
    const [row] = await tx
      .insert(transferCertificates)
      .values({ institutionId: tenant, studentId: decl.student_id, studentProgramId: decl.id, issueYear: year, serialNo: no, issuedOn, docstatus: 'submitted', submittedAt: new Date(), submittedBy: actor.id })
      .returning({ id: transferCertificates.id })
    await tx.insert(transferPayloads).values({ certificateId: row!.id, institutionId: tenant, snapshot: snap })
    const serial = formatSerial(year, no)
    await issuedAudit(tx, actor, tenant, row!.id, `issued ${serial}`)
    return { id: row!.id, serial, notice: `Transfer certificate ${serial} issued.` }
  })
}

async function headerIn(tx: Tx, tenant: string, id: string) {
  const [h] = await tx
    .select()
    .from(transferCertificates)
    .where(and(eq(transferCertificates.id, id), eq(transferCertificates.institutionId, tenant)))
    .for('update')
  if (!h) throw noCertificate()
  return h
}

export async function revokeTransferCertificate(actor: Actor, input: unknown): Promise<{ notice: string }> {
  const tenant = requireTransferOffice(actor)
  const d = transferRevokeSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    await lockSeries(tx, tenant)
    await headerIn(tx, tenant, d.certificateId)
    await cancelDocument(tx, transferCertificates, d.certificateId, { ...who(actor, tenant), reason: d.reason })
    return { notice: 'Transfer certificate revoked.' }
  })
}

export async function reissueTransferCertificate(actor: Actor, input: unknown): Promise<TransferResult> {
  const tenant = requireTransferOffice(actor)
  const d = transferReissueSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    await lockSeries(tx, tenant)
    const issuedOn = await istToday(tx)
    const old = await headerIn(tx, tenant, d.certificateId)
    if (old.docstatus !== 'cancelled') throw new CeremonyError(409, 'transfer_not_revoked', 'Revoke the certificate before replacing it.')
    const decl = await declarationIn(tx, tenant, old.studentProgramId)
    const snap = snapshotOf(d, decl, issuedOn, formatSerial(old.issueYear, old.serialNo))
    const { year, no } = await allocate(tx, tenant, decl.student_id, issuedOn)
    const draft = await amendDocument(tx, transferCertificates, old.id, who(actor, tenant), { issue_year: year, serial_no: no, issued_on: issuedOn })
    await tx.insert(transferPayloads).values({ certificateId: String(draft.id), institutionId: tenant, snapshot: snap })
    await submitDocument(tx, transferCertificates, String(draft.id), who(actor, tenant))
    const serial = formatSerial(year, no)
    await issuedAudit(tx, actor, tenant, String(draft.id), `issued ${serial} replacing ${snap.replacesSerial}`)
    return { id: String(draft.id), serial, notice: `Transfer certificate ${serial} issued.` }
  })
}

/** The register: an exact pupil or serial, newest first, at most 50. No names, no snapshot. */
export async function listTransferCertificates(actor: Actor, input: unknown): Promise<TransferListRow[]> {
  const tenant = requireTransferOffice(actor)
  const f = transferListSchema.parse(input ?? {})
  const serial = f.serial ? { year: Number(f.serial.slice(3, 7)), no: Number(f.serial.slice(8)) } : null
  return withTenant(tenant, async (tx) => {
    const r = await tx.execute(sql`
      select c.id, c.issue_year, c.serial_no, c.issued_on::text as issued_on, c.docstatus, c.amended_from,
             (c.docstatus = 'submitted' and p.certificate_id is not null) as printable
        from ceremony_transfer_certificates c
        left join ceremony_transfer_payloads p on p.certificate_id = c.id and p.institution_id = c.institution_id
       where c.institution_id = ${tenant}::uuid
         ${f.studentId ? sql`and c.student_id = ${f.studentId}` : sql``}
         ${serial ? sql`and c.issue_year = ${serial.year} and c.serial_no = ${serial.no}` : sql``}
       order by c.issued_on desc, c.serial_no desc, c.id desc
       limit 50`)
    return (r.rows as { id: string; issue_year: number; serial_no: number; issued_on: string; docstatus: 'submitted' | 'cancelled'; amended_from: string | null; printable: boolean }[]).map((x) => ({
      id: x.id,
      serial: formatSerial(x.issue_year, x.serial_no),
      issuedOn: x.issued_on,
      docstatus: x.docstatus,
      printable: x.printable,
      amendedFrom: x.amended_from,
    }))
  })
}

/** Up to 20 of a pupil's school declarations that ended as transferred out, latest first: the issue form's choices. */
export async function transferDeclarations(actor: Actor, studentId: string) {
  const tenant = requireTransferOffice(actor)
  return withTenant(tenant, async (tx) => {
    const r = await tx.execute(sql`
      select sp.id, p.code, p.name, sp.ended_on::text as ended_on
        from academic_student_programs sp join academic_programs p on p.id = sp.program_id
        join users u on u.id = sp.student_id and u.institution_id = sp.institution_id
       where sp.institution_id = ${tenant}::uuid and sp.student_id = ${studentId} and p.level = 'school'
         and sp.status = 'transferred_out' and u.erased_at is null
       order by sp.declared_on desc, sp.id desc limit 20`)
    return (r.rows as { id: string; code: string; name: string; ended_on: string }[]).map((x) => ({ id: x.id, code: x.code, name: x.name, endedOn: x.ended_on }))
  })
}
