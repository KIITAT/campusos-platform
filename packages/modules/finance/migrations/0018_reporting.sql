-- P2-05: finance publishes its sales invoices as a reporting dataset (MG-57, decisions 488, 489).
-- Pre-flight: none (a view over existing tables). Adds only.
-- Rollback: DROP VIEW IF EXISTS reporting.finance_sales_invoices;
CREATE SCHEMA IF NOT EXISTS reporting;
--> statement-breakpoint
GRANT USAGE ON SCHEMA reporting TO campusos_app;
--> statement-breakpoint
CREATE VIEW reporting.finance_sales_invoices WITH (security_invoker = true) AS
  SELECT i.number, i.posting_date, i.due_date, p.name AS party, i.docstatus::text AS status,
         i.is_return, i.total_paise, i.cost_center
    FROM public.finance_invoices i
    JOIN public.finance_parties p ON p.id = i.party_id
   WHERE i.kind = 'sales';
--> statement-breakpoint
GRANT SELECT ON reporting.finance_sales_invoices TO campusos_app;
--> statement-breakpoint
COMMENT ON VIEW reporting.finance_sales_invoices IS '{"label":"Sales invoices","module":"finance","roles":["institution_admin","super_admin","accounts_staff"]}';
--> statement-breakpoint
COMMENT ON COLUMN reporting.finance_sales_invoices.number IS '{"label":"Invoice","kind":"text"}';
--> statement-breakpoint
COMMENT ON COLUMN reporting.finance_sales_invoices.posting_date IS '{"label":"Date","kind":"date"}';
--> statement-breakpoint
COMMENT ON COLUMN reporting.finance_sales_invoices.due_date IS '{"label":"Due","kind":"date"}';
--> statement-breakpoint
COMMENT ON COLUMN reporting.finance_sales_invoices.party IS '{"label":"Customer","kind":"text"}';
--> statement-breakpoint
COMMENT ON COLUMN reporting.finance_sales_invoices.status IS '{"label":"Status","kind":"text"}';
--> statement-breakpoint
COMMENT ON COLUMN reporting.finance_sales_invoices.is_return IS '{"label":"Return","kind":"bool"}';
--> statement-breakpoint
COMMENT ON COLUMN reporting.finance_sales_invoices.total_paise IS '{"label":"Total","kind":"money"}';
--> statement-breakpoint
COMMENT ON COLUMN reporting.finance_sales_invoices.cost_center IS '{"label":"Cost centre","kind":"text"}';
