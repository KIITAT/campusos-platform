-- P1-06d (ACC-29): a liability account for the gratuity provision, valued at
-- month ends by hr and drawn on by gratuity payouts.
-- Rollback: enum values cannot be dropped in Postgres; the value is inert if
-- unused. Archive account 2250 if it must go from the chart.
ALTER TYPE "public"."finance_account_purpose" ADD VALUE IF NOT EXISTS 'gratuity_provision';
