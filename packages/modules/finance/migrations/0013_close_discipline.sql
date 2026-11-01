-- P1-04: close discipline (ACC-02, ACC-05, ACC-07).
-- 1. finance_periods: a pending reopen request (who, when, why); a second person confirms it.
-- 2. finance_gst_filings: GST returns marked filed, by period.
-- 3. finance_lines_control_party: a receivable or payable line names its party (fee receivable excepted).
-- 4. finance_invoice_not_in_filed_return: a sales invoice inside a filed GSTR-1 is not cancelled.
-- Pre-flight: nothing is refused at upgrade; both triggers act on new writes only. Existing lines a
-- trigger would have refused are listed by KIITAT docs/audit/tools/p104-diagnostics.sql.
-- Rollback (a later migration, or by hand as the owner):
--   DROP TRIGGER finance_invoices_not_in_filed_return ON finance_invoices;
--   DROP FUNCTION finance_invoice_not_in_filed_return();
--   DROP TRIGGER finance_lines_control_party ON finance_journal_lines;
--   DROP FUNCTION finance_line_control_party();
--   DROP TABLE finance_gst_filings;
--   ALTER TABLE finance_periods DROP CONSTRAINT finance_periods_reopen_request,
--     DROP COLUMN reopen_requested_by, DROP COLUMN reopen_requested_at, DROP COLUMN reopen_request_reason;
-- and run finance at its previous version, whose code reads none of them.

ALTER TABLE "finance_periods"
  ADD COLUMN "reopen_requested_by" text,
  ADD COLUMN "reopen_requested_at" timestamp with time zone,
  ADD COLUMN "reopen_request_reason" text;--> statement-breakpoint
ALTER TABLE "finance_periods" ADD CONSTRAINT "finance_periods_reopen_requested_by_users_id_fk" FOREIGN KEY ("reopen_requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_periods" ADD CONSTRAINT "finance_periods_reopen_request" CHECK (
  (reopen_requested_at IS NULL AND reopen_request_reason IS NULL)
  OR (reopen_requested_at IS NOT NULL AND reopen_request_reason IS NOT NULL)
);--> statement-breakpoint

CREATE TABLE "finance_gst_filings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"return_type" text NOT NULL,
	"period_from" date NOT NULL,
	"period_to" date NOT NULL,
	"filed_on" date NOT NULL,
	"arn" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_gst_filings_type" CHECK (return_type in ('gstr1', 'gstr3b')),
	CONSTRAINT "finance_gst_filings_period" CHECK (period_to >= period_from)
);--> statement-breakpoint
ALTER TABLE "finance_gst_filings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "finance_gst_filings" ADD CONSTRAINT "finance_gst_filings_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "finance_gst_filings_period_start" ON "finance_gst_filings" USING btree ("institution_id","return_type","period_from");--> statement-breakpoint
CREATE POLICY "finance_gst_filings_tenant_isolation" ON "finance_gst_filings" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint

CREATE OR REPLACE FUNCTION finance_line_control_party() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.party_id IS NULL AND EXISTS (
    SELECT 1 FROM finance_accounts a
     WHERE a.id = NEW.account_id
       AND a.subtype IN ('receivable', 'payable')
       AND a.purpose IS DISTINCT FROM 'fees_receivable'
  ) THEN
    RAISE EXCEPTION 'a receivable or payable line names its party'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'finance_control_line_needs_party';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "finance_lines_control_party" BEFORE INSERT ON "finance_journal_lines" FOR EACH ROW EXECUTE FUNCTION finance_line_control_party();--> statement-breakpoint

CREATE OR REPLACE FUNCTION finance_invoice_not_in_filed_return() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.docstatus = 'submitted' AND NEW.docstatus = 'cancelled' AND NEW.kind = 'sales'
     AND EXISTS (
       SELECT 1 FROM finance_gst_filings f
        WHERE f.institution_id = NEW.institution_id
          AND f.return_type = 'gstr1'
          AND NEW.posting_date BETWEEN f.period_from AND f.period_to
     ) THEN
    RAISE EXCEPTION 'this invoice is in a filed GSTR-1; raise a credit note instead'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'finance_invoice_in_filed_return';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "finance_invoices_not_in_filed_return" BEFORE UPDATE ON "finance_invoices" FOR EACH ROW EXECUTE FUNCTION finance_invoice_not_in_filed_return();
