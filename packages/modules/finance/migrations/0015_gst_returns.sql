-- P1-05a: GST returns pack (ACC-03 Part A).
-- 1. finance_settings: the institution's GST scheme, filing frequency and composition rate.
-- 2. finance_gst_filings: IFF and CMP-08 join the return types.
-- 3. finance_gstr2b_returns / finance_gstr2b_lines: imported GSTR-2B documents.
-- 4. finance_invoice_not_in_filed_return(): an IFF filing also locks B2B invoices.
-- Pre-flight: nothing existing is refused. New settings columns default to a monthly regular
-- taxpayer, which is what every institution was treated as before. The filings check is widened.
-- Rollback (a later migration, or by hand as the owner):
--   DROP TABLE finance_gstr2b_lines; DROP TABLE finance_gstr2b_returns;
--   ALTER TABLE finance_gst_filings DROP CONSTRAINT finance_gst_filings_type,
--     ADD CONSTRAINT finance_gst_filings_type CHECK (return_type in ('gstr1', 'gstr3b'));  -- after deleting iff/cmp08 rows
--   ALTER TABLE finance_settings DROP CONSTRAINT finance_settings_composition,
--     DROP CONSTRAINT finance_settings_gst_filing, DROP CONSTRAINT finance_settings_gst_scheme,
--     DROP COLUMN composition_rate_bp, DROP COLUMN gst_filing, DROP COLUMN gst_scheme;
--   and re-create finance_invoice_not_in_filed_return() from 0013.

ALTER TABLE "finance_settings"
  ADD COLUMN "gst_scheme" text DEFAULT 'regular' NOT NULL,
  ADD COLUMN "gst_filing" text DEFAULT 'monthly' NOT NULL,
  ADD COLUMN "composition_rate_bp" integer;--> statement-breakpoint
ALTER TABLE "finance_settings" ADD CONSTRAINT "finance_settings_gst_scheme" CHECK (gst_scheme in ('regular', 'composition'));--> statement-breakpoint
ALTER TABLE "finance_settings" ADD CONSTRAINT "finance_settings_gst_filing" CHECK (gst_filing in ('monthly', 'quarterly'));--> statement-breakpoint
ALTER TABLE "finance_settings" ADD CONSTRAINT "finance_settings_composition" CHECK (
  (gst_scheme = 'composition') = (composition_rate_bp IS NOT NULL)
  AND (composition_rate_bp IS NULL OR (composition_rate_bp BETWEEN 2 AND 10000 AND composition_rate_bp % 2 = 0))
  AND (gst_scheme <> 'composition' OR gst_filing = 'quarterly')
);--> statement-breakpoint

ALTER TABLE "finance_gst_filings" DROP CONSTRAINT "finance_gst_filings_type";--> statement-breakpoint
ALTER TABLE "finance_gst_filings" ADD CONSTRAINT "finance_gst_filings_type" CHECK (return_type in ('gstr1', 'gstr3b', 'iff', 'cmp08'));--> statement-breakpoint

CREATE TABLE "finance_gstr2b_returns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"period" text NOT NULL,
	"gstin" text NOT NULL,
	"file_name" text NOT NULL,
	"documents" integer NOT NULL,
	"skipped" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_gstr2b_returns_period" CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "finance_gstr2b_returns_documents" CHECK (documents >= 0)
);--> statement-breakpoint
ALTER TABLE "finance_gstr2b_returns" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "finance_gstr2b_returns" ADD CONSTRAINT "finance_gstr2b_returns_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "finance_gstr2b_returns_one" ON "finance_gstr2b_returns" USING btree ("institution_id","period");--> statement-breakpoint
CREATE POLICY "finance_gstr2b_returns_tenant_isolation" ON "finance_gstr2b_returns" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint

CREATE TABLE "finance_gstr2b_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"return_id" uuid NOT NULL,
	"supplier_gstin" text,
	"supplier_gstin_raw" text NOT NULL,
	"supplier_name" text,
	"doc_type" text NOT NULL,
	"doc_number" text NOT NULL,
	"doc_key" text NOT NULL,
	"doc_date" date NOT NULL,
	"value_paise" bigint NOT NULL,
	"taxable_paise" bigint NOT NULL,
	"igst_paise" bigint DEFAULT 0 NOT NULL,
	"cgst_paise" bigint DEFAULT 0 NOT NULL,
	"sgst_paise" bigint DEFAULT 0 NOT NULL,
	"cess_paise" bigint DEFAULT 0 NOT NULL,
	"itc_available" boolean NOT NULL,
	"reverse_charge" boolean NOT NULL,
	CONSTRAINT "finance_gstr2b_lines_doc_type" CHECK (doc_type in ('invoice', 'credit', 'debit')),
	CONSTRAINT "finance_gstr2b_lines_gstin" CHECK (supplier_gstin IS NULL OR supplier_gstin ~ '^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]Z[0-9A-Z]$')
);--> statement-breakpoint
ALTER TABLE "finance_gstr2b_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "finance_gstr2b_lines" ADD CONSTRAINT "finance_gstr2b_lines_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_gstr2b_lines" ADD CONSTRAINT "finance_gstr2b_lines_return_id_finance_gstr2b_returns_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."finance_gstr2b_returns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "finance_gstr2b_lines_key" ON "finance_gstr2b_lines" USING btree ("institution_id","supplier_gstin","doc_key");--> statement-breakpoint
CREATE INDEX "finance_gstr2b_lines_return" ON "finance_gstr2b_lines" USING btree ("return_id");--> statement-breakpoint
CREATE POLICY "finance_gstr2b_lines_tenant_isolation" ON "finance_gstr2b_lines" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint

CREATE OR REPLACE FUNCTION finance_invoice_not_in_filed_return() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.docstatus = 'submitted' AND NEW.docstatus = 'cancelled' AND NEW.kind = 'sales'
     AND EXISTS (
       SELECT 1 FROM finance_gst_filings f
        WHERE f.institution_id = NEW.institution_id
          AND NEW.posting_date BETWEEN f.period_from AND f.period_to
          AND (
            f.return_type = 'gstr1'
            OR (f.return_type = 'iff' AND EXISTS (
                  SELECT 1 FROM finance_parties p
                   WHERE p.id = NEW.party_id AND p.gstin IS NOT NULL AND p.gst_category <> 'overseas'))
          )
     ) THEN
    RAISE EXCEPTION 'this invoice is in a filed GSTR-1; raise a credit note instead'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'finance_invoice_in_filed_return';
  END IF;
  RETURN NEW;
END;
$$;
