-- P0-10: the solver leaves the request thread (REL-01, decisions 218 and 219).
--
-- A run is inserted as 'solving' and becomes a draft when the worker thread
-- finishes, or 'failed' (with why) or 'cancelled'. One solving run per
-- institution. The solver's limit is capped at 120 seconds; a limit set above
-- it is lowered to 120 (counted in a NOTICE below).
--
-- Pre-flight: no run is in a new status yet (they do not exist); settings above
-- 120 are reported and lowered, nothing else is rewritten.
-- Rollback (loses failed and cancelled run rows):
--   DELETE FROM timetable_runs WHERE status IN ('solving','failed','cancelled');
--   DROP INDEX timetable_runs_one_solving;
--   ALTER TABLE timetable_runs DROP CONSTRAINT timetable_runs_error, DROP CONSTRAINT timetable_runs_solving_deadline, DROP COLUMN error, DROP COLUMN solve_deadline;
--   ALTER TABLE timetable_runs DROP CONSTRAINT timetable_runs_status, ADD CONSTRAINT timetable_runs_status CHECK (status in ('draft','applied','discarded','superseded'));
--   ALTER TABLE timetable_settings DROP CONSTRAINT timetable_settings_time, ADD CONSTRAINT timetable_settings_time CHECK (time_limit_seconds between 1 and 600);
-- with timetable 0.4.0.

DO $$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM timetable_settings WHERE time_limit_seconds > 120;
  IF n > 0 THEN
    RAISE NOTICE 'timetable 0001: % institution(s) had a solver limit above 120 seconds; it is now 120', n;
  END IF;
END $$;
--> statement-breakpoint
UPDATE "timetable_settings" SET "time_limit_seconds" = 120 WHERE "time_limit_seconds" > 120;--> statement-breakpoint
ALTER TABLE "timetable_settings" DROP CONSTRAINT "timetable_settings_time";--> statement-breakpoint
ALTER TABLE "timetable_settings" ADD CONSTRAINT "timetable_settings_time" CHECK (time_limit_seconds between 1 and 120);--> statement-breakpoint
ALTER TABLE "timetable_runs" DROP CONSTRAINT "timetable_runs_status";--> statement-breakpoint
ALTER TABLE "timetable_runs" ADD CONSTRAINT "timetable_runs_status" CHECK (status in ('solving', 'draft', 'applied', 'discarded', 'superseded', 'failed', 'cancelled'));--> statement-breakpoint
ALTER TABLE "timetable_runs" ADD COLUMN "solve_deadline" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "timetable_runs" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "timetable_runs" ADD CONSTRAINT "timetable_runs_error" CHECK (error is null or error in ('interrupted', 'timed_out', 'out_of_memory', 'crashed', 'cancelled', 'not_permitted'));--> statement-breakpoint
ALTER TABLE "timetable_runs" ADD CONSTRAINT "timetable_runs_solving_deadline" CHECK ((status = 'solving') = (solve_deadline is not null));--> statement-breakpoint
CREATE UNIQUE INDEX "timetable_runs_one_solving" ON "timetable_runs" USING btree ("institution_id") WHERE status = 'solving';
