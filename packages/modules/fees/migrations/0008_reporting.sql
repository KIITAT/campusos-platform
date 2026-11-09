-- P2-05: fees publishes its payments as a reporting dataset (MG-57, decisions 488, 489).
-- Pre-flight: none. Adds only.
-- Rollback: DROP VIEW IF EXISTS reporting.fees_payments;
CREATE SCHEMA IF NOT EXISTS reporting;
--> statement-breakpoint
GRANT USAGE ON SCHEMA reporting TO campusos_app;
--> statement-breakpoint
CREATE VIEW reporting.fees_payments WITH (security_invoker = true) AS
  SELECT p.receipt_no, (p.received_at AT TIME ZONE 'Asia/Kolkata')::date AS received_on,
         t.name AS term, p.method::text AS method, p.amount_paise,
         (p.reconciled_at IS NOT NULL) AS reconciled, u.name AS student
    FROM public.fee_payments p
    JOIN public.academic_terms t ON t.id = p.term_id
    JOIN public.users u ON u.id = p.student_id;
--> statement-breakpoint
GRANT SELECT ON reporting.fees_payments TO campusos_app;
--> statement-breakpoint
COMMENT ON VIEW reporting.fees_payments IS '{"label":"Fee payments","module":"fees","roles":["institution_admin","super_admin","accounts_staff"]}';
--> statement-breakpoint
COMMENT ON COLUMN reporting.fees_payments.receipt_no IS '{"label":"Receipt","kind":"text"}';
--> statement-breakpoint
COMMENT ON COLUMN reporting.fees_payments.received_on IS '{"label":"Received","kind":"date"}';
--> statement-breakpoint
COMMENT ON COLUMN reporting.fees_payments.term IS '{"label":"Term","kind":"text"}';
--> statement-breakpoint
COMMENT ON COLUMN reporting.fees_payments.method IS '{"label":"Method","kind":"text"}';
--> statement-breakpoint
COMMENT ON COLUMN reporting.fees_payments.amount_paise IS '{"label":"Amount","kind":"money"}';
--> statement-breakpoint
COMMENT ON COLUMN reporting.fees_payments.reconciled IS '{"label":"Reconciled","kind":"bool"}';
--> statement-breakpoint
COMMENT ON COLUMN reporting.fees_payments.student IS '{"label":"Student","kind":"text"}';
