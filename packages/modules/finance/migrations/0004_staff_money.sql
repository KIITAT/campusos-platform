-- Money that moves between an institution and its own staff outside payroll.
--
-- An advance handed to somebody going to a conference is still the
-- institution's money until it is accounted for, so it is an asset, not an
-- expense. The expense arrives when the claim is approved, owed to the claimant
-- until it is paid or set against the advance. Three purposes, so HR can post
-- all of that without knowing what this institution numbered its accounts.
--
-- Existing charts pick the accounts up the first time a posting asks for one:
-- the default chart is re-applied, idempotently, when a purpose cannot be
-- resolved.
ALTER TYPE "public"."finance_account_purpose" ADD VALUE IF NOT EXISTS 'employee_advances';--> statement-breakpoint
ALTER TYPE "public"."finance_account_purpose" ADD VALUE IF NOT EXISTS 'staff_expenses';--> statement-breakpoint
ALTER TYPE "public"."finance_account_purpose" ADD VALUE IF NOT EXISTS 'expense_claims_payable';
