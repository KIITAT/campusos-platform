-- P1-03b: void and cheque return (ACC-23), cheques unique by drawer, an FY
-- receipt series and the receipt's fee heads (ACC-30), voidable invoices (the
-- D3 case of tools/p006-diagnostics.sql).
--
-- A payment is never deleted again: a mistake is voided and a returned cheque
-- is marked bounced; both keep the row, reverse the journal entry, and leave
-- the student ledger (postedSql), which counts live payments only. A voided or
-- bounced row is final. A voided invoice frees its student and term for a new
-- one. Receipt numbers run per fiscal year in fee_receipt_series.
--
-- Pre-flight: none needed. Every new column is nullable or defaults to 'live',
-- which every new CHECK accepts for existing rows; the two re-made unique
-- indexes only gain a predicate, so they are narrower than the ones they
-- replace; the cheque index needs drawer details, which no existing row has.
--
-- Rollback (forward-only; decision 162): the only safe way back is to restore
-- the pre-upgrade backup with fees 0.22.0, and only while this branch has taken
-- no payment and made no correction since the backup. Fees 0.22.0 sums every
-- payment row and knows nothing of status, so once a receipt has been voided or
-- a cheque returned it would count that money as paid while its journal entry
-- stays reversed. There is no downgrade that keeps those records: after the
-- first correction or the first receipt on the new series, the way out is a
-- forward repair (a later migration and release) that preserves them, never a
-- restore. Taking the old indexes and guards back by hand is not a rollback and
-- is not offered.

ALTER TABLE "fee_payments" ADD COLUMN "status" text NOT NULL DEFAULT 'live';--> statement-breakpoint
ALTER TABLE "fee_payments" ADD COLUMN "voided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fee_payments" ADD COLUMN "voided_by" text;--> statement-breakpoint
ALTER TABLE "fee_payments" ADD COLUMN "void_reason" text;--> statement-breakpoint
ALTER TABLE "fee_payments" ADD COLUMN "bounced_on" date;--> statement-breakpoint
ALTER TABLE "fee_payments" ADD COLUMN "drawer_ifsc" text;--> statement-breakpoint
ALTER TABLE "fee_payments" ADD COLUMN "drawer_account" text;--> statement-breakpoint
ALTER TABLE "fee_payments" ADD COLUMN "breakup" jsonb;--> statement-breakpoint
ALTER TABLE "fee_payments" ADD CONSTRAINT "fee_payments_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_payments" ADD CONSTRAINT "fee_payments_status" CHECK (status IN ('live', 'voided', 'bounced'));--> statement-breakpoint
ALTER TABLE "fee_payments" ADD CONSTRAINT "fee_payments_void_shape" CHECK ((status = 'live') = (voided_at IS NULL) AND (status = 'live' OR length(btrim(coalesce(void_reason, ''))) >= 5) AND ((status = 'bounced') = (bounced_on IS NOT NULL)));--> statement-breakpoint
ALTER TABLE "fee_payments" ADD CONSTRAINT "fee_payments_bounce_cheque" CHECK (status <> 'bounced' OR method = 'cheque');--> statement-breakpoint
ALTER TABLE "fee_payments" ADD CONSTRAINT "fee_payments_drawer" CHECK ((drawer_ifsc IS NULL) = (drawer_account IS NULL) AND (drawer_ifsc IS NULL OR (method = 'cheque' AND drawer_ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$' AND drawer_account ~ '^[0-9A-Z]{6,20}$')));--> statement-breakpoint
DROP INDEX "fee_payments_reference";--> statement-breakpoint
CREATE UNIQUE INDEX "fee_payments_reference" ON "fee_payments" USING btree ("institution_id", upper(btrim("reference"))) WHERE method IN ('bank_transfer', 'upi') AND reference IS NOT NULL AND btrim(reference) <> '' AND status = 'live';--> statement-breakpoint
CREATE UNIQUE INDEX "fee_payments_cheque" ON "fee_payments" USING btree ("institution_id", "drawer_ifsc", "drawer_account", upper(btrim("reference"))) WHERE method = 'cheque' AND drawer_ifsc IS NOT NULL AND reference IS NOT NULL AND btrim(reference) <> '' AND status = 'live';--> statement-breakpoint

ALTER TABLE "fee_invoices" ADD COLUMN "voided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fee_invoices" ADD COLUMN "voided_by" text;--> statement-breakpoint
ALTER TABLE "fee_invoices" ADD COLUMN "void_reason" text;--> statement-breakpoint
ALTER TABLE "fee_invoices" ADD CONSTRAINT "fee_invoices_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_invoices" ADD CONSTRAINT "fee_invoices_void_shape" CHECK ((voided_at IS NULL) = (void_reason IS NULL) AND (void_reason IS NULL OR length(btrim(void_reason)) >= 5));--> statement-breakpoint
DROP INDEX "fee_invoices_once";--> statement-breakpoint
CREATE UNIQUE INDEX "fee_invoices_once" ON "fee_invoices" USING btree ("student_id", "term_id") WHERE voided_at IS NULL;--> statement-breakpoint

CREATE TABLE "fee_receipt_series" (
	"institution_id" uuid NOT NULL,
	"fiscal_year" text NOT NULL,
	"next" bigint DEFAULT 1 NOT NULL,
	CONSTRAINT "fee_receipt_series_pk" PRIMARY KEY ("institution_id", "fiscal_year"),
	CONSTRAINT "fee_receipt_series_year" CHECK (fiscal_year ~ '^[0-9]{2}([0-9]{2})?$'),
	CONSTRAINT "fee_receipt_series_next" CHECK (next >= 1)
);--> statement-breakpoint
ALTER TABLE "fee_receipt_series" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fee_receipt_series" ADD CONSTRAINT "fee_receipt_series_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "fee_receipt_series_tenant_isolation" ON "fee_receipt_series" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE OR REPLACE FUNCTION fee_receipt_series_forward_only() RETURNS trigger AS $$
BEGIN
  IF NEW.next < OLD.next THEN
    RAISE EXCEPTION 'a receipt series cannot move backwards (% -> %)', OLD.next, NEW.next
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER fee_receipt_series_forward_only
  BEFORE UPDATE ON "fee_receipt_series"
  FOR EACH ROW EXECUTE FUNCTION fee_receipt_series_forward_only();
--> statement-breakpoint

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
     AND (to_jsonb(NEW) - ARRAY['recorded_by', 'reconciled_by', 'voided_by'])
         IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['recorded_by', 'reconciled_by', 'voided_by'])
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
--> statement-breakpoint

CREATE OR REPLACE FUNCTION fee_payments_guard_delete() RETURNS trigger AS $$
BEGIN
  -- Offboarding an institution cascades; that is not somebody deleting a receipt.
  IF pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;

  IF OLD.reconciled_at IS NOT NULL THEN
    RAISE EXCEPTION 'a reconciled payment cannot be deleted'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'fee_payment_kept',
            HINT = 'void it, or record the cheque returned unpaid';
  END IF;
  IF EXISTS (SELECT 1 FROM fee_refunds r WHERE r.payment_id = OLD.id) THEN
    RAISE EXCEPTION 'a payment that has been refunded cannot be deleted'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'fee_payment_kept',
            HINT = 'the refund is the record of the money going back';
  END IF;
  RAISE EXCEPTION 'a payment is never deleted'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'fee_payment_kept',
          HINT = 'void it, or record the cheque returned unpaid; both reverse it in the books and keep the record';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE VIEW reporting.fees_payments WITH (security_invoker = true) AS
  SELECT p.receipt_no, (p.received_at AT TIME ZONE 'Asia/Kolkata')::date AS received_on,
         t.name AS term, p.method::text AS method, p.amount_paise,
         (p.reconciled_at IS NOT NULL) AS reconciled, u.name AS student, p.status
    FROM public.fee_payments p
    JOIN public.academic_terms t ON t.id = p.term_id
    JOIN public.users u ON u.id = p.student_id;
--> statement-breakpoint
COMMENT ON COLUMN reporting.fees_payments.status IS '{"label":"Status","kind":"text"}';
