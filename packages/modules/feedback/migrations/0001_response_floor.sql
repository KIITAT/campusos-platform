-- P1-08c: results need at least three answers (AUD-10, decision D18/D19 of plans/P1-08c.md).
-- Windows with a threshold below three are raised to three. That only hides
-- results that a smaller group could have shown; it reveals nothing. A
-- submitted window cannot otherwise be changed (campusos_docstatus_guard), so
-- the two guards are switched off for the one statement, in this transaction.
--
-- Rollback (the raised values stay; they are valid under the old check):
--   ALTER TABLE feedback_windows DROP CONSTRAINT feedback_windows_min;
--   ALTER TABLE feedback_windows ADD CONSTRAINT feedback_windows_min CHECK (min_responses BETWEEN 1 AND 50);
DO $$ BEGIN
  RAISE NOTICE 'raising % feedback windows to a threshold of 3',
    (SELECT count(*) FROM feedback_windows WHERE min_responses < 3);
END $$;
--> statement-breakpoint
ALTER TABLE feedback_windows DISABLE TRIGGER feedback_windows_docstatus;
--> statement-breakpoint
ALTER TABLE feedback_windows DISABLE TRIGGER feedback_windows_guard;
--> statement-breakpoint
UPDATE feedback_windows SET min_responses = 3 WHERE min_responses < 3;
--> statement-breakpoint
ALTER TABLE feedback_windows ENABLE TRIGGER feedback_windows_docstatus;
--> statement-breakpoint
ALTER TABLE feedback_windows ENABLE TRIGGER feedback_windows_guard;
--> statement-breakpoint
ALTER TABLE feedback_windows DROP CONSTRAINT feedback_windows_min;
--> statement-breakpoint
ALTER TABLE feedback_windows ADD CONSTRAINT feedback_windows_min CHECK (min_responses BETWEEN 3 AND 50);
