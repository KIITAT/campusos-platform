-- Quizzes (Phase I, decision 129). A question bank per course, quizzes set
-- from it for one offering, and attempts scored by the machine -- with the
-- database, not the client, deciding how long a student has and what an
-- attempt totals. Not grades: nothing here writes a mark or a completion.

CREATE TYPE "public"."quiz_question_kind" AS ENUM('single', 'multiple', 'true_false', 'short', 'numeric');--> statement-breakpoint
CREATE TYPE "public"."quiz_keep" AS ENUM('best', 'latest');--> statement-breakpoint
CREATE TYPE "public"."quiz_reveal" AS ENUM('after_submit', 'after_close', 'never');--> statement-breakpoint
CREATE TABLE "quiz_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"kind" "quiz_question_kind" NOT NULL,
	"prompt" text NOT NULL,
	"choices" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"accepted_answers" text[] DEFAULT '{}'::text[] NOT NULL,
	"numeric_answer" numeric,
	"tolerance" numeric DEFAULT '0' NOT NULL,
	"partial_credit" boolean DEFAULT false NOT NULL,
	"points" numeric(6, 2) DEFAULT '1' NOT NULL,
	"topic" text,
	"explanation" text,
	"revision_of" uuid,
	"retired_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quiz_questions_prompt" CHECK (length(trim(prompt)) > 0),
	CONSTRAINT "quiz_questions_points" CHECK (points > 0 and points <= 100),
	CONSTRAINT "quiz_questions_tolerance" CHECK (tolerance >= 0),
	CONSTRAINT "quiz_questions_partial" CHECK (not partial_credit or kind = 'multiple')
);
--> statement-breakpoint
ALTER TABLE "quiz_questions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "quiz_quizzes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"offering_id" uuid NOT NULL,
	"title" text NOT NULL,
	"instructions" text,
	"opens_at" timestamp with time zone NOT NULL,
	"closes_at" timestamp with time zone NOT NULL,
	"time_zone" text NOT NULL,
	"time_limit_minutes" integer,
	"attempts_allowed" smallint DEFAULT 1 NOT NULL,
	"keep" "quiz_keep" DEFAULT 'best' NOT NULL,
	"penalty_percent" numeric(5, 2) DEFAULT '0' NOT NULL,
	"reveal" "quiz_reveal" DEFAULT 'after_close' NOT NULL,
	"shuffle" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"docstatus" text DEFAULT 'draft' NOT NULL,
	"submitted_at" timestamp with time zone,
	"submitted_by" text,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" text,
	"cancel_reason" text,
	"amended_from" uuid,
	CONSTRAINT "quiz_quizzes_title" CHECK (length(trim(title)) > 0),
	CONSTRAINT "quiz_quizzes_window" CHECK (closes_at > opens_at),
	CONSTRAINT "quiz_quizzes_limit" CHECK (time_limit_minutes is null or time_limit_minutes between 1 and 600),
	CONSTRAINT "quiz_quizzes_attempts" CHECK (attempts_allowed between 1 and 10),
	CONSTRAINT "quiz_quizzes_penalty" CHECK (penalty_percent between 0 and 100)
);
--> statement-breakpoint
ALTER TABLE "quiz_quizzes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "quiz_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"quiz_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"points" numeric(6, 2) NOT NULL,
	CONSTRAINT "quiz_items_points" CHECK (points > 0 and points <= 100)
);
--> statement-breakpoint
ALTER TABLE "quiz_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "quiz_extensions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"quiz_id" uuid NOT NULL,
	"student_id" text NOT NULL,
	"closes_at" timestamp with time zone,
	"extra_minutes" integer DEFAULT 0 NOT NULL,
	"reason" text NOT NULL,
	"granted_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quiz_extensions_reason" CHECK (length(trim(reason)) >= 5),
	CONSTRAINT "quiz_extensions_minutes" CHECK (extra_minutes between 0 and 600),
	CONSTRAINT "quiz_extensions_something" CHECK (closes_at is not null or extra_minutes > 0)
);
--> statement-breakpoint
ALTER TABLE "quiz_extensions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "quiz_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"quiz_id" uuid NOT NULL,
	"student_id" text NOT NULL,
	"number" smallint NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deadline" timestamp with time zone NOT NULL,
	"item_order" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"submitted_at" timestamp with time zone,
	"auto_submitted" boolean DEFAULT false NOT NULL,
	"score" numeric(8, 2),
	"max_score" numeric(8, 2) NOT NULL,
	CONSTRAINT "quiz_attempts_scored" CHECK ((submitted_at is null) = (score is null))
);
--> statement-breakpoint
ALTER TABLE "quiz_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "quiz_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"answer" jsonb,
	"answered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"correct" boolean,
	"awarded" numeric(6, 2),
	"overridden_by" text,
	"overridden_at" timestamp with time zone,
	"override_reason" text,
	CONSTRAINT "quiz_responses_override" CHECK ((overridden_at is null) = (override_reason is null))
);
--> statement-breakpoint
ALTER TABLE "quiz_responses" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "quiz_questions" ADD CONSTRAINT "quiz_questions_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_questions" ADD CONSTRAINT "quiz_questions_course_id_academic_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."academic_courses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_questions" ADD CONSTRAINT "quiz_questions_revision_of_quiz_questions_id_fk" FOREIGN KEY ("revision_of") REFERENCES "public"."quiz_questions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_questions" ADD CONSTRAINT "quiz_questions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_quizzes" ADD CONSTRAINT "quiz_quizzes_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_quizzes" ADD CONSTRAINT "quiz_quizzes_offering_id_academic_offerings_id_fk" FOREIGN KEY ("offering_id") REFERENCES "public"."academic_offerings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_quizzes" ADD CONSTRAINT "quiz_quizzes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_items" ADD CONSTRAINT "quiz_items_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_items" ADD CONSTRAINT "quiz_items_quiz_id_quiz_quizzes_id_fk" FOREIGN KEY ("quiz_id") REFERENCES "public"."quiz_quizzes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_items" ADD CONSTRAINT "quiz_items_question_id_quiz_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."quiz_questions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_extensions" ADD CONSTRAINT "quiz_extensions_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_extensions" ADD CONSTRAINT "quiz_extensions_quiz_id_quiz_quizzes_id_fk" FOREIGN KEY ("quiz_id") REFERENCES "public"."quiz_quizzes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_extensions" ADD CONSTRAINT "quiz_extensions_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_extensions" ADD CONSTRAINT "quiz_extensions_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_quiz_id_quiz_quizzes_id_fk" FOREIGN KEY ("quiz_id") REFERENCES "public"."quiz_quizzes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_responses" ADD CONSTRAINT "quiz_responses_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_responses" ADD CONSTRAINT "quiz_responses_attempt_id_quiz_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."quiz_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_responses" ADD CONSTRAINT "quiz_responses_item_id_quiz_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."quiz_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_responses" ADD CONSTRAINT "quiz_responses_overridden_by_users_id_fk" FOREIGN KEY ("overridden_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quiz_questions_course" ON "quiz_questions" USING btree ("course_id","retired_at");--> statement-breakpoint
CREATE UNIQUE INDEX "quiz_questions_revision" ON "quiz_questions" USING btree ("revision_of");--> statement-breakpoint
CREATE INDEX "quiz_quizzes_offering" ON "quiz_quizzes" USING btree ("offering_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quiz_items_once" ON "quiz_items" USING btree ("quiz_id","question_id");--> statement-breakpoint
CREATE INDEX "quiz_items_question" ON "quiz_items" USING btree ("question_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quiz_extensions_once" ON "quiz_extensions" USING btree ("quiz_id","student_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quiz_attempts_number" ON "quiz_attempts" USING btree ("quiz_id","student_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "quiz_attempts_open" ON "quiz_attempts" USING btree ("quiz_id","student_id") WHERE submitted_at is null;--> statement-breakpoint
CREATE INDEX "quiz_attempts_student" ON "quiz_attempts" USING btree ("student_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quiz_responses_once" ON "quiz_responses" USING btree ("attempt_id","item_id");--> statement-breakpoint
CREATE INDEX "quiz_responses_item" ON "quiz_responses" USING btree ("item_id");--> statement-breakpoint
CREATE POLICY "quiz_questions_tenant_isolation" ON "quiz_questions" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "quiz_quizzes_tenant_isolation" ON "quiz_quizzes" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "quiz_items_tenant_isolation" ON "quiz_items" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "quiz_extensions_tenant_isolation" ON "quiz_extensions" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "quiz_attempts_tenant_isolation" ON "quiz_attempts" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "quiz_responses_tenant_isolation" ON "quiz_responses" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);

--> statement-breakpoint
ALTER TABLE "quiz_quizzes" ADD CONSTRAINT "quiz_quizzes_docstatus" CHECK (docstatus in ('draft', 'submitted', 'cancelled'));
--> statement-breakpoint
ALTER TABLE "quiz_quizzes" ADD CONSTRAINT "quiz_quizzes_amended_from_fk" FOREIGN KEY ("amended_from") REFERENCES "quiz_quizzes"("id") ON DELETE restrict;
--> statement-breakpoint
CREATE TRIGGER "quiz_quizzes_docstatus" BEFORE INSERT OR UPDATE OR DELETE ON "quiz_quizzes" FOR EACH ROW EXECUTE FUNCTION campusos_docstatus_guard();
--> statement-breakpoint

-- A question's key is checked as it is written, and never changes after:
-- students were scored against it. The only change is retiring it, once.
CREATE OR REPLACE FUNCTION quiz_question_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  n int;
  k int;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.retired_at IS NOT NULL
       OR (to_jsonb(NEW) - 'retired_at') IS DISTINCT FROM (to_jsonb(OLD) - 'retired_at') THEN
      RAISE EXCEPTION 'a question is never edited; revise it into a new one'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'quiz_question_frozen';
    END IF;
    RETURN NEW;
  END IF;

  n := jsonb_array_length(NEW.choices);
  SELECT count(*) INTO k FROM jsonb_array_elements(NEW.choices) e WHERE (e->>'correct')::boolean;
  IF (NEW.kind IN ('single', 'true_false') AND (n < 2 OR k <> 1))
     OR (NEW.kind = 'multiple' AND (n < 2 OR k < 1))
     OR (NEW.kind = 'short' AND cardinality(NEW.accepted_answers) = 0)
     OR (NEW.kind = 'numeric' AND NEW.numeric_answer IS NULL)
     OR (NEW.kind IN ('short', 'numeric') AND n > 0) THEN
    RAISE EXCEPTION 'a % question needs a key it can be scored against', NEW.kind
      USING ERRCODE = 'check_violation', CONSTRAINT = 'quiz_question_key';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "quiz_questions_guard" BEFORE INSERT OR UPDATE ON "quiz_questions"
  FOR EACH ROW EXECUTE FUNCTION quiz_question_guard();
--> statement-breakpoint

-- What is on a quiz changes only while it is a draft, and only with live
-- questions from the offering's own course.
CREATE OR REPLACE FUNCTION quiz_items_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  q record;
  qn record;
BEGIN
  SELECT z.docstatus, o.course_id INTO q
    FROM quiz_quizzes z JOIN academic_offerings o ON o.id = z.offering_id
   WHERE z.id = CASE WHEN TG_OP = 'DELETE' THEN OLD.quiz_id ELSE NEW.quiz_id END;
  -- Gone already: a draft quiz being deleted takes its items with it.
  IF NOT FOUND THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF q.docstatus <> 'draft' THEN
    RAISE EXCEPTION 'a published quiz is not changed; withdraw it and revise'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'quiz_items_frozen';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;

  SELECT course_id, retired_at INTO qn FROM quiz_questions WHERE id = NEW.question_id;
  IF qn.retired_at IS NOT NULL THEN
    RAISE EXCEPTION 'that question is retired'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'quiz_items_retired';
  END IF;
  IF qn.course_id <> q.course_id THEN
    RAISE EXCEPTION 'that question is from another course''s bank'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'quiz_items_course';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "quiz_items_guard" BEFORE INSERT OR UPDATE OR DELETE ON "quiz_items"
  FOR EACH ROW EXECUTE FUNCTION quiz_items_guard();
--> statement-breakpoint

-- Published means something a student can take: at least one question, and
-- a close still ahead.
CREATE OR REPLACE FUNCTION quiz_publish_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.docstatus = 'draft' AND NEW.docstatus = 'submitted' THEN
    IF NOT EXISTS (SELECT 1 FROM quiz_items WHERE quiz_id = NEW.id) THEN
      RAISE EXCEPTION 'a quiz with no questions is not published'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'quiz_publish_empty';
    END IF;
    IF NEW.closes_at <= now() THEN
      RAISE EXCEPTION 'that quiz has already closed'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'quiz_publish_closed';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "quiz_quizzes_publish" BEFORE UPDATE OF docstatus ON "quiz_quizzes"
  FOR EACH ROW EXECUTE FUNCTION quiz_publish_guard();
--> statement-breakpoint

-- An attempt: whether it may start, and the facts of it -- number, start and
-- deadline -- are the database's, not the caller's. Once submitted only its
-- score moves, and the score is always the sum of its responses, floored at
-- zero, recomputed here on every write.
CREATE OR REPLACE FUNCTION quiz_attempt_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  q record;
  ext record;
  closes timestamptz;
  extra int := 0;
  used int;
  total int;
  fixed text[] := ARRAY['submitted_at', 'auto_submitted', 'score'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Kept: a sitting is a record. It goes only with the student, when their
    -- account is erased.
    IF EXISTS (SELECT 1 FROM users WHERE id = OLD.student_id) THEN
      RAISE EXCEPTION 'an attempt is a record and is not deleted'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'quiz_attempt_kept';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.submitted_at IS NOT NULL THEN
      IF (to_jsonb(NEW) - 'score') IS DISTINCT FROM (to_jsonb(OLD) - 'score') THEN
        RAISE EXCEPTION 'a submitted attempt is final'
          USING ERRCODE = 'check_violation', CONSTRAINT = 'quiz_attempt_submitted';
      END IF;
    ELSIF (to_jsonb(NEW) - fixed) IS DISTINCT FROM (to_jsonb(OLD) - fixed) THEN
      RAISE EXCEPTION 'an attempt''s start, deadline and questions are fixed when it starts'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'quiz_attempt_fixed';
    END IF;
    IF NEW.submitted_at IS NOT NULL THEN
      SELECT greatest(0, coalesce(sum(awarded), 0)) INTO NEW.score
        FROM quiz_responses WHERE attempt_id = NEW.id;
    ELSE
      NEW.score := NULL;
    END IF;
    RETURN NEW;
  END IF;

  SELECT z.docstatus, z.opens_at, z.closes_at, z.time_limit_minutes, z.attempts_allowed, o.section_id INTO q
    FROM quiz_quizzes z JOIN academic_offerings o ON o.id = z.offering_id
   WHERE z.id = NEW.quiz_id;
  IF q.docstatus IS DISTINCT FROM 'submitted' THEN
    RAISE EXCEPTION 'that quiz is not published'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'quiz_attempt_unpublished';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM academic_section_members
                  WHERE section_id = q.section_id AND user_id = NEW.student_id) THEN
    RAISE EXCEPTION 'that quiz is for another class'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'quiz_attempt_not_enrolled';
  END IF;
  closes := q.closes_at;
  SELECT closes_at, extra_minutes INTO ext FROM quiz_extensions
   WHERE quiz_id = NEW.quiz_id AND student_id = NEW.student_id;
  IF FOUND THEN
    closes := greatest(q.closes_at, coalesce(ext.closes_at, q.closes_at));
    extra := ext.extra_minutes;
  END IF;
  IF now() < q.opens_at THEN
    RAISE EXCEPTION 'that quiz is not open yet'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'quiz_attempt_not_open';
  END IF;
  IF now() >= closes THEN
    RAISE EXCEPTION 'that quiz has closed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'quiz_attempt_closed';
  END IF;
  SELECT count(*) INTO used FROM quiz_attempts WHERE quiz_id = NEW.quiz_id AND student_id = NEW.student_id;
  IF used >= q.attempts_allowed THEN
    RAISE EXCEPTION 'no attempts left'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'quiz_attempt_limit';
  END IF;

  NEW.number := used + 1;
  NEW.started_at := now();
  NEW.deadline := CASE
    WHEN q.time_limit_minutes IS NULL THEN closes
    ELSE least(closes, now() + make_interval(mins => q.time_limit_minutes + extra))
  END;
  NEW.submitted_at := NULL;
  NEW.auto_submitted := false;
  NEW.score := NULL;
  SELECT coalesce(sum(points), 0), count(*) INTO NEW.max_score, total FROM quiz_items WHERE quiz_id = NEW.quiz_id;
  IF cardinality(NEW.item_order) = 0 THEN
    SELECT coalesce(array_agg(id ORDER BY position), '{}') INTO NEW.item_order FROM quiz_items WHERE quiz_id = NEW.quiz_id;
  ELSIF cardinality(NEW.item_order) <> total
        OR (SELECT count(DISTINCT id) FROM quiz_items WHERE quiz_id = NEW.quiz_id AND id = ANY (NEW.item_order)) <> total THEN
    RAISE EXCEPTION 'an attempt''s order must be the quiz''s questions, each once'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'quiz_attempt_order';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "quiz_attempts_guard" BEFORE INSERT OR UPDATE OR DELETE ON "quiz_attempts"
  FOR EACH ROW EXECUTE FUNCTION quiz_attempt_guard();
--> statement-breakpoint

-- An answer is saved until the deadline -- thirty seconds' grace for the
-- network -- and frozen once the attempt is submitted. No marks exist before
-- submission; after it, a mark may change (a teacher's override) but the
-- answer never does.
CREATE OR REPLACE FUNCTION quiz_response_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  a record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM quiz_attempts WHERE id = OLD.attempt_id) THEN
      RAISE EXCEPTION 'an answer is not deleted; clear it instead'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'quiz_response_kept';
    END IF;
    RETURN OLD;
  END IF;

  SELECT t.submitted_at, t.deadline, t.quiz_id, z.docstatus INTO a
    FROM quiz_attempts t JOIN quiz_quizzes z ON z.id = t.quiz_id
   WHERE t.id = NEW.attempt_id;
  IF NOT EXISTS (SELECT 1 FROM quiz_items WHERE id = NEW.item_id AND quiz_id = a.quiz_id) THEN
    RAISE EXCEPTION 'that question is not on this quiz'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'quiz_response_item';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.attempt_id <> OLD.attempt_id OR NEW.item_id <> OLD.item_id) THEN
    RAISE EXCEPTION 'an answer belongs to its attempt and question'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'quiz_response_item';
  END IF;

  IF TG_OP = 'INSERT' OR NEW.answer IS DISTINCT FROM OLD.answer THEN
    IF a.submitted_at IS NOT NULL THEN
      RAISE EXCEPTION 'that attempt is submitted; its answers are final'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'quiz_response_locked';
    END IF;
    IF now() > a.deadline + interval '30 seconds' THEN
      RAISE EXCEPTION 'time is up for that attempt'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'quiz_response_late';
    END IF;
    IF a.docstatus <> 'submitted' THEN
      RAISE EXCEPTION 'that quiz was withdrawn'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'quiz_response_withdrawn';
    END IF;
    NEW.answered_at := now();
  END IF;

  IF a.submitted_at IS NULL THEN
    NEW.correct := NULL;
    NEW.awarded := NULL;
    NEW.overridden_by := NULL;
    NEW.overridden_at := NULL;
    NEW.override_reason := NULL;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "quiz_responses_guard" BEFORE INSERT OR UPDATE OR DELETE ON "quiz_responses"
  FOR EACH ROW EXECUTE FUNCTION quiz_response_guard();
--> statement-breakpoint

-- A mark written or changed moves the attempt's total with it.
CREATE OR REPLACE FUNCTION quiz_response_rescore() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE quiz_attempts SET score = score WHERE id = NEW.attempt_id AND submitted_at IS NOT NULL;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "quiz_responses_rescore" AFTER UPDATE OF awarded ON "quiz_responses"
  FOR EACH ROW WHEN (NEW.awarded IS DISTINCT FROM OLD.awarded) EXECUTE FUNCTION quiz_response_rescore();
