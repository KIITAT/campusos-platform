-- Mentoring (decision 139). A mentor and co-mentor per student, notes and a
-- conversation, and leave applications decided by the mentor. The database
-- holds who may write where, that a leave is decided once and never rewritten,
-- and that nothing here is deleted while the student is.

CREATE TYPE "public"."mentor_note_kind" AS ENUM('meeting', 'call', 'progress', 'concern');--> statement-breakpoint
CREATE TYPE "public"."mentor_leave_status" AS ENUM('pending', 'approved', 'rejected', 'cancelled');--> statement-breakpoint
CREATE TABLE "mentor_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"student_id" text NOT NULL,
	"mentor_id" text NOT NULL,
	"co_mentor_id" text,
	"from_on" date DEFAULT now() NOT NULL,
	"to_on" date,
	"reason" text,
	"assigned_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mentor_assignments_two" CHECK (co_mentor_id is null or co_mentor_id <> mentor_id),
	CONSTRAINT "mentor_assignments_span" CHECK (to_on is null or to_on >= from_on)
);
--> statement-breakpoint
ALTER TABLE "mentor_assignments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "mentor_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"student_id" text NOT NULL,
	"author_id" text,
	"met_on" date NOT NULL,
	"kind" "mentor_note_kind" NOT NULL,
	"body" text NOT NULL,
	"shared" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mentor_notes_body" CHECK (length(trim(body)) between 3 and 4000)
);
--> statement-breakpoint
ALTER TABLE "mentor_notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "mentor_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"student_id" text NOT NULL,
	"sender_id" text,
	"body" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	CONSTRAINT "mentor_messages_body" CHECK (length(trim(body)) between 1 and 4000)
);
--> statement-breakpoint
ALTER TABLE "mentor_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "mentor_leave_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"name" text NOT NULL,
	"needs_document" boolean DEFAULT false NOT NULL,
	"max_days" smallint,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mentor_leave_types_days" CHECK (max_days is null or max_days between 1 and 365)
);
--> statement-breakpoint
ALTER TABLE "mentor_leave_types" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "mentor_leave_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"student_id" text NOT NULL,
	"leave_type_id" uuid NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"purpose" text NOT NULL,
	"place_of_visit" text NOT NULL,
	"leaving_at" timestamp with time zone NOT NULL,
	"arriving_at" timestamp with time zone NOT NULL,
	"contact_phone" text NOT NULL,
	"document_name" text,
	"document_sha256" text,
	"document_size" integer,
	"document" "bytea",
	"status" "mentor_leave_status" DEFAULT 'pending' NOT NULL,
	"mentor_id" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"hostel_leave_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mentor_leave_applications_days" CHECK (ends_on >= starts_on),
	CONSTRAINT "mentor_leave_applications_times" CHECK (arriving_at > leaving_at),
	CONSTRAINT "mentor_leave_applications_purpose" CHECK (length(trim(purpose)) >= 5),
	CONSTRAINT "mentor_leave_applications_phone" CHECK (contact_phone ~ '^[0-9+() -]{7,20}$'),
	CONSTRAINT "mentor_leave_applications_document" CHECK ((document is null) = (document_sha256 is null) and (document is null or octet_length(document) = document_size))
);
--> statement-breakpoint
ALTER TABLE "mentor_leave_applications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mentor_assignments" ADD CONSTRAINT "mentor_assignments_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentor_assignments" ADD CONSTRAINT "mentor_assignments_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentor_assignments" ADD CONSTRAINT "mentor_assignments_mentor_id_users_id_fk" FOREIGN KEY ("mentor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentor_assignments" ADD CONSTRAINT "mentor_assignments_co_mentor_id_users_id_fk" FOREIGN KEY ("co_mentor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentor_assignments" ADD CONSTRAINT "mentor_assignments_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentor_notes" ADD CONSTRAINT "mentor_notes_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentor_notes" ADD CONSTRAINT "mentor_notes_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentor_notes" ADD CONSTRAINT "mentor_notes_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentor_messages" ADD CONSTRAINT "mentor_messages_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentor_messages" ADD CONSTRAINT "mentor_messages_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentor_messages" ADD CONSTRAINT "mentor_messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentor_leave_types" ADD CONSTRAINT "mentor_leave_types_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentor_leave_applications" ADD CONSTRAINT "mentor_leave_applications_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentor_leave_applications" ADD CONSTRAINT "mentor_leave_applications_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentor_leave_applications" ADD CONSTRAINT "mentor_leave_applications_type_fk" FOREIGN KEY ("leave_type_id") REFERENCES "public"."mentor_leave_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentor_leave_applications" ADD CONSTRAINT "mentor_leave_applications_mentor_id_users_id_fk" FOREIGN KEY ("mentor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentor_leave_applications" ADD CONSTRAINT "mentor_leave_applications_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mentor_assignments_current" ON "mentor_assignments" USING btree ("student_id") WHERE to_on is null;--> statement-breakpoint
CREATE INDEX "mentor_assignments_mentor" ON "mentor_assignments" USING btree ("mentor_id") WHERE to_on is null;--> statement-breakpoint
CREATE INDEX "mentor_assignments_co" ON "mentor_assignments" USING btree ("co_mentor_id") WHERE to_on is null;--> statement-breakpoint
CREATE INDEX "mentor_notes_student" ON "mentor_notes" USING btree ("student_id","met_on");--> statement-breakpoint
CREATE INDEX "mentor_messages_thread" ON "mentor_messages" USING btree ("student_id","sent_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mentor_leave_types_name" ON "mentor_leave_types" USING btree ("institution_id","name");--> statement-breakpoint
CREATE INDEX "mentor_leave_applications_student" ON "mentor_leave_applications" USING btree ("student_id","starts_on");--> statement-breakpoint
CREATE INDEX "mentor_leave_applications_waiting" ON "mentor_leave_applications" USING btree ("mentor_id") WHERE status = 'pending';--> statement-breakpoint
CREATE POLICY "mentor_assignments_tenant_isolation" ON "mentor_assignments" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "mentor_notes_tenant_isolation" ON "mentor_notes" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "mentor_messages_tenant_isolation" ON "mentor_messages" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "mentor_leave_types_tenant_isolation" ON "mentor_leave_types" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "mentor_leave_applications_tenant_isolation" ON "mentor_leave_applications" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
--> statement-breakpoint

-- A mentor is staff and a mentee a student. An assignment only ever ends --
-- once, on or after it began -- and is never removed, so who was responsible
-- on a given day stays answerable.
CREATE OR REPLACE FUNCTION mentor_assignment_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM institutions WHERE id = OLD.institution_id)
       AND EXISTS (SELECT 1 FROM users WHERE id = OLD.student_id) THEN
      RAISE EXCEPTION 'an assignment is ended, not deleted'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'mentor_assignment_kept';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.to_on IS NOT NULL OR NEW.to_on IS NULL
       OR (to_jsonb(NEW) - 'to_on') IS DISTINCT FROM (to_jsonb(OLD) - 'to_on') THEN
      RAISE EXCEPTION 'an assignment only ends, once'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'mentor_assignment_fixed';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.student_id AND role = 'student') THEN
    RAISE EXCEPTION 'a mentee is a student'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'mentor_student';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.mentor_id AND role IN ('faculty', 'hod', 'institution_admin'))
     OR (NEW.co_mentor_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.co_mentor_id AND role IN ('faculty', 'hod', 'institution_admin'))) THEN
    RAISE EXCEPTION 'a mentor is a member of staff'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'mentor_staff';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "mentor_assignments_guard" BEFORE INSERT OR UPDATE OR DELETE ON "mentor_assignments"
  FOR EACH ROW EXECUTE FUNCTION mentor_assignment_guard();
--> statement-breakpoint

-- A note is written by staff and kept as written.
CREATE OR REPLACE FUNCTION mentor_note_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.author_id AND role IN ('faculty', 'hod', 'institution_admin')) THEN
      RAISE EXCEPTION 'notes are written by staff'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'mentor_note_author';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' AND (NOT EXISTS (SELECT 1 FROM institutions WHERE id = OLD.institution_id)
                           OR NOT EXISTS (SELECT 1 FROM users WHERE id = OLD.student_id)) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'a note is kept as written; add another to correct it'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'mentor_note_kept';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "mentor_notes_guard" BEFORE INSERT OR UPDATE OR DELETE ON "mentor_notes"
  FOR EACH ROW EXECUTE FUNCTION mentor_note_guard();
--> statement-breakpoint

-- A thread is the student's and their current mentors': nobody else writes in
-- it but the office. A message is read once and otherwise left as sent.
CREATE OR REPLACE FUNCTION mentor_message_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.sender_id IS DISTINCT FROM NEW.student_id
       AND NOT EXISTS (SELECT 1 FROM mentor_assignments a
                        WHERE a.student_id = NEW.student_id AND a.to_on IS NULL
                          AND NEW.sender_id IN (a.mentor_id, a.co_mentor_id))
       AND NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.sender_id AND role = 'institution_admin') THEN
      RAISE EXCEPTION 'only the student and their mentors write here'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'mentor_message_sender';
    END IF;
    NEW.sent_at := now();
    NEW.read_at := NULL;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.read_at IS NOT NULL OR NEW.read_at IS NULL
       OR (to_jsonb(NEW) - 'read_at') IS DISTINCT FROM (to_jsonb(OLD) - 'read_at') THEN
      RAISE EXCEPTION 'a message is left as it was sent'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'mentor_message_fixed';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM institutions WHERE id = OLD.institution_id)
     OR NOT EXISTS (SELECT 1 FROM users WHERE id = OLD.student_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'a message is kept'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'mentor_message_kept';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "mentor_messages_guard" BEFORE INSERT OR UPDATE OR DELETE ON "mentor_messages"
  FOR EACH ROW EXECUTE FUNCTION mentor_message_guard();
--> statement-breakpoint

-- A leave application: a student's, of a live kind, with its document where the
-- kind needs one, within the kind's length, not overlapping another leave of
-- theirs that stands, and waiting on their mentor of the day. Decided once;
-- what was asked for never changes.
CREATE OR REPLACE FUNCTION mentor_leave_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  t record;
  decision text[] := ARRAY['status', 'decided_by', 'decided_at', 'decision_note', 'hostel_leave_id'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM institutions WHERE id = OLD.institution_id)
       AND EXISTS (SELECT 1 FROM users WHERE id = OLD.student_id) THEN
      RAISE EXCEPTION 'a leave application is kept'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'leave_kept';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.student_id AND role = 'student') THEN
      RAISE EXCEPTION 'leave is asked for by a student'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'leave_student';
    END IF;
    SELECT needs_document, max_days, retired_at INTO t FROM mentor_leave_types WHERE id = NEW.leave_type_id;
    IF t.retired_at IS NOT NULL THEN
      RAISE EXCEPTION 'that kind of leave is no longer offered'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'leave_type_retired';
    END IF;
    IF t.needs_document AND NEW.document IS NULL THEN
      RAISE EXCEPTION 'that kind of leave needs a supporting document'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'leave_document_required';
    END IF;
    IF t.max_days IS NOT NULL AND (NEW.ends_on - NEW.starts_on + 1) > t.max_days THEN
      RAISE EXCEPTION 'that is longer than this kind of leave allows'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'leave_too_long';
    END IF;
    IF EXISTS (SELECT 1 FROM mentor_leave_applications
                WHERE student_id = NEW.student_id AND status IN ('pending', 'approved')
                  AND daterange(starts_on, ends_on, '[]') && daterange(NEW.starts_on, NEW.ends_on, '[]')) THEN
      RAISE EXCEPTION 'you already have leave asked for or granted over those days'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'leave_overlap';
    END IF;
    SELECT mentor_id INTO NEW.mentor_id FROM mentor_assignments
     WHERE student_id = NEW.student_id AND to_on IS NULL;
    NEW.status := 'pending';
    NEW.decided_by := NULL;
    NEW.decided_at := NULL;
    NEW.decision_note := NULL;
    NEW.hostel_leave_id := NULL;
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - decision) IS DISTINCT FROM (to_jsonb(OLD) - decision) THEN
    RAISE EXCEPTION 'what was asked for does not change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'leave_fixed';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT ((OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected', 'cancelled'))
            OR (OLD.status = 'approved' AND NEW.status = 'cancelled')) THEN
      RAISE EXCEPTION 'that leave has been decided'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'leave_decided';
    END IF;
    IF NEW.status = 'rejected' AND length(trim(coalesce(NEW.decision_note, ''))) < 5 THEN
      RAISE EXCEPTION 'say why the leave is refused'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'leave_reason';
    END IF;
    NEW.decided_at := now();
  ELSIF (NEW.decided_by, NEW.decision_note) IS DISTINCT FROM (OLD.decided_by, OLD.decision_note) THEN
    RAISE EXCEPTION 'that leave has been decided'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'leave_decided';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "mentor_leave_applications_guard" BEFORE INSERT OR UPDATE OR DELETE ON "mentor_leave_applications"
  FOR EACH ROW EXECUTE FUNCTION mentor_leave_guard();
