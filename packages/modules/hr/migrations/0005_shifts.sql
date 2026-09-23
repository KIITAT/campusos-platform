-- Shifts: when somebody works, and what a night on duty is worth.
--
-- Teaching staff mostly never have one. Wardens, security, the late library
-- desk and a teaching hospital do, and their pay depends on it -- so the
-- allowance is on the shift type and payroll reads the assignments, rather
-- than somebody remembering to set a pay component each month.

CREATE TABLE "hr_shift_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"starts_at" text NOT NULL,
	"ends_at" text NOT NULL,
	"break_minutes" smallint DEFAULT 0 NOT NULL,
	"allowance_paise" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hr_shift_types_code_shape" CHECK (length(trim(code)) > 0),
	CONSTRAINT "hr_shift_types_times" CHECK (starts_at ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' and ends_at ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
	CONSTRAINT "hr_shift_types_not_empty" CHECK (starts_at <> ends_at),
	CONSTRAINT "hr_shift_types_break" CHECK (break_minutes between 0 and 240),
	CONSTRAINT "hr_shift_types_allowance" CHECK (allowance_paise >= 0)
);
--> statement-breakpoint
ALTER TABLE "hr_shift_types" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hr_shift_types" ADD CONSTRAINT "hr_shift_types_institution_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hr_shift_types_code" ON "hr_shift_types" USING btree ("institution_id","code");--> statement-breakpoint
CREATE POLICY "hr_shift_types_tenant_isolation" ON "hr_shift_types" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint

CREATE TABLE "hr_shift_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"shift_type_id" uuid NOT NULL,
	"from_on" date NOT NULL,
	"to_on" date,
	"request_id" uuid,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hr_shift_assignments_dates" CHECK (to_on is null or to_on >= from_on)
);
--> statement-breakpoint
ALTER TABLE "hr_shift_assignments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hr_shift_assignments" ADD CONSTRAINT "hr_shift_assignments_institution_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_shift_assignments" ADD CONSTRAINT "hr_shift_assignments_staff_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."hr_staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_shift_assignments" ADD CONSTRAINT "hr_shift_assignments_type_fk" FOREIGN KEY ("shift_type_id") REFERENCES "public"."hr_shift_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_shift_assignments" ADD CONSTRAINT "hr_shift_assignments_created_by_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hr_shift_assignments_staff" ON "hr_shift_assignments" USING btree ("staff_id","from_on");--> statement-breakpoint
CREATE INDEX "hr_shift_assignments_when" ON "hr_shift_assignments" USING btree ("institution_id","from_on");--> statement-breakpoint
CREATE POLICY "hr_shift_assignments_tenant_isolation" ON "hr_shift_assignments" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
-- One shift at a time: the roll call and the payslip both read this.
ALTER TABLE "hr_shift_assignments"
  ADD CONSTRAINT hr_shift_assignments_no_overlap
  EXCLUDE USING gist (
    staff_id WITH =,
    daterange(from_on, to_on, '[]') WITH &&
  );
--> statement-breakpoint

CREATE TABLE "hr_shift_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"shift_type_id" uuid NOT NULL,
	"from_on" date NOT NULL,
	"to_on" date NOT NULL,
	"reason" text NOT NULL,
	"status" "hr_leave_status" DEFAULT 'pending' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hr_shift_requests_dates" CHECK (to_on >= from_on),
	CONSTRAINT "hr_shift_requests_span" CHECK (to_on - from_on <= 366),
	CONSTRAINT "hr_shift_requests_reason" CHECK (length(trim(reason)) >= 5)
);
--> statement-breakpoint
ALTER TABLE "hr_shift_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hr_shift_requests" ADD CONSTRAINT "hr_shift_requests_institution_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_shift_requests" ADD CONSTRAINT "hr_shift_requests_staff_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."hr_staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_shift_requests" ADD CONSTRAINT "hr_shift_requests_type_fk" FOREIGN KEY ("shift_type_id") REFERENCES "public"."hr_shift_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_shift_requests" ADD CONSTRAINT "hr_shift_requests_decided_by_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hr_shift_requests_pending" ON "hr_shift_requests" USING btree ("institution_id","status");--> statement-breakpoint
CREATE POLICY "hr_shift_requests_tenant_isolation" ON "hr_shift_requests" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint

-- A shift belongs inside the employment ---------------------------------------
--
-- Rostering somebody onto nights after their leaving date is how an allowance
-- gets paid to a former employee.
CREATE OR REPLACE FUNCTION hr_shift_within_employment() RETURNS trigger AS $$
DECLARE
  joined date;
  left_on date;
BEGIN
  SELECT s.joined_on, s.left_on INTO joined, left_on FROM hr_staff s WHERE s.id = NEW.staff_id;
  IF NEW.from_on < joined THEN
    RAISE EXCEPTION 'a shift cannot start before the joining date of %', joined
      USING ERRCODE = 'check_violation';
  END IF;
  IF left_on IS NOT NULL AND (NEW.to_on IS NULL OR NEW.to_on > left_on) THEN
    RAISE EXCEPTION 'a shift cannot run past the leaving date of %', left_on
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER hr_shift_within_employment
  BEFORE INSERT OR UPDATE ON "hr_shift_assignments"
  FOR EACH ROW EXECUTE FUNCTION hr_shift_within_employment();
--> statement-breakpoint

-- Ending an employment ends its open shifts, rather than leaving them running
-- into a period nobody is employed for.
CREATE OR REPLACE FUNCTION hr_staff_end_shifts() RETURNS trigger AS $$
BEGIN
  IF NEW.left_on IS NOT NULL AND OLD.left_on IS DISTINCT FROM NEW.left_on THEN
    DELETE FROM hr_shift_assignments a
     WHERE a.staff_id = NEW.id AND a.from_on > NEW.left_on;
    UPDATE hr_shift_assignments a
       SET to_on = NEW.left_on
     WHERE a.staff_id = NEW.id
       AND a.from_on <= NEW.left_on
       AND (a.to_on IS NULL OR a.to_on > NEW.left_on);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER hr_staff_end_shifts
  AFTER UPDATE ON "hr_staff"
  FOR EACH ROW EXECUTE FUNCTION hr_staff_end_shifts();
