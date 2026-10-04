-- A weekly slot meets only during its term.
--
-- The clash rules from 0001 compared every slot with every other, whatever the
-- term: Room 101 on Mondays at 09:00 in the autumn blocked Room 101 on Mondays
-- at 09:00 in the spring, and a lecturer's last-term timetable blocked their
-- next one. Each slot now carries its term's dates, kept by trigger from the
-- offering, and two slots clash only when their terms' dates overlap too.
--
-- And an offering's teacher changing is now checked against the new teacher's
-- other slots. Before, only a slot being written was checked, so handing a
-- class to a teacher already busy at that hour went through.

ALTER TABLE "academic_slots" ADD COLUMN "term_dates" daterange;
--> statement-breakpoint
UPDATE "academic_slots" s
   SET "term_dates" = daterange(t."starts_on", t."ends_on", '[]')
  FROM "academic_offerings" o
  JOIN "academic_terms" t ON t."id" = o."term_id"
 WHERE o."id" = s."offering_id";
--> statement-breakpoint
ALTER TABLE "academic_slots" ALTER COLUMN "term_dates" SET NOT NULL;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION academic_slots_term_dates() RETURNS trigger AS $$
BEGIN
  SELECT daterange(t.starts_on, t.ends_on, '[]') INTO NEW.term_dates
    FROM academic_offerings o
    JOIN academic_terms t ON t.id = o.term_id
   WHERE o.id = NEW.offering_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "academic_slots_term_dates"
  BEFORE INSERT OR UPDATE OF "offering_id" ON "academic_slots"
  FOR EACH ROW EXECUTE FUNCTION academic_slots_term_dates();
--> statement-breakpoint

-- A term's dates moving, or an offering moving term, carries its slots along.
CREATE OR REPLACE FUNCTION academic_terms_slot_dates() RETURNS trigger AS $$
BEGIN
  UPDATE academic_slots s
     SET term_dates = daterange(NEW.starts_on, NEW.ends_on, '[]')
    FROM academic_offerings o
   WHERE o.id = s.offering_id AND o.term_id = NEW.id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "academic_terms_slot_dates"
  AFTER UPDATE OF "starts_on", "ends_on" ON "academic_terms"
  FOR EACH ROW
  WHEN (OLD.starts_on IS DISTINCT FROM NEW.starts_on OR OLD.ends_on IS DISTINCT FROM NEW.ends_on)
  EXECUTE FUNCTION academic_terms_slot_dates();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION academic_offerings_slot_dates() RETURNS trigger AS $$
BEGIN
  UPDATE academic_slots s
     SET term_dates = (SELECT daterange(t.starts_on, t.ends_on, '[]') FROM academic_terms t WHERE t.id = NEW.term_id)
   WHERE s.offering_id = NEW.id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "academic_offerings_slot_dates"
  AFTER UPDATE OF "term_id" ON "academic_offerings"
  FOR EACH ROW WHEN (OLD.term_id IS DISTINCT FROM NEW.term_id)
  EXECUTE FUNCTION academic_offerings_slot_dates();
--> statement-breakpoint

-- Rooms: the same exclusion as before, now only between overlapping terms.
ALTER TABLE "academic_slots" DROP CONSTRAINT "academic_slots_room_no_overlap";
--> statement-breakpoint
ALTER TABLE "academic_slots"
  ADD CONSTRAINT "academic_slots_room_no_overlap"
  EXCLUDE USING gist (
    "room_id" WITH =,
    "day_of_week" WITH =,
    tsrange('2000-01-01'::date + "starts_at", '2000-01-01'::date + "ends_at") WITH &&,
    "term_dates" WITH &&
  );
--> statement-breakpoint

-- Lecturers: the trigger from 0001, now only between overlapping terms.
CREATE OR REPLACE FUNCTION academic_slots_faculty_no_overlap() RETURNS trigger AS $$
DECLARE
  faculty text;
  clash_id uuid;
BEGIN
  SELECT o.faculty_user_id INTO faculty
    FROM academic_offerings o WHERE o.id = NEW.offering_id;

  IF faculty IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT s.id INTO clash_id
    FROM academic_slots s
    JOIN academic_offerings o ON o.id = s.offering_id
   WHERE o.faculty_user_id = faculty
     AND s.day_of_week = NEW.day_of_week
     AND s.id <> NEW.id
     AND s.term_dates && NEW.term_dates
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

-- A class given to a teacher must not land on their other classes.
CREATE OR REPLACE FUNCTION academic_offerings_faculty_no_overlap() RETURNS trigger AS $$
DECLARE
  clash_id uuid;
BEGIN
  IF NEW.faculty_user_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT mine.id INTO clash_id
    FROM academic_slots mine
    JOIN academic_slots other ON other.day_of_week = mine.day_of_week
     AND other.id <> mine.id
     AND other.offering_id <> NEW.id
     AND other.term_dates && mine.term_dates
     AND tsrange('2000-01-01'::date + other.starts_at, '2000-01-01'::date + other.ends_at)
      && tsrange('2000-01-01'::date + mine.starts_at, '2000-01-01'::date + mine.ends_at)
    JOIN academic_offerings o ON o.id = other.offering_id AND o.faculty_user_id = NEW.faculty_user_id
   WHERE mine.offering_id = NEW.id
   LIMIT 1;

  IF clash_id IS NOT NULL THEN
    RAISE EXCEPTION
      'lecturer % is already booked when this class meets',
      NEW.faculty_user_id
      USING ERRCODE = '23P01';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "academic_offerings_faculty_no_overlap"
  AFTER UPDATE OF "faculty_user_id" ON "academic_offerings"
  FOR EACH ROW EXECUTE FUNCTION academic_offerings_faculty_no_overlap();
