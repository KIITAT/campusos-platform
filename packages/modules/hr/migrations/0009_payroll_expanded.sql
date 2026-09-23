-- Payroll, expanded: salary structures, income tax as the institution enters
-- it, gratuity, salary held back, and a record of each payroll run.
--
-- This deepens what feeds a payslip; the posting to the books is unchanged.
-- Tax slabs and gratuity figures are data, not defaults: nothing statutory is
-- seeded, because a stale rate shipped as a default computes wrong salaries
-- without anybody noticing.

CREATE TYPE "public"."hr_structure_calc" AS ENUM('base', 'fixed', 'percent_of');--> statement-breakpoint
CREATE TABLE "hr_payroll_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"period" date NOT NULL,
	"generated" smallint NOT NULL,
	"skipped" smallint NOT NULL,
	"gross_paise" bigint NOT NULL,
	"net_paise" bigint NOT NULL,
	"run_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hr_payroll_runs_period_start" CHECK (extract(day from period) = 1)
);
--> statement-breakpoint
ALTER TABLE "hr_payroll_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hr_salary_structures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hr_salary_structures_code_shape" CHECK (length(trim(code)) > 0)
);
--> statement-breakpoint
ALTER TABLE "hr_salary_structures" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hr_salary_structure_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"structure_id" uuid NOT NULL,
	"seq" smallint NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"kind" "hr_component_kind" NOT NULL,
	"calc" "hr_structure_calc" NOT NULL,
	"amount_paise" bigint,
	"percent_bp" smallint,
	"of" text,
	"taxable" boolean DEFAULT true NOT NULL,
	CONSTRAINT "hr_salary_structure_lines_calc" CHECK ((calc = 'base' and amount_paise is null and percent_bp is null and of is null)
          or (calc = 'fixed' and amount_paise > 0 and percent_bp is null and of is null)
          or (calc = 'percent_of' and amount_paise is null and percent_bp between 1 and 10000 and of is not null))
);
--> statement-breakpoint
ALTER TABLE "hr_salary_structure_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hr_salary_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"structure_id" uuid NOT NULL,
	"base_paise" bigint NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hr_salary_assignments_base" CHECK (base_paise > 0),
	CONSTRAINT "hr_salary_assignments_dates" CHECK (effective_to is null or effective_to >= effective_from)
);
--> statement-breakpoint
ALTER TABLE "hr_salary_assignments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hr_tax_regimes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"year_starts_month" smallint DEFAULT 4 NOT NULL,
	"standard_deduction_paise" bigint DEFAULT 0 NOT NULL,
	"cess_bp" smallint DEFAULT 0 NOT NULL,
	"rebate_up_to_paise" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hr_tax_regimes_month" CHECK (year_starts_month between 1 and 12),
	CONSTRAINT "hr_tax_regimes_cess" CHECK (cess_bp between 0 and 5000),
	CONSTRAINT "hr_tax_regimes_deduction" CHECK (standard_deduction_paise >= 0)
);
--> statement-breakpoint
ALTER TABLE "hr_tax_regimes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hr_tax_slabs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"regime_id" uuid NOT NULL,
	"from_paise" bigint NOT NULL,
	"to_paise" bigint,
	"rate_bp" smallint NOT NULL,
	CONSTRAINT "hr_tax_slabs_range" CHECK (to_paise is null or to_paise > from_paise),
	CONSTRAINT "hr_tax_slabs_rate" CHECK (rate_bp between 0 and 10000)
);
--> statement-breakpoint
ALTER TABLE "hr_tax_slabs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hr_tax_elections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"regime_id" uuid NOT NULL,
	"tax_year" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hr_tax_elections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hr_gratuity_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"min_service_years" smallint NOT NULL,
	"days_per_year" smallint NOT NULL,
	"divisor_days" smallint NOT NULL,
	"wage_codes" text[] NOT NULL,
	"round_up_months" smallint,
	"max_paise" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hr_gratuity_rules_service" CHECK (min_service_years between 0 and 50),
	CONSTRAINT "hr_gratuity_rules_days" CHECK (days_per_year between 1 and 366 and divisor_days between 1 and 31),
	CONSTRAINT "hr_gratuity_rules_wage" CHECK (cardinality(wage_codes) > 0),
	CONSTRAINT "hr_gratuity_rules_round" CHECK (round_up_months is null or round_up_months between 1 and 11)
);
--> statement-breakpoint
ALTER TABLE "hr_gratuity_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hr_gratuity_payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"service_years" smallint NOT NULL,
	"monthly_wage_paise" bigint NOT NULL,
	"amount_paise" bigint NOT NULL,
	"paid_on" date NOT NULL,
	"paid_from" text DEFAULT 'bank' NOT NULL,
	"paid_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hr_gratuity_payouts_amount" CHECK (amount_paise > 0),
	CONSTRAINT "hr_gratuity_payouts_route" CHECK (paid_from in ('bank', 'cash'))
);
--> statement-breakpoint
ALTER TABLE "hr_gratuity_payouts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hr_salary_withholdings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"from_period" date NOT NULL,
	"reason" text NOT NULL,
	"lifted_at" timestamp with time zone,
	"lifted_by" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hr_salary_withholdings_reason" CHECK (length(trim(reason)) >= 5),
	CONSTRAINT "hr_salary_withholdings_period" CHECK (extract(day from from_period) = 1)
);
--> statement-breakpoint
ALTER TABLE "hr_salary_withholdings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hr_payroll_runs" ADD CONSTRAINT "hr_payroll_runs_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_payroll_runs" ADD CONSTRAINT "hr_payroll_runs_run_by_users_id_fk" FOREIGN KEY ("run_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_salary_structures" ADD CONSTRAINT "hr_salary_structures_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_salary_structure_lines" ADD CONSTRAINT "hr_salary_structure_lines_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_salary_structure_lines" ADD CONSTRAINT "hr_salary_structure_lines_structure_id_hr_salary_structures_id_fk" FOREIGN KEY ("structure_id") REFERENCES "public"."hr_salary_structures"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_salary_assignments" ADD CONSTRAINT "hr_salary_assignments_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_salary_assignments" ADD CONSTRAINT "hr_salary_assignments_staff_id_hr_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."hr_staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_salary_assignments" ADD CONSTRAINT "hr_salary_assignments_structure_id_hr_salary_structures_id_fk" FOREIGN KEY ("structure_id") REFERENCES "public"."hr_salary_structures"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_tax_regimes" ADD CONSTRAINT "hr_tax_regimes_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_tax_slabs" ADD CONSTRAINT "hr_tax_slabs_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_tax_slabs" ADD CONSTRAINT "hr_tax_slabs_regime_id_hr_tax_regimes_id_fk" FOREIGN KEY ("regime_id") REFERENCES "public"."hr_tax_regimes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_tax_elections" ADD CONSTRAINT "hr_tax_elections_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_tax_elections" ADD CONSTRAINT "hr_tax_elections_staff_id_hr_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."hr_staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_tax_elections" ADD CONSTRAINT "hr_tax_elections_regime_id_hr_tax_regimes_id_fk" FOREIGN KEY ("regime_id") REFERENCES "public"."hr_tax_regimes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_gratuity_rules" ADD CONSTRAINT "hr_gratuity_rules_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_gratuity_payouts" ADD CONSTRAINT "hr_gratuity_payouts_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_gratuity_payouts" ADD CONSTRAINT "hr_gratuity_payouts_staff_id_hr_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."hr_staff"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_gratuity_payouts" ADD CONSTRAINT "hr_gratuity_payouts_rule_id_hr_gratuity_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."hr_gratuity_rules"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_gratuity_payouts" ADD CONSTRAINT "hr_gratuity_payouts_paid_by_users_id_fk" FOREIGN KEY ("paid_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_salary_withholdings" ADD CONSTRAINT "hr_salary_withholdings_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_salary_withholdings" ADD CONSTRAINT "hr_salary_withholdings_staff_id_hr_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."hr_staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_salary_withholdings" ADD CONSTRAINT "hr_salary_withholdings_lifted_by_users_id_fk" FOREIGN KEY ("lifted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_salary_withholdings" ADD CONSTRAINT "hr_salary_withholdings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hr_payroll_runs_period" ON "hr_payroll_runs" USING btree ("institution_id","period");--> statement-breakpoint
CREATE UNIQUE INDEX "hr_salary_structures_code" ON "hr_salary_structures" USING btree ("institution_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "hr_salary_structure_lines_code" ON "hr_salary_structure_lines" USING btree ("structure_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "hr_salary_structure_lines_seq" ON "hr_salary_structure_lines" USING btree ("structure_id","seq");--> statement-breakpoint
CREATE INDEX "hr_salary_assignments_staff" ON "hr_salary_assignments" USING btree ("staff_id","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "hr_tax_regimes_code" ON "hr_tax_regimes" USING btree ("institution_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "hr_tax_slabs_from" ON "hr_tax_slabs" USING btree ("regime_id","from_paise");--> statement-breakpoint
CREATE UNIQUE INDEX "hr_tax_elections_once" ON "hr_tax_elections" USING btree ("staff_id","tax_year");--> statement-breakpoint
CREATE UNIQUE INDEX "hr_gratuity_rules_code" ON "hr_gratuity_rules" USING btree ("institution_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "hr_gratuity_payouts_once" ON "hr_gratuity_payouts" USING btree ("staff_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hr_salary_withholdings_open" ON "hr_salary_withholdings" USING btree ("staff_id") WHERE lifted_at is null;--> statement-breakpoint
CREATE POLICY "hr_payroll_runs_tenant_isolation" ON "hr_payroll_runs" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hr_salary_structures_tenant_isolation" ON "hr_salary_structures" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hr_salary_structure_lines_tenant_isolation" ON "hr_salary_structure_lines" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hr_salary_assignments_tenant_isolation" ON "hr_salary_assignments" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hr_tax_regimes_tenant_isolation" ON "hr_tax_regimes" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hr_tax_slabs_tenant_isolation" ON "hr_tax_slabs" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hr_tax_elections_tenant_isolation" ON "hr_tax_elections" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hr_gratuity_rules_tenant_isolation" ON "hr_gratuity_rules" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hr_gratuity_payouts_tenant_isolation" ON "hr_gratuity_payouts" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hr_salary_withholdings_tenant_isolation" ON "hr_salary_withholdings" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
--> statement-breakpoint

-- Payslips learn which run made them, and whether they are held back ---------
ALTER TABLE "hr_payslips" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "hr_payslips" ADD COLUMN "withheld" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_payslips" ADD COLUMN "released_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hr_payslips" ADD CONSTRAINT "hr_payslips_run_fk" FOREIGN KEY ("run_id") REFERENCES "public"."hr_payroll_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_payslips" ADD CONSTRAINT "hr_payslips_released" CHECK (released_at is null or withheld);--> statement-breakpoint

-- One structure at a time: "what was their basic in March" has one answer.
ALTER TABLE "hr_salary_assignments"
  ADD CONSTRAINT hr_salary_assignments_no_overlap
  EXCLUDE USING gist (
    staff_id WITH =,
    daterange(effective_from, effective_to, '[]') WITH &&
  );
--> statement-breakpoint

-- Slabs in a regime do not overlap: a rupee of income is taxed at one rate.
ALTER TABLE "hr_tax_slabs"
  ADD CONSTRAINT hr_tax_slabs_no_overlap
  EXCLUDE USING gist (
    regime_id WITH =,
    int8range(from_paise, to_paise, '[)') WITH &&
  );
--> statement-breakpoint

-- The payment run pays what is not held back ---------------------------------
--
-- Withheld payslips accrue their salary in the month as ever; they are left out
-- of the run and released, one by one, with a reason, later.
CREATE OR REPLACE FUNCTION hr_salary_payment_matches_payroll() RETURNS trigger AS $$
DECLARE
  owed bigint;
BEGIN
  SELECT COALESCE(sum(p.net_paise), 0) INTO owed
    FROM hr_payslips p
   WHERE p.institution_id = NEW.institution_id
     AND p.period = NEW.period
     AND NOT p.withheld;

  IF owed = 0 THEN
    RAISE EXCEPTION 'no payroll has been generated for %', NEW.period
      USING ERRCODE = 'check_violation',
            HINT = 'generate the payslips first; paying accrues nothing on its own';
  END IF;

  IF NEW.amount_paise <> owed THEN
    RAISE EXCEPTION 'salaries for % come to %, not %', NEW.period, owed, NEW.amount_paise
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- A gratuity is paid to somebody whose employment has ended --------------------
CREATE OR REPLACE FUNCTION hr_gratuity_after_leaving() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM hr_staff s WHERE s.id = NEW.staff_id AND s.left_on IS NOT NULL) THEN
    RAISE EXCEPTION 'gratuity is paid when an employment ends'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER hr_gratuity_after_leaving
  BEFORE INSERT ON "hr_gratuity_payouts"
  FOR EACH ROW EXECUTE FUNCTION hr_gratuity_after_leaving();
