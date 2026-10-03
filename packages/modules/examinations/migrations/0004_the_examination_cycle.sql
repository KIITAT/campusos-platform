-- The examination cycle (decision 134): windows for enrolment and backlog
-- booking, enrolments that keep the details a student confirmed, backlog
-- bookings for courses the record shows failed, sealed question papers, and
-- the institution's settings for them. The database holds the windows, the
-- eligibility and the seal.

CREATE TYPE "public"."exam_window_kind" AS ENUM('enrolment', 'backlog');--> statement-breakpoint
CREATE TYPE "public"."exam_backlog_type" AS ENUM('internal', 'university', 'both');--> statement-breakpoint
CREATE TABLE "exam_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"term_id" uuid NOT NULL,
	"kind" "exam_window_kind" NOT NULL,
	"opens_at" timestamp with time zone NOT NULL,
	"closes_at" timestamp with time zone NOT NULL,
	"time_zone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"instructions" text,
	"internal_fee_paise" bigint DEFAULT 0 NOT NULL,
	"exam_fee_paise" bigint DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exam_windows_span" CHECK (closes_at > opens_at),
	CONSTRAINT "exam_windows_fees" CHECK (internal_fee_paise >= 0 and exam_fee_paise >= 0)
);
--> statement-breakpoint
ALTER TABLE "exam_windows" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "exam_enrolments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"term_id" uuid NOT NULL,
	"student_id" text NOT NULL,
	"confirmed" jsonb NOT NULL,
	"enrolled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" text,
	"cancel_reason" text,
	CONSTRAINT "exam_enrolments_cancel" CHECK ((cancelled_at is null) = (cancel_reason is null))
);
--> statement-breakpoint
ALTER TABLE "exam_enrolments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "exam_enrolment_papers" (
	"institution_id" uuid NOT NULL,
	"enrolment_id" uuid NOT NULL,
	"offering_id" uuid NOT NULL,
	CONSTRAINT "exam_enrolment_papers_enrolment_id_offering_id_pk" PRIMARY KEY("enrolment_id","offering_id")
);
--> statement-breakpoint
ALTER TABLE "exam_enrolment_papers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "exam_backlog_bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"term_id" uuid NOT NULL,
	"student_id" text NOT NULL,
	"course_id" uuid NOT NULL,
	"booking_type" "exam_backlog_type" NOT NULL,
	"fee_paise" bigint DEFAULT 0 NOT NULL,
	"booked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" text,
	"cancel_reason" text,
	CONSTRAINT "exam_backlog_bookings_cancel" CHECK ((cancelled_at is null) = (cancel_reason is null)),
	CONSTRAINT "exam_backlog_bookings_fee" CHECK (fee_paise >= 0)
);
--> statement-breakpoint
ALTER TABLE "exam_backlog_bookings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "exam_question_papers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"exam_id" uuid NOT NULL,
	"version" smallint NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"content" "bytea" NOT NULL,
	"uploaded_by" text,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	CONSTRAINT "exam_question_papers_size" CHECK (size_bytes > 0 and size_bytes = octet_length(content))
);
--> statement-breakpoint
ALTER TABLE "exam_question_papers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "exam_settings" (
	"institution_id" uuid PRIMARY KEY NOT NULL,
	"paper_release_minutes" integer DEFAULT 60 NOT NULL,
	"grade_report_needs_feedback" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exam_settings_release" CHECK (paper_release_minutes between 5 and 1440)
);
--> statement-breakpoint
ALTER TABLE "exam_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "exam_windows" ADD CONSTRAINT "exam_windows_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_windows" ADD CONSTRAINT "exam_windows_term_id_academic_terms_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."academic_terms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_windows" ADD CONSTRAINT "exam_windows_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_enrolments" ADD CONSTRAINT "exam_enrolments_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_enrolments" ADD CONSTRAINT "exam_enrolments_term_id_academic_terms_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."academic_terms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_enrolments" ADD CONSTRAINT "exam_enrolments_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_enrolments" ADD CONSTRAINT "exam_enrolments_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_enrolment_papers" ADD CONSTRAINT "exam_enrolment_papers_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_enrolment_papers" ADD CONSTRAINT "exam_enrolment_papers_enrolment_id_exam_enrolments_id_fk" FOREIGN KEY ("enrolment_id") REFERENCES "public"."exam_enrolments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_enrolment_papers" ADD CONSTRAINT "exam_enrolment_papers_offering_id_academic_offerings_id_fk" FOREIGN KEY ("offering_id") REFERENCES "public"."academic_offerings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_backlog_bookings" ADD CONSTRAINT "exam_backlog_bookings_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_backlog_bookings" ADD CONSTRAINT "exam_backlog_bookings_term_id_academic_terms_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."academic_terms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_backlog_bookings" ADD CONSTRAINT "exam_backlog_bookings_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_backlog_bookings" ADD CONSTRAINT "exam_backlog_bookings_course_id_academic_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."academic_courses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_backlog_bookings" ADD CONSTRAINT "exam_backlog_bookings_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_question_papers" ADD CONSTRAINT "exam_question_papers_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_question_papers" ADD CONSTRAINT "exam_question_papers_exam_id_exams_id_fk" FOREIGN KEY ("exam_id") REFERENCES "public"."exams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_question_papers" ADD CONSTRAINT "exam_question_papers_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_settings" ADD CONSTRAINT "exam_settings_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "exam_windows_once" ON "exam_windows" USING btree ("term_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "exam_enrolments_once" ON "exam_enrolments" USING btree ("term_id","student_id") WHERE cancelled_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "exam_backlog_bookings_once" ON "exam_backlog_bookings" USING btree ("term_id","student_id","course_id") WHERE cancelled_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "exam_question_papers_version" ON "exam_question_papers" USING btree ("exam_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "exam_question_papers_current" ON "exam_question_papers" USING btree ("exam_id") WHERE superseded_at is null;--> statement-breakpoint
CREATE POLICY "exam_windows_tenant_isolation" ON "exam_windows" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "exam_enrolments_tenant_isolation" ON "exam_enrolments" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "exam_enrolment_papers_tenant_isolation" ON "exam_enrolment_papers" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "exam_backlog_bookings_tenant_isolation" ON "exam_backlog_bookings" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "exam_question_papers_tenant_isolation" ON "exam_question_papers" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "exam_settings_tenant_isolation" ON "exam_settings" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
--> statement-breakpoint

-- A window keeps its term and kind; its dates, instructions and fees may move,
-- and it is not removed once anybody has used it.
CREATE OR REPLACE FUNCTION exam_window_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM institutions WHERE id = OLD.institution_id)
       AND ((OLD.kind = 'enrolment' AND EXISTS (SELECT 1 FROM exam_enrolments WHERE term_id = OLD.term_id))
         OR (OLD.kind = 'backlog' AND EXISTS (SELECT 1 FROM exam_backlog_bookings WHERE term_id = OLD.term_id))) THEN
      RAISE EXCEPTION 'that window has been used and is kept'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'exam_window_used';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.term_id IS DISTINCT FROM OLD.term_id OR NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'a window keeps its term and kind'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'exam_window_fixed';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "exam_windows_guard" BEFORE UPDATE OR DELETE ON "exam_windows"
  FOR EACH ROW EXECUTE FUNCTION exam_window_guard();
--> statement-breakpoint

-- Enrolling is a student's act, inside the term's enrolment window. Once made
-- it stands, unless the office cancels it with a reason.
CREATE OR REPLACE FUNCTION exam_enrolment_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  w record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM institutions WHERE id = OLD.institution_id)
       AND EXISTS (SELECT 1 FROM users WHERE id = OLD.student_id) THEN
      RAISE EXCEPTION 'an enrolment is cancelled, not deleted'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'exam_enrolment_kept';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.cancelled_at IS NOT NULL
       OR NEW.cancelled_at IS NULL
       OR (to_jsonb(NEW) - ARRAY['cancelled_at', 'cancelled_by', 'cancel_reason'])
          IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['cancelled_at', 'cancelled_by', 'cancel_reason'])
       OR length(trim(coalesce(NEW.cancel_reason, ''))) < 5 THEN
      RAISE EXCEPTION 'an enrolment is only cancelled, once, with a reason'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'exam_enrolment_fixed';
    END IF;
    RETURN NEW;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.student_id AND role = 'student') THEN
    RAISE EXCEPTION 'enrolment is for a student'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'exam_enrolment_student';
  END IF;
  SELECT opens_at, closes_at INTO w FROM exam_windows WHERE term_id = NEW.term_id AND kind = 'enrolment';
  IF NOT FOUND OR now() < w.opens_at OR now() >= w.closes_at THEN
    RAISE EXCEPTION 'the enrolment window is not open'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'exam_enrolment_window';
  END IF;
  NEW.enrolled_at := now();
  NEW.cancelled_at := NULL;
  NEW.cancelled_by := NULL;
  NEW.cancel_reason := NULL;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "exam_enrolments_guard" BEFORE INSERT OR UPDATE OR DELETE ON "exam_enrolments"
  FOR EACH ROW EXECUTE FUNCTION exam_enrolment_guard();
--> statement-breakpoint

-- A paper on an enrolment is one of the student's own classes that term, and
-- the list is fixed with the enrolment.
CREATE OR REPLACE FUNCTION exam_enrolment_paper_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  e record;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM exam_enrolments WHERE id = OLD.enrolment_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'the papers are fixed with the enrolment'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'exam_enrolment_fixed';
  END IF;
  SELECT term_id, student_id, cancelled_at INTO e FROM exam_enrolments WHERE id = NEW.enrolment_id;
  IF e.cancelled_at IS NOT NULL OR NOT EXISTS (
    SELECT 1 FROM academic_offerings o
      JOIN academic_section_members m ON m.section_id = o.section_id AND m.user_id = e.student_id
     WHERE o.id = NEW.offering_id AND o.term_id = e.term_id
  ) THEN
    RAISE EXCEPTION 'that is not one of your classes this term'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'exam_enrolment_paper';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "exam_enrolment_papers_guard" BEFORE INSERT OR UPDATE OR DELETE ON "exam_enrolment_papers"
  FOR EACH ROW EXECUTE FUNCTION exam_enrolment_paper_guard();
--> statement-breakpoint

-- A backlog is booked in the backlog window, for a course the record shows
-- failed and not passed since, at the fee the window sets -- worked out here,
-- not taken from the caller.
CREATE OR REPLACE FUNCTION exam_backlog_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  w record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM institutions WHERE id = OLD.institution_id)
       AND EXISTS (SELECT 1 FROM users WHERE id = OLD.student_id) THEN
      RAISE EXCEPTION 'a booking is cancelled, not deleted'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'exam_backlog_kept';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.cancelled_at IS NOT NULL
       OR NEW.cancelled_at IS NULL
       OR (to_jsonb(NEW) - ARRAY['cancelled_at', 'cancelled_by', 'cancel_reason'])
          IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['cancelled_at', 'cancelled_by', 'cancel_reason'])
       OR length(trim(coalesce(NEW.cancel_reason, ''))) < 5 THEN
      RAISE EXCEPTION 'a booking is only cancelled, once, with a reason'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'exam_backlog_fixed';
    END IF;
    RETURN NEW;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.student_id AND role = 'student') THEN
    RAISE EXCEPTION 'a backlog is booked by a student'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'exam_backlog_student';
  END IF;
  SELECT opens_at, closes_at, internal_fee_paise, exam_fee_paise INTO w
    FROM exam_windows WHERE term_id = NEW.term_id AND kind = 'backlog';
  IF NOT FOUND OR now() < w.opens_at OR now() >= w.closes_at THEN
    RAISE EXCEPTION 'the backlog booking window is not open'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'exam_backlog_window';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM academic_course_completions
                  WHERE student_id = NEW.student_id AND course_id = NEW.course_id AND NOT passed)
     OR EXISTS (SELECT 1 FROM academic_course_completions
                 WHERE student_id = NEW.student_id AND course_id = NEW.course_id AND passed) THEN
    RAISE EXCEPTION 'that course is not a backlog on your record'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'exam_backlog_not_failed';
  END IF;
  NEW.fee_paise := CASE NEW.booking_type
    WHEN 'internal' THEN w.internal_fee_paise
    WHEN 'university' THEN w.exam_fee_paise
    ELSE w.internal_fee_paise + w.exam_fee_paise END;
  NEW.booked_at := now();
  NEW.cancelled_at := NULL;
  NEW.cancelled_by := NULL;
  NEW.cancel_reason := NULL;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "exam_backlog_bookings_guard" BEFORE INSERT OR UPDATE OR DELETE ON "exam_backlog_bookings"
  FOR EACH ROW EXECUTE FUNCTION exam_backlog_guard();
--> statement-breakpoint

-- A question paper is uploaded only while there is still time before the exam
-- -- the release lead included -- numbered here, superseding the last; and
-- never edited afterwards.
CREATE OR REPLACE FUNCTION exam_paper_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  at timestamptz;
  lead int;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM exams WHERE id = OLD.exam_id) THEN
      RAISE EXCEPTION 'a question paper is kept'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'exam_paper_kept';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.superseded_at IS NOT NULL OR NEW.superseded_at IS NULL
       OR (to_jsonb(NEW) - 'superseded_at') IS DISTINCT FROM (to_jsonb(OLD) - 'superseded_at') THEN
      RAISE EXCEPTION 'a question paper is never edited; upload a new one'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'exam_paper_fixed';
    END IF;
    RETURN NEW;
  END IF;

  SELECT scheduled_at INTO at FROM exams WHERE id = NEW.exam_id;
  IF at IS NULL THEN
    RAISE EXCEPTION 'schedule the exam before its paper is set'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'exam_paper_unscheduled';
  END IF;
  SELECT paper_release_minutes INTO lead FROM exam_settings WHERE institution_id = NEW.institution_id;
  IF now() >= at - make_interval(mins => coalesce(lead, 60)) THEN
    RAISE EXCEPTION 'the paper is sealed: it is too close to the exam to change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'exam_paper_locked';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('exam_paper:' || NEW.exam_id::text));
  UPDATE exam_question_papers SET superseded_at = now() WHERE exam_id = NEW.exam_id AND superseded_at IS NULL;
  SELECT coalesce(max(version), 0) + 1 INTO NEW.version FROM exam_question_papers WHERE exam_id = NEW.exam_id;
  NEW.uploaded_at := now();
  NEW.superseded_at := NULL;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "exam_question_papers_guard" BEFORE INSERT OR UPDATE OR DELETE ON "exam_question_papers"
  FOR EACH ROW EXECUTE FUNCTION exam_paper_guard();
