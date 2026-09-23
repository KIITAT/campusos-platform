-- Expense claims and advances: money between the institution and its staff
-- outside payroll.
--
-- An advance stays the institution's money until it is accounted for -- by a
-- claim set against it, by deductions from pay, or by being handed back.
-- Every recovery is a row, the outstanding figure is computed from them, and
-- nothing recovers more than was paid out.

CREATE TYPE "public"."hr_claim_status" AS ENUM('submitted', 'approved', 'rejected', 'paid');--> statement-breakpoint
CREATE TYPE "public"."hr_advance_status" AS ENUM('requested', 'approved', 'rejected', 'paid', 'settled');--> statement-breakpoint
CREATE TYPE "public"."hr_recovery_source" AS ENUM('claim', 'payroll', 'cash');--> statement-breakpoint
CREATE TABLE "hr_expense_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"title" text NOT NULL,
	"status" "hr_claim_status" DEFAULT 'submitted' NOT NULL,
	"claimed_paise" bigint NOT NULL,
	"sanctioned_paise" bigint,
	"advance_applied_paise" bigint DEFAULT 0 NOT NULL,
	"paid_paise" bigint DEFAULT 0 NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"paid_on" date,
	"paid_from" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hr_expense_claims_title" CHECK (length(trim(title)) > 0),
	CONSTRAINT "hr_expense_claims_claimed" CHECK (claimed_paise > 0),
	CONSTRAINT "hr_expense_claims_sanctioned" CHECK (sanctioned_paise is null or sanctioned_paise between 0 and claimed_paise),
	CONSTRAINT "hr_expense_claims_settled" CHECK (status <> 'paid' or advance_applied_paise + paid_paise = sanctioned_paise),
	CONSTRAINT "hr_expense_claims_route" CHECK (paid_from is null or paid_from in ('bank', 'cash'))
);
--> statement-breakpoint
ALTER TABLE "hr_expense_claims" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hr_expense_claim_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"claim_id" uuid NOT NULL,
	"spent_on" date NOT NULL,
	"category" text NOT NULL,
	"description" text NOT NULL,
	"amount_paise" bigint NOT NULL,
	"sanctioned_paise" bigint,
	"receipt_ref" text,
	CONSTRAINT "hr_expense_claim_lines_amount" CHECK (amount_paise > 0),
	CONSTRAINT "hr_expense_claim_lines_sanctioned" CHECK (sanctioned_paise is null or sanctioned_paise between 0 and amount_paise)
);
--> statement-breakpoint
ALTER TABLE "hr_expense_claim_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hr_employee_advances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"amount_paise" bigint NOT NULL,
	"status" "hr_advance_status" DEFAULT 'requested' NOT NULL,
	"monthly_recovery_paise" bigint,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"paid_on" date,
	"paid_from" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hr_employee_advances_amount" CHECK (amount_paise > 0),
	CONSTRAINT "hr_employee_advances_purpose" CHECK (length(trim(purpose)) >= 5),
	CONSTRAINT "hr_employee_advances_monthly" CHECK (monthly_recovery_paise is null or monthly_recovery_paise between 1 and amount_paise),
	CONSTRAINT "hr_employee_advances_route" CHECK (paid_from is null or paid_from in ('bank', 'cash'))
);
--> statement-breakpoint
ALTER TABLE "hr_employee_advances" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hr_advance_recoveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"advance_id" uuid NOT NULL,
	"source" "hr_recovery_source" NOT NULL,
	"claim_id" uuid,
	"payslip_id" uuid,
	"amount_paise" bigint NOT NULL,
	"recovered_on" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hr_advance_recoveries_amount" CHECK (amount_paise > 0),
	CONSTRAINT "hr_advance_recoveries_source" CHECK ((source = 'claim') = (claim_id is not null) and (source = 'payroll') = (payslip_id is not null))
);
--> statement-breakpoint
ALTER TABLE "hr_advance_recoveries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hr_expense_claims" ADD CONSTRAINT "hr_expense_claims_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_expense_claims" ADD CONSTRAINT "hr_expense_claims_staff_id_hr_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."hr_staff"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_expense_claims" ADD CONSTRAINT "hr_expense_claims_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_expense_claims" ADD CONSTRAINT "hr_expense_claims_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_expense_claim_lines" ADD CONSTRAINT "hr_expense_claim_lines_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_expense_claim_lines" ADD CONSTRAINT "hr_expense_claim_lines_claim_id_hr_expense_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."hr_expense_claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_employee_advances" ADD CONSTRAINT "hr_employee_advances_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_employee_advances" ADD CONSTRAINT "hr_employee_advances_staff_id_hr_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."hr_staff"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_employee_advances" ADD CONSTRAINT "hr_employee_advances_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_employee_advances" ADD CONSTRAINT "hr_employee_advances_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_advance_recoveries" ADD CONSTRAINT "hr_advance_recoveries_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_advance_recoveries" ADD CONSTRAINT "hr_advance_recoveries_advance_id_hr_employee_advances_id_fk" FOREIGN KEY ("advance_id") REFERENCES "public"."hr_employee_advances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_advance_recoveries" ADD CONSTRAINT "hr_advance_recoveries_claim_id_hr_expense_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."hr_expense_claims"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_advance_recoveries" ADD CONSTRAINT "hr_advance_recoveries_payslip_id_hr_payslips_id_fk" FOREIGN KEY ("payslip_id") REFERENCES "public"."hr_payslips"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hr_expense_claims_staff" ON "hr_expense_claims" USING btree ("staff_id","status");--> statement-breakpoint
CREATE INDEX "hr_expense_claims_status" ON "hr_expense_claims" USING btree ("institution_id","status");--> statement-breakpoint
CREATE INDEX "hr_expense_claim_lines_claim" ON "hr_expense_claim_lines" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX "hr_employee_advances_staff" ON "hr_employee_advances" USING btree ("staff_id","status");--> statement-breakpoint
CREATE INDEX "hr_advance_recoveries_advance" ON "hr_advance_recoveries" USING btree ("advance_id");--> statement-breakpoint
CREATE POLICY "hr_expense_claims_tenant_isolation" ON "hr_expense_claims" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hr_expense_claim_lines_tenant_isolation" ON "hr_expense_claim_lines" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hr_employee_advances_tenant_isolation" ON "hr_employee_advances" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hr_advance_recoveries_tenant_isolation" ON "hr_advance_recoveries" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
--> statement-breakpoint

-- An advance is not recovered twice ------------------------------------------
--
-- Taking back more than was handed out would leave the advances account
-- negative and the person owed money nobody ever recorded owing them.
CREATE OR REPLACE FUNCTION hr_recovery_within_advance() RETURNS trigger AS $$
DECLARE
  handed bigint;
  back bigint;
  state hr_advance_status;
BEGIN
  SELECT a.amount_paise, a.status INTO handed, state
    FROM hr_employee_advances a WHERE a.id = NEW.advance_id FOR UPDATE;
  IF state NOT IN ('paid', 'settled') THEN
    RAISE EXCEPTION 'an advance that was never paid out has nothing to recover'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(sum(r.amount_paise), 0) INTO back
    FROM hr_advance_recoveries r WHERE r.advance_id = NEW.advance_id;
  IF back + NEW.amount_paise > handed THEN
    RAISE EXCEPTION 'that would recover % of an advance of %', back + NEW.amount_paise, handed
      USING ERRCODE = 'check_violation';
  END IF;
  -- Fully back is settled; the status follows the money rather than a button.
  IF back + NEW.amount_paise = handed THEN
    UPDATE hr_employee_advances SET status = 'settled' WHERE id = NEW.advance_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER hr_recovery_within_advance
  BEFORE INSERT ON "hr_advance_recoveries"
  FOR EACH ROW EXECUTE FUNCTION hr_recovery_within_advance();
--> statement-breakpoint

-- Recoveries are history -----------------------------------------------------
CREATE OR REPLACE FUNCTION hr_recovery_immutable() RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() > 1
     OR nullif(current_setting('app.audit_reason', true), '') IS NOT NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a recovery is money that came back; it is reversed, not edited'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER hr_recovery_immutable
  BEFORE UPDATE OR DELETE ON "hr_advance_recoveries"
  FOR EACH ROW EXECUTE FUNCTION hr_recovery_immutable();
--> statement-breakpoint

-- The claimed figure is the sum of its lines ---------------------------------
CREATE OR REPLACE FUNCTION hr_claim_totals() RETURNS trigger AS $$
DECLARE
  target uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN target := OLD.claim_id; ELSE target := NEW.claim_id; END IF;
  UPDATE hr_expense_claims c
     SET claimed_paise = s.claimed,
         sanctioned_paise = CASE WHEN s.unsanctioned = 0 THEN s.sanctioned ELSE c.sanctioned_paise END
    FROM (
      SELECT COALESCE(sum(l.amount_paise), 0) AS claimed,
             COALESCE(sum(l.sanctioned_paise), 0) AS sanctioned,
             count(*) FILTER (WHERE l.sanctioned_paise IS NULL) AS unsanctioned
        FROM hr_expense_claim_lines l WHERE l.claim_id = target
    ) s
   WHERE c.id = target AND s.claimed > 0;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER hr_claim_totals
  AFTER INSERT OR UPDATE OR DELETE ON "hr_expense_claim_lines"
  FOR EACH ROW EXECUTE FUNCTION hr_claim_totals();
--> statement-breakpoint

-- A decided claim's lines do not change --------------------------------------
CREATE OR REPLACE FUNCTION hr_claim_lines_frozen() RETURNS trigger AS $$
DECLARE
  state hr_claim_status;
BEGIN
  SELECT c.status INTO state FROM hr_expense_claims c
   WHERE c.id = CASE WHEN TG_OP = 'DELETE' THEN OLD.claim_id ELSE NEW.claim_id END;
  -- Sanctioning is part of deciding, so a submitted claim's lines may take a
  -- sanctioned figure; nothing else about them moves once they are in.
  IF state = 'submitted' AND TG_OP = 'UPDATE'
     AND NEW.amount_paise = OLD.amount_paise AND NEW.spent_on = OLD.spent_on THEN
    RETURN NEW;
  END IF;
  IF state = 'submitted' AND TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;
  IF pg_trigger_depth() > 1
     OR nullif(current_setting('app.audit_reason', true), '') IS NOT NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'the lines of a claim do not change once it is in'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER hr_claim_lines_frozen
  BEFORE INSERT OR UPDATE OR DELETE ON "hr_expense_claim_lines"
  FOR EACH ROW EXECUTE FUNCTION hr_claim_lines_frozen();
