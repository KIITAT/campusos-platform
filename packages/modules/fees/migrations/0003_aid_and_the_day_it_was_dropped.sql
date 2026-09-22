-- Student financials. Applied by the host at install time, in this order.
--
-- Two things fees could not previously say:
--
--   * the institution is paying this student's fees, in part, under a rule it
--     wrote down -- which is a cost, not a discount, and belongs in its own
--     account
--   * this student dropped a course on the eleventh, and the calendar says
--     three quarters of the tuition comes back
--
-- Nothing here reads an enrollment table through a foreign key. The drop credit
-- records the offering it came from as a plain identifier, because enrollment
-- is optional: an institution that registers students on paper still awards
-- scholarships, and uninstalling enrollment must not take the fees module's
-- history with it.

CREATE TYPE "public"."fee_scholarship_kind" AS ENUM('merit', 'need', 'staff', 'sport', 'other');--> statement-breakpoint
CREATE TYPE "public"."fee_award_basis" AS ENUM('fixed', 'proportional');--> statement-breakpoint
CREATE TYPE "public"."fee_award_status" AS ENUM('awarded', 'revoked');--> statement-breakpoint

ALTER TABLE "fee_items" ADD COLUMN "proratable" boolean DEFAULT false NOT NULL;--> statement-breakpoint

CREATE TABLE "fee_scholarships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" "fee_scholarship_kind" NOT NULL,
	"basis" "fee_award_basis" NOT NULL,
	"amount_paise" bigint,
	"percent_bps" integer,
	"min_credits" smallint DEFAULT 0 NOT NULL,
	"min_cgpa" numeric(4, 2),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fee_scholarships_amount" CHECK (
		(basis = 'fixed' and amount_paise > 0 and percent_bps is null)
		or (basis = 'proportional' and percent_bps between 1 and 10000 and amount_paise is null)
	),
	CONSTRAINT "fee_scholarships_credits" CHECK (min_credits between 0 and 60)
);
--> statement-breakpoint
ALTER TABLE "fee_scholarships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE TABLE "fee_scholarship_awards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"scholarship_id" uuid NOT NULL,
	"student_id" text NOT NULL,
	"term_id" uuid NOT NULL,
	"amount_paise" bigint NOT NULL,
	"status" "fee_award_status" DEFAULT 'awarded' NOT NULL,
	"credits_at_award" smallint,
	"cgpa_at_award" numeric(4, 2),
	"reason" text,
	"awarded_by" text,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fee_scholarship_awards_amount" CHECK (amount_paise > 0),
	CONSTRAINT "fee_scholarship_awards_revoked" CHECK ((status = 'revoked') = (revoked_reason is not null))
);
--> statement-breakpoint
ALTER TABLE "fee_scholarship_awards" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE TABLE "fee_refund_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"term_id" uuid NOT NULL,
	"through_on" date NOT NULL,
	"refund_bps" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fee_refund_rules_bps" CHECK (refund_bps between 0 and 10000)
);
--> statement-breakpoint
ALTER TABLE "fee_refund_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE TABLE "fee_drop_credits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"student_id" text NOT NULL,
	"term_id" uuid NOT NULL,
	"offering_id" uuid NOT NULL,
	"credits_dropped" smallint NOT NULL,
	"effective_on" date NOT NULL,
	"refund_bps" integer NOT NULL,
	"amount_paise" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fee_drop_credits_amount" CHECK (amount_paise > 0)
);
--> statement-breakpoint
ALTER TABLE "fee_drop_credits" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

ALTER TABLE "fee_scholarships" ADD CONSTRAINT "fee_scholarships_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "fee_scholarship_awards" ADD CONSTRAINT "fee_scholarship_awards_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_scholarship_awards" ADD CONSTRAINT "fee_scholarship_awards_scholarship_id_fee_scholarships_id_fk" FOREIGN KEY ("scholarship_id") REFERENCES "public"."fee_scholarships"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_scholarship_awards" ADD CONSTRAINT "fee_scholarship_awards_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_scholarship_awards" ADD CONSTRAINT "fee_scholarship_awards_term_id_academic_terms_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."academic_terms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_scholarship_awards" ADD CONSTRAINT "fee_scholarship_awards_awarded_by_users_id_fk" FOREIGN KEY ("awarded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "fee_refund_rules" ADD CONSTRAINT "fee_refund_rules_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_refund_rules" ADD CONSTRAINT "fee_refund_rules_term_id_academic_terms_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."academic_terms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "fee_drop_credits" ADD CONSTRAINT "fee_drop_credits_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_drop_credits" ADD CONSTRAINT "fee_drop_credits_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_drop_credits" ADD CONSTRAINT "fee_drop_credits_term_id_academic_terms_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."academic_terms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "fee_scholarships_code" ON "fee_scholarships" USING btree ("institution_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "fee_scholarship_awards_once" ON "fee_scholarship_awards" USING btree ("scholarship_id","student_id","term_id");--> statement-breakpoint
CREATE INDEX "fee_scholarship_awards_student" ON "fee_scholarship_awards" USING btree ("student_id","term_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fee_refund_rules_bracket" ON "fee_refund_rules" USING btree ("term_id","through_on");--> statement-breakpoint
CREATE UNIQUE INDEX "fee_drop_credits_once" ON "fee_drop_credits" USING btree ("student_id","offering_id");--> statement-breakpoint
CREATE INDEX "fee_drop_credits_term" ON "fee_drop_credits" USING btree ("term_id","student_id");--> statement-breakpoint

CREATE POLICY "fee_scholarships_tenant_isolation" ON "fee_scholarships" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "fee_scholarship_awards_tenant_isolation" ON "fee_scholarship_awards" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "fee_refund_rules_tenant_isolation" ON "fee_refund_rules" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "fee_drop_credits_tenant_isolation" ON "fee_drop_credits" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint

-- An award that outlived its reason ----------------------------------------
--
-- Revoking is a status change with a reason, never a delete: a student who lost
-- a scholarship and a student who never had one are different facts, and only
-- one of them has a reversal in the books to explain. Restoring a revoked award
-- is a fresh decision, so the row does not travel backwards either.
CREATE OR REPLACE FUNCTION fee_awards_one_way() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'revoked' AND NEW.status <> 'revoked' THEN
    RAISE EXCEPTION 'a revoked award is not un-revoked; award it again'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER fee_awards_one_way
  BEFORE UPDATE ON "fee_scholarship_awards"
  FOR EACH ROW EXECUTE FUNCTION fee_awards_one_way();--> statement-breakpoint

CREATE OR REPLACE FUNCTION fee_awards_no_delete() RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'an award is revoked, not deleted'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER fee_awards_no_delete
  BEFORE DELETE ON "fee_scholarship_awards"
  FOR EACH ROW EXECUTE FUNCTION fee_awards_no_delete();
