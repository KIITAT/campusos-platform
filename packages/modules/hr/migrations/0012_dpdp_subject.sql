-- P1-08a: hr's part in erasing and exporting a person (AUD-03, decisions 220, 221).
-- Overwrites:
--   nothing (this module holds no free text about a person to overwrite).
-- Rows about a person keyed by someone else: every hr table keyed by hr_staff.id, for the staff member's own rows.
--
-- Rollback:
--   DROP VIEW IF EXISTS dpdp_subject.hr_about;

-- Pre-flight: core 0012.
DO $$
BEGIN
  IF to_regnamespace('dpdp_subject') IS NULL OR to_regprocedure('public.campusos_erasure_allows(text, jsonb, jsonb, text[])') IS NULL THEN
    RAISE EXCEPTION 'core migration 0012 (dpdp_subject) must be applied first';
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE VIEW dpdp_subject.hr_about WITH (security_invoker = true) AS
  SELECT s.user_id AS subject_id, 'hr_appraisals'::text AS source, to_jsonb(t) AS row_data
    FROM public.hr_appraisals t JOIN public.hr_staff s ON s.id = t.staff_id WHERE s.user_id IS NOT NULL
  UNION ALL
  SELECT s.user_id AS subject_id, 'hr_comp_off_requests'::text AS source, to_jsonb(t) AS row_data
    FROM public.hr_comp_off_requests t JOIN public.hr_staff s ON s.id = t.staff_id WHERE s.user_id IS NOT NULL
  UNION ALL
  SELECT s.user_id AS subject_id, 'hr_employee_advances'::text AS source, to_jsonb(t) AS row_data
    FROM public.hr_employee_advances t JOIN public.hr_staff s ON s.id = t.staff_id WHERE s.user_id IS NOT NULL
  UNION ALL
  SELECT s.user_id AS subject_id, 'hr_employment_changes'::text AS source, to_jsonb(t) AS row_data
    FROM public.hr_employment_changes t JOIN public.hr_staff s ON s.id = t.staff_id WHERE s.user_id IS NOT NULL
  UNION ALL
  SELECT s.user_id AS subject_id, 'hr_expense_claims'::text AS source, to_jsonb(t) AS row_data
    FROM public.hr_expense_claims t JOIN public.hr_staff s ON s.id = t.staff_id WHERE s.user_id IS NOT NULL
  UNION ALL
  SELECT s.user_id AS subject_id, 'hr_goals'::text AS source, to_jsonb(t) AS row_data
    FROM public.hr_goals t JOIN public.hr_staff s ON s.id = t.staff_id WHERE s.user_id IS NOT NULL
  UNION ALL
  SELECT s.user_id AS subject_id, 'hr_gratuity_payouts'::text AS source, to_jsonb(t) AS row_data
    FROM public.hr_gratuity_payouts t JOIN public.hr_staff s ON s.id = t.staff_id WHERE s.user_id IS NOT NULL
  UNION ALL
  SELECT s.user_id AS subject_id, 'hr_job_offers'::text AS source, to_jsonb(t) AS row_data
    FROM public.hr_job_offers t JOIN public.hr_staff s ON s.id = t.staff_id WHERE s.user_id IS NOT NULL
  UNION ALL
  SELECT s.user_id AS subject_id, 'hr_leave_allocations'::text AS source, to_jsonb(t) AS row_data
    FROM public.hr_leave_allocations t JOIN public.hr_staff s ON s.id = t.staff_id WHERE s.user_id IS NOT NULL
  UNION ALL
  SELECT s.user_id AS subject_id, 'hr_leave_encashments'::text AS source, to_jsonb(t) AS row_data
    FROM public.hr_leave_encashments t JOIN public.hr_staff s ON s.id = t.staff_id WHERE s.user_id IS NOT NULL
  UNION ALL
  SELECT s.user_id AS subject_id, 'hr_leave_policy_assignments'::text AS source, to_jsonb(t) AS row_data
    FROM public.hr_leave_policy_assignments t JOIN public.hr_staff s ON s.id = t.staff_id WHERE s.user_id IS NOT NULL
  UNION ALL
  SELECT s.user_id AS subject_id, 'hr_leave_requests'::text AS source, to_jsonb(t) AS row_data
    FROM public.hr_leave_requests t JOIN public.hr_staff s ON s.id = t.staff_id WHERE s.user_id IS NOT NULL
  UNION ALL
  SELECT s.user_id AS subject_id, 'hr_onboardings'::text AS source, to_jsonb(t) AS row_data
    FROM public.hr_onboardings t JOIN public.hr_staff s ON s.id = t.staff_id WHERE s.user_id IS NOT NULL
  UNION ALL
  SELECT s.user_id AS subject_id, 'hr_pay_components'::text AS source, to_jsonb(t) AS row_data
    FROM public.hr_pay_components t JOIN public.hr_staff s ON s.id = t.staff_id WHERE s.user_id IS NOT NULL
  UNION ALL
  SELECT s.user_id AS subject_id, 'hr_payroll_arrears'::text AS source, to_jsonb(t) AS row_data
    FROM public.hr_payroll_arrears t JOIN public.hr_staff s ON s.id = t.staff_id WHERE s.user_id IS NOT NULL
  UNION ALL
  SELECT s.user_id AS subject_id, 'hr_payslips'::text AS source, to_jsonb(t) AS row_data
    FROM public.hr_payslips t JOIN public.hr_staff s ON s.id = t.staff_id WHERE s.user_id IS NOT NULL
  UNION ALL
  SELECT s.user_id AS subject_id, 'hr_salary_assignments'::text AS source, to_jsonb(t) AS row_data
    FROM public.hr_salary_assignments t JOIN public.hr_staff s ON s.id = t.staff_id WHERE s.user_id IS NOT NULL
  UNION ALL
  SELECT s.user_id AS subject_id, 'hr_salary_withholdings'::text AS source, to_jsonb(t) AS row_data
    FROM public.hr_salary_withholdings t JOIN public.hr_staff s ON s.id = t.staff_id WHERE s.user_id IS NOT NULL
  UNION ALL
  SELECT s.user_id AS subject_id, 'hr_separations'::text AS source, to_jsonb(t) AS row_data
    FROM public.hr_separations t JOIN public.hr_staff s ON s.id = t.staff_id WHERE s.user_id IS NOT NULL
  UNION ALL
  SELECT s.user_id AS subject_id, 'hr_shift_assignments'::text AS source, to_jsonb(t) AS row_data
    FROM public.hr_shift_assignments t JOIN public.hr_staff s ON s.id = t.staff_id WHERE s.user_id IS NOT NULL
  UNION ALL
  SELECT s.user_id AS subject_id, 'hr_shift_requests'::text AS source, to_jsonb(t) AS row_data
    FROM public.hr_shift_requests t JOIN public.hr_staff s ON s.id = t.staff_id WHERE s.user_id IS NOT NULL
  UNION ALL
  SELECT s.user_id AS subject_id, 'hr_tax_elections'::text AS source, to_jsonb(t) AS row_data
    FROM public.hr_tax_elections t JOIN public.hr_staff s ON s.id = t.staff_id WHERE s.user_id IS NOT NULL
  UNION ALL
  SELECT s.user_id, 'hr_appraisal_feedback'::text, to_jsonb(t)
    FROM public.hr_appraisal_feedback t JOIN public.hr_appraisals p ON p.id = t.appraisal_id JOIN public.hr_staff s ON s.id = p.staff_id WHERE s.user_id IS NOT NULL
  UNION ALL
  SELECT s.user_id, 'hr_appraisal_kras'::text, to_jsonb(t)
    FROM public.hr_appraisal_kras t JOIN public.hr_appraisals p ON p.id = t.appraisal_id JOIN public.hr_staff s ON s.id = p.staff_id WHERE s.user_id IS NOT NULL
  UNION ALL
  SELECT s.user_id, 'hr_expense_claim_lines'::text, to_jsonb(t)
    FROM public.hr_expense_claim_lines t JOIN public.hr_expense_claims p ON p.id = t.claim_id JOIN public.hr_staff s ON s.id = p.staff_id WHERE s.user_id IS NOT NULL
  UNION ALL
  SELECT s.user_id, 'hr_onboarding_activities'::text, to_jsonb(t)
    FROM public.hr_onboarding_activities t JOIN public.hr_onboardings p ON p.id = t.onboarding_id JOIN public.hr_staff s ON s.id = p.staff_id WHERE s.user_id IS NOT NULL;
--> statement-breakpoint
GRANT SELECT ON dpdp_subject.hr_about TO campusos_app;
