-- Split from the monorepo history (0007_reconciled_payment_guard.sql) when modules became
-- installable plugins. Applied by the host at install time, in this order.

-- Money already receipted is a document of record.
--
-- Same mechanism as the published-marks guard (0005): audit() sets
-- app.audit_reason transaction-locally, and these triggers refuse the write
-- when it is absent. So a fee ledger can only be altered by a path that has
-- written down why, and a psql session cannot quietly change what a student
-- was told they paid.
--
-- Three guarantees, in descending strictness:
--   1. a receipt number never changes, for any reason
--   2. a reconciled payment is never deleted
--   3. anything else on a payment row needs an audited reason
-- plus two arithmetic invariants the application also checks, so that the
-- check surviving is not a matter of remembering to call the helper.

-- 1 + 3 ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fee_payments_guard_amend() RETURNS trigger AS $$
DECLARE
  reason text;
BEGIN
  -- A receipt number is printed and handed over. Reassigning one would point
  -- two records at the same piece of paper, so no reason unlocks this.
  IF NEW.receipt_no IS DISTINCT FROM OLD.receipt_no THEN
    RAISE EXCEPTION 'a receipt number cannot be reassigned'
      USING ERRCODE = 'check_violation',
            HINT = 'reverse the payment and record a new one';
  END IF;

  -- Everything the student or the bank can see, including un-reconciling.
  IF NEW.amount_paise IS DISTINCT FROM OLD.amount_paise
     OR NEW.student_id IS DISTINCT FROM OLD.student_id
     OR NEW.term_id IS DISTINCT FROM OLD.term_id
     OR NEW.method IS DISTINCT FROM OLD.method
     OR NEW.reference IS DISTINCT FROM OLD.reference
     OR NEW.received_at IS DISTINCT FROM OLD.received_at
     OR NEW.reconciled_at IS DISTINCT FROM OLD.reconciled_at
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
--> statement-breakpoint

CREATE TRIGGER fee_payments_guard_amend
  BEFORE UPDATE ON "fee_payments"
  FOR EACH ROW EXECUTE FUNCTION fee_payments_guard_amend();
--> statement-breakpoint

-- 2 ----------------------------------------------------------------------
-- Once matched against the bank, the money moved. Deleting the row would
-- leave the institution's books disagreeing with its statement.
CREATE OR REPLACE FUNCTION fee_payments_guard_delete() RETURNS trigger AS $$
BEGIN
  -- A cascade is not an amendment. Deleting the institution row offboards the
  -- whole tenant, and its ledger going with it is the point; depth > 1 means
  -- this delete was issued by another trigger, i.e. the FK cascade, not by
  -- somebody reaching for a single payment.
  IF pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;

  IF OLD.reconciled_at IS NOT NULL THEN
    RAISE EXCEPTION 'a reconciled payment cannot be deleted'
      USING ERRCODE = 'check_violation',
            HINT = 'record a refund or an adjusting entry instead';
  END IF;

  IF nullif(current_setting('app.audit_reason', true), '') IS NULL THEN
    RAISE EXCEPTION 'deleting a payment requires an audited reason'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER fee_payments_guard_delete
  BEFORE DELETE ON "fee_payments"
  FOR EACH ROW EXECUTE FUNCTION fee_payments_guard_delete();
--> statement-breakpoint

-- A receipt counter that goes backwards re-issues a number already printed.
-- Monotonic is the whole contract of the table.
CREATE OR REPLACE FUNCTION fee_receipt_counters_forward_only() RETURNS trigger AS $$
BEGIN
  IF NEW.next < OLD.next THEN
    RAISE EXCEPTION 'a receipt counter cannot move backwards (% -> %)', OLD.next, NEW.next
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.prefix IS DISTINCT FROM OLD.prefix
     AND nullif(current_setting('app.audit_reason', true), '') IS NULL
  THEN
    RAISE EXCEPTION 'changing a receipt prefix requires an audited reason'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER fee_receipt_counters_forward_only
  BEFORE UPDATE ON "fee_receipt_counters"
  FOR EACH ROW EXECUTE FUNCTION fee_receipt_counters_forward_only();
--> statement-breakpoint

-- A waiver larger than the charge it waives is a negative fee: it would turn
-- into a credit nobody approved. grantWaiver refuses it; so does the database.
CREATE OR REPLACE FUNCTION fee_waivers_within_charge() RETURNS trigger AS $$
DECLARE
  charged bigint;
BEGIN
  SELECT i.amount_paise INTO charged FROM fee_items i WHERE i.id = NEW.fee_item_id;

  IF charged IS NULL THEN
    RAISE EXCEPTION 'waiver refers to a fee item that does not exist'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NEW.amount_paise > charged THEN
    RAISE EXCEPTION 'a waiver of % cannot exceed the charge of %', NEW.amount_paise, charged
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER fee_waivers_within_charge
  BEFORE INSERT OR UPDATE ON "fee_waivers"
  FOR EACH ROW EXECUTE FUNCTION fee_waivers_within_charge();
--> statement-breakpoint

-- Lowering a charge below a waiver already granted against it is the same
-- violation approached from the other side.
CREATE OR REPLACE FUNCTION fee_items_above_waivers() RETURNS trigger AS $$
DECLARE
  biggest bigint;
BEGIN
  IF NEW.amount_paise >= OLD.amount_paise THEN
    RETURN NEW;
  END IF;

  SELECT max(w.amount_paise) INTO biggest
    FROM fee_waivers w WHERE w.fee_item_id = NEW.id;

  IF biggest IS NOT NULL AND biggest > NEW.amount_paise THEN
    RAISE EXCEPTION 'charge cannot fall to % below an existing waiver of %', NEW.amount_paise, biggest
      USING ERRCODE = 'check_violation',
            HINT = 'revoke or reduce the waiver first';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER fee_items_above_waivers
  BEFORE UPDATE ON "fee_items"
  FOR EACH ROW EXECUTE FUNCTION fee_items_above_waivers();
