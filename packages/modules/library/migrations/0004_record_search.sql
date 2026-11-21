-- P1-09c, UX-04: trigram indexes so a title or author is found by any part of it (decision 1005).
-- Pre-flight: library_titles exists and pg_trgm is installed in public (core 0018). Adds only.
-- Rollback:
--   DROP INDEX IF EXISTS public.library_titles_author_trgm;
--   DROP INDEX IF EXISTS public.library_titles_title_trgm;
DO $$
BEGIN
  IF to_regclass('public.library_titles') IS NULL THEN
    RAISE EXCEPTION 'record search needs library_titles';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_opclass o JOIN pg_namespace n ON n.oid = o.opcnamespace
    WHERE n.nspname = 'public' AND o.opcname = 'gin_trgm_ops'
  ) THEN
    RAISE EXCEPTION 'record search needs pg_trgm in public (core migration 0018)';
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX library_titles_title_trgm ON public.library_titles
  USING gin (lower(title) public.gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX library_titles_author_trgm ON public.library_titles
  USING gin (lower(author) public.gin_trgm_ops);
