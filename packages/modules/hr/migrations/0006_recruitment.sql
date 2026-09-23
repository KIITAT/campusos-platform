-- Recruitment: a post agreed, advertised, applied for, interviewed for,
-- offered, and filled.
--
-- Every step is its own table because every step is a decision somebody is
-- accountable for: the requisition says the institution agreed the post exists
-- and is paid for; the opening says it was advertised; feedback is signed by
-- the interviewer who gave it; the offer carries the terms; and the staff
-- record it produced is linked back, so "who hired this person, on what
-- terms" is a join rather than a filing cabinet.

CREATE TYPE "public"."hr_requisition_status" AS ENUM('pending', 'approved', 'rejected', 'filled', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."hr_applicant_status" AS ENUM('applied', 'shortlisted', 'interviewing', 'offered', 'hired', 'rejected', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."hr_interview_status" AS ENUM('scheduled', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."hr_recommendation" AS ENUM('strong_hire', 'hire', 'no_hire', 'strong_no_hire');--> statement-breakpoint
CREATE TYPE "public"."hr_offer_status" AS ENUM('issued', 'accepted', 'declined', 'withdrawn');--> statement-breakpoint
CREATE TABLE "hr_job_requisitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"designation" text NOT NULL,
	"department" text,
	"positions" smallint DEFAULT 1 NOT NULL,
	"reason" text NOT NULL,
	"expected_by" date,
	"status" "hr_requisition_status" DEFAULT 'pending' NOT NULL,
	"requested_by" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hr_job_requisitions_positions" CHECK (positions between 1 and 100),
	CONSTRAINT "hr_job_requisitions_reason" CHECK (length(trim(reason)) >= 5)
);
--> statement-breakpoint
ALTER TABLE "hr_job_requisitions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hr_job_openings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"requisition_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"opens_on" date NOT NULL,
	"closes_on" date,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hr_job_openings_dates" CHECK (closes_on is null or closes_on >= opens_on)
);
--> statement-breakpoint
ALTER TABLE "hr_job_openings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hr_job_applicants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"opening_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"source" text,
	"status" "hr_applicant_status" DEFAULT 'applied' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hr_job_applicants_name" CHECK (length(trim(name)) > 0)
);
--> statement-breakpoint
ALTER TABLE "hr_job_applicants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hr_interviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"applicant_id" uuid NOT NULL,
	"round" smallint NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"panel" text[] NOT NULL,
	"status" "hr_interview_status" DEFAULT 'scheduled' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hr_interviews_round_range" CHECK (round between 1 and 10),
	CONSTRAINT "hr_interviews_panel" CHECK (cardinality(panel) between 1 and 12)
);
--> statement-breakpoint
ALTER TABLE "hr_interviews" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hr_interview_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"interview_id" uuid NOT NULL,
	"interviewer_id" text NOT NULL,
	"rating" smallint NOT NULL,
	"recommendation" "hr_recommendation" NOT NULL,
	"notes" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hr_interview_feedback_rating" CHECK (rating between 1 and 5),
	CONSTRAINT "hr_interview_feedback_notes" CHECK (length(trim(notes)) >= 5)
);
--> statement-breakpoint
ALTER TABLE "hr_interview_feedback" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hr_job_offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"applicant_id" uuid NOT NULL,
	"designation" text NOT NULL,
	"department" text,
	"employment" "hr_employment" DEFAULT 'permanent' NOT NULL,
	"monthly_paise" bigint NOT NULL,
	"joining_on" date NOT NULL,
	"expires_on" date NOT NULL,
	"status" "hr_offer_status" DEFAULT 'issued' NOT NULL,
	"responded_at" timestamp with time zone,
	"staff_id" uuid,
	"issued_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hr_job_offers_pay" CHECK (monthly_paise > 0),
	CONSTRAINT "hr_job_offers_hired" CHECK (staff_id is null or status = 'accepted')
);
--> statement-breakpoint
ALTER TABLE "hr_job_offers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hr_job_requisitions" ADD CONSTRAINT "hr_job_requisitions_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_job_requisitions" ADD CONSTRAINT "hr_job_requisitions_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_job_requisitions" ADD CONSTRAINT "hr_job_requisitions_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_job_openings" ADD CONSTRAINT "hr_job_openings_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_job_openings" ADD CONSTRAINT "hr_job_openings_requisition_id_hr_job_requisitions_id_fk" FOREIGN KEY ("requisition_id") REFERENCES "public"."hr_job_requisitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_job_applicants" ADD CONSTRAINT "hr_job_applicants_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_job_applicants" ADD CONSTRAINT "hr_job_applicants_opening_id_hr_job_openings_id_fk" FOREIGN KEY ("opening_id") REFERENCES "public"."hr_job_openings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_interviews" ADD CONSTRAINT "hr_interviews_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_interviews" ADD CONSTRAINT "hr_interviews_applicant_id_hr_job_applicants_id_fk" FOREIGN KEY ("applicant_id") REFERENCES "public"."hr_job_applicants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_interview_feedback" ADD CONSTRAINT "hr_interview_feedback_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_interview_feedback" ADD CONSTRAINT "hr_interview_feedback_interview_id_hr_interviews_id_fk" FOREIGN KEY ("interview_id") REFERENCES "public"."hr_interviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_interview_feedback" ADD CONSTRAINT "hr_interview_feedback_interviewer_id_users_id_fk" FOREIGN KEY ("interviewer_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_job_offers" ADD CONSTRAINT "hr_job_offers_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_job_offers" ADD CONSTRAINT "hr_job_offers_applicant_id_hr_job_applicants_id_fk" FOREIGN KEY ("applicant_id") REFERENCES "public"."hr_job_applicants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_job_offers" ADD CONSTRAINT "hr_job_offers_staff_id_hr_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."hr_staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_job_offers" ADD CONSTRAINT "hr_job_offers_issued_by_users_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hr_job_requisitions_status" ON "hr_job_requisitions" USING btree ("institution_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "hr_job_openings_live" ON "hr_job_openings" USING btree ("requisition_id") WHERE closed_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "hr_job_applicants_once" ON "hr_job_applicants" USING btree ("opening_id",lower("email"));--> statement-breakpoint
CREATE INDEX "hr_job_applicants_status" ON "hr_job_applicants" USING btree ("opening_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "hr_interviews_round" ON "hr_interviews" USING btree ("applicant_id","round");--> statement-breakpoint
CREATE UNIQUE INDEX "hr_interview_feedback_once" ON "hr_interview_feedback" USING btree ("interview_id","interviewer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hr_job_offers_live" ON "hr_job_offers" USING btree ("applicant_id") WHERE status in ('issued', 'accepted');--> statement-breakpoint
CREATE UNIQUE INDEX "hr_job_offers_staff" ON "hr_job_offers" USING btree ("staff_id") WHERE staff_id is not null;--> statement-breakpoint
CREATE POLICY "hr_job_requisitions_tenant_isolation" ON "hr_job_requisitions" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hr_job_openings_tenant_isolation" ON "hr_job_openings" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hr_job_applicants_tenant_isolation" ON "hr_job_applicants" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hr_interviews_tenant_isolation" ON "hr_interviews" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hr_interview_feedback_tenant_isolation" ON "hr_interview_feedback" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hr_job_offers_tenant_isolation" ON "hr_job_offers" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
--> statement-breakpoint

-- Feedback belongs to the panel ----------------------------------------------
--
-- A rating from somebody who was not in the room is an opinion, not feedback,
-- and an offer resting on it rests on nothing.
CREATE OR REPLACE FUNCTION hr_feedback_from_panel() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM hr_interviews i
     WHERE i.id = NEW.interview_id AND NEW.interviewer_id = ANY (i.panel)
  ) THEN
    RAISE EXCEPTION 'only the interview panel gives feedback on it'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER hr_feedback_from_panel
  BEFORE INSERT OR UPDATE ON "hr_interview_feedback"
  FOR EACH ROW EXECUTE FUNCTION hr_feedback_from_panel();
--> statement-breakpoint

-- Signed feedback is not rewritten ------------------------------------------
CREATE OR REPLACE FUNCTION hr_feedback_final() RETURNS trigger AS $$
BEGIN
  IF nullif(current_setting('app.audit_reason', true), '') IS NULL THEN
    RAISE EXCEPTION 'interview feedback is not changed after it is given'
      USING ERRCODE = 'check_violation',
            HINT = 'add a note in a later round instead';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER hr_feedback_final
  BEFORE UPDATE ON "hr_interview_feedback"
  FOR EACH ROW EXECUTE FUNCTION hr_feedback_final();
