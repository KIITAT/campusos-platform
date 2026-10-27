-- P0-04: counters for abuse limits on sign-in, magic links, pairing, export
-- and the operator console (SEC-02, SEC-04, decision 197).
--
-- One row per (bucket, subject) in a fixed window. The subject (an address or
-- an account) is stored only as its SHA-256. Only campusos_rate_limit touches
-- the table: SECURITY DEFINER with a fixed search path, EXECUTE revoked from
-- PUBLIC. The web host's migrate grants EXECUTE to the auth role and the
-- console's scripts/role.mjs to the console role; the application role, which
-- plugins run as, is never granted it.
--
-- Adds only. Rollback:
--   DROP FUNCTION public.campusos_rate_limit(text, text, integer, integer);
--   DROP TABLE public.rate_limit_counters;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'campusos_app') THEN
    RAISE EXCEPTION 'role campusos_app does not exist. Run docker/init.sql, or the web host''s migrate, first.';
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE public.rate_limit_counters (
  bucket text NOT NULL,
  subject_hash text NOT NULL,
  hits integer NOT NULL,
  resets_at timestamptz NOT NULL,
  PRIMARY KEY (bucket, subject_hash)
);
--> statement-breakpoint
CREATE INDEX rate_limit_counters_resets_at ON public.rate_limit_counters (resets_at);
--> statement-breakpoint
ALTER TABLE public.rate_limit_counters ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.rate_limit_counters FROM PUBLIC, campusos_app;
--> statement-breakpoint
CREATE FUNCTION public.campusos_rate_limit(p_bucket text, p_subject text, p_limit integer, p_window_seconds integer)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_hash text;
  v_hits integer;
  v_resets timestamptz;
BEGIN
  IF p_bucket IS NULL OR p_bucket !~ '^[a-z][a-z0-9.]{0,63}$' OR p_subject IS NULL
     OR p_limit IS NULL OR p_limit < 1
     OR p_window_seconds IS NULL OR p_window_seconds < 1 OR p_window_seconds > 86400 THEN
    RAISE EXCEPTION 'campusos_rate_limit: invalid arguments';
  END IF;
  v_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_subject, 'UTF8')), 'hex');

  INSERT INTO public.rate_limit_counters AS c (bucket, subject_hash, hits, resets_at)
  VALUES (p_bucket, v_hash, 1, v_now + pg_catalog.make_interval(secs => p_window_seconds))
  ON CONFLICT (bucket, subject_hash) DO UPDATE
    SET hits = CASE WHEN c.resets_at <= v_now THEN 1 ELSE LEAST(c.hits, 1000000) + 1 END,
        resets_at = CASE WHEN c.resets_at <= v_now THEN EXCLUDED.resets_at ELSE c.resets_at END
  RETURNING c.hits, c.resets_at INTO v_hits, v_resets;

  -- Housekeeping, a little per call: windows that ended over an hour ago.
  DELETE FROM public.rate_limit_counters
   WHERE ctid = ANY (ARRAY(
     SELECT ctid FROM public.rate_limit_counters
      WHERE resets_at < v_now - interval '1 hour'
      LIMIT 50
      FOR UPDATE SKIP LOCKED));

  IF v_hits <= p_limit THEN
    RETURN 0;
  END IF;
  RETURN GREATEST(1, CEIL(EXTRACT(EPOCH FROM v_resets - v_now)))::integer;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.campusos_rate_limit(text, text, integer, integer) FROM PUBLIC;
