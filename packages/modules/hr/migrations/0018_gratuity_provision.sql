-- P1-06d (ACC-29): gratuity valued as a provision at month ends, with the
-- working per person for the accrued method; hr_about gains the lines.
-- Nothing changes for an institution until it records a valuation.
--
-- Rollback: a later migration dropping hr_gratuity_valuation_lines,
-- hr_gratuity_valuations and hr_gratuity_valuation_append_only(), and
-- restoring the hr_about of 0017. Both tables are records: export them first
-- (select * from hr_gratuity_valuations; select * from
-- hr_gratuity_valuation_lines). Preferred, per decision 162: restore the
-- pre-upgrade backup with the previous hr, which reads neither.

DO $$
BEGIN
  IF to_regclass('public.hr_gratuity_rules') IS NULL OR to_regclass('public.hr_payslip_reissues') IS NULL THEN
    RAISE EXCEPTION 'hr 0018 needs hr 0017' USING ERRCODE = 'undefined_table';
  END IF;
END
$$;
--> statement-breakpoint
CREATE TABLE "hr_gratuity_valuations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"as_of" date NOT NULL,
	"method" text NOT NULL,
	"rule_id" uuid REFERENCES "hr_gratuity_rules"("id") ON DELETE restrict,
	"obligation_paise" bigint NOT NULL,
	"provision_before_paise" bigint NOT NULL,
	"adjustment_paise" bigint NOT NULL,
	"reference" text,
	"valued_by" text REFERENCES "users"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hr_gratuity_valuations_method" CHECK (method in ('accrued', 'actuarial')),
	CONSTRAINT "hr_gratuity_valuations_month_end" CHECK (as_of = (date_trunc('month', as_of) + interval '1 month - 1 day')::date),
	CONSTRAINT "hr_gratuity_valuations_obligation" CHECK (obligation_paise >= 0),
	CONSTRAINT "hr_gratuity_valuations_sum" CHECK (adjustment_paise = obligation_paise - provision_before_paise),
	CONSTRAINT "hr_gratuity_valuations_basis" CHECK ((method = 'accrued' and rule_id is not null) or (method = 'actuarial' and rule_id is null and coalesce(length(trim(reference)) between 3 and 200, false)))
);
--> statement-breakpoint
ALTER TABLE "hr_gratuity_valuations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hr_gratuity_valuations" ADD CONSTRAINT "hr_gratuity_valuations_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hr_gratuity_valuations_as_of" ON "hr_gratuity_valuations" USING btree ("institution_id","as_of");--> statement-breakpoint
CREATE POLICY "hr_gratuity_valuations_tenant_isolation" ON "hr_gratuity_valuations" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE TABLE "hr_gratuity_valuation_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"valuation_id" uuid NOT NULL REFERENCES "hr_gratuity_valuations"("id") ON DELETE cascade,
	"staff_id" uuid NOT NULL,
	"left_on" date,
	"service_years" smallint NOT NULL,
	"monthly_wage_paise" bigint NOT NULL,
	"amount_paise" bigint NOT NULL,
	CONSTRAINT "hr_gratuity_valuation_lines_figures" CHECK (service_years >= 0 and monthly_wage_paise >= 0 and amount_paise >= 0)
);
--> statement-breakpoint
ALTER TABLE "hr_gratuity_valuation_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hr_gratuity_valuation_lines" ADD CONSTRAINT "hr_gratuity_valuation_lines_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_gratuity_valuation_lines" ADD CONSTRAINT "hr_gratuity_valuation_lines_staff_id_hr_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."hr_staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hr_gratuity_valuation_lines_once" ON "hr_gratuity_valuation_lines" USING btree ("valuation_id","staff_id");--> statement-breakpoint
CREATE INDEX "hr_gratuity_valuation_lines_staff" ON "hr_gratuity_valuation_lines" USING btree ("staff_id");--> statement-breakpoint
CREATE POLICY "hr_gratuity_valuation_lines_tenant_isolation" ON "hr_gratuity_valuation_lines" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE OR REPLACE FUNCTION hr_gratuity_valuation_append_only() RETURNS trigger AS $$
BEGIN
  -- An institution being offboarded deletes these by cascade.
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'a gratuity valuation cannot be changed' USING ERRCODE = 'check_violation',
    HINT = 'value the provision again as at the same date; the new valuation trues it up';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER hr_gratuity_valuation_append_only BEFORE UPDATE OR DELETE ON "hr_gratuity_valuations" FOR EACH ROW EXECUTE FUNCTION hr_gratuity_valuation_append_only();
--> statement-breakpoint
CREATE TRIGGER hr_gratuity_valuation_line_append_only BEFORE UPDATE OR DELETE ON "hr_gratuity_valuation_lines" FOR EACH ROW EXECUTE FUNCTION hr_gratuity_valuation_append_only();
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
    FROM public.hr_onboarding_activities t JOIN public.hr_onboardings p ON p.id = t.onboarding_id JOIN public.hr_staff s ON s.id = p.staff_id WHERE s.user_id IS NOT NULL
  UNION ALL
  SELECT s.user_id, 'hr_payslip_reissues'::text, to_jsonb(t)
    FROM public.hr_payslip_reissues t JOIN public.hr_staff s ON s.id = t.staff_id WHERE s.user_id IS NOT NULL
  UNION ALL
  SELECT s.user_id, 'hr_tax_declarations'::text, to_jsonb(t)
    FROM public.hr_tax_declarations t JOIN public.hr_staff s ON s.id = t.staff_id WHERE s.user_id IS NOT NULL
  UNION ALL
  SELECT s.user_id, 'hr_tax_previous_employment'::text, to_jsonb(t)
    FROM public.hr_tax_previous_employment t JOIN public.hr_staff s ON s.id = t.staff_id WHERE s.user_id IS NOT NULL
  UNION ALL
  SELECT s.user_id, 'hr_gratuity_valuation_lines'::text, to_jsonb(t)
    FROM public.hr_gratuity_valuation_lines t JOIN public.hr_staff s ON s.id = t.staff_id WHERE s.user_id IS NOT NULL;
--> statement-breakpoint
GRANT SELECT ON dpdp_subject.hr_about TO campusos_app;
