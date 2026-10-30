-- P1-08a: what each module holds about a person, for erasure and export
-- (AUD-03, NEW-02, decisions 220-222).
--
-- Schema dpdp_subject holds, per module, at most one function
--   dpdp_subject.erase_<module>(who text) RETURNS jsonb   -- SECURITY INVOKER
-- that overwrites the person's free text and contact data in that module and
-- returns {"<table>": rows changed}, and at most one view
--   dpdp_subject.<module>_about (subject_id text, source text, row_data jsonb)
-- WITH (security_invoker = true), for rows about the person that no foreign
-- key to users reaches. Both run with the caller's rights and RLS, so they
-- see one institution. A definer function or a view without security_invoker
-- makes every erasure or export fail, never succeed partly.
--
-- Adds only. Rollback, after rolling back every module's <n>_dpdp_subject.sql:
--   DROP FUNCTION public.campusos_forget_credentials(text);
--   DROP FUNCTION public.campusos_subject_about(text);
--   DROP FUNCTION public.campusos_erase_subject(text);
--   DROP FUNCTION public.campusos_erasure_allows(text, jsonb, jsonb, text[]);
--   DROP SCHEMA dpdp_subject CASCADE;

-- Pre-flight: the app role must exist.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'campusos_app') THEN
    RAISE EXCEPTION 'role campusos_app does not exist. Run docker/init.sql, or the web host''s migrate, first.';
  END IF;
END $$;
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS dpdp_subject;
--> statement-breakpoint
REVOKE ALL ON SCHEMA dpdp_subject FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA dpdp_subject TO campusos_app;
--> statement-breakpoint
-- A module guard that keeps a row "as written" lets one update through: the
-- person it is about has been erased, and only the listed columns change.
CREATE FUNCTION public.campusos_erasure_allows(who text, old jsonb, new jsonb, cols text[])
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
  SELECT EXISTS (SELECT 1 FROM public.users u WHERE u.id = who AND u.erased_at IS NOT NULL)
     AND (old - cols) = (new - cols)
$$;
--> statement-breakpoint
CREATE FUNCTION public.campusos_erase_subject(who text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  f record;
  part jsonb;
  result jsonb := '{}'::jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = who AND u.erased_at IS NOT NULL) THEN
    RAISE EXCEPTION 'erase the person before their records' USING ERRCODE = 'check_violation';
  END IF;
  FOR f IN
    SELECT p.proname, p.prosecdef FROM pg_catalog.pg_proc p
     WHERE p.pronamespace = 'dpdp_subject'::pg_catalog.regnamespace AND p.proname LIKE 'erase\_%'
     ORDER BY p.proname
  LOOP
    IF f.prosecdef THEN
      RAISE EXCEPTION 'dpdp_subject.% must be SECURITY INVOKER', f.proname;
    END IF;
    EXECUTE pg_catalog.format('SELECT dpdp_subject.%I($1)', f.proname) INTO part USING who;
    result := result || COALESCE(part, '{}'::jsonb);
  END LOOP;
  RETURN result;
END
$$;
--> statement-breakpoint
CREATE FUNCTION public.campusos_subject_about(who text)
RETURNS TABLE (view_name text, source text, row_data jsonb)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v record;
BEGIN
  FOR v IN
    SELECT c.relname, c.reloptions FROM pg_catalog.pg_class c
     WHERE c.relnamespace = 'dpdp_subject'::pg_catalog.regnamespace AND c.relkind = 'v'
     ORDER BY c.relname
  LOOP
    IF NOT ('security_invoker=true' = ANY (COALESCE(v.reloptions, '{}'::text[]))) THEN
      RAISE EXCEPTION 'dpdp_subject.% must be a security_invoker view', v.relname;
    END IF;
    RETURN QUERY EXECUTE pg_catalog.format(
      'SELECT %L::text, x.source, x.row_data FROM dpdp_subject.%I x WHERE x.subject_id = $1',
      v.relname, v.relname) USING who;
  END LOOP;
END
$$;
--> statement-breakpoint
-- Sign-in material of an erased person (NEW-02). The app role cannot touch
-- these tables (SEC-05); this does it for one person, only once they are
-- erased, and only in the caller's institution, as campusos_end_sessions does.
CREATE FUNCTION public.campusos_forget_credentials(who text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  inst uuid := nullif(current_setting('app.institution_id', true), '')::uuid;
  n_sessions integer;
  n_accounts integer;
  n_devices integer;
  n_invitations integer;
BEGIN
  IF inst IS NULL OR NOT EXISTS (
    SELECT 1 FROM users WHERE id = who AND institution_id = inst AND erased_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'credentials are removed only for a person erased in this institution'
      USING ERRCODE = 'check_violation';
  END IF;
  DELETE FROM sessions WHERE "userId" = who;
  GET DIAGNOSTICS n_sessions = ROW_COUNT;
  DELETE FROM accounts WHERE "userId" = who;
  GET DIAGNOSTICS n_accounts = ROW_COUNT;
  DELETE FROM device_tokens WHERE user_id = who AND institution_id = inst;
  GET DIAGNOSTICS n_devices = ROW_COUNT;
  UPDATE invitations SET email = 'erased+' || id || '@invalid'
   WHERE user_id = who AND institution_id = inst AND email NOT LIKE 'erased+%';
  GET DIAGNOSTICS n_invitations = ROW_COUNT;
  RETURN jsonb_build_object('sessions', n_sessions, 'accounts', n_accounts,
                            'device_tokens', n_devices, 'invitations', n_invitations);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.campusos_erasure_allows(text, jsonb, jsonb, text[]) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.campusos_erase_subject(text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.campusos_subject_about(text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.campusos_forget_credentials(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.campusos_erasure_allows(text, jsonb, jsonb, text[]) TO campusos_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.campusos_erase_subject(text) TO campusos_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.campusos_subject_about(text) TO campusos_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.campusos_forget_credentials(text) TO campusos_app;
