-- Fees learns to post. Applied by the host at install time, in this order.
--
-- Three additions, all of them about the boundary between what a student is
-- told and what the books say:
--
--   * fee_invoices  -- the moment a term's charges become money owed
--   * fee_refunds   -- money going back out, against the payment it came in on
--   * two columns on fee_waivers, so a waiver revised after the invoice was
--     issued posts the difference rather than the whole thing again
--
-- Nothing here references a finance table. The link between a fee and its
-- journal entry is (source_module, source_ref), which is what lets the books
-- be uninstalled without a foreign key stopping it.

ALTER TABLE "fee_waivers" ADD COLUMN "posted_paise" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "fee_waivers" ADD COLUMN "postings" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

CREATE TABLE "fee_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"student_id" text NOT NULL,
	"term_id" uuid NOT NULL,
	"charged_paise" bigint NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"issued_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fee_invoices_amount" CHECK (charged_paise > 0)
);
--> statement-breakpoint
ALTER TABLE "fee_invoices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE TABLE "fee_refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"amount_paise" bigint NOT NULL,
	"method" "fee_payment_method" NOT NULL,
	"reference" text,
	"reason" text NOT NULL,
	"refunded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"refunded_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fee_refunds_amount" CHECK (amount_paise > 0),
	CONSTRAINT "fee_refunds_reason" CHECK (length(trim(reason)) >= 5)
);
--> statement-breakpoint
ALTER TABLE "fee_refunds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

ALTER TABLE "fee_invoices" ADD CONSTRAINT "fee_invoices_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_invoices" ADD CONSTRAINT "fee_invoices_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_invoices" ADD CONSTRAINT "fee_invoices_term_id_academic_terms_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."academic_terms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_invoices" ADD CONSTRAINT "fee_invoices_issued_by_users_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "fee_refunds" ADD CONSTRAINT "fee_refunds_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_refunds" ADD CONSTRAINT "fee_refunds_payment_id_fee_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."fee_payments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_refunds" ADD CONSTRAINT "fee_refunds_refunded_by_users_id_fk" FOREIGN KEY ("refunded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "fee_invoices_once" ON "fee_invoices" USING btree ("student_id","term_id");--> statement-breakpoint
CREATE INDEX "fee_invoices_term" ON "fee_invoices" USING btree ("term_id");--> statement-breakpoint
CREATE INDEX "fee_refunds_payment" ON "fee_refunds" USING btree ("payment_id");--> statement-breakpoint

CREATE POLICY "fee_invoices_tenant_isolation" ON "fee_invoices" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "fee_refunds_tenant_isolation" ON "fee_refunds" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint

-- More back than came in --------------------------------------------------
--
-- refundPayment checks this too; the trigger is what makes it true for every
-- path, including a second clerk refunding the same receipt at the same
-- moment. FOR UPDATE on the payment serialises the two.
CREATE OR REPLACE FUNCTION fee_refunds_within_payment() RETURNS trigger AS $$
DECLARE
  paid bigint;
  back bigint;
BEGIN
  SELECT p.amount_paise INTO paid
    FROM fee_payments p WHERE p.id = NEW.payment_id FOR UPDATE;

  IF paid IS NULL THEN
    RAISE EXCEPTION 'refund refers to a payment that does not exist'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  SELECT COALESCE(sum(r.amount_paise), 0) INTO back
    FROM fee_refunds r WHERE r.payment_id = NEW.payment_id AND r.id <> NEW.id;

  IF back + NEW.amount_paise > paid THEN
    RAISE EXCEPTION 'refunds of % would exceed the payment of %', back + NEW.amount_paise, paid
      USING ERRCODE = 'check_violation',
            HINT = 'refund against the payment the money actually came in on';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER fee_refunds_within_payment
  BEFORE INSERT OR UPDATE ON "fee_refunds"
  FOR EACH ROW EXECUTE FUNCTION fee_refunds_within_payment();
--> statement-breakpoint

-- A refunded payment is a document of record twice over ---------------------
--
-- The delete guard already refuses a reconciled payment. This one refuses any
-- payment money has gone back out against, reconciled or not: deleting it
-- would leave a refund pointing at nothing and the books holding both halves.
CREATE OR REPLACE FUNCTION fee_payments_guard_refunded() RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;

  IF EXISTS (SELECT 1 FROM fee_refunds r WHERE r.payment_id = OLD.id) THEN
    RAISE EXCEPTION 'a payment that has been refunded cannot be deleted'
      USING ERRCODE = 'check_violation',
            HINT = 'the refund is the record of the money going back';
  END IF;

  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER fee_payments_guard_refunded
  BEFORE DELETE ON "fee_payments"
  FOR EACH ROW EXECUTE FUNCTION fee_payments_guard_refunded();
