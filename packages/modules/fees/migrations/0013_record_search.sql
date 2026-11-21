-- P1-09c, UX-04: a trigram index so a receipt number is found by any part of it (decision 1005).
-- Numbered 0013 so 0010 to 0012 stay free for P1-03c to P1-03e, built in parallel; nothing here depends on them.
-- Pre-flight: fee_payments exists and pg_trgm is installed in public (core 0018). Adds only.
-- Rollback: DROP INDEX IF EXISTS public.fee_payments_receipt_lookup;
DO $$
BEGIN
  IF to_regclass('public.fee_payments') IS NULL THEN
    RAISE EXCEPTION 'record search needs fee_payments';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_opclass o JOIN pg_namespace n ON n.oid = o.opcnamespace
    WHERE n.nspname = 'public' AND o.opcname = 'gin_trgm_ops'
  ) THEN
    RAISE EXCEPTION 'record search needs pg_trgm in public (core migration 0018)';
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX fee_payments_receipt_lookup ON public.fee_payments
  USING gin (lower(receipt_no) public.gin_trgm_ops);
