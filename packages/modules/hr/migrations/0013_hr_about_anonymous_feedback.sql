-- P1-08a review finding 1: hr_about no longer carries who wrote colleague feedback.
-- The hr screens show colleague feedback to the appraisee without names
-- (api/performance.ts); the export must not undo that. The writer's own export
-- still carries the row, through the foreign key from_user_id.
--
-- Rollback: re-run the CREATE OR REPLACE VIEW of 0012_dpdp_subject.sql.

-- Pre-flight: 0012 created the view.
DO $$
BEGIN
  IF to_regclass('dpdp_subject.hr_about') IS NULL THEN
    RAISE EXCEPTION 'hr migration 0012 (dpdp_subject) must be applied first';
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
  SELECT s.user_id, 'hr_appraisal_feedback'::text, to_jsonb(t) - 'from_user_id'
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
