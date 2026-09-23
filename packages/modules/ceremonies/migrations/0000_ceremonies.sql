-- Ceremonies (Phase H, decision 126). Eligibility is the academic module's
-- degree audit; this module keeps who is on the list, who is coming, office
-- holds, and the certificates -- which the database issues only to a student
-- the audit cleared.

CREATE TYPE "public"."ceremony_status" AS ENUM('planning', 'open', 'held', 'closed');--> statement-breakpoint
CREATE TYPE "public"."ceremony_attendance" AS ENUM('in_person', 'in_absentia');--> statement-breakpoint
CREATE TABLE "ceremony_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"name" text NOT NULL,
	"held_on" date NOT NULL,
	"venue" text,
	"rsvp_closes_on" date,
	"program_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"guest_limit" integer DEFAULT 2 NOT NULL,
	"status" "ceremony_status" DEFAULT 'planning' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ceremony_events_name" CHECK (length(trim(name)) > 0),
	CONSTRAINT "ceremony_events_rsvp" CHECK (rsvp_closes_on is null or rsvp_closes_on <= held_on),
	CONSTRAINT "ceremony_events_guests" CHECK (guest_limit between 0 and 10)
);
--> statement-breakpoint
ALTER TABLE "ceremony_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ceremony_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"ceremony_id" uuid NOT NULL,
	"student_id" text NOT NULL,
	"student_program_id" uuid NOT NULL,
	"program_code" text NOT NULL,
	"program_name" text NOT NULL,
	"credits_earned" integer NOT NULL,
	"credits_required" integer,
	"cgpa" numeric(4, 2),
	"eligible" boolean NOT NULL,
	"short_of" text,
	"audited_at" timestamp with time zone NOT NULL,
	"attendance" "ceremony_attendance",
	"guests" integer DEFAULT 0 NOT NULL,
	"responded_at" timestamp with time zone,
	"checked_in_at" timestamp with time zone,
	"checked_in_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ceremony_candidates_guests" CHECK (guests between 0 and 10),
	CONSTRAINT "ceremony_candidates_short" CHECK (eligible or short_of is not null),
	CONSTRAINT "ceremony_candidates_reply" CHECK ((attendance is null) = (responded_at is null))
);
--> statement-breakpoint
ALTER TABLE "ceremony_candidates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ceremony_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"placed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cleared_at" timestamp with time zone,
	"cleared_by" text,
	"clear_reason" text,
	CONSTRAINT "ceremony_holds_reason" CHECK (length(trim(reason)) >= 5),
	CONSTRAINT "ceremony_holds_cleared" CHECK ((cleared_at is null) = (clear_reason is null))
);
--> statement-breakpoint
ALTER TABLE "ceremony_holds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ceremony_certificates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"ceremony_id" uuid NOT NULL,
	"student_id" text NOT NULL,
	"serial" text NOT NULL,
	"verification_code" text NOT NULL,
	"student_name" text NOT NULL,
	"program_code" text NOT NULL,
	"program_name" text NOT NULL,
	"cgpa" numeric(4, 2),
	"credits_earned" integer NOT NULL,
	"conferred_on" date NOT NULL,
	"audit" jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"docstatus" text DEFAULT 'draft' NOT NULL,
	"submitted_at" timestamp with time zone,
	"submitted_by" text,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" text,
	"cancel_reason" text,
	"amended_from" uuid
);
--> statement-breakpoint
ALTER TABLE "ceremony_certificates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ceremony_events" ADD CONSTRAINT "ceremony_events_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ceremony_events" ADD CONSTRAINT "ceremony_events_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ceremony_candidates" ADD CONSTRAINT "ceremony_candidates_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ceremony_candidates" ADD CONSTRAINT "ceremony_candidates_ceremony_id_ceremony_events_id_fk" FOREIGN KEY ("ceremony_id") REFERENCES "public"."ceremony_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ceremony_candidates" ADD CONSTRAINT "ceremony_candidates_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ceremony_candidates" ADD CONSTRAINT "ceremony_candidates_checked_in_by_users_id_fk" FOREIGN KEY ("checked_in_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ceremony_holds" ADD CONSTRAINT "ceremony_holds_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ceremony_holds" ADD CONSTRAINT "ceremony_holds_candidate_id_ceremony_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."ceremony_candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ceremony_holds" ADD CONSTRAINT "ceremony_holds_placed_by_users_id_fk" FOREIGN KEY ("placed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ceremony_holds" ADD CONSTRAINT "ceremony_holds_cleared_by_users_id_fk" FOREIGN KEY ("cleared_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ceremony_certificates" ADD CONSTRAINT "ceremony_certificates_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ceremony_certificates" ADD CONSTRAINT "ceremony_certificates_candidate_id_ceremony_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."ceremony_candidates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ceremony_certificates" ADD CONSTRAINT "ceremony_certificates_ceremony_id_ceremony_events_id_fk" FOREIGN KEY ("ceremony_id") REFERENCES "public"."ceremony_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ceremony_certificates" ADD CONSTRAINT "ceremony_certificates_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ceremony_certificates" ADD CONSTRAINT "ceremony_certificates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ceremony_candidates_one" ON "ceremony_candidates" USING btree ("ceremony_id","student_id");--> statement-breakpoint
CREATE INDEX "ceremony_candidates_student" ON "ceremony_candidates" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "ceremony_holds_open" ON "ceremony_holds" USING btree ("candidate_id","cleared_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ceremony_certificates_serial" ON "ceremony_certificates" USING btree ("institution_id","serial");--> statement-breakpoint
CREATE UNIQUE INDEX "ceremony_certificates_code" ON "ceremony_certificates" USING btree ("verification_code");--> statement-breakpoint
CREATE UNIQUE INDEX "ceremony_certificates_live" ON "ceremony_certificates" USING btree ("candidate_id") WHERE docstatus <> 'cancelled';--> statement-breakpoint
CREATE INDEX "ceremony_certificates_student" ON "ceremony_certificates" USING btree ("student_id");--> statement-breakpoint
CREATE POLICY "ceremony_events_tenant_isolation" ON "ceremony_events" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ceremony_candidates_tenant_isolation" ON "ceremony_candidates" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ceremony_holds_tenant_isolation" ON "ceremony_holds" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ceremony_certificates_tenant_isolation" ON "ceremony_certificates" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "ceremony_certificates" ADD CONSTRAINT "ceremony_certificates_docstatus" CHECK (docstatus in ('draft', 'submitted', 'cancelled'));
--> statement-breakpoint
ALTER TABLE "ceremony_certificates" ADD CONSTRAINT "ceremony_certificates_amended_from_fk" FOREIGN KEY ("amended_from") REFERENCES "ceremony_certificates"("id") ON DELETE restrict;
--> statement-breakpoint
CREATE TRIGGER "ceremony_certificates_docstatus" BEFORE INSERT OR UPDATE OR DELETE ON "ceremony_certificates" FOR EACH ROW EXECUTE FUNCTION campusos_docstatus_guard();
--> statement-breakpoint

-- A ceremony only moves forward. Reopening replies after the day, or planning
-- one that was held, would rewrite what happened.
CREATE OR REPLACE FUNCTION ceremony_status_forward() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  rank_old int := array_position(ARRAY['planning','open','held','closed'], OLD.status::text);
  rank_new int := array_position(ARRAY['planning','open','held','closed'], NEW.status::text);
BEGIN
  IF rank_new < rank_old THEN
    RAISE EXCEPTION 'a ceremony moves forward only: % cannot go back to %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ceremony_status_forward';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "ceremony_events_forward" BEFORE UPDATE OF status ON "ceremony_events"
  FOR EACH ROW EXECUTE FUNCTION ceremony_status_forward();
--> statement-breakpoint

-- The guarantee this module exists for: a certificate stands only for a
-- student the degree audit cleared, with no hold open, at a ceremony that is
-- past planning. Checked when a certificate is created and when a draft (an
-- amendment) is submitted; the audit it carries must itself say complete.
CREATE OR REPLACE FUNCTION ceremony_certificate_cleared() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  c record;
  s text;
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;
  IF NEW.docstatus <> 'submitted' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.docstatus = 'submitted' THEN RETURN NEW; END IF;

  SELECT * INTO c FROM ceremony_candidates WHERE id = NEW.candidate_id;
  IF c.student_id <> NEW.student_id OR c.ceremony_id <> NEW.ceremony_id THEN
    RAISE EXCEPTION 'a certificate must be for its candidate''s student and ceremony'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ceremony_certificate_candidate';
  END IF;
  IF NOT c.eligible OR coalesce((NEW.audit->>'complete')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'the degree audit has not cleared this student'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ceremony_certificate_audit';
  END IF;
  IF EXISTS (SELECT 1 FROM ceremony_holds WHERE candidate_id = c.id AND cleared_at IS NULL) THEN
    RAISE EXCEPTION 'a hold is open on this candidate'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ceremony_certificate_hold';
  END IF;
  SELECT status::text INTO s FROM ceremony_events WHERE id = NEW.ceremony_id;
  IF s = 'planning' THEN
    RAISE EXCEPTION 'certificates are issued once the ceremony is open'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ceremony_certificate_planning';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "ceremony_certificates_cleared" BEFORE INSERT OR UPDATE OF docstatus ON "ceremony_certificates"
  FOR EACH ROW EXECUTE FUNCTION ceremony_certificate_cleared();
