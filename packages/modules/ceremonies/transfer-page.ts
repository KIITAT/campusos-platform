import { param, type PluginField, type PluginPage, type PluginSection } from '@campusos/module-framework'
import { listTransferCertificates, transferDeclarations, type Actor } from './api'

/**
 * The office register of school transfer certificates (P1-13d, decision 980).
 * Office only: a minor's date of birth, category and family names stay with
 * the office, so no row, option or notice carries any of them.
 */

const OFFICE = ['institution_admin', 'super_admin'] as const
const PDF = '/api/v1/modules/ceremonies/transfer-certificate.pdf?certificateId={id}'

const text = (name: string, label: string, over: Partial<PluginField> = {}): PluginField => ({ name, label, kind: 'text', ...over })
const date = (name: string, label: string, over: Partial<PluginField> = {}): PluginField => ({ name, label, kind: 'date', ...over })
const num = (name: string, label: string): PluginField => ({ name, label, kind: 'number' })

/** The facts the office confirms for every certificate, in the order of the form. */
const facts: PluginField[] = [
  { name: 'schoolAddress', label: 'School address', kind: 'textarea', rows: 2 },
  text('affiliationNo', 'CBSE affiliation number'),
  text('schoolCode', 'School code'),
  text('bookNo', 'Register book number'),
  text('admissionNo', 'Admission register number'),
  text('motherName', "Mother's name", { optional: true }),
  text('fatherOrGuardianName', "Father's or guardian's name"),
  text('birthInWords', 'Date of birth in words'),
  text('nationality', 'Nationality', { value: 'Indian' }),
  {
    name: 'reservationCategory',
    label: 'Category',
    kind: 'select',
    options: ['SC', 'ST', 'OBC', 'Neither', 'Not recorded'].map((v) => ({ value: v, label: v })),
  },
  date('firstAdmittedOn', 'Date of first admission'),
  text('firstClass', 'Class at first admission'),
  text('lastClassFigures', 'Last class, in figures'),
  text('lastClassWords', 'Last class, in words'),
  text('lastExamResult', 'Last examination and result'),
  { ...num('repeatCount', 'Times failed in the same class (0, 1 or 2)'), value: '0' },
  text('subjects', 'Subjects studied', { hint: 'Separate with commas.' }),
  {
    name: 'promotionEligible',
    label: 'Qualified for promotion',
    kind: 'select',
    options: [
      { value: 'yes', label: 'Yes' },
      { value: 'no', label: 'No' },
      { value: 'not_applicable', label: 'Not applicable' },
    ],
  },
  text('promotionClassFigures', 'Promoted to class, in figures', { optional: true, hint: 'Only when promotion is yes.' }),
  text('promotionClassWords', 'Promoted to class, in words', { optional: true }),
  text('paidThroughMonth', 'Fees paid through (YYYY-MM)', { optional: true, hint: 'The office statement; outstanding dues are checked separately.' }),
  text('feeConcession', 'Fee concession availed', { optional: true }),
  num('workingDays', 'Total working days'),
  num('presentDays', 'Days present'),
  text('activitiesUniformed', 'NCC, scouts or guides', { optional: true }),
  text('activitiesOther', 'Games and activities', { optional: true }),
  text('conduct', 'General conduct'),
  date('appliedOn', 'Date of application'),
  text('leavingReason', 'Reason for leaving'),
  text('remarks', 'Other remarks', { optional: true }),
  text('checkedBy', 'Checked by (name and designation)'),
]

export const transferPage: PluginPage = {
  path: '/transfer-certificates',
  title: 'Transfer certificates',
  menu: 'Transfer certificates',
  roles: [...OFFICE],
  async load(actor, req) {
    const a = actor as Actor
    const studentId = param(req, 'studentId')?.trim() || undefined
    const serial = param(req, 'serial')?.trim() || undefined
    const [rows, declarations] = await Promise.all([
      listTransferCertificates(a, { studentId, serial }),
      studentId ? transferDeclarations(a, studentId) : Promise.resolve([]),
    ])
    const shown = rows.map((r) => ({ ...r, printAction: r.printable ? 'Print PDF' : '' }))
    return {
      rows: shown,
      declarationOptions: declarations.map((d) => ({ value: d.id, label: `${d.code} - ${d.name}, left ${d.endedOn}` })),
      revocable: shown.filter((r) => r.docstatus === 'submitted').map((r) => ({ value: r.id, label: r.serial })),
      replaceable: shown.filter((r) => r.docstatus === 'cancelled').map((r) => ({ value: r.id, label: r.serial })),
    }
  },
  sections(data) {
    const declarations = data.declarationOptions as { value: string; label: string }[]
    const revocable = data.revocable as unknown[]
    const replaceable = data.replaceable as unknown[]
    const out: PluginSection[] = [
      {
        kind: 'form',
        title: 'Find transfer records',
        note: 'A pupil or a serial, exactly. The register shows the newest 50 and never a name.',
        method: 'GET',
        path: '/transfer-certificates',
        submit: 'Find',
        fields: [text('studentId', 'Pupil (student ID)', { optional: true }), text('serial', 'Serial (TC-YYYY-NNNNNN)', { optional: true })],
      },
      {
        kind: 'table',
        title: 'Certificates',
        rows: 'rows',
        empty: 'No transfer certificate matches.',
        columns: [
          { key: 'serial', label: 'Serial', kind: 'code' },
          { key: 'issuedOn', label: 'Issued', kind: 'date' },
          { key: 'docstatus', label: 'Status', kind: 'status' },
          { key: 'printAction', label: 'Print', href: PDF },
        ],
      },
    ]
    if (declarations.length) {
      out.push({
        kind: 'form',
        title: 'Issue a transfer certificate',
        note: 'The school declaration must already be ended as transferred out. Dues are checked when you submit; a refusal takes no serial.',
        submit: 'Issue',
        path: '/transfer-certificates/issue',
        placement: 'inline',
        fields: [{ name: 'studentProgramId', label: 'School declaration', kind: 'select', options: 'declarationOptions' }, ...facts],
      })
    }
    if (revocable.length) {
      out.push({
        kind: 'form',
        title: 'Revoke a certificate',
        submit: 'Revoke',
        path: '/transfer-certificates/revoke',
        placement: 'inline',
        fields: [
          { name: 'certificateId', label: 'Certificate', kind: 'select', options: 'revocable' },
          text('reason', 'Reason for revocation (no personal details)'),
        ],
      })
    }
    if (replaceable.length) {
      out.push({
        kind: 'form',
        title: 'Replace a revoked certificate',
        note: 'Confirm every fact again; the replacement takes a new serial and names the one it replaces.',
        submit: 'Issue replacement',
        path: '/transfer-certificates/reissue',
        placement: 'inline',
        fields: [{ name: 'certificateId', label: 'Revoked certificate', kind: 'select', options: 'replaceable' }, ...facts],
      })
    }
    return out
  },
}
