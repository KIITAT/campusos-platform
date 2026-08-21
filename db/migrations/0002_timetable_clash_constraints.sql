-- Timetable clash prevention. Hand-written because drizzle-kit has no builder
-- for EXCLUDE constraints or triggers, and an application-level "check then
-- insert" is a race.
--
-- Ranges are half-open, so 09:00-10:00 and 10:00-11:00 are adjacent, not
-- overlapping. The date literal only exists to give the times a range type;
-- date + time is immutable, so the expression is indexable.

CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint

-- A room cannot host two overlapping slots on the same weekday. Fully
-- race-safe: the index itself rejects the conflicting insert.
ALTER TABLE "academic_slots"
  ADD CONSTRAINT "academic_slots_room_no_overlap"
  EXCLUDE USING gist (
    "room_id" WITH =,
    "day_of_week" WITH =,
    tsrange('2000-01-01'::date + "starts_at", '2000-01-01'::date + "ends_at") WITH &&
  );
--> statement-breakpoint

-- A lecturer cannot be in two places at once. This needs a trigger rather than
-- a second EXCLUDE constraint because the faculty member lives on
-- academic_offerings, and an exclusion constraint cannot span tables.
--
-- ponytail: a constraint trigger is not immune to two concurrent inserts that
-- each pass their own check. Timetable editing is one registrar at a time, so
-- that is an acceptable ceiling. If concurrent editing ever becomes real,
-- denormalise faculty_user_id onto academic_slots and replace this with a
-- second EXCLUDE constraint, which is race-safe.
CREATE OR REPLACE FUNCTION academic_slots_faculty_no_overlap() RETURNS trigger AS $$
DECLARE
  faculty text;
  clash_id uuid;
BEGIN
  SELECT o.faculty_user_id INTO faculty
    FROM academic_offerings o WHERE o.id = NEW.offering_id;

  -- An unstaffed offering cannot clash with anything.
  IF faculty IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT s.id INTO clash_id
    FROM academic_slots s
    JOIN academic_offerings o ON o.id = s.offering_id
   WHERE o.faculty_user_id = faculty
     AND s.day_of_week = NEW.day_of_week
     AND s.id <> NEW.id
     AND tsrange('2000-01-01'::date + s.starts_at, '2000-01-01'::date + s.ends_at)
      && tsrange('2000-01-01'::date + NEW.starts_at, '2000-01-01'::date + NEW.ends_at)
   LIMIT 1;

  IF clash_id IS NOT NULL THEN
    RAISE EXCEPTION
      'lecturer % is already booked in an overlapping slot on day %',
      faculty, NEW.day_of_week
      USING ERRCODE = '23P01';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER "academic_slots_faculty_no_overlap"
  AFTER INSERT OR UPDATE ON "academic_slots"
  FOR EACH ROW EXECUTE FUNCTION academic_slots_faculty_no_overlap();
