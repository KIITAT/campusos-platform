/**
 * What a DPDP export may hand over, table by table.
 *
 * The export still *finds* tables from the catalogue -- every foreign key to
 * `users` -- so nothing about a person is missed by accident. What it no
 * longer does is hand over whatever it finds. `select *` on every such table
 * returned Auth.js session tokens, Google refresh tokens and the secrets that
 * sign a teacher's attendance QR codes (SEC-01, NEW-01), to whoever asked for
 * the export. A table is exported only once somebody has decided it should be.
 *
 * Three layers, so one mistake is not a leak:
 *
 *  1. a table that is not listed here is not exported at all. A plugin that
 *     ships a table before core classifies it fails safe, and CI fails it by
 *     name (dpdp-policy.test.ts) so it does not stay unclassified;
 *  2. credentials are excluded by name, and columns that carry one are omitted
 *     or the table is reduced to the columns that are about the person;
 *  3. any remaining column whose name looks like a secret is redacted, unless
 *     it is listed in SAFE_COLUMNS after review. CI fails on a new one, so the
 *     review happens rather than the redaction silently standing in for it.
 *
 * ponytail: core naming module tables is a layering shortcut for the hotfix.
 * Each module should declare its own export and erasure rules (P1-08, AUD-03).
 */

export type ExportRule =
  /** Every column, after secret-looking ones are redacted. */
  | 'export'
  /** Never exported: a credential, or a table that is not about the person. */
  | 'exclude'
  /** Every column except these. */
  | { omit: readonly string[] }
  /**
   * Only these columns. `through: 'auth'` reads the table with the auth role,
   * for the tables the application role may no longer read at all (SEC-05).
   */
  | { only: readonly string[]; through?: 'auth' }

/** Column names that might hold a credential. Broad on purpose. */
export const SECRET_LIKE = /(token|secret|password|passwd|hash|salt|nonce|private|credential|otp|key|signature|cookie)/i

/** Columns that match SECRET_LIKE but were reviewed and carry no secret. */
export const SAFE_COLUMNS: readonly string[] = [
  // A digest of the scan the student made, and its one-time number: evidence
  // of their own attendance, useless for signing anything.
  'attendance_records.payload_hash',
  'attendance_records.scan_nonce',
  // A duration, not a token.
  'attendance_sessions.token_window_seconds',
  // The public half of the student's device key. The private half never
  // leaves the phone.
  'attendance_devices.public_key',
]

/**
 * Tables the web host creates rather than a migration in this repository, so
 * the catalogue check here cannot see them. Classified all the same.
 */
export const HOST_TABLES: readonly string[] = ['installed_plugins']

export const EXPORT_POLICY: Readonly<Record<string, ExportRule>> = {
  // core: credentials and the job queue
  accounts: 'exclude',
  sessions: 'exclude',
  // No foreign key (it is keyed by address), so discovery never reaches it;
  // listed so that a later one cannot quietly export it.
  verificationToken: 'exclude',
  // Which phones the person paired and when -- never the token or code hash.
  device_tokens: { only: ['id', 'device_name', 'created_at', 'last_used_at', 'revoked_at'], through: 'auth' },
  invitations: { omit: ['token_hash'] },
  // Leases and payloads of internal work, not a record about the person.
  background_jobs: 'exclude',
  // The salt is the chain's, not the person's (P0-02).
  audit_log: { omit: ['salt'] },
  installed_plugins: { only: ['module_id', 'version', 'installed_at'] },

  // academic
  academic_class_changes: 'export',
  academic_course_completions: 'export',
  academic_departments: 'export',
  academic_gpa_policies: 'export',
  academic_offerings: 'export',
  academic_prerequisite_waivers: 'export',
  academic_section_members: 'export',
  academic_sections: 'export',
  academic_student_profiles: 'export',
  academic_student_programs: 'export',

  admissions_applications: 'export',
  alumni_profiles: 'export',

  // attendance. The QR signing secrets are the teacher's credential for the
  // class: anybody holding one can mint scans for it (NEW-01).
  attendance_devices: { omit: ['device_hash'] },
  attendance_excuses: 'export',
  attendance_offline_credentials: 'exclude',
  attendance_records: 'export',
  attendance_sessions: { omit: ['token_secret'] },

  // care (counselling). Confidential notes are exported as before; whether a
  // subject access request should include them is a P1-08 decision.
  care_appointments: 'export',
  care_counsellors: 'export',
  care_instruments: 'export',
  care_notes: 'export',
  care_requests: 'export',
  care_results: 'export',
  care_settings: 'export',

  // ceremony
  ceremony_candidates: 'export',
  ceremony_certificates: 'export',
  ceremony_events: 'export',
  ceremony_holds: 'export',

  // enrollment
  enrollment_registration_events: 'export',
  enrollment_registrations: 'export',

  // examinations
  exam_backlog_bookings: 'export',
  exam_enrolments: 'export',
  exam_marks: 'export',
  exam_question_papers: 'export',
  exam_windows: 'export',
  exams: 'export',

  // fees
  fee_demand_letters: 'export',
  fee_drop_credits: 'export',
  // Replay guards on payments, refunds and charges (P0-06): ids and a hash,
  // nothing the person said or did that the receipt does not already record.
  fee_idempotency_keys: 'exclude',
  fee_invoices: 'export',
  fee_payments: 'export',
  fee_refunds: 'export',
  fee_scholarship_awards: 'export',
  fee_student_charges: 'export',
  fee_transfer_claims: 'export',
  fee_waivers: 'export',

  // feedback
  feedback_forms: 'export',
  feedback_submissions: 'export',
  feedback_windows: 'export',

  // finance
  finance_approvals: 'export',
  finance_asset_events: 'export',
  finance_assets: 'export',
  finance_bank_statement_lines: 'export',
  finance_bank_statements: 'export',
  finance_exchange_rates: 'export',
  finance_fiscal_years: 'export',
  finance_invoices: 'export',
  finance_journal_entries: 'export',
  finance_journals: 'export',
  finance_material_requests: 'export',
  finance_order_closures: 'export',
  finance_orders: 'export',
  finance_payments: 'export',
  finance_periods: 'export',
  finance_receipts: 'export',
  finance_staff: 'export',
  finance_stock_entries: 'export',

  // helpdesk
  helpdesk_cases: 'export',
  helpdesk_messages: 'export',

  // hostel
  hostel_allocations: 'export',
  hostel_blocks: 'export',
  hostel_check_ins: 'export',
  hostel_leaves: 'export',
  hostel_visitors: 'export',

  // hr
  hr_appraisal_feedback: 'export',
  hr_appraisals: 'export',
  hr_comp_off_requests: 'export',
  hr_employee_advances: 'export',
  hr_employment_changes: 'export',
  hr_expense_claims: 'export',
  hr_goals: 'export',
  hr_gratuity_payouts: 'export',
  hr_interview_feedback: 'export',
  hr_job_offers: 'export',
  hr_job_requisitions: 'export',
  hr_leave_allocations: 'export',
  hr_leave_encashments: 'export',
  hr_leave_requests: 'export',
  hr_onboarding_activities: 'export',
  hr_payroll_runs: 'export',
  hr_payslips: 'export',
  hr_salary_payments: 'export',
  hr_salary_withholdings: 'export',
  hr_separations: 'export',
  hr_shift_assignments: 'export',
  hr_shift_requests: 'export',
  hr_staff: 'export',

  library_loans: 'export',

  // mentoring
  mentor_assignments: 'export',
  mentor_leave_applications: 'export',
  mentor_messages: 'export',
  mentor_notes: 'export',

  // notices and notifications
  notice_attachments: 'export',
  notices: 'export',
  notifications: 'export',

  // parents
  parent_guardian_invites: 'export',
  parent_links: 'export',

  // placement
  placement_applications: 'export',
  placement_offers: 'export',
  placement_officers: 'export',

  // quiz
  quiz_attempts: 'export',
  quiz_extensions: 'export',
  quiz_questions: 'export',
  quiz_quizzes: 'export',
  quiz_responses: 'export',

  skill_assessments: 'export',

  // timetable
  timetable_eligibility: 'export',
  timetable_pins: 'export',
  timetable_run_entries: 'export',
  timetable_teachers: 'export',
  timetable_unavailable: 'export',

  transport_assignments: 'export',
}

/** Apply a table's rule and the secret redaction to one exported row. */
export function exportableRow(table: string, row: Record<string, unknown>): Record<string, unknown> {
  const rule = EXPORT_POLICY[table]
  const omit = typeof rule === 'object' && 'omit' in rule ? rule.omit : []
  const out: Record<string, unknown> = {}
  for (const [column, value] of Object.entries(row)) {
    if (omit.includes(column)) continue
    out[column] =
      SECRET_LIKE.test(column) && !SAFE_COLUMNS.includes(`${table}.${column}`) ? '[redacted]' : value
  }
  return out
}
