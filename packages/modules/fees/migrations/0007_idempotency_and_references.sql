-- ACC-18, both halves.
--
-- 1. Submitting the same payment form twice made two receipts and two journal
--    entries, because nothing tied the second request to the first.
--    fee_idempotency_keys holds one claim per idempotency key: the operation
--    writes it first, in its own transaction, so it commits with the receipt
--    it guards or not at all. A second request with the key waits on the
--    primary key for the first to end, then gets the first one's receipt back
--    (decision 187). Kept for the life of the receipt; offboarding removes it
--    with the institution. RLS and the tenant policy as on every fees table.
--
-- 2. The same UTR could be receipted twice: typed at the counter twice, or
--    typed once and then verified again from the student's transfer claim.
--    fee_payments_reference makes a bank-transfer or UPI reference unique per
--    institution, ignoring case and padding, as fee_transfer_claims_utr does
--    for claims (decision 188). Cheque numbers repeat across banks, and card
--    codes and "other" references repeat too, so those methods are left out
--    until P1-03 records what makes them unique.
--
-- Pre-flight (first, before any change): existing payments that share such a
-- reference would make the index impossible. They are listed and the upgrade
-- stops; fees stays at 0006 with nothing changed. Each one is a decision about
-- a financial record -- a receipt made twice, or a reference mistyped -- so it
-- is resolved by hand, through an audited amendment, and the upgrade is run
-- again. Nothing here rewrites a payment.
--
-- Rollback: a later migration dropping the index and the table. Neither holds
-- money or personal content; dropping them loses the protection, not data.
-- Preferred, per decision 162: restore the pre-upgrade backup with fees 0.5.2,
-- whose code never reads either.

DO $$
DECLARE
  groups bigint;
  listing text;
BEGIN
  SELECT count(*) INTO groups
    FROM (SELECT 1
            FROM fee_payments
           WHERE method IN ('bank_transfer', 'upi') AND reference IS NOT NULL AND btrim(reference) <> ''
           GROUP BY institution_id, upper(btrim(reference))
          HAVING count(*) > 1) d;
  IF groups > 0 THEN
    SELECT string_agg(format('%s: %s receipted as %s', coalesce(i.slug, d.institution_id::text), d.ref, d.receipts), E'\n')
      INTO listing
      FROM (SELECT institution_id, upper(btrim(reference)) AS ref,
                   string_agg(format('%s (%s paise, %s)', receipt_no, amount_paise, method), ', ' ORDER BY receipt_no) AS receipts
              FROM fee_payments
             WHERE method IN ('bank_transfer', 'upi') AND reference IS NOT NULL AND btrim(reference) <> ''
             GROUP BY institution_id, upper(btrim(reference))
            HAVING count(*) > 1
             ORDER BY 1, 2
             LIMIT 20) d
      LEFT JOIN institutions i ON i.id = d.institution_id;
    RAISE EXCEPTION 'fees 0007: % bank-transfer or UPI references are receipted more than once', groups
      USING ERRCODE = 'unique_violation',
            DETAIL = listing,
            HINT = 'Resolve each by hand (an audited amendment of the extra receipt''s reference, then a refund if it was received once), then run the upgrade again.';
  END IF;
END
$$;
--> statement-breakpoint
CREATE TABLE "fee_idempotency_keys" (
	"institution_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"operation" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"result_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fee_idempotency_keys_pkey" PRIMARY KEY("institution_id","actor_id","operation","key"),
	CONSTRAINT "fee_idempotency_keys_key" CHECK (key ~ '^[A-Za-z0-9._:-]{8,128}$')
);
--> statement-breakpoint
ALTER TABLE "fee_idempotency_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fee_idempotency_keys" ADD CONSTRAINT "fee_idempotency_keys_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_idempotency_keys" ADD CONSTRAINT "fee_idempotency_keys_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "fee_idempotency_keys_tenant_isolation" ON "fee_idempotency_keys" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE UNIQUE INDEX "fee_payments_reference" ON "fee_payments" USING btree ("institution_id", upper(btrim("reference"))) WHERE method IN ('bank_transfer', 'upi') AND reference IS NOT NULL AND btrim(reference) <> '';
