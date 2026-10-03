-- Student care (decisions 142 and 143). Self-checks a student takes for
-- themselves, the counselling they ask for, and the counsellors' cases. The
-- database holds that a result is never rewritten, that only a student's own
-- results go with their request, that a case moves forward and is kept, that
-- a counsellor is never booked twice at once, and that only the counsellor
-- holding a case writes in it.
CREATE TYPE "public"."care_topic" AS ENUM('studies', 'mood', 'anxiety', 'relationships', 'family', 'health', 'loss', 'other', 'not_said');--> statement-breakpoint
CREATE TYPE "public"."care_urgency" AS ENUM('routine', 'soon', 'today');--> statement-breakpoint
CREATE TYPE "public"."care_mode" AS ENUM('in_person', 'phone', 'video');--> statement-breakpoint
CREATE TYPE "public"."care_request_status" AS ENUM('waiting', 'accepted', 'closed', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."care_outcome" AS ENUM('supported', 'referred', 'no_response');--> statement-breakpoint
CREATE TYPE "public"."care_appointment_status" AS ENUM('booked', 'held', 'missed', 'cancelled');--> statement-breakpoint
CREATE TABLE "care_settings" (
	"institution_id" uuid PRIMARY KEY NOT NULL,
	"crisis_line" text DEFAULT '' NOT NULL,
	"contact" text DEFAULT '' NOT NULL,
	"time_zone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "care_settings_lengths" CHECK (length(crisis_line) <= 300 and length(contact) <= 500)
);
--> statement-breakpoint
ALTER TABLE "care_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "care_counsellors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"added_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "care_counsellors_title" CHECK (length(trim(title)) between 2 and 80)
);
--> statement-breakpoint
ALTER TABLE "care_counsellors" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "care_instruments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"about" text NOT NULL,
	"stem" text NOT NULL,
	"source" text NOT NULL,
	"options" jsonb NOT NULL,
	"items" jsonb NOT NULL,
	"bands" jsonb NOT NULL,
	"max_score" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "care_instruments_builtin" CHECK (upper(code) not in ('PHQ-9', 'GAD-7')),
	CONSTRAINT "care_instruments_shape" CHECK (jsonb_typeof(items) = 'array' and jsonb_typeof(bands) = 'array' and jsonb_typeof(options) = 'array' and max_score > 0),
	CONSTRAINT "care_instruments_source" CHECK (length(trim(source)) >= 10)
);
--> statement-breakpoint
ALTER TABLE "care_instruments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "care_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"student_id" text NOT NULL,
	"instrument_code" text NOT NULL,
	"instrument_id" uuid,
	"answers" smallint[] NOT NULL,
	"score" integer NOT NULL,
	"max_score" integer NOT NULL,
	"band" text NOT NULL,
	"band_rank" smallint NOT NULL,
	"safety" boolean DEFAULT false NOT NULL,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "care_results_score" CHECK (score between 0 and max_score and band_rank >= 0)
);
--> statement-breakpoint
ALTER TABLE "care_results" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "care_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"student_id" text NOT NULL,
	"topic" "care_topic" DEFAULT 'not_said' NOT NULL,
	"urgency" "care_urgency" DEFAULT 'routine' NOT NULL,
	"mode" "care_mode" DEFAULT 'in_person' NOT NULL,
	"preferred_times" text,
	"message" text,
	"status" "care_request_status" DEFAULT 'waiting' NOT NULL,
	"counsellor_id" text,
	"accepted_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"outcome" "care_outcome",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "care_requests_message" CHECK (message is null or length(message) <= 2000),
	CONSTRAINT "care_requests_times" CHECK (preferred_times is null or length(preferred_times) <= 200),
	CONSTRAINT "care_requests_outcome" CHECK ((status = 'closed') = (outcome is not null))
);
--> statement-breakpoint
ALTER TABLE "care_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "care_shared_results" (
	"institution_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"result_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "care_shared_results_request_id_result_id_pk" PRIMARY KEY("request_id","result_id")
);
--> statement-breakpoint
ALTER TABLE "care_shared_results" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "care_appointments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"counsellor_id" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"mode" "care_mode" NOT NULL,
	"place" text NOT NULL,
	"note_to_student" text,
	"status" "care_appointment_status" DEFAULT 'booked' NOT NULL,
	"cancelled_by" text,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "care_appointments_times" CHECK (ends_at > starts_at and ends_at - starts_at <= interval '4 hours'),
	CONSTRAINT "care_appointments_place" CHECK (length(trim(place)) between 2 and 300),
	CONSTRAINT "care_appointments_cancel" CHECK ((status = 'cancelled') = (cancel_reason is not null))
);
--> statement-breakpoint
ALTER TABLE "care_appointments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "care_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"author_id" text,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "care_notes_body" CHECK (length(trim(body)) between 2 and 5000)
);
--> statement-breakpoint
ALTER TABLE "care_notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "care_settings" ADD CONSTRAINT "care_settings_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_settings" ADD CONSTRAINT "care_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_counsellors" ADD CONSTRAINT "care_counsellors_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_counsellors" ADD CONSTRAINT "care_counsellors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_counsellors" ADD CONSTRAINT "care_counsellors_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_instruments" ADD CONSTRAINT "care_instruments_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_instruments" ADD CONSTRAINT "care_instruments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_results" ADD CONSTRAINT "care_results_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_results" ADD CONSTRAINT "care_results_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_results" ADD CONSTRAINT "care_results_instrument_id_care_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."care_instruments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_requests" ADD CONSTRAINT "care_requests_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_requests" ADD CONSTRAINT "care_requests_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_requests" ADD CONSTRAINT "care_requests_counsellor_id_users_id_fk" FOREIGN KEY ("counsellor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_shared_results" ADD CONSTRAINT "care_shared_results_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_shared_results" ADD CONSTRAINT "care_shared_results_request_id_care_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."care_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_shared_results" ADD CONSTRAINT "care_shared_results_result_id_care_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."care_results"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_appointments" ADD CONSTRAINT "care_appointments_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_appointments" ADD CONSTRAINT "care_appointments_request_id_care_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."care_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_appointments" ADD CONSTRAINT "care_appointments_counsellor_id_users_id_fk" FOREIGN KEY ("counsellor_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_appointments" ADD CONSTRAINT "care_appointments_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_notes" ADD CONSTRAINT "care_notes_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_notes" ADD CONSTRAINT "care_notes_request_id_care_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."care_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_notes" ADD CONSTRAINT "care_notes_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "care_counsellors_user" ON "care_counsellors" USING btree ("institution_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "care_instruments_code" ON "care_instruments" USING btree ("institution_id",upper(code));--> statement-breakpoint
CREATE INDEX "care_results_student" ON "care_results" USING btree ("student_id","taken_at");--> statement-breakpoint
CREATE INDEX "care_results_instrument" ON "care_results" USING btree ("institution_id","instrument_code","taken_at");--> statement-breakpoint
CREATE INDEX "care_requests_queue" ON "care_requests" USING btree ("institution_id","status","created_at");--> statement-breakpoint
CREATE INDEX "care_requests_student" ON "care_requests" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "care_requests_counsellor" ON "care_requests" USING btree ("counsellor_id","status");--> statement-breakpoint
CREATE INDEX "care_shared_results_result" ON "care_shared_results" USING btree ("result_id");--> statement-breakpoint
CREATE INDEX "care_appointments_counsellor" ON "care_appointments" USING btree ("counsellor_id","starts_at");--> statement-breakpoint
CREATE INDEX "care_appointments_request" ON "care_appointments" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "care_notes_request" ON "care_notes" USING btree ("request_id","created_at");--> statement-breakpoint
CREATE POLICY "care_settings_tenant_isolation" ON "care_settings" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "care_counsellors_tenant_isolation" ON "care_counsellors" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "care_instruments_tenant_isolation" ON "care_instruments" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "care_results_tenant_isolation" ON "care_results" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "care_requests_tenant_isolation" ON "care_requests" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "care_shared_results_tenant_isolation" ON "care_shared_results" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "care_appointments_tenant_isolation" ON "care_appointments" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "care_notes_tenant_isolation" ON "care_notes" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);

--> statement-breakpoint

-- A counsellor is a member of staff, named by the office, and stays on the
-- list: they are made inactive, and not while a case of theirs is open.
CREATE OR REPLACE FUNCTION care_counsellor_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM institutions WHERE id = OLD.institution_id)
       AND EXISTS (SELECT 1 FROM users WHERE id = OLD.user_id) THEN
      RAISE EXCEPTION 'a counsellor is made inactive, not removed'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'care_counsellor_kept';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'a counsellor is a person; name another rather than changing this one'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'care_counsellor_fixed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND institution_id = NEW.institution_id
                    AND role NOT IN ('student', 'parent', 'pending')) THEN
    RAISE EXCEPTION 'a counsellor is a member of staff'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'care_counsellor_staff';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.active AND NOT NEW.active
     AND EXISTS (SELECT 1 FROM care_requests WHERE counsellor_id = NEW.user_id AND status = 'accepted') THEN
    RAISE EXCEPTION 'hand their open cases to another counsellor first'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'care_counsellor_cases';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "care_counsellors_guard" BEFORE INSERT OR UPDATE OR DELETE ON "care_counsellors"
  FOR EACH ROW EXECUTE FUNCTION care_counsellor_guard();
--> statement-breakpoint

-- An institution's check is fixed once written: a score means what its
-- questions meant when it was taken. It is retired, never deleted.
CREATE OR REPLACE FUNCTION care_instrument_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM institutions WHERE id = OLD.institution_id) THEN
      RAISE EXCEPTION 'a check is retired, not deleted'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'care_instrument_kept';
    END IF;
    RETURN OLD;
  END IF;
  IF (to_jsonb(NEW) - 'active') IS DISTINCT FROM (to_jsonb(OLD) - 'active') THEN
    RAISE EXCEPTION 'a check is fixed once written; write a new one'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'care_instrument_fixed';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "care_instruments_guard" BEFORE UPDATE OR DELETE ON "care_instruments"
  FOR EACH ROW EXECUTE FUNCTION care_instrument_guard();
--> statement-breakpoint

-- A result is a student's, of a check that is offered, and never rewritten.
-- Deleting it is theirs to do; the operation behind it checks whose it is.
CREATE OR REPLACE FUNCTION care_result_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'a result is kept as it was taken'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'care_result_fixed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.student_id AND role = 'student') THEN
    RAISE EXCEPTION 'a self-check is taken by a student'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'care_result_student';
  END IF;
  IF NEW.instrument_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM care_instruments
                      WHERE id = NEW.instrument_id AND active AND upper(code) = upper(NEW.instrument_code)) THEN
    RAISE EXCEPTION 'that check is no longer offered'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'care_result_instrument';
  END IF;
  NEW.taken_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "care_results_guard" BEFORE INSERT OR UPDATE ON "care_results"
  FOR EACH ROW EXECUTE FUNCTION care_result_guard();
--> statement-breakpoint

-- A request is a student's, one open at a time. It waits for a counsellor,
-- who takes it and may hand it to another; it is closed by them with an
-- outcome or withdrawn by the student, and then it is final. What the student
-- asked never changes, except that they may say it has become more urgent.
CREATE OR REPLACE FUNCTION care_request_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  moving text[] := ARRAY['status', 'counsellor_id', 'accepted_at', 'closed_at', 'outcome', 'urgency'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM institutions WHERE id = OLD.institution_id)
       AND EXISTS (SELECT 1 FROM users WHERE id = OLD.student_id) THEN
      RAISE EXCEPTION 'a request for counselling is kept'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'care_request_kept';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.student_id AND role = 'student') THEN
      RAISE EXCEPTION 'counselling is asked for by a student'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'care_request_student';
    END IF;
    IF EXISTS (SELECT 1 FROM care_requests WHERE student_id = NEW.student_id AND status IN ('waiting', 'accepted')) THEN
      RAISE EXCEPTION 'you already have a request open'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'care_request_open';
    END IF;
    NEW.status := 'waiting';
    NEW.counsellor_id := NULL;
    NEW.accepted_at := NULL;
    NEW.closed_at := NULL;
    NEW.outcome := NULL;
    NEW.created_at := now();
    RETURN NEW;
  END IF;

  -- The counsellor's account removed: the case stays, without them.
  IF NEW.counsellor_id IS NULL AND OLD.counsellor_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM users WHERE id = OLD.counsellor_id)
     AND (to_jsonb(NEW) - 'counsellor_id') = (to_jsonb(OLD) - 'counsellor_id') THEN
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - moving) IS DISTINCT FROM (to_jsonb(OLD) - moving)
     OR NEW.urgency < OLD.urgency THEN
    RAISE EXCEPTION 'what the student asked does not change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'care_request_fixed';
  END IF;
  IF OLD.status IN ('closed', 'withdrawn') THEN
    RAISE EXCEPTION 'that request is finished'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'care_request_final';
  END IF;
  IF NOT ((OLD.status = NEW.status)
          OR (OLD.status = 'waiting' AND NEW.status IN ('accepted', 'withdrawn'))
          OR (OLD.status = 'accepted' AND NEW.status IN ('closed', 'withdrawn'))) THEN
    RAISE EXCEPTION 'a request is taken, then closed or withdrawn'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'care_request_final';
  END IF;
  IF NEW.status = 'waiting' AND NEW.counsellor_id IS NOT NULL THEN
    RAISE EXCEPTION 'a counsellor takes a request by accepting it'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'care_request_counsellor';
  END IF;
  IF NEW.status = 'accepted' AND NEW.counsellor_id IS DISTINCT FROM OLD.counsellor_id
     AND NOT EXISTS (SELECT 1 FROM care_counsellors
                      WHERE user_id = NEW.counsellor_id AND institution_id = NEW.institution_id AND active) THEN
    RAISE EXCEPTION 'that is not one of the counsellors'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'care_request_counsellor';
  END IF;
  IF NEW.status IN ('closed', 'withdrawn') AND NEW.counsellor_id IS DISTINCT FROM OLD.counsellor_id THEN
    RAISE EXCEPTION 'a request is handed over while it is open'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'care_request_counsellor';
  END IF;
  IF OLD.status = 'waiting' AND NEW.status = 'accepted' THEN
    NEW.accepted_at := now();
  ELSE
    NEW.accepted_at := OLD.accepted_at;
  END IF;
  IF NEW.status IN ('closed', 'withdrawn') THEN
    NEW.closed_at := now();
  ELSE
    NEW.closed_at := OLD.closed_at;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "care_requests_guard" BEFORE INSERT OR UPDATE OR DELETE ON "care_requests"
  FOR EACH ROW EXECUTE FUNCTION care_request_guard();
--> statement-breakpoint

-- Only a student's own results go with their request, and only while it is
-- open. Taking one back is theirs to do.
CREATE OR REPLACE FUNCTION care_shared_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'a result is shared or it is not'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'care_share_own';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM care_requests q JOIN care_results r ON r.student_id = q.student_id
                  WHERE q.id = NEW.request_id AND r.id = NEW.result_id) THEN
    RAISE EXCEPTION 'only your own results go with your request'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'care_share_own';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM care_requests WHERE id = NEW.request_id AND status IN ('waiting', 'accepted')) THEN
    RAISE EXCEPTION 'that request is finished'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'care_share_open';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "care_shared_results_guard" BEFORE INSERT OR UPDATE ON "care_shared_results"
  FOR EACH ROW EXECUTE FUNCTION care_shared_guard();
--> statement-breakpoint

-- An appointment is made by the counsellor holding the case, never over
-- another of theirs. Once made, only what happened to it is recorded: held
-- or missed once it has begun, or cancelled with a reason. Kept.
CREATE OR REPLACE FUNCTION care_appointment_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  outcome text[] := ARRAY['status', 'cancelled_by', 'cancel_reason'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM institutions WHERE id = OLD.institution_id)
       AND EXISTS (SELECT 1 FROM care_requests WHERE id = OLD.request_id)
       AND EXISTS (SELECT 1 FROM users WHERE id = OLD.counsellor_id) THEN
      RAISE EXCEPTION 'an appointment is cancelled, not deleted'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'care_appointment_kept';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM care_requests
                    WHERE id = NEW.request_id AND status = 'accepted' AND counsellor_id = NEW.counsellor_id) THEN
      RAISE EXCEPTION 'appointments are made by the counsellor holding an open case'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'care_appointment_case';
    END IF;
    IF EXISTS (SELECT 1 FROM care_appointments
                WHERE counsellor_id = NEW.counsellor_id AND status IN ('booked', 'held')
                  AND tstzrange(starts_at, ends_at) && tstzrange(NEW.starts_at, NEW.ends_at)) THEN
      RAISE EXCEPTION 'you have another appointment then'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'care_appointment_clash';
    END IF;
    NEW.status := 'booked';
    NEW.cancelled_by := NULL;
    NEW.cancel_reason := NULL;
    NEW.created_at := now();
    RETURN NEW;
  END IF;

  -- The person who cancelled it removed: the record stays, without them.
  IF NEW.cancelled_by IS NULL AND OLD.cancelled_by IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM users WHERE id = OLD.cancelled_by)
     AND (to_jsonb(NEW) - 'cancelled_by') = (to_jsonb(OLD) - 'cancelled_by') THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - outcome) IS DISTINCT FROM (to_jsonb(OLD) - outcome) THEN
    RAISE EXCEPTION 'an appointment is cancelled and made again, not moved'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'care_appointment_fixed';
  END IF;
  IF OLD.status <> 'booked' OR NEW.status = 'booked' THEN
    RAISE EXCEPTION 'that appointment is already recorded'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'care_appointment_final';
  END IF;
  IF NEW.status IN ('held', 'missed') AND OLD.starts_at > now() THEN
    RAISE EXCEPTION 'an appointment is recorded once it has begun'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'care_appointment_early';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "care_appointments_guard" BEFORE INSERT OR UPDATE OR DELETE ON "care_appointments"
  FOR EACH ROW EXECUTE FUNCTION care_appointment_guard();
--> statement-breakpoint

-- A note is the case's counsellor's, written while the case is theirs, and
-- kept as written.
CREATE OR REPLACE FUNCTION care_note_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM care_requests
                    WHERE id = NEW.request_id AND counsellor_id = NEW.author_id AND status IN ('accepted', 'closed')) THEN
      RAISE EXCEPTION 'notes are written by the counsellor holding the case'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'care_note_author';
    END IF;
    NEW.created_at := now();
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.author_id IS NULL AND OLD.author_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM users WHERE id = OLD.author_id)
     AND (to_jsonb(NEW) - 'author_id') = (to_jsonb(OLD) - 'author_id') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' AND (NOT EXISTS (SELECT 1 FROM institutions WHERE id = OLD.institution_id)
                           OR NOT EXISTS (SELECT 1 FROM care_requests WHERE id = OLD.request_id)) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'a note is kept as written; add another to correct it'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'care_note_kept';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "care_notes_guard" BEFORE INSERT OR UPDATE OR DELETE ON "care_notes"
  FOR EACH ROW EXECUTE FUNCTION care_note_guard();
