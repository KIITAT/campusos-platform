-- One meeting of a weekly class, changed (decision 140): cancelled, moved to
-- another day, time or room, or taken by a substitute. The database holds that
-- the change is to a real meeting -- its weekday, inside its term -- and that a
-- moved class or a substitute does not double-book a room or a teacher.

CREATE TYPE "public"."academic_class_change_kind" AS ENUM('cancelled', 'rescheduled', 'substitute');--> statement-breakpoint
CREATE TABLE "academic_class_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"slot_id" uuid NOT NULL,
	"on_date" date NOT NULL,
	"kind" "academic_class_change_kind" NOT NULL,
	"moved_on" date,
	"moved_starts" time,
	"moved_ends" time,
	"moved_room_id" uuid,
	"substitute_id" text,
	"reason" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_at" timestamp with time zone,
	"withdrawn_by" text,
	"withdraw_reason" text,
	CONSTRAINT "academic_class_changes_reason" CHECK (length(trim(reason)) >= 5),
	CONSTRAINT "academic_class_changes_shape" CHECK ((kind = 'cancelled' and moved_on is null and moved_starts is null and moved_ends is null and moved_room_id is null and substitute_id is null)
       or (kind = 'rescheduled' and moved_on is not null and moved_starts is not null and moved_ends > moved_starts and moved_room_id is not null and substitute_id is null)
       or (kind = 'substitute' and substitute_id is not null and moved_on is null and moved_starts is null and moved_ends is null and moved_room_id is null)),
	CONSTRAINT "academic_class_changes_withdrawn" CHECK ((withdrawn_at is null) = (withdraw_reason is null))
);
--> statement-breakpoint
ALTER TABLE "academic_class_changes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "academic_class_changes" ADD CONSTRAINT "academic_class_changes_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academic_class_changes" ADD CONSTRAINT "academic_class_changes_slot_id_academic_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."academic_slots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academic_class_changes" ADD CONSTRAINT "academic_class_changes_moved_room_id_academic_rooms_id_fk" FOREIGN KEY ("moved_room_id") REFERENCES "public"."academic_rooms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academic_class_changes" ADD CONSTRAINT "academic_class_changes_substitute_id_users_id_fk" FOREIGN KEY ("substitute_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academic_class_changes" ADD CONSTRAINT "academic_class_changes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academic_class_changes" ADD CONSTRAINT "academic_class_changes_withdrawn_by_users_id_fk" FOREIGN KEY ("withdrawn_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "academic_class_changes_once" ON "academic_class_changes" USING btree ("slot_id","on_date") WHERE withdrawn_at is null;--> statement-breakpoint
CREATE INDEX "academic_class_changes_moved" ON "academic_class_changes" USING btree ("moved_on") WHERE withdrawn_at is null;--> statement-breakpoint
CREATE POLICY "academic_class_changes_tenant_isolation" ON "academic_class_changes" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
--> statement-breakpoint

-- What already meets on a date between two times, in a room or with a teacher:
-- the weekly classes of terms running that day that are not cancelled or moved
-- away that date, and the classes moved into that date. A substitute teaches
-- in place of the lecturer. Returns what clashes, or null.
CREATE OR REPLACE FUNCTION academic_class_busy(
  p_date date, p_starts time, p_ends time, p_room uuid, p_teacher text, p_except_change uuid, p_except_slot uuid
) RETURNS text
LANGUAGE sql STABLE AS $$
  WITH occurrences AS (
    SELECT s.id AS slot_id, s.room_id, s.starts_at, s.ends_at,
           coalesce(sub.substitute_id, o.faculty_user_id) AS teacher
      FROM academic_slots s
      JOIN academic_offerings o ON o.id = s.offering_id
      JOIN academic_terms t ON t.id = o.term_id
      LEFT JOIN academic_class_changes sub
        ON sub.slot_id = s.id AND sub.on_date = p_date AND sub.withdrawn_at IS NULL AND sub.kind = 'substitute'
     WHERE s.day_of_week = extract(isodow FROM p_date)
       AND p_date BETWEEN t.starts_on AND t.ends_on
       AND NOT EXISTS (SELECT 1 FROM academic_class_changes c
                        WHERE c.slot_id = s.id AND c.on_date = p_date AND c.withdrawn_at IS NULL
                          AND c.kind IN ('cancelled', 'rescheduled'))
    UNION ALL
    SELECT c.slot_id, c.moved_room_id, c.moved_starts, c.moved_ends, o.faculty_user_id
      FROM academic_class_changes c
      JOIN academic_slots s ON s.id = c.slot_id
      JOIN academic_offerings o ON o.id = s.offering_id
     WHERE c.kind = 'rescheduled' AND c.moved_on = p_date AND c.withdrawn_at IS NULL
       AND c.id IS DISTINCT FROM p_except_change
  )
  SELECT CASE WHEN bool_or(room_id = p_room) THEN 'room' ELSE 'teacher' END
    FROM occurrences
   WHERE slot_id IS DISTINCT FROM p_except_slot
     AND tsrange('2000-01-01'::date + starts_at, '2000-01-01'::date + ends_at)
      && tsrange('2000-01-01'::date + p_starts, '2000-01-01'::date + p_ends)
     AND (room_id = p_room OR teacher = p_teacher)
  HAVING count(*) > 0
$$;
--> statement-breakpoint

-- A change is to a real meeting of the class -- its own weekday, inside its
-- term -- and does not double-book a room or a teacher. Only ever withdrawn,
-- once, with a reason.
CREATE OR REPLACE FUNCTION academic_class_change_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  s record;
  clash text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Gone with its institution or its slot; otherwise kept.
    IF EXISTS (SELECT 1 FROM institutions WHERE id = OLD.institution_id)
       AND EXISTS (SELECT 1 FROM academic_slots WHERE id = OLD.slot_id) THEN
      RAISE EXCEPTION 'a change is withdrawn, not deleted'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'academic_class_change_kept';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.withdrawn_at IS NOT NULL OR NEW.withdrawn_at IS NULL
       OR (to_jsonb(NEW) - ARRAY['withdrawn_at', 'withdrawn_by', 'withdraw_reason'])
          IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['withdrawn_at', 'withdrawn_by', 'withdraw_reason']) THEN
      RAISE EXCEPTION 'a change is only withdrawn, once'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'academic_class_change_fixed';
    END IF;
    RETURN NEW;
  END IF;

  SELECT sl.day_of_week, sl.starts_at, sl.ends_at, sl.room_id, o.faculty_user_id, t.starts_on, t.ends_on INTO s
    FROM academic_slots sl
    JOIN academic_offerings o ON o.id = sl.offering_id
    JOIN academic_terms t ON t.id = o.term_id
   WHERE sl.id = NEW.slot_id;
  IF extract(isodow FROM NEW.on_date) <> s.day_of_week THEN
    RAISE EXCEPTION 'the class does not meet on that day of the week'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'academic_class_change_day';
  END IF;
  IF NEW.on_date NOT BETWEEN s.starts_on AND s.ends_on
     OR (NEW.moved_on IS NOT NULL AND NEW.moved_on NOT BETWEEN s.starts_on AND s.ends_on) THEN
    RAISE EXCEPTION 'that date is outside the term'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'academic_class_change_term';
  END IF;

  IF NEW.kind = 'rescheduled' THEN
    clash := academic_class_busy(NEW.moved_on, NEW.moved_starts, NEW.moved_ends, NEW.moved_room_id, s.faculty_user_id, NEW.id,
                                 CASE WHEN NEW.moved_on = NEW.on_date THEN NEW.slot_id END);
  ELSIF NEW.kind = 'substitute' THEN
    IF NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.substitute_id AND role IN ('faculty', 'hod')) THEN
      RAISE EXCEPTION 'a substitute is a teacher'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'academic_class_change_substitute';
    END IF;
    IF NEW.substitute_id = s.faculty_user_id THEN
      RAISE EXCEPTION 'a substitute is somebody other than the lecturer'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'academic_class_change_substitute';
    END IF;
    clash := academic_class_busy(NEW.on_date, s.starts_at, s.ends_at, NULL, NEW.substitute_id, NEW.id, NEW.slot_id);
  END IF;
  IF clash = 'room' THEN
    RAISE EXCEPTION 'that room is taken then'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'academic_class_change_room_clash';
  ELSIF clash = 'teacher' THEN
    RAISE EXCEPTION 'that teacher is teaching then'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'academic_class_change_teacher_clash';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "academic_class_changes_guard" BEFORE INSERT OR UPDATE OR DELETE ON "academic_class_changes"
  FOR EACH ROW EXECUTE FUNCTION academic_class_change_guard();
