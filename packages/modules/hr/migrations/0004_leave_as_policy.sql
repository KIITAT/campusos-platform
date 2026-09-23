-- Leave as policy rather than as one number per leave type.
--
-- Until now a balance was the leave type's annual figure less what was taken,
-- the same for everybody. That is still what happens for an institution that
-- never defines a policy. What this adds is everything a real HR office asks
-- for next: different entitlements for different kinds of staff, days carried
-- into the new year, days earned by working a holiday, days paid out, and a
-- refusal to approve leave nobody has.

CREATE TYPE "public"."hr_allocation_source" AS ENUM('policy', 'carry_forward', 'compensatory', 'manual');--> statement-breakpoint

ALTER TABLE "hr_leave_types" ADD COLUMN "allow_negative" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_leave_types" ADD COLUMN "encashable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_leave_types" ADD COLUMN "encashment_components" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_leave_types" ADD COLUMN "max_carry_forward" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_leave_types" ADD COLUMN "compensatory" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_leave_types" ADD COLUMN "comp_off_validity_days" smallint;--> statement-breakpoint
ALTER TABLE "hr_leave_types" ADD CONSTRAINT "hr_leave_types_carry" CHECK (max_carry_forward between 0 and 365);--> statement-breakpoint
ALTER TABLE "hr_leave_types" ADD CONSTRAINT "hr_leave_types_validity" CHECK (comp_off_validity_days is null or comp_off_validity_days between 1 and 365);--> statement-breakpoint
-- A day's worth of what, exactly, is the institution's to say. An encashable
-- type that names no component would pay out nothing and look like it worked.
ALTER TABLE "hr_leave_types" ADD CONSTRAINT "hr_leave_types_encash_basis" CHECK (not encashable or cardinality(encashment_components) > 0);--> statement-breakpoint

CREATE TABLE "hr_leave_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"prorate_joiners" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hr_leave_policies_code_shape" CHECK (length(trim(code)) > 0)
);
--> statement-breakpoint
ALTER TABLE "hr_leave_policies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hr_leave_policies" ADD CONSTRAINT "hr_leave_policies_institution_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hr_leave_policies_code" ON "hr_leave_policies" USING btree ("institution_id","code");--> statement-breakpoint
CREATE POLICY "hr_leave_policies_tenant_isolation" ON "hr_leave_policies" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint

CREATE TABLE "hr_leave_policy_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"leave_type_id" uuid NOT NULL,
	"annual_days" smallint NOT NULL,
	CONSTRAINT "hr_leave_policy_lines_days" CHECK (annual_days between 1 and 365)
);
--> statement-breakpoint
ALTER TABLE "hr_leave_policy_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hr_leave_policy_lines" ADD CONSTRAINT "hr_leave_policy_lines_institution_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_leave_policy_lines" ADD CONSTRAINT "hr_leave_policy_lines_policy_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."hr_leave_policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_leave_policy_lines" ADD CONSTRAINT "hr_leave_policy_lines_type_fk" FOREIGN KEY ("leave_type_id") REFERENCES "public"."hr_leave_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hr_leave_policy_lines_once" ON "hr_leave_policy_lines" USING btree ("policy_id","leave_type_id");--> statement-breakpoint
CREATE POLICY "hr_leave_policy_lines_tenant_isolation" ON "hr_leave_policy_lines" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint

CREATE TABLE "hr_leave_policy_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hr_leave_policy_assignments_dates" CHECK (effective_to is null or effective_to >= effective_from)
);
--> statement-breakpoint
ALTER TABLE "hr_leave_policy_assignments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hr_leave_policy_assignments" ADD CONSTRAINT "hr_leave_policy_assignments_institution_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_leave_policy_assignments" ADD CONSTRAINT "hr_leave_policy_assignments_staff_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."hr_staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_leave_policy_assignments" ADD CONSTRAINT "hr_leave_policy_assignments_policy_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."hr_leave_policies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hr_leave_policy_assignments_staff" ON "hr_leave_policy_assignments" USING btree ("staff_id","effective_from");--> statement-breakpoint
CREATE POLICY "hr_leave_policy_assignments_tenant_isolation" ON "hr_leave_policy_assignments" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
-- One policy at a time: "which entitlement applied in March" has one answer.
ALTER TABLE "hr_leave_policy_assignments"
  ADD CONSTRAINT hr_leave_policy_assignments_no_overlap
  EXCLUDE USING gist (
    staff_id WITH =,
    daterange(effective_from, effective_to, '[]') WITH &&
  );
--> statement-breakpoint

CREATE TABLE "hr_leave_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"leave_type_id" uuid NOT NULL,
	"year" smallint NOT NULL,
	"days" smallint NOT NULL,
	"source" "hr_allocation_source" NOT NULL,
	"expires_on" date,
	"reason" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hr_leave_allocations_days" CHECK (days between 1 and 365),
	CONSTRAINT "hr_leave_allocations_year" CHECK (year between 2000 and 2100),
	CONSTRAINT "hr_leave_allocations_manual_reason" CHECK (source <> 'manual' or length(trim(coalesce(reason, ''))) >= 5)
);
--> statement-breakpoint
ALTER TABLE "hr_leave_allocations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hr_leave_allocations" ADD CONSTRAINT "hr_leave_allocations_institution_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_leave_allocations" ADD CONSTRAINT "hr_leave_allocations_staff_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."hr_staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_leave_allocations" ADD CONSTRAINT "hr_leave_allocations_type_fk" FOREIGN KEY ("leave_type_id") REFERENCES "public"."hr_leave_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_leave_allocations" ADD CONSTRAINT "hr_leave_allocations_created_by_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hr_leave_allocations_staff" ON "hr_leave_allocations" USING btree ("staff_id","year");--> statement-breakpoint
CREATE UNIQUE INDEX "hr_leave_allocations_once" ON "hr_leave_allocations" USING btree ("staff_id","leave_type_id","year","source") WHERE source in ('policy', 'carry_forward');--> statement-breakpoint
CREATE POLICY "hr_leave_allocations_tenant_isolation" ON "hr_leave_allocations" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint

CREATE TABLE "hr_comp_off_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"leave_type_id" uuid NOT NULL,
	"worked_on" date NOT NULL,
	"days" smallint DEFAULT 1 NOT NULL,
	"reason" text NOT NULL,
	"status" "hr_leave_status" DEFAULT 'pending' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"allocation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hr_comp_off_requests_days" CHECK (days between 1 and 2),
	CONSTRAINT "hr_comp_off_requests_reason" CHECK (length(trim(reason)) >= 5)
);
--> statement-breakpoint
ALTER TABLE "hr_comp_off_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hr_comp_off_requests" ADD CONSTRAINT "hr_comp_off_requests_institution_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_comp_off_requests" ADD CONSTRAINT "hr_comp_off_requests_staff_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."hr_staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_comp_off_requests" ADD CONSTRAINT "hr_comp_off_requests_type_fk" FOREIGN KEY ("leave_type_id") REFERENCES "public"."hr_leave_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_comp_off_requests" ADD CONSTRAINT "hr_comp_off_requests_decided_by_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_comp_off_requests" ADD CONSTRAINT "hr_comp_off_requests_allocation_fk" FOREIGN KEY ("allocation_id") REFERENCES "public"."hr_leave_allocations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hr_comp_off_requests_once" ON "hr_comp_off_requests" USING btree ("staff_id","worked_on");--> statement-breakpoint
CREATE INDEX "hr_comp_off_requests_pending" ON "hr_comp_off_requests" USING btree ("institution_id","status");--> statement-breakpoint
CREATE POLICY "hr_comp_off_requests_tenant_isolation" ON "hr_comp_off_requests" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint

CREATE TABLE "hr_leave_encashments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"leave_type_id" uuid NOT NULL,
	"year" smallint NOT NULL,
	"days" smallint NOT NULL,
	"period" date NOT NULL,
	"amount_paise" bigint DEFAULT 0 NOT NULL,
	"reason" text NOT NULL,
	"status" "hr_leave_status" DEFAULT 'pending' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"payslip_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hr_leave_encashments_days" CHECK (days between 1 and 365),
	CONSTRAINT "hr_leave_encashments_amount" CHECK (amount_paise >= 0),
	CONSTRAINT "hr_leave_encashments_period_start" CHECK (extract(day from period) = 1),
	CONSTRAINT "hr_leave_encashments_reason" CHECK (length(trim(reason)) >= 5)
);
--> statement-breakpoint
ALTER TABLE "hr_leave_encashments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hr_leave_encashments" ADD CONSTRAINT "hr_leave_encashments_institution_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_leave_encashments" ADD CONSTRAINT "hr_leave_encashments_staff_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."hr_staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_leave_encashments" ADD CONSTRAINT "hr_leave_encashments_type_fk" FOREIGN KEY ("leave_type_id") REFERENCES "public"."hr_leave_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_leave_encashments" ADD CONSTRAINT "hr_leave_encashments_decided_by_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_leave_encashments" ADD CONSTRAINT "hr_leave_encashments_payslip_fk" FOREIGN KEY ("payslip_id") REFERENCES "public"."hr_payslips"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hr_leave_encashments_staff" ON "hr_leave_encashments" USING btree ("staff_id","year");--> statement-breakpoint
CREATE INDEX "hr_leave_encashments_period" ON "hr_leave_encashments" USING btree ("institution_id","period","status");--> statement-breakpoint
CREATE POLICY "hr_leave_encashments_tenant_isolation" ON "hr_leave_encashments" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint

-- An encashment on a payslip is money somebody was handed ---------------------
--
-- Same rule as the payslip itself: once paid, its days and amount do not move
-- without an audited reason, and it cannot be withdrawn as if it never went out.
CREATE OR REPLACE FUNCTION hr_encashment_paid_stands() RETURNS trigger AS $$
BEGIN
  IF OLD.payslip_id IS NOT NULL
     AND (NEW.days IS DISTINCT FROM OLD.days
          OR NEW.amount_paise IS DISTINCT FROM OLD.amount_paise
          OR NEW.status IS DISTINCT FROM OLD.status)
     AND nullif(current_setting('app.audit_reason', true), '') IS NULL
  THEN
    RAISE EXCEPTION 'that encashment has been paid on a payslip'
      USING ERRCODE = 'check_violation',
            HINT = 'correct it on a later payslip, with a reason';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER hr_encashment_paid_stands
  BEFORE UPDATE ON "hr_leave_encashments"
  FOR EACH ROW EXECUTE FUNCTION hr_encashment_paid_stands();
--> statement-breakpoint

-- An allocation that leave has been drawn against is history -----------------
--
-- Deleting the block of leave somebody already used would leave their taken
-- days hanging off nothing, and their balance quietly negative.
CREATE OR REPLACE FUNCTION hr_allocation_no_delete() RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  IF nullif(current_setting('app.audit_reason', true), '') IS NULL THEN
    RAISE EXCEPTION 'a leave allocation is not deleted without an audited reason'
      USING ERRCODE = 'check_violation',
            HINT = 'allocate a correcting block, or delete with a reason';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER hr_allocation_no_delete
  BEFORE DELETE ON "hr_leave_allocations"
  FOR EACH ROW EXECUTE FUNCTION hr_allocation_no_delete();
