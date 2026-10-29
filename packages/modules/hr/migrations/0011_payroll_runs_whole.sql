-- P0-08: a payroll run that finishes, pays part months by the day, and
-- records what it could not deduct.
--
-- 1. hr_payslips_net_not_negative (ACC-14). A payslip's deductions now stop
--    at its gross; what is left over is arrears the person owes, kept in
--    hr_payroll_arrears. The old code clamped net to zero against
--    hr_payslips_net and so could not write a negative net; the pre-flight
--    expects none and stops, naming the count, if it finds any.
-- 2. hr_payroll_arrears, under RLS with the tenant policy as on every hr
--    table. A row goes with its payslip (which is deleted only with an audited
--    reason) and, like the payslip, keeps its staff record from being deleted.
-- 3. hr_payroll_settings (ACC-15): how a part month is paid, one row per
--    institution; no row means the calendar month.
-- 4. hr_payroll_runs.failures: who a run could not pay, and why.
--
-- Rollback: a later migration dropping the constraint, both tables and the
-- column. Arrears rows record money owed: export them first
-- (select * from hr_payroll_arrears). Preferred, per decision 162: restore the
-- pre-upgrade backup with hr 0.4.0, whose code reads none of them.

DO $$
DECLARE
  bad bigint;
BEGIN
  SELECT count(*) INTO bad FROM hr_payslips WHERE net_paise < 0;
  IF bad > 0 THEN
    RAISE EXCEPTION 'hr 0011: % payslip(s) have a negative net', bad
      USING ERRCODE = 'check_violation',
            HINT = 'Each is a document of record: correct it with an audited reason, then run the upgrade again.';
  END IF;
END
$$;
--> statement-breakpoint
ALTER TABLE "hr_payslips" ADD CONSTRAINT "hr_payslips_net_not_negative" CHECK (net_paise >= 0);--> statement-breakpoint
CREATE TABLE "hr_payroll_arrears" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"payslip_id" uuid NOT NULL,
	"period" date NOT NULL,
	"amount_paise" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hr_payroll_arrears_amount" CHECK (amount_paise > 0),
	CONSTRAINT "hr_payroll_arrears_period_start" CHECK (extract(day from period) = 1)
);
--> statement-breakpoint
ALTER TABLE "hr_payroll_arrears" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hr_payroll_arrears" ADD CONSTRAINT "hr_payroll_arrears_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_payroll_arrears" ADD CONSTRAINT "hr_payroll_arrears_staff_id_hr_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."hr_staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_payroll_arrears" ADD CONSTRAINT "hr_payroll_arrears_payslip_id_hr_payslips_id_fk" FOREIGN KEY ("payslip_id") REFERENCES "public"."hr_payslips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hr_payroll_arrears_once" ON "hr_payroll_arrears" USING btree ("payslip_id");--> statement-breakpoint
CREATE INDEX "hr_payroll_arrears_staff" ON "hr_payroll_arrears" USING btree ("institution_id","staff_id");--> statement-breakpoint
CREATE POLICY "hr_payroll_arrears_tenant_isolation" ON "hr_payroll_arrears" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE TABLE "hr_payroll_settings" (
	"institution_id" uuid PRIMARY KEY NOT NULL,
	"proration_basis" text DEFAULT 'calendar' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hr_payroll_settings_basis" CHECK (proration_basis in ('calendar', 'days_30', 'days_26'))
);
--> statement-breakpoint
ALTER TABLE "hr_payroll_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hr_payroll_settings" ADD CONSTRAINT "hr_payroll_settings_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "hr_payroll_settings_tenant_isolation" ON "hr_payroll_settings" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "hr_payroll_runs" ADD COLUMN "failures" jsonb DEFAULT '[]'::jsonb NOT NULL;
