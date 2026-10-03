-- Feedback (decision 133). Questionnaires the institution writes, opened to
-- students per term in windows, answered anonymously: who answered and what
-- was said are kept apart, and the database holds who may answer, when, and
-- that nothing said is changed afterwards.

CREATE TYPE "public"."feedback_audience" AS ENUM('teaching', 'general');--> statement-breakpoint
CREATE TYPE "public"."feedback_question_kind" AS ENUM('scale', 'choice', 'text');--> statement-breakpoint
CREATE TABLE "feedback_forms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"name" text NOT NULL,
	"audience" "feedback_audience" NOT NULL,
	"description" text,
	"scale_points" smallint DEFAULT 5 NOT NULL,
	"scale_low" text DEFAULT 'Strongly disagree' NOT NULL,
	"scale_high" text DEFAULT 'Strongly agree' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"docstatus" text DEFAULT 'draft' NOT NULL,
	"submitted_at" timestamp with time zone,
	"submitted_by" text,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" text,
	"cancel_reason" text,
	"amended_from" uuid,
	CONSTRAINT "feedback_forms_name" UNIQUE("institution_id","name"),
	CONSTRAINT "feedback_forms_name_len" CHECK (length(trim(name)) > 0),
	CONSTRAINT "feedback_forms_scale" CHECK (scale_points between 3 and 10)
);
--> statement-breakpoint
ALTER TABLE "feedback_forms" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "feedback_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"form_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"section" text,
	"prompt" text NOT NULL,
	"kind" "feedback_question_kind" NOT NULL,
	"options" text[] DEFAULT '{}'::text[] NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	CONSTRAINT "feedback_questions_prompt" CHECK (length(trim(prompt)) > 0),
	CONSTRAINT "feedback_questions_options" CHECK ((kind = 'choice' and cardinality(options) between 2 and 12) or (kind <> 'choice' and cardinality(options) = 0))
);
--> statement-breakpoint
ALTER TABLE "feedback_questions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "feedback_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"form_id" uuid NOT NULL,
	"term_id" uuid NOT NULL,
	"title" text NOT NULL,
	"opens_at" timestamp with time zone NOT NULL,
	"closes_at" timestamp with time zone NOT NULL,
	"time_zone" text NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"min_responses" smallint DEFAULT 5 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"docstatus" text DEFAULT 'draft' NOT NULL,
	"submitted_at" timestamp with time zone,
	"submitted_by" text,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" text,
	"cancel_reason" text,
	"amended_from" uuid,
	CONSTRAINT "feedback_windows_title" CHECK (length(trim(title)) > 0),
	CONSTRAINT "feedback_windows_span" CHECK (closes_at > opens_at),
	CONSTRAINT "feedback_windows_min" CHECK (min_responses between 1 and 50)
);
--> statement-breakpoint
ALTER TABLE "feedback_windows" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "feedback_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"window_id" uuid NOT NULL,
	"student_id" text NOT NULL,
	"offering_id" uuid,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_submissions_once" UNIQUE NULLS NOT DISTINCT("window_id","student_id","offering_id")
);
--> statement-breakpoint
ALTER TABLE "feedback_submissions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "feedback_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"window_id" uuid NOT NULL,
	"offering_id" uuid
);
--> statement-breakpoint
ALTER TABLE "feedback_responses" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "feedback_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"response_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"score" smallint,
	"choice" text,
	"comment" text,
	CONSTRAINT "feedback_answers_once" UNIQUE("response_id","question_id"),
	CONSTRAINT "feedback_answers_one" CHECK (num_nonnulls(score, choice, comment) = 1),
	CONSTRAINT "feedback_answers_comment" CHECK (comment is null or length(comment) between 1 and 2000)
);
--> statement-breakpoint
ALTER TABLE "feedback_answers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "feedback_forms" ADD CONSTRAINT "feedback_forms_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_forms" ADD CONSTRAINT "feedback_forms_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_questions" ADD CONSTRAINT "feedback_questions_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_questions" ADD CONSTRAINT "feedback_questions_form_id_feedback_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."feedback_forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_windows" ADD CONSTRAINT "feedback_windows_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_windows" ADD CONSTRAINT "feedback_windows_form_id_feedback_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."feedback_forms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_windows" ADD CONSTRAINT "feedback_windows_term_id_academic_terms_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."academic_terms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_windows" ADD CONSTRAINT "feedback_windows_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_submissions" ADD CONSTRAINT "feedback_submissions_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_submissions" ADD CONSTRAINT "feedback_submissions_window_id_feedback_windows_id_fk" FOREIGN KEY ("window_id") REFERENCES "public"."feedback_windows"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_submissions" ADD CONSTRAINT "feedback_submissions_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_submissions" ADD CONSTRAINT "feedback_submissions_offering_id_academic_offerings_id_fk" FOREIGN KEY ("offering_id") REFERENCES "public"."academic_offerings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_responses" ADD CONSTRAINT "feedback_responses_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_responses" ADD CONSTRAINT "feedback_responses_window_id_feedback_windows_id_fk" FOREIGN KEY ("window_id") REFERENCES "public"."feedback_windows"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_responses" ADD CONSTRAINT "feedback_responses_offering_id_academic_offerings_id_fk" FOREIGN KEY ("offering_id") REFERENCES "public"."academic_offerings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_answers" ADD CONSTRAINT "feedback_answers_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_answers" ADD CONSTRAINT "feedback_answers_response_id_feedback_responses_id_fk" FOREIGN KEY ("response_id") REFERENCES "public"."feedback_responses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_answers" ADD CONSTRAINT "feedback_answers_question_id_feedback_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."feedback_questions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feedback_questions_form" ON "feedback_questions" USING btree ("form_id","position");--> statement-breakpoint
CREATE INDEX "feedback_windows_term" ON "feedback_windows" USING btree ("term_id");--> statement-breakpoint
CREATE INDEX "feedback_submissions_student" ON "feedback_submissions" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "feedback_responses_window" ON "feedback_responses" USING btree ("window_id","offering_id");--> statement-breakpoint
CREATE INDEX "feedback_answers_question" ON "feedback_answers" USING btree ("question_id");--> statement-breakpoint
CREATE POLICY "feedback_forms_tenant_isolation" ON "feedback_forms" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "feedback_questions_tenant_isolation" ON "feedback_questions" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "feedback_windows_tenant_isolation" ON "feedback_windows" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "feedback_submissions_tenant_isolation" ON "feedback_submissions" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "feedback_responses_tenant_isolation" ON "feedback_responses" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "feedback_answers_tenant_isolation" ON "feedback_answers" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "feedback_forms" ADD CONSTRAINT "feedback_forms_docstatus" CHECK (docstatus in ('draft', 'submitted', 'cancelled'));
--> statement-breakpoint
ALTER TABLE "feedback_forms" ADD CONSTRAINT "feedback_forms_amended_from_fk" FOREIGN KEY ("amended_from") REFERENCES "feedback_forms"("id") ON DELETE restrict;
--> statement-breakpoint
CREATE TRIGGER "feedback_forms_docstatus" BEFORE INSERT OR UPDATE OR DELETE ON "feedback_forms" FOR EACH ROW EXECUTE FUNCTION campusos_docstatus_guard();
--> statement-breakpoint
ALTER TABLE "feedback_windows" ADD CONSTRAINT "feedback_windows_docstatus" CHECK (docstatus in ('draft', 'submitted', 'cancelled'));
--> statement-breakpoint
ALTER TABLE "feedback_windows" ADD CONSTRAINT "feedback_windows_amended_from_fk" FOREIGN KEY ("amended_from") REFERENCES "feedback_windows"("id") ON DELETE restrict;
--> statement-breakpoint
CREATE TRIGGER "feedback_windows_docstatus" BEFORE INSERT OR UPDATE OR DELETE ON "feedback_windows" FOR EACH ROW EXECUTE FUNCTION campusos_docstatus_guard();
--> statement-breakpoint

-- A question changes only while its form is a draft: answers already given
-- were to these exact words.
CREATE OR REPLACE FUNCTION feedback_question_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  st text;
BEGIN
  SELECT docstatus INTO st FROM feedback_forms
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.form_id ELSE NEW.form_id END;
  -- Gone already: a draft form being deleted takes its questions with it.
  IF NOT FOUND THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF st <> 'draft' THEN
    RAISE EXCEPTION 'a published questionnaire is not changed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'feedback_question_frozen';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "feedback_questions_guard" BEFORE INSERT OR UPDATE OR DELETE ON "feedback_questions"
  FOR EACH ROW EXECUTE FUNCTION feedback_question_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION feedback_form_publish_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.docstatus = 'draft' AND NEW.docstatus = 'submitted'
     AND NOT EXISTS (SELECT 1 FROM feedback_questions WHERE form_id = NEW.id) THEN
    RAISE EXCEPTION 'a questionnaire with no questions is not published'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'feedback_form_empty';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "feedback_forms_publish" BEFORE UPDATE OF docstatus ON "feedback_forms"
  FOR EACH ROW EXECUTE FUNCTION feedback_form_publish_guard();
--> statement-breakpoint

-- A window opens a published questionnaire, and is published with its close
-- still ahead.
CREATE OR REPLACE FUNCTION feedback_window_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  st text;
BEGIN
  IF TG_OP = 'INSERT' OR (OLD.docstatus = 'draft' AND NEW.docstatus = 'submitted') THEN
    SELECT docstatus INTO st FROM feedback_forms WHERE id = NEW.form_id;
    IF st IS DISTINCT FROM 'submitted' THEN
      RAISE EXCEPTION 'that questionnaire is not published'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'feedback_window_form';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.docstatus = 'draft' AND NEW.docstatus = 'submitted' AND NEW.closes_at <= now() THEN
    RAISE EXCEPTION 'that window has already closed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'feedback_window_closed';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "feedback_windows_guard" BEFORE INSERT OR UPDATE ON "feedback_windows"
  FOR EACH ROW EXECUTE FUNCTION feedback_window_guard();
--> statement-breakpoint

-- Who may answer, and when, is decided here: a student, while the window is
-- open, for a class they sit in that term -- or, for a general window, any
-- student with a class that term. Once given, it is a record.
CREATE OR REPLACE FUNCTION feedback_submission_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  w record;
  o record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM institutions WHERE id = OLD.institution_id)
       AND EXISTS (SELECT 1 FROM users WHERE id = OLD.student_id) THEN
      RAISE EXCEPTION 'that feedback was given and is kept'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'feedback_submission_kept';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'that feedback was given and is kept'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'feedback_submission_kept';
  END IF;

  SELECT fw.docstatus, fw.opens_at, fw.closes_at, fw.term_id, ff.audience INTO w
    FROM feedback_windows fw JOIN feedback_forms ff ON ff.id = fw.form_id
   WHERE fw.id = NEW.window_id;
  IF w.docstatus IS DISTINCT FROM 'submitted' THEN
    RAISE EXCEPTION 'that window is not taking feedback'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'feedback_submission_window';
  END IF;
  IF now() < w.opens_at THEN
    RAISE EXCEPTION 'that window has not opened yet'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'feedback_submission_not_open';
  END IF;
  IF now() >= w.closes_at THEN
    RAISE EXCEPTION 'that window has closed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'feedback_submission_closed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.student_id AND role = 'student') THEN
    RAISE EXCEPTION 'feedback is given by students'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'feedback_submission_student';
  END IF;

  IF w.audience = 'teaching' THEN
    SELECT term_id, section_id INTO o FROM academic_offerings WHERE id = NEW.offering_id;
    IF NEW.offering_id IS NULL OR o.term_id IS DISTINCT FROM w.term_id
       OR NOT EXISTS (SELECT 1 FROM academic_section_members
                       WHERE section_id = o.section_id AND user_id = NEW.student_id) THEN
      RAISE EXCEPTION 'that is not one of your classes this term'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'feedback_submission_class';
    END IF;
  ELSE
    IF NEW.offering_id IS NOT NULL
       OR NOT EXISTS (SELECT 1 FROM academic_offerings ao
                        JOIN academic_section_members m ON m.section_id = ao.section_id
                       WHERE ao.term_id = w.term_id AND m.user_id = NEW.student_id) THEN
      RAISE EXCEPTION 'you have no classes that term'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'feedback_submission_class';
    END IF;
  END IF;
  NEW.submitted_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "feedback_submissions_guard" BEFORE INSERT OR UPDATE OR DELETE ON "feedback_submissions"
  FOR EACH ROW EXECUTE FUNCTION feedback_submission_guard();
--> statement-breakpoint

-- What was said never outnumbers who said it: every response is matched by a
-- submission for the same window and class, so nothing can be stuffed in
-- around the student check. And it is never changed.
CREATE OR REPLACE FUNCTION feedback_response_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  given int;
  said int;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM institutions WHERE id = OLD.institution_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'what was said is kept as it was said'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'feedback_response_kept';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('feedback:' || NEW.window_id::text || ':' || coalesce(NEW.offering_id::text, '')));
  SELECT count(*) INTO given FROM feedback_submissions
   WHERE window_id = NEW.window_id AND offering_id IS NOT DISTINCT FROM NEW.offering_id;
  SELECT count(*) INTO said FROM feedback_responses
   WHERE window_id = NEW.window_id AND offering_id IS NOT DISTINCT FROM NEW.offering_id;
  IF said >= given THEN
    RAISE EXCEPTION 'a response needs a student who has just given it'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'feedback_response_unmatched';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "feedback_responses_guard" BEFORE INSERT OR UPDATE OR DELETE ON "feedback_responses"
  FOR EACH ROW EXECUTE FUNCTION feedback_response_guard();
--> statement-breakpoint

-- Every required question answered, checked when the transaction commits, so
-- a response cannot be left half-written.
CREATE OR REPLACE FUNCTION feedback_response_complete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM feedback_questions q
      JOIN feedback_windows w ON w.form_id = q.form_id
     WHERE w.id = NEW.window_id AND q.required
       AND NOT EXISTS (SELECT 1 FROM feedback_answers a WHERE a.response_id = NEW.id AND a.question_id = q.id)
  ) THEN
    RAISE EXCEPTION 'answer every required question'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'feedback_response_incomplete';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "feedback_responses_complete" AFTER INSERT ON "feedback_responses"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION feedback_response_complete();
--> statement-breakpoint

-- An answer fits its question: a point on the form's own scale, one of the
-- question's options, or a comment -- for a question on this window's form.
CREATE OR REPLACE FUNCTION feedback_answer_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  q record;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM institutions WHERE id = OLD.institution_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'what was said is kept as it was said'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'feedback_answer_kept';
  END IF;
  SELECT fq.kind, fq.options, ff.scale_points, (fw.form_id = fq.form_id) AS same INTO q
    FROM feedback_questions fq
    JOIN feedback_forms ff ON ff.id = fq.form_id
    JOIN feedback_responses r ON r.id = NEW.response_id
    JOIN feedback_windows fw ON fw.id = r.window_id
   WHERE fq.id = NEW.question_id;
  IF NOT FOUND OR NOT q.same THEN
    RAISE EXCEPTION 'that question is not on this questionnaire'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'feedback_answer_question';
  END IF;
  IF (q.kind = 'scale' AND (NEW.score IS NULL OR NEW.score NOT BETWEEN 1 AND q.scale_points))
     OR (q.kind = 'choice' AND (NEW.choice IS NULL OR NOT NEW.choice = ANY (q.options)))
     OR (q.kind = 'text' AND NEW.comment IS NULL) THEN
    RAISE EXCEPTION 'that answer does not fit the question'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'feedback_answer_value';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "feedback_answers_guard" BEFORE INSERT OR UPDATE OR DELETE ON "feedback_answers"
  FOR EACH ROW EXECUTE FUNCTION feedback_answer_guard();
