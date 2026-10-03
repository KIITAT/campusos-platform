-- Paying by bank transfer, and saying what is owed (decision 138). A student
-- reports an RTGS, NEFT or IMPS transfer into one of the institution's
-- accounts; the accounts office verifies it into a receipted, reconciled
-- payment or rejects it with a reason, once. Demand letters are numbered and
-- kept as issued, so the institution can confirm one it is shown.

CREATE TYPE "public"."fee_transfer_mode" AS ENUM('rtgs', 'neft', 'imps');--> statement-breakpoint
CREATE TYPE "public"."fee_claim_status" AS ENUM('pending', 'verified', 'rejected');--> statement-breakpoint
CREATE TABLE "fee_bank_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"label" text NOT NULL,
	"account_name" text NOT NULL,
	"bank_name" text NOT NULL,
	"branch" text NOT NULL,
	"account_number" text NOT NULL,
	"ifsc" text NOT NULL,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fee_bank_accounts_ifsc" CHECK (ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
	CONSTRAINT "fee_bank_accounts_number_digits" CHECK (account_number ~ '^[0-9]{6,20}$')
);
--> statement-breakpoint
ALTER TABLE "fee_bank_accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "fee_transfer_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"student_id" text NOT NULL,
	"term_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"mode" "fee_transfer_mode" NOT NULL,
	"remitter_bank" text NOT NULL,
	"remitter_branch" text,
	"remitter_ifsc" text,
	"account_holder" text NOT NULL,
	"contact_phone" text NOT NULL,
	"transferred_on" date NOT NULL,
	"amount_paise" bigint NOT NULL,
	"utr" text NOT NULL,
	"bank_reference" text,
	"status" "fee_claim_status" DEFAULT 'pending' NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"payment_id" uuid,
	CONSTRAINT "fee_transfer_claims_amount" CHECK (amount_paise > 0),
	CONSTRAINT "fee_transfer_claims_utr_shape" CHECK (utr ~ '^[A-Za-z0-9]{6,30}$'),
	CONSTRAINT "fee_transfer_claims_ifsc" CHECK (remitter_ifsc is null or remitter_ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
	CONSTRAINT "fee_transfer_claims_phone" CHECK (contact_phone ~ '^[0-9+() -]{7,20}$'),
	CONSTRAINT "fee_transfer_claims_decided" CHECK ((status = 'pending') = (decided_at is null) and (status = 'verified') = (payment_id is not null))
);
--> statement-breakpoint
ALTER TABLE "fee_transfer_claims" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "fee_demand_letters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"number" text NOT NULL,
	"student_id" text NOT NULL,
	"term_id" uuid NOT NULL,
	"addressee" text NOT NULL,
	"purpose" text NOT NULL,
	"content" jsonb NOT NULL,
	"payable_paise" bigint NOT NULL,
	"issued_by" text,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fee_demand_letters_addressee" CHECK (length(trim(addressee)) >= 3)
);
--> statement-breakpoint
ALTER TABLE "fee_demand_letters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "fee_letter_settings" (
	"institution_id" uuid PRIMARY KEY NOT NULL,
	"signatory_name" text NOT NULL,
	"signatory_title" text NOT NULL,
	"opening" text,
	"closing" text,
	"next_number" bigint DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fee_letter_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fee_bank_accounts" ADD CONSTRAINT "fee_bank_accounts_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_transfer_claims" ADD CONSTRAINT "fee_transfer_claims_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_transfer_claims" ADD CONSTRAINT "fee_transfer_claims_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_transfer_claims" ADD CONSTRAINT "fee_transfer_claims_term_id_academic_terms_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."academic_terms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_transfer_claims" ADD CONSTRAINT "fee_transfer_claims_account_id_fee_bank_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."fee_bank_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_transfer_claims" ADD CONSTRAINT "fee_transfer_claims_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_transfer_claims" ADD CONSTRAINT "fee_transfer_claims_payment_id_fee_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."fee_payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_demand_letters" ADD CONSTRAINT "fee_demand_letters_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_demand_letters" ADD CONSTRAINT "fee_demand_letters_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_demand_letters" ADD CONSTRAINT "fee_demand_letters_term_id_academic_terms_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."academic_terms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_demand_letters" ADD CONSTRAINT "fee_demand_letters_issued_by_users_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_letter_settings" ADD CONSTRAINT "fee_letter_settings_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fee_bank_accounts_number" ON "fee_bank_accounts" USING btree ("institution_id","account_number");--> statement-breakpoint
CREATE INDEX "fee_transfer_claims_student" ON "fee_transfer_claims" USING btree ("student_id","term_id");--> statement-breakpoint
CREATE INDEX "fee_transfer_claims_pending" ON "fee_transfer_claims" USING btree ("institution_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "fee_transfer_claims_utr" ON "fee_transfer_claims" USING btree ("institution_id",upper("utr")) WHERE status <> 'rejected';--> statement-breakpoint
CREATE UNIQUE INDEX "fee_demand_letters_number" ON "fee_demand_letters" USING btree ("institution_id","number");--> statement-breakpoint
CREATE INDEX "fee_demand_letters_student" ON "fee_demand_letters" USING btree ("student_id");--> statement-breakpoint
CREATE POLICY "fee_bank_accounts_tenant_isolation" ON "fee_bank_accounts" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "fee_transfer_claims_tenant_isolation" ON "fee_transfer_claims" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "fee_demand_letters_tenant_isolation" ON "fee_demand_letters" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "fee_letter_settings_tenant_isolation" ON "fee_letter_settings" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
--> statement-breakpoint

-- An account students have paid into keeps its number, bank and IFSC: a claim
-- names it, and changing it under the claim would change what the student
-- said they did.
CREATE OR REPLACE FUNCTION fee_bank_account_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.account_number, NEW.ifsc, NEW.bank_name, NEW.account_name)
       IS DISTINCT FROM (OLD.account_number, OLD.ifsc, OLD.bank_name, OLD.account_name)
     AND EXISTS (SELECT 1 FROM fee_transfer_claims WHERE account_id = OLD.id) THEN
    RAISE EXCEPTION 'students have paid into that account; retire it and add the new one'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'fee_bank_account_used';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "fee_bank_accounts_guard" BEFORE UPDATE ON "fee_bank_accounts"
  FOR EACH ROW EXECUTE FUNCTION fee_bank_account_guard();
--> statement-breakpoint

-- A claim is a student's, into a live account, for a transfer already made.
-- It is decided once: verified with the payment that matches it, or rejected
-- with a reason. Nothing else about it changes, and it is never deleted.
CREATE OR REPLACE FUNCTION fee_transfer_claim_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  p record;
  decision text[] := ARRAY['status', 'decided_by', 'decided_at', 'decision_note', 'payment_id'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM institutions WHERE id = OLD.institution_id)
       AND EXISTS (SELECT 1 FROM users WHERE id = OLD.student_id) THEN
      RAISE EXCEPTION 'a claim is kept'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'fee_claim_kept';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.student_id AND role = 'student') THEN
      RAISE EXCEPTION 'a transfer is claimed by a student'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'fee_claim_student';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM fee_bank_accounts WHERE id = NEW.account_id AND retired_at IS NULL) THEN
      RAISE EXCEPTION 'that account no longer takes fees'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'fee_claim_account';
    END IF;
    IF NEW.transferred_on > current_date THEN
      RAISE EXCEPTION 'a transfer is claimed after it is made'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'fee_claim_future';
    END IF;
    NEW.status := 'pending';
    NEW.decided_by := NULL;
    NEW.decided_at := NULL;
    NEW.decision_note := NULL;
    NEW.payment_id := NULL;
    NEW.submitted_at := now();
    RETURN NEW;
  END IF;

  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'that claim has been decided'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'fee_claim_decided';
  END IF;
  IF (to_jsonb(NEW) - decision) IS DISTINCT FROM (to_jsonb(OLD) - decision) THEN
    RAISE EXCEPTION 'a claim is decided, not edited'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'fee_claim_fixed';
  END IF;
  IF NEW.status = 'verified' THEN
    SELECT student_id, term_id, amount_paise, reference INTO p FROM fee_payments WHERE id = NEW.payment_id;
    IF NOT FOUND OR p.student_id <> NEW.student_id OR p.term_id <> NEW.term_id
       OR p.amount_paise <> NEW.amount_paise OR upper(coalesce(p.reference, '')) <> upper(NEW.utr) THEN
      RAISE EXCEPTION 'a verified claim is the payment it describes'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'fee_claim_payment';
    END IF;
  ELSIF NEW.status = 'rejected' AND length(trim(coalesce(NEW.decision_note, ''))) < 5 THEN
    RAISE EXCEPTION 'say why it was rejected'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'fee_claim_reason';
  END IF;
  NEW.decided_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "fee_transfer_claims_guard" BEFORE INSERT OR UPDATE OR DELETE ON "fee_transfer_claims"
  FOR EACH ROW EXECUTE FUNCTION fee_transfer_claim_guard();
--> statement-breakpoint

-- A demand letter is what was sent; it is not changed afterwards.
CREATE OR REPLACE FUNCTION fee_demand_letter_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND (NOT EXISTS (SELECT 1 FROM institutions WHERE id = OLD.institution_id)
                           OR NOT EXISTS (SELECT 1 FROM users WHERE id = OLD.student_id)) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'a demand letter is kept as it was issued'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'fee_demand_letter_kept';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "fee_demand_letters_guard" BEFORE UPDATE OR DELETE ON "fee_demand_letters"
  FOR EACH ROW EXECUTE FUNCTION fee_demand_letter_guard();
