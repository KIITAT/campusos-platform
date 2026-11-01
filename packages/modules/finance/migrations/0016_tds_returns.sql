-- P1-05b: TDS returns pack (ACC-31, ACC-06).
-- 1. finance_account_purpose gains tds_interest (account 5610 comes from the default chart).
-- 2. finance_invoices.tds_advance_paise: advance TDS a bill absorbed.
-- 3. finance_tds_challans / finance_tds_challan_links: deposits and the deductions they cover.
-- Pre-flight: nothing existing is refused (new column defaults to 0; new tables are empty).
-- Rollback (a later migration, or by hand as the owner):
--   DROP TABLE finance_tds_challan_links; DROP TABLE finance_tds_challans;
--   ALTER TABLE finance_invoices DROP CONSTRAINT finance_invoices_tds_advance, DROP COLUMN tds_advance_paise;
--   (the enum value stays; it is inert unused. Archive account 5610 if it must go.)
--   Reverse every challan entry first (source_ref 'tds-challan:%') if challans were recorded.

ALTER TYPE "public"."finance_account_purpose" ADD VALUE IF NOT EXISTS 'tds_interest';--> statement-breakpoint
ALTER TABLE "finance_invoices" ADD COLUMN "tds_advance_paise" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "finance_invoices" ADD CONSTRAINT "finance_invoices_tds_advance" CHECK (tds_advance_paise >= 0);--> statement-breakpoint

CREATE TABLE "finance_tds_challans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"form" text NOT NULL,
	"month" date NOT NULL,
	"deposited_on" date NOT NULL,
	"bsr_code" text NOT NULL,
	"challan_serial" text NOT NULL,
	"tds_paise" bigint NOT NULL,
	"interest_paise" bigint DEFAULT 0 NOT NULL,
	"fee_paise" bigint DEFAULT 0 NOT NULL,
	"account_id" uuid NOT NULL,
	"entry_id" uuid,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_tds_challans_form" CHECK (form in ('26Q', '27Q')),
	CONSTRAINT "finance_tds_challans_month" CHECK (extract(day from month) = 1),
	CONSTRAINT "finance_tds_challans_bsr" CHECK (bsr_code ~ '^[0-9]{7}$'),
	CONSTRAINT "finance_tds_challans_serial" CHECK (challan_serial ~ '^[0-9]{5}$'),
	CONSTRAINT "finance_tds_challans_amounts" CHECK (tds_paise > 0 AND interest_paise >= 0 AND fee_paise >= 0),
	CONSTRAINT "finance_tds_challans_void" CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);--> statement-breakpoint
ALTER TABLE "finance_tds_challans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "finance_tds_challans" ADD CONSTRAINT "finance_tds_challans_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_tds_challans" ADD CONSTRAINT "finance_tds_challans_account_id_finance_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."finance_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_tds_challans" ADD CONSTRAINT "finance_tds_challans_entry_id_finance_journal_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."finance_journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "finance_tds_challans_live" ON "finance_tds_challans" USING btree ("institution_id","bsr_code","deposited_on","challan_serial") WHERE voided_at IS NULL;--> statement-breakpoint
CREATE POLICY "finance_tds_challans_tenant_isolation" ON "finance_tds_challans" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint

CREATE TABLE "finance_tds_challan_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"challan_id" uuid NOT NULL,
	"invoice_id" uuid,
	"payment_id" uuid,
	"tds_paise" bigint NOT NULL,
	CONSTRAINT "finance_tds_challan_links_one" CHECK ((invoice_id IS NULL) <> (payment_id IS NULL)),
	CONSTRAINT "finance_tds_challan_links_amount" CHECK (tds_paise <> 0)
);--> statement-breakpoint
ALTER TABLE "finance_tds_challan_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "finance_tds_challan_links" ADD CONSTRAINT "finance_tds_challan_links_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_tds_challan_links" ADD CONSTRAINT "finance_tds_challan_links_challan_id_finance_tds_challans_id_fk" FOREIGN KEY ("challan_id") REFERENCES "public"."finance_tds_challans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_tds_challan_links" ADD CONSTRAINT "finance_tds_challan_links_invoice_id_finance_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."finance_invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_tds_challan_links" ADD CONSTRAINT "finance_tds_challan_links_payment_id_finance_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."finance_payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "finance_tds_challan_links_invoice" ON "finance_tds_challan_links" USING btree ("invoice_id") WHERE invoice_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "finance_tds_challan_links_payment" ON "finance_tds_challan_links" USING btree ("payment_id") WHERE payment_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "finance_tds_challan_links_challan" ON "finance_tds_challan_links" USING btree ("challan_id");--> statement-breakpoint
CREATE POLICY "finance_tds_challan_links_tenant_isolation" ON "finance_tds_challan_links" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
