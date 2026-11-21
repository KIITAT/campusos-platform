-- P1-09c, UX-04: stored lower-cased title and author with tenant-leading indexes, so an exact lookup
-- is an index condition under row-level security (lower() and LIKE are not leakproof: NEW-175) and
-- a contains-search narrows to one tenant first.
-- The column is stored, so adding it rewrites library_titles and rebuilds its indexes under an exclusive lock: run it in a
-- quiet window on a large hub. The statement timeout is lifted for this transaction, since the installer runs
-- migrations on the auth pool, whose limit is 30 s (measured: cancelled at 30 s past about 4.5M rows; NEW-80 class,
-- edited in place before any hub ran it). The lock wait is capped at 5 s so a migration stuck behind a long report
-- fails fast and is retried, instead of queueing every write behind it.
-- Pre-flight: library_titles exists and has neither column. Adds only.
-- Rollback:
--   DROP INDEX IF EXISTS public.library_titles_author_key;
--   DROP INDEX IF EXISTS public.library_titles_title_key;
--   ALTER TABLE public.library_titles DROP COLUMN IF EXISTS author_key, DROP COLUMN IF EXISTS title_key;
DO $$
BEGIN
  IF to_regclass('public.library_titles') IS NULL THEN
    RAISE EXCEPTION 'record search needs library_titles';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='library_titles' AND column_name IN ('title_key','author_key')) THEN
    RAISE EXCEPTION 'library_titles already has title_key or author_key';
  END IF;
END $$;
--> statement-breakpoint
SET LOCAL statement_timeout = 0;--> statement-breakpoint
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE public.library_titles
  ADD COLUMN title_key text GENERATED ALWAYS AS (lower(title)) STORED,
  ADD COLUMN author_key text GENERATED ALWAYS AS (lower(author)) STORED;
--> statement-breakpoint
CREATE INDEX library_titles_title_key ON public.library_titles (institution_id, title_key);
--> statement-breakpoint
CREATE INDEX library_titles_author_key ON public.library_titles (institution_id, author_key);
