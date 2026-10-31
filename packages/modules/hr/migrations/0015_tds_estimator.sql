-- P1-06b (ACC-17): what the TDS estimator needs. Nothing changes for an
-- institution until statutory pay is on for a month (hr_payroll_settings.statutory_from).
--
-- Rollback: a later migration dropping hr_tax_previous_employment,
-- hr_tax_declarations, hr_tax_surcharges, the hr_tax_head type, the added
-- columns and the constraint. Export the declarations and previous employment
-- first (they are Form 12BB and 12B records). Preferred: restore the
-- pre-upgrade backup with hr at the previous version, which reads none of them.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'hr_payslips' AND column_name = 'statutory') THEN
    RAISE EXCEPTION 'hr tds estimator needs hr 0014 (statutory pay)' USING ERRCODE = 'undefined_column';
  END IF;
END
$$;
--> statement-breakpoint
CREATE TYPE "public"."hr_tax_head" AS ENUM('80c', '80ccd_1b', '80d', '24b', 'other', 'rent');--> statement-breakpoint
ALTER TABLE "hr_tax_regimes" ADD COLUMN "rebate_max_paise" bigint;--> statement-breakpoint
ALTER TABLE "hr_tax_regimes" ADD COLUMN "rebate_marginal_relief" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_tax_regimes" ADD COLUMN "allows_deductions" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_tax_regimes" ADD CONSTRAINT "hr_tax_regimes_rebate_max" CHECK (rebate_max_paise is null or rebate_max_paise >= 0);--> statement-breakpoint
ALTER TABLE "hr_payroll_settings" ADD COLUMN "default_regime_id" uuid;--> statement-breakpoint
ALTER TABLE "hr_payroll_settings" ADD CONSTRAINT "hr_payroll_settings_default_regime_id_hr_tax_regimes_id_fk" FOREIGN KEY ("default_regime_id") REFERENCES "public"."hr_tax_regimes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_payslips" ADD COLUMN "tax" jsonb;--> statement-breakpoint
CREATE TABLE "hr_tax_surcharges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"regime_id" uuid NOT NULL,
	"above_paise" bigint NOT NULL,
	"rate_bp" smallint NOT NULL,
	CONSTRAINT "hr_tax_surcharges_above" CHECK (above_paise > 0),
	CONSTRAINT "hr_tax_surcharges_rate" CHECK (rate_bp between 0 and 10000)
);
--> statement-breakpoint
CREATE TABLE "hr_tax_declarations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"tax_year" smallint NOT NULL,
	"head" "hr_tax_head" NOT NULL,
	"declared_paise" bigint NOT NULL,
	"proved_paise" bigint,
	"metro" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hr_tax_declarations_year" CHECK (tax_year between 2000 and 2100),
	CONSTRAINT "hr_tax_declarations_amounts" CHECK (declared_paise >= 0 and (proved_paise is null or proved_paise >= 0))
);
--> statement-breakpoint
CREATE TABLE "hr_tax_previous_employment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"tax_year" smallint NOT NULL,
	"income_paise" bigint NOT NULL,
	"tds_paise" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hr_tax_previous_year" CHECK (tax_year between 2000 and 2100),
	CONSTRAINT "hr_tax_previous_amounts" CHECK (income_paise >= 0 and tds_paise >= 0)
);
--> statement-breakpoint
ALTER TABLE "hr_tax_surcharges" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hr_tax_declarations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hr_tax_previous_employment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hr_tax_surcharges" ADD CONSTRAINT "hr_tax_surcharges_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_tax_surcharges" ADD CONSTRAINT "hr_tax_surcharges_regime_id_hr_tax_regimes_id_fk" FOREIGN KEY ("regime_id") REFERENCES "public"."hr_tax_regimes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_tax_declarations" ADD CONSTRAINT "hr_tax_declarations_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_tax_declarations" ADD CONSTRAINT "hr_tax_declarations_staff_id_hr_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."hr_staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_tax_previous_employment" ADD CONSTRAINT "hr_tax_previous_employment_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_tax_previous_employment" ADD CONSTRAINT "hr_tax_previous_employment_staff_id_hr_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."hr_staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hr_tax_surcharges_once" ON "hr_tax_surcharges" USING btree ("regime_id","above_paise");--> statement-breakpoint
CREATE UNIQUE INDEX "hr_tax_declarations_once" ON "hr_tax_declarations" USING btree ("staff_id","tax_year","head");--> statement-breakpoint
CREATE UNIQUE INDEX "hr_tax_previous_once" ON "hr_tax_previous_employment" USING btree ("staff_id","tax_year");--> statement-breakpoint
CREATE POLICY "hr_tax_surcharges_tenant_isolation" ON "hr_tax_surcharges" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hr_tax_declarations_tenant_isolation" ON "hr_tax_declarations" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hr_tax_previous_employment_tenant_isolation" ON "hr_tax_previous_employment" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
