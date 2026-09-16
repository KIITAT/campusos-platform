-- Split from the monorepo history (0011_hostel_occupancy_guard.sql) when modules became
-- installable plugins. Applied by the host at install time, in this order.

-- A room cannot hold more students than it has beds, and a student cannot take
-- leave twice over the same night.
--
-- Both are race conditions if left to the application: two wardens allocating
-- the last bed at the same moment each read "one free" and each write. The first
-- is a locked recount, the second an exclusion constraint, which is race-free by
-- construction.

CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION hostel_room_has_room() RETURNS trigger AS $$
DECLARE
  beds int;
  taken int;
  block_kind hostel_block_kind;
BEGIN
  -- Closing an allocation frees a bed; it never needs checking.
  IF NEW.vacated_on IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- FOR UPDATE on the room row serialises two wardens racing for the last bed:
  -- the second waits, then recounts and sees the first one's student.
  SELECT r.capacity, b.kind INTO beds, block_kind
    FROM hostel_rooms r
    JOIN hostel_blocks b ON b.id = r.block_id
   WHERE r.id = NEW.room_id
     FOR UPDATE OF r;

  IF beds IS NULL THEN
    RAISE EXCEPTION 'allocation refers to a room that does not exist'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  SELECT count(*) INTO taken
    FROM hostel_allocations a
   WHERE a.room_id = NEW.room_id
     AND a.vacated_on IS NULL
     AND a.id IS DISTINCT FROM NEW.id;

  IF taken >= beds THEN
    RAISE EXCEPTION 'that room is full: % of % beds taken', taken, beds
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER hostel_room_has_room
  AFTER INSERT OR UPDATE ON "hostel_allocations"
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION hostel_room_has_room();
--> statement-breakpoint

-- Overlapping leave for one student would make a roll call ambiguous: two rows
-- could disagree about why the bed is empty. Ranges are inclusive of both ends
-- here, because leave "from the 4th to the 6th" includes the 6th.
ALTER TABLE "hostel_leaves"
  ADD CONSTRAINT hostel_leaves_no_overlap
  EXCLUDE USING gist (
    student_id WITH =,
    daterange(from_on, to_on, '[]') WITH &&
  );
--> statement-breakpoint

-- A vacated allocation is history. Re-pointing one at another student or room
-- would rewrite who slept where, which is exactly the record somebody official
-- asks for. Correcting it takes an audited reason, as everywhere else.
CREATE OR REPLACE FUNCTION hostel_allocation_history_honest() RETURNS trigger AS $$
BEGIN
  IF (NEW.student_id IS DISTINCT FROM OLD.student_id
      OR NEW.room_id IS DISTINCT FROM OLD.room_id
      OR NEW.allocated_on IS DISTINCT FROM OLD.allocated_on)
     AND nullif(current_setting('app.audit_reason', true), '') IS NULL
  THEN
    RAISE EXCEPTION 'an allocation cannot be re-pointed at another student or room'
      USING ERRCODE = 'check_violation',
            HINT = 'vacate it and allocate again, or record why';
  END IF;

  IF OLD.vacated_on IS NOT NULL
     AND NEW.vacated_on IS NULL
     AND nullif(current_setting('app.audit_reason', true), '') IS NULL
  THEN
    RAISE EXCEPTION 'reopening a closed allocation requires an audited reason'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER hostel_allocation_history_honest
  BEFORE UPDATE ON "hostel_allocations"
  FOR EACH ROW EXECUTE FUNCTION hostel_allocation_history_honest();
--> statement-breakpoint

-- A resident is checked in against the block they actually live in. Recording a
-- student present in a block they were never allocated is not a typo worth
-- keeping: it is the roll call quietly becoming fiction.
CREATE OR REPLACE FUNCTION hostel_check_in_resident() RETURNS trigger AS $$
DECLARE
  lives_here boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
      FROM hostel_allocations a
      JOIN hostel_rooms r ON r.id = a.room_id
     WHERE a.student_id = NEW.student_id
       AND r.block_id = NEW.block_id
       AND a.allocated_on <= NEW.on_night
       -- Strictly greater: a student who vacated on the 6th slept elsewhere on
       -- the night of the 6th, exactly as one who arrives on the 6th sleeps
       -- here that night.
       AND (a.vacated_on IS NULL OR a.vacated_on > NEW.on_night)
  ) INTO lives_here;

  IF NOT lives_here THEN
    RAISE EXCEPTION 'that student was not resident in this block on %', NEW.on_night
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER hostel_check_in_resident
  BEFORE INSERT OR UPDATE ON "hostel_check_ins"
  FOR EACH ROW EXECUTE FUNCTION hostel_check_in_resident();
