-- P1-09c, UX-04: a stored lower-cased receipt number with a tenant-leading index. Under row-level
-- security lower() and LIKE are not leakproof, so the old shape scanned every tenant's receipts
-- (NEW-175); equality on this column is an index condition, and any contains-search narrows to one
-- tenant first. Adding the column rewrites fee_payments once: run it in a quiet window on a large hub.
-- Numbered 0013 so 0010 to 0012 stay free for P1-03c to P1-03e, built in parallel; nothing here depends on them.
-- Pre-flight: fee_payments exists and has no receipt_no_key column. Adds only.
-- Rollback:
--   DROP INDEX IF EXISTS public.fee_payments_receipt_key;
--   ALTER TABLE public.fee_payments DROP COLUMN IF EXISTS receipt_no_key;
DO $$
BEGIN
  IF to_regclass('public.fee_payments') IS NULL THEN
    RAISE EXCEPTION 'record search needs fee_payments';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='fee_payments' AND column_name='receipt_no_key') THEN
    RAISE EXCEPTION 'fee_payments.receipt_no_key already exists';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE public.fee_payments ADD COLUMN receipt_no_key text GENERATED ALWAYS AS (lower(receipt_no)) STORED;
--> statement-breakpoint
CREATE INDEX fee_payments_receipt_key ON public.fee_payments (institution_id, receipt_no_key);
