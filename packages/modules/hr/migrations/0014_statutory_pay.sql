-- P1-06a (ACC-16): what statutory pay needs to know and what it leaves on a
-- payslip. Nothing changes for an institution until it sets
-- hr_payroll_settings.statutory_from.
--
-- Rollback: a later migration dropping hr_pt_slabs, the added columns and the
-- hr_wage_class type. Payslip statutory records and staff identifiers are
-- records: export them first (select id, statutory, employer_cost_paise from
-- hr_payslips where statutory is not null; select id, pan, uan, esi_number,
-- bank_account, bank_ifsc, work_state from hr_staff). Preferred, per decision
-- 162: restore the pre-upgrade backup with hr 0.9.0, which reads none of them.

DO $$
BEGIN
  IF to_regclass('public.hr_payroll_settings') IS NULL THEN
    RAISE EXCEPTION 'hr 0014 needs hr 0011 (hr_payroll_settings)' USING ERRCODE = 'undefined_table';
  END IF;
END
$$;
--> statement-breakpoint
CREATE TYPE "public"."hr_wage_class" AS ENUM('wage', 'excluded', 'outside');--> statement-breakpoint
ALTER TABLE "hr_salary_structure_lines" ADD COLUMN "wage_class" "hr_wage_class" DEFAULT 'wage' NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_pay_components" ADD COLUMN "wage_class" "hr_wage_class" DEFAULT 'wage' NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_staff" ADD COLUMN "pan" text;--> statement-breakpoint
ALTER TABLE "hr_staff" ADD COLUMN "uan" text;--> statement-breakpoint
ALTER TABLE "hr_staff" ADD COLUMN "esi_number" text;--> statement-breakpoint
ALTER TABLE "hr_staff" ADD COLUMN "bank_account" text;--> statement-breakpoint
ALTER TABLE "hr_staff" ADD COLUMN "bank_ifsc" text;--> statement-breakpoint
ALTER TABLE "hr_staff" ADD COLUMN "work_state" text;--> statement-breakpoint
ALTER TABLE "hr_staff" ADD COLUMN "pf_member" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_staff" ADD COLUMN "pf_on_actual" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_staff" ADD COLUMN "eps_excluded" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_staff" ADD COLUMN "esi_exempt" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_staff" ADD CONSTRAINT "hr_staff_pan" CHECK (pan is null or pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$');--> statement-breakpoint
ALTER TABLE "hr_staff" ADD CONSTRAINT "hr_staff_uan" CHECK (uan is null or uan ~ '^[0-9]{12}$');--> statement-breakpoint
ALTER TABLE "hr_staff" ADD CONSTRAINT "hr_staff_esi_number" CHECK (esi_number is null or esi_number ~ '^[0-9]{10}$');--> statement-breakpoint
ALTER TABLE "hr_staff" ADD CONSTRAINT "hr_staff_bank_account" CHECK (bank_account is null or bank_account ~ '^[0-9]{9,18}$');--> statement-breakpoint
ALTER TABLE "hr_staff" ADD CONSTRAINT "hr_staff_bank_ifsc" CHECK (bank_ifsc is null or bank_ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$');--> statement-breakpoint
ALTER TABLE "hr_staff" ADD CONSTRAINT "hr_staff_work_state" CHECK (work_state is null or work_state ~ '^[A-Z]{2}$');--> statement-breakpoint
ALTER TABLE "hr_payroll_settings" ADD COLUMN "statutory_from" date;--> statement-breakpoint
ALTER TABLE "hr_payroll_settings" ADD COLUMN "pf_registered" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_payroll_settings" ADD COLUMN "esi_registered" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_payroll_settings" ADD CONSTRAINT "hr_payroll_settings_statutory_from" CHECK (statutory_from is null or extract(day from statutory_from) = 1);--> statement-breakpoint
ALTER TABLE "hr_payslips" ADD COLUMN "statutory" jsonb;--> statement-breakpoint
ALTER TABLE "hr_payslips" ADD COLUMN "employer_cost_paise" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_payslips" ADD CONSTRAINT "hr_payslips_employer_cost" CHECK (employer_cost_paise >= 0);--> statement-breakpoint
CREATE TABLE "hr_pt_slabs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"state" text NOT NULL,
	"effective_from" date NOT NULL,
	"from_paise" bigint NOT NULL,
	"to_paise" bigint,
	"amount_paise" bigint NOT NULL,
	"february_paise" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hr_pt_slabs_state" CHECK (state ~ '^[A-Z]{2}$'),
	CONSTRAINT "hr_pt_slabs_effective_from" CHECK (extract(day from effective_from) = 1),
	CONSTRAINT "hr_pt_slabs_from" CHECK (from_paise >= 0),
	CONSTRAINT "hr_pt_slabs_to" CHECK (to_paise is null or to_paise >= from_paise),
	CONSTRAINT "hr_pt_slabs_amount" CHECK (amount_paise >= 0 and (february_paise is null or february_paise >= 0))
);
--> statement-breakpoint
ALTER TABLE "hr_pt_slabs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hr_pt_slabs" ADD CONSTRAINT "hr_pt_slabs_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hr_pt_slabs_once" ON "hr_pt_slabs" USING btree ("institution_id","state","effective_from","from_paise");--> statement-breakpoint
CREATE POLICY "hr_pt_slabs_tenant_isolation" ON "hr_pt_slabs" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
