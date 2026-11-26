-- P1-09c, UX-04: a stored lower-cased receipt number with a tenant-leading index. Under row-level
-- security lower() and LIKE are not leakproof, so the old shape scanned every tenant's receipts
-- (NEW-175); equality on this column is an index condition, and any contains-search narrows to one
-- tenant first.
-- The column is stored, so adding it rewrites fee_payments and rebuilds its indexes under an exclusive lock: run it in a
-- quiet window on a large hub. The statement timeout is lifted for this transaction, since the installer runs
-- migrations on the auth pool, whose limit is 30 s (measured: cancelled at 30 s past about 4.5M rows; NEW-80 class,
-- edited in place before any hub ran it). The lock wait is capped at 5 s so a migration stuck behind a long report
-- fails fast and is retried, instead of queueing every write behind it.
-- Numbered 0013 so 0010 to 0012 stay free for P1-03c to P1-03e, built in parallel; nothing here depends on them.
-- Pre-flight: fee_payments exists and has no receipt_no_key column. Adds only.
-- Rollback (re-run the guard function from 0009 to restore it):
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
SET LOCAL statement_timeout = 0;--> statement-breakpoint
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE public.fee_payments ADD COLUMN receipt_no_key text GENERATED ALWAYS AS (lower(receipt_no)) STORED;
--> statement-breakpoint
CREATE INDEX fee_payments_receipt_key ON public.fee_payments (institution_id, receipt_no_key);
--> statement-breakpoint

-- The amend guard compares a voided payment's whole row; a stored generated column is NULL in NEW inside a BEFORE
-- trigger, so the new key must be left out of that comparison or an ON DELETE SET NULL on a voided payment fails.
-- Same body as 0009 apart from the one name in the excluded list.
CREATE OR REPLACE FUNCTION fee_payments_guard_amend() RETURNS trigger AS $$
DECLARE
  reason text;
BEGIN
  IF NEW.receipt_no IS DISTINCT FROM OLD.receipt_no THEN
    RAISE EXCEPTION 'a receipt number cannot be reassigned'
      USING ERRCODE = 'check_violation',
            HINT = 'void the payment and record a new one';
  END IF;

  -- Voided or returned is final. Only the person columns an ON DELETE SET NULL
  -- clears may still change.
  IF OLD.status <> 'live'
     AND (to_jsonb(NEW) - ARRAY['recorded_by', 'reconciled_by', 'voided_by', 'receipt_no_key'])
         IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['recorded_by', 'reconciled_by', 'voided_by', 'receipt_no_key'])
  THEN
    RAISE EXCEPTION 'a voided or bounced payment is final'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'fee_payment_final';
  END IF;

  IF NEW.breakup IS DISTINCT FROM OLD.breakup THEN
    RAISE EXCEPTION 'a receipt''s fee breakup is printed and never changes'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'fee_payment_breakup_fixed';
  END IF;

  IF NEW.amount_paise IS DISTINCT FROM OLD.amount_paise
     OR NEW.student_id IS DISTINCT FROM OLD.student_id
     OR NEW.term_id IS DISTINCT FROM OLD.term_id
     OR NEW.method IS DISTINCT FROM OLD.method
     OR NEW.reference IS DISTINCT FROM OLD.reference
     OR NEW.received_at IS DISTINCT FROM OLD.received_at
     OR NEW.reconciled_at IS DISTINCT FROM OLD.reconciled_at
     OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.voided_at IS DISTINCT FROM OLD.voided_at
     OR NEW.void_reason IS DISTINCT FROM OLD.void_reason
     OR NEW.bounced_on IS DISTINCT FROM OLD.bounced_on
     OR NEW.drawer_ifsc IS DISTINCT FROM OLD.drawer_ifsc
     OR NEW.drawer_account IS DISTINCT FROM OLD.drawer_account
  THEN
    reason := nullif(current_setting('app.audit_reason', true), '');
    IF reason IS NULL THEN
      RAISE EXCEPTION
        'a recorded payment can only be amended through an audited change'
        USING ERRCODE = 'check_violation',
              HINT = 'call audit() in the same transaction, supplying a reason';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
