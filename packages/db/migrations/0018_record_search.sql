-- Record search (P1-09c, UX-04): a stored, lower-cased copy of a name so a lookup compares a plain
-- column. Under row-level security lower() and LIKE are not leakproof and cannot be index conditions
-- (NEW-175); equality on a stored column can, and a (institution_id, name_key) index narrows to one tenant.
-- The column is stored, so adding it rewrites public.users and rebuilds its indexes under an exclusive lock: run it in a
-- quiet window on a large hub. The statement timeout is lifted for this transaction, since the installer runs
-- migrations on the auth pool, whose limit is 30 s (measured: cancelled at 30 s past about 4.5M rows; NEW-80 class,
-- edited in place before any hub ran it). The lock wait is capped at 5 s so a migration stuck behind a long report
-- fails fast and is retried, instead of queueing every write behind it.
-- Pre-flight: public.users exists and has no name_key column yet (aborts otherwise).
-- Rollback (no data is lost; the column is derived):
--   DROP INDEX IF EXISTS public.campusos_users_student_name_key;
--   ALTER TABLE public.users DROP COLUMN IF EXISTS name_key;
DO $$
BEGIN
  IF to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION 'record search requires public.users';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='name_key') THEN
    RAISE EXCEPTION 'users.name_key already exists';
  END IF;
END $$;
--> statement-breakpoint
SET LOCAL statement_timeout = 0;--> statement-breakpoint
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE public.users ADD COLUMN name_key text GENERATED ALWAYS AS (lower(coalesce(name, ''))) STORED;
--> statement-breakpoint
CREATE INDEX campusos_users_student_name_key ON public.users (institution_id, name_key)
  WHERE role = 'student' AND erased_at IS NULL;
