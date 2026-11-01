-- P1-06c (UX-06, ACC-24, ACC-17, NEW-50, NEW-55): remittances of statutory
-- payables, the archive of reissued payslips, and hr_about gains the tax
-- tables. Nothing changes for an institution until it records one.
--
-- Rollback: a later migration dropping hr_payslip_reissues and hr_remittances
-- and restoring the hr_about of 0013. Both tables are records: export them
-- first (select * from hr_remittances; select * from hr_payslip_reissues).
-- Preferred, per decision 162: restore the pre-upgrade backup with hr 0.12.0,
-- which reads neither.

DO $$
BEGIN
  IF to_regclass('public.hr_payslips') IS NULL OR to_regnamespace('dpdp_subject') IS NULL THEN
    RAISE EXCEPTION 'hr 0017 needs hr 0016 and core 0012 (dpdp_subject)' USING ERRCODE = 'undefined_table';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'hr_payslips' AND column_name = 'tax') THEN
    RAISE EXCEPTION 'hr 0017 needs hr 0015 (tds estimator)' USING ERRCODE = 'undefined_column';
  END IF;
END
$$;
--> statement-breakpoint
CREATE TABLE "hr_remittances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"head" text NOT NULL,
	"period" date NOT NULL,
	"state" text,
	"amount_paise" bigint NOT NULL,
	"paid_on" date NOT NULL,
	"paid_from" text NOT NULL,
	"challan_ref" text NOT NULL,
	"bsr_code" text,
	"challan_serial" text,
	"note" text,
	"remitted_by" text REFERENCES "users"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" text REFERENCES "users"("id") ON DELETE set null,
	"void_reason" text,
	CONSTRAINT "hr_remittances_head" CHECK (head in ('pf', 'esi', 'pt', 'tds')),
	CONSTRAINT "hr_remittances_period" CHECK (extract(day from period) = 1),
	CONSTRAINT "hr_remittances_amount" CHECK (amount_paise > 0),
	CONSTRAINT "hr_remittances_route" CHECK (paid_from in ('bank', 'cash')),
	CONSTRAINT "hr_remittances_state_rule" CHECK ((head = 'pt') = (state is not null)),
	CONSTRAINT "hr_remittances_tds_challan" CHECK (head <> 'tds' or (coalesce(bsr_code ~ '^[0-9]{7}$', false) and coalesce(challan_serial ~ '^[0-9]{5}$', false))),
	CONSTRAINT "hr_remittances_challan_ref" CHECK (length(trim(challan_ref)) between 1 and 40),
	CONSTRAINT "hr_remittances_void" CHECK ((voided_at is null and void_reason is null and voided_by is null) or (voided_at is not null and void_reason is not null))
);
--> statement-breakpoint
ALTER TABLE "hr_remittances" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hr_remittances" ADD CONSTRAINT "hr_remittances_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hr_remittances_period" ON "hr_remittances" USING btree ("institution_id","period","head");--> statement-breakpoint
CREATE UNIQUE INDEX "hr_remittances_challan_once" ON "hr_remittances" USING btree ("institution_id","head","challan_ref") WHERE voided_at is null;--> statement-breakpoint
CREATE POLICY "hr_remittances_tenant_isolation" ON "hr_remittances" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE OR REPLACE FUNCTION hr_remittance_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'a remittance cannot be deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.voided_at IS NOT NULL
     OR NEW.voided_at IS NULL
     OR (to_jsonb(NEW) - 'voided_at' - 'voided_by' - 'void_reason') IS DISTINCT FROM (to_jsonb(OLD) - 'voided_at' - 'voided_by' - 'void_reason') THEN
    RAISE EXCEPTION 'a remittance cannot be changed' USING ERRCODE = 'check_violation',
      HINT = 'void it with a reason and enter it again';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER hr_remittance_guard BEFORE UPDATE OR DELETE ON "hr_remittances" FOR EACH ROW EXECUTE FUNCTION hr_remittance_guard();
--> statement-breakpoint
CREATE TABLE "hr_payslip_reissues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"period" date NOT NULL,
	"original_id" uuid NOT NULL,
	"snapshot" jsonb NOT NULL,
	"reason" text NOT NULL,
	"reversal_entry_id" uuid,
	"replacement_id" uuid,
	"reissued_by" text REFERENCES "users"("id") ON DELETE set null,
	"reissued_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hr_payslip_reissues_period" CHECK (extract(day from period) = 1),
	CONSTRAINT "hr_payslip_reissues_reason" CHECK (length(trim(reason)) >= 5)
);
--> statement-breakpoint
ALTER TABLE "hr_payslip_reissues" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hr_payslip_reissues" ADD CONSTRAINT "hr_payslip_reissues_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_payslip_reissues" ADD CONSTRAINT "hr_payslip_reissues_staff_id_hr_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."hr_staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_payslip_reissues" ADD CONSTRAINT "hr_payslip_reissues_replacement_id_hr_payslips_id_fk" FOREIGN KEY ("replacement_id") REFERENCES "public"."hr_payslips"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hr_payslip_reissues_staff" ON "hr_payslip_reissues" USING btree ("staff_id","period");--> statement-breakpoint
CREATE POLICY "hr_payslip_reissues_tenant_isolation" ON "hr_payslip_reissues" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE OR REPLACE FUNCTION hr_payslip_reissue_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
  -- replacement_id goes to null when the replacement payslip is itself deleted (offboarding); nothing else changes.
  IF TG_OP = 'UPDATE' AND NEW.replacement_id IS NULL
     AND (to_jsonb(NEW) - 'replacement_id') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'replacement_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a reissue record cannot be changed' USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER hr_payslip_reissue_append_only BEFORE UPDATE OR DELETE ON "hr_payslip_reissues" FOR EACH ROW EXECUTE FUNCTION hr_payslip_reissue_append_only();
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
    FROM public.hr_tax_previous_employment t JOIN public.hr_staff s ON s.id = t.staff_id WHERE s.user_id IS NOT NULL;
--> statement-breakpoint
GRANT SELECT ON dpdp_subject.hr_about TO campusos_app;
