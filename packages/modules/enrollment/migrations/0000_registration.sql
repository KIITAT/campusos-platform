-- Enrollment. Applied by the host at install time, in this order.
--
-- Three tables and two rules the database keeps rather than the application:
--
--   * a seat count cannot be oversold, however many clerks press Register at
--     the same instant
--   * an add/drop event cannot be edited after the fact, because a refund is
--     prorated against its date
--
-- Nothing here writes to an academic table. The dependency runs one way: this
-- module reads offerings and terms, and uninstalling it leaves the timetable
-- exactly as it was.

CREATE TYPE "public"."enrollment_status" AS ENUM('registered', 'waitlisted', 'dropped', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."enrollment_event_kind" AS ENUM('registered', 'waitlisted', 'promoted', 'dropped', 'withdrawn');--> statement-breakpoint

CREATE TABLE "enrollment_offering_limits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"offering_id" uuid NOT NULL,
	"capacity" smallint NOT NULL,
	"waitlist_capacity" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enrollment_offering_limits_capacity" CHECK (capacity >= 0 and waitlist_capacity >= 0)
);
--> statement-breakpoint
ALTER TABLE "enrollment_offering_limits" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE TABLE "enrollment_registrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"student_id" text NOT NULL,
	"offering_id" uuid NOT NULL,
	"term_id" uuid NOT NULL,
	"status" "enrollment_status" DEFAULT 'registered' NOT NULL,
	"credits" smallint NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enrollment_registrations_credits" CHECK (credits between 0 and 30),
	CONSTRAINT "enrollment_registrations_ended" CHECK (
		(status in ('registered', 'waitlisted')) = (ended_on is null)
	)
);
--> statement-breakpoint
ALTER TABLE "enrollment_registrations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE TABLE "enrollment_registration_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"registration_id" uuid NOT NULL,
	"kind" "enrollment_event_kind" NOT NULL,
	"effective_on" date NOT NULL,
	"reason" text,
	"actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "enrollment_registration_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

ALTER TABLE "enrollment_offering_limits" ADD CONSTRAINT "enrollment_offering_limits_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment_offering_limits" ADD CONSTRAINT "enrollment_offering_limits_offering_id_academic_offerings_id_fk" FOREIGN KEY ("offering_id") REFERENCES "public"."academic_offerings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "enrollment_registrations" ADD CONSTRAINT "enrollment_registrations_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment_registrations" ADD CONSTRAINT "enrollment_registrations_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment_registrations" ADD CONSTRAINT "enrollment_registrations_offering_id_academic_offerings_id_fk" FOREIGN KEY ("offering_id") REFERENCES "public"."academic_offerings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment_registrations" ADD CONSTRAINT "enrollment_registrations_term_id_academic_terms_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."academic_terms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "enrollment_registration_events" ADD CONSTRAINT "enrollment_registration_events_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment_registration_events" ADD CONSTRAINT "enrollment_registration_events_registration_id_enrollment_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."enrollment_registrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment_registration_events" ADD CONSTRAINT "enrollment_registration_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "enrollment_offering_limits_once" ON "enrollment_offering_limits" USING btree ("offering_id");--> statement-breakpoint
CREATE UNIQUE INDEX "enrollment_registrations_once" ON "enrollment_registrations" USING btree ("student_id","offering_id");--> statement-breakpoint
CREATE INDEX "enrollment_registrations_offering" ON "enrollment_registrations" USING btree ("offering_id","status");--> statement-breakpoint
CREATE INDEX "enrollment_registrations_term" ON "enrollment_registrations" USING btree ("term_id","student_id");--> statement-breakpoint
CREATE INDEX "enrollment_events_registration" ON "enrollment_registration_events" USING btree ("registration_id","created_at");--> statement-breakpoint

CREATE POLICY "enrollment_offering_limits_tenant_isolation" ON "enrollment_offering_limits" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "enrollment_registrations_tenant_isolation" ON "enrollment_registrations" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "enrollment_registration_events_tenant_isolation" ON "enrollment_registration_events" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint

-- The seat that was sold twice ---------------------------------------------
--
-- register() checks the count before it inserts, which is correct and not
-- enough: two students pressing Register on the last seat at the same instant
-- both read the same count. The lock on the limits row is what serialises
-- them, and it is taken here so that it is taken on every path into the
-- table, including a registrar's correction and a promotion off the waitlist.
--
-- An offering with no limits row is uncapped and this does nothing.
CREATE OR REPLACE FUNCTION enrollment_within_capacity() RETURNS trigger AS $$
DECLARE
  seats int;
  queue int;
  taken int;
BEGIN
  IF NEW.status NOT IN ('registered', 'waitlisted') THEN
    RETURN NEW;
  END IF;

  SELECT capacity, waitlist_capacity INTO seats, queue
    FROM enrollment_offering_limits
   WHERE offering_id = NEW.offering_id
     FOR UPDATE;

  IF seats IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO taken
    FROM enrollment_registrations r
   WHERE r.offering_id = NEW.offering_id
     AND r.status = NEW.status
     AND r.id <> NEW.id;

  IF NEW.status = 'registered' AND taken >= seats THEN
    RAISE EXCEPTION 'that class is full'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'waitlisted' AND taken >= queue THEN
    RAISE EXCEPTION 'that waiting list is full'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER enrollment_registrations_within_capacity
  BEFORE INSERT OR UPDATE ON enrollment_registrations
  FOR EACH ROW EXECUTE FUNCTION enrollment_within_capacity();--> statement-breakpoint

-- A cap that contradicts the roster ----------------------------------------
--
-- Lowering a cap below the students already sitting in the class does not
-- remove anybody; it just makes the number on the seats page a lie. Refused
-- here rather than in the operation, because the roster can change between
-- reading it and saving the new cap.
CREATE OR REPLACE FUNCTION enrollment_limit_covers_seated() RETURNS trigger AS $$
DECLARE
  taken int;
  queued int;
BEGIN
  SELECT count(*) FILTER (WHERE status = 'registered'),
         count(*) FILTER (WHERE status = 'waitlisted')
    INTO taken, queued
    FROM enrollment_registrations
   WHERE offering_id = NEW.offering_id;

  IF taken > NEW.capacity THEN
    RAISE EXCEPTION 'that class already seats % students', taken
      USING ERRCODE = '23514';
  END IF;

  IF queued > NEW.waitlist_capacity THEN
    RAISE EXCEPTION 'that waiting list already holds % students', queued
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER enrollment_offering_limits_cover_seated
  BEFORE INSERT OR UPDATE ON enrollment_offering_limits
  FOR EACH ROW EXECUTE FUNCTION enrollment_limit_covers_seated();--> statement-breakpoint

-- What happened, happened ---------------------------------------------------
--
-- A refund is prorated against an event's date. An event that could be edited
-- afterwards would make every refund a matter of opinion, so a correction is a
-- new event rather than a revised one.
--
-- Depth is checked so that deleting an institution still cascades: the guard is
-- against a hand on the table, not against the database tidying up after
-- itself.
CREATE OR REPLACE FUNCTION enrollment_events_append_only() RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'a registration event is a record of what happened; add another instead'
    USING ERRCODE = '0A000';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER enrollment_events_no_update
  BEFORE UPDATE ON enrollment_registration_events
  FOR EACH ROW EXECUTE FUNCTION enrollment_events_append_only();--> statement-breakpoint

CREATE TRIGGER enrollment_events_no_delete
  BEFORE DELETE ON enrollment_registration_events
  FOR EACH ROW EXECUTE FUNCTION enrollment_events_append_only();
