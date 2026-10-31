-- P1-08c: a counsellor is named by one administrator and made active by
-- another (AUD-07). No row is changed: a counsellor who named themselves stays
-- as they are (see KIITAT docs/audit/tools/p108c-diagnostics.sql). Only new
-- rows are held to the rule, by the service and by the trigger below.
--
-- Rollback:
--   DROP TRIGGER care_counsellors_confirm ON care_counsellors;
--   DROP FUNCTION care_counsellor_confirm_guard();
--   ALTER TABLE care_counsellors ALTER COLUMN active SET DEFAULT true, DROP COLUMN confirmed_at, DROP COLUMN confirmed_by;
DO $$ BEGIN
  IF to_regclass('public.care_counsellors') IS NULL THEN
    RAISE EXCEPTION 'care 0000 must be applied first';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE care_counsellors ADD COLUMN confirmed_by text REFERENCES users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE care_counsellors ADD COLUMN confirmed_at timestamptz;
--> statement-breakpoint
ALTER TABLE care_counsellors ALTER COLUMN active SET DEFAULT false;
--> statement-breakpoint
CREATE FUNCTION care_counsellor_confirm_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF (TG_OP = 'INSERT' OR NEW.added_by IS DISTINCT FROM OLD.added_by)
     AND NEW.added_by IS NOT NULL AND NEW.added_by = NEW.user_id THEN
    RAISE EXCEPTION 'nobody names or confirms themselves as a counsellor'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'care_counsellor_self';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.active THEN
    RAISE EXCEPTION 'a counsellor is named first, then made active by another administrator'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'care_counsellor_unconfirmed';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.active AND NOT OLD.active THEN
    IF NEW.confirmed_by IS NULL THEN
      RAISE EXCEPTION 'a counsellor is named first, then made active by another administrator'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'care_counsellor_unconfirmed';
    END IF;
    IF NEW.confirmed_by = NEW.user_id THEN
      RAISE EXCEPTION 'nobody names or confirms themselves as a counsellor'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'care_counsellor_self';
    END IF;
    IF NEW.confirmed_by = NEW.added_by AND (
         SELECT count(*) FROM public.users
          WHERE institution_id = NEW.institution_id
            AND role IN ('institution_admin', 'super_admin') AND erased_at IS NULL) > 1 THEN
      RAISE EXCEPTION 'another administrator makes a counsellor active'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'care_counsellor_second';
    END IF;
    NEW.confirmed_at := now();
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.active AND NOT NEW.active THEN
    NEW.confirmed_by := NULL;
    NEW.confirmed_at := NULL;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER care_counsellors_confirm BEFORE INSERT OR UPDATE ON care_counsellors
  FOR EACH ROW EXECUTE FUNCTION care_counsellor_confirm_guard();
