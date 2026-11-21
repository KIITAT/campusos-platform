-- P1-03c: paying by UPI, reporting UPI payments and deposited cheques.
--
-- 1. fee_bank_accounts gains the account's UPI ID (VPA), stored lower-case,
--    and whether it is a merchant VPA (whose QR may carry the amount due).
-- 2. fee_transfer_mode gains 'upi' and 'cheque'. A UPI claim's utr is the
--    12-digit UPI reference; a cheque claim's utr is the 6-digit cheque number,
--    with the drawer's IFSC (remitter_ifsc) and account (drawer_account, new).
-- 3. Claim uniqueness: a reference once per institution for every claim but a
--    cheque (drawer_account IS NULL is exactly "not a cheque", by the check
--    below); a cheque once per IFSC, account and number. The predicates use
--    drawer_account rather than the enum: an index predicate must be immutable
--    and the new enum values cannot be used in the transaction that adds them.
--
-- Pre-flight: the enum must hold exactly the three values 0005 made; anything
-- else was changed by hand and stops the upgrade with nothing changed. No
-- existing row can break a new check (every row is rtgs, neft or imps, and
-- drawer_account is new and null), and the re-made reference index is
-- narrower than the one it replaces.
--
-- Rollback (forward-only; decision 162): restore the pre-upgrade backup with
-- the previous fees version. Otherwise a later migration that drops
-- fee_transfer_claims_cheque, re-creates fee_transfer_claims_utr without
-- "AND drawer_account IS NULL" (only once no two live claims share a cheque
-- number), and drops the four checks and three columns -- dropping
-- drawer_account loses the drawer of every cheque claim, so only before any
-- exists. Postgres cannot drop enum values; 'upi' and 'cheque' stay.

DO $$
DECLARE
  v text[];
BEGIN
  SELECT array_agg(enumlabel::text ORDER BY enumsortorder) INTO v
    FROM pg_enum WHERE enumtypid = 'public.fee_transfer_mode'::regtype;
  IF v IS DISTINCT FROM ARRAY['rtgs', 'neft', 'imps'] THEN
    RAISE EXCEPTION 'fee_transfer_mode is %, expected {rtgs,neft,imps}; it was changed outside the migrations', v;
  END IF;
END $$;--> statement-breakpoint
ALTER TYPE "public"."fee_transfer_mode" ADD VALUE 'upi';--> statement-breakpoint
ALTER TYPE "public"."fee_transfer_mode" ADD VALUE 'cheque';--> statement-breakpoint
ALTER TABLE "fee_bank_accounts" ADD COLUMN "upi_vpa" text;--> statement-breakpoint
ALTER TABLE "fee_bank_accounts" ADD COLUMN "upi_merchant" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "fee_bank_accounts" ADD CONSTRAINT "fee_bank_accounts_vpa" CHECK (upi_vpa IS NULL OR upi_vpa ~ '^[a-z0-9][a-z0-9._-]{1,255}@[a-z][a-z0-9.-]{1,63}$');--> statement-breakpoint
ALTER TABLE "fee_bank_accounts" ADD CONSTRAINT "fee_bank_accounts_merchant" CHECK (NOT upi_merchant OR upi_vpa IS NOT NULL);--> statement-breakpoint
ALTER TABLE "fee_transfer_claims" ADD COLUMN "drawer_account" text;--> statement-breakpoint
ALTER TABLE "fee_transfer_claims" ADD CONSTRAINT "fee_transfer_claims_upi_shape" CHECK (mode::text <> 'upi' OR utr ~ '^[0-9]{12}$');--> statement-breakpoint
ALTER TABLE "fee_transfer_claims" ADD CONSTRAINT "fee_transfer_claims_cheque_shape" CHECK ((mode::text = 'cheque') = (drawer_account IS NOT NULL) AND (mode::text <> 'cheque' OR (utr ~ '^[0-9]{6}$' AND remitter_ifsc IS NOT NULL AND drawer_account ~ '^[0-9A-Z]{6,20}$')));--> statement-breakpoint
DROP INDEX "fee_transfer_claims_utr";--> statement-breakpoint
CREATE UNIQUE INDEX "fee_transfer_claims_utr" ON "fee_transfer_claims" USING btree ("institution_id", upper("utr")) WHERE status <> 'rejected' AND drawer_account IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "fee_transfer_claims_cheque" ON "fee_transfer_claims" USING btree ("institution_id", "remitter_ifsc", "drawer_account", "utr") WHERE status <> 'rejected' AND drawer_account IS NOT NULL;
