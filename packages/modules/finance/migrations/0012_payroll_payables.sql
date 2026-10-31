-- P1-06a (ACC-24): a payable account per statutory payroll head, so PF, ESI,
-- professional tax and TDS on salaries reconcile and are remitted separately.
-- Rollback: enum values cannot be dropped in Postgres; they are inert if
-- unused. Archive accounts 2210-2240 if they must go from the chart.
ALTER TYPE "public"."finance_account_purpose" ADD VALUE IF NOT EXISTS 'pf_payable';--> statement-breakpoint
ALTER TYPE "public"."finance_account_purpose" ADD VALUE IF NOT EXISTS 'esi_payable';--> statement-breakpoint
ALTER TYPE "public"."finance_account_purpose" ADD VALUE IF NOT EXISTS 'pt_payable';--> statement-breakpoint
ALTER TYPE "public"."finance_account_purpose" ADD VALUE IF NOT EXISTS 'salary_tds_payable';
