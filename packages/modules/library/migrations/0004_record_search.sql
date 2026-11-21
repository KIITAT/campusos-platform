-- P1-09c, UX-04: stored lower-cased title and author with tenant-leading indexes, so an exact lookup
-- is an index condition under row-level security (lower() and LIKE are not leakproof: NEW-175) and
-- a contains-search narrows to one tenant first.
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
ALTER TABLE public.library_titles
  ADD COLUMN title_key text GENERATED ALWAYS AS (lower(title)) STORED,
  ADD COLUMN author_key text GENERATED ALWAYS AS (lower(author)) STORED;
--> statement-breakpoint
CREATE INDEX library_titles_title_key ON public.library_titles (institution_id, title_key);
--> statement-breakpoint
CREATE INDEX library_titles_author_key ON public.library_titles (institution_id, author_key);
