-- The books of a business.
--
-- Until now this module kept the books a fee office needs: a flat chart, a
-- journal, months that close, budgets. An institution also buys, sells, keeps
-- stores, owns buildings and equipment, receives grants it must account for
-- apart, and reports by fiscal year. This migration lays the ground every one
-- of those stands on: a chart that is a tree, fiscal years, cost centres and
-- funds as real lists, currencies, numbering, approvals, and the day an entry
-- counts on, read in the institution's own zone.
--
-- Three holes in what was here are closed on the way (decision 149):
--   * a line could be added later to an entry already in a closed month --
--     lines are now written only in the transaction that wrote their entry;
--   * a posting could land on a group of accounts -- groups carry none;
--   * the month an entry counts in was read in the database's zone, not the
--     institution's.

ALTER TYPE "public"."finance_account_purpose" ADD VALUE IF NOT EXISTS 'accounts_receivable';--> statement-breakpoint
ALTER TYPE "public"."finance_account_purpose" ADD VALUE IF NOT EXISTS 'accounts_payable';--> statement-breakpoint
ALTER TYPE "public"."finance_account_purpose" ADD VALUE IF NOT EXISTS 'stock_in_hand';--> statement-breakpoint
ALTER TYPE "public"."finance_account_purpose" ADD VALUE IF NOT EXISTS 'stock_received_not_billed';--> statement-breakpoint
ALTER TYPE "public"."finance_account_purpose" ADD VALUE IF NOT EXISTS 'stock_adjustment';--> statement-breakpoint
ALTER TYPE "public"."finance_account_purpose" ADD VALUE IF NOT EXISTS 'cost_of_goods';--> statement-breakpoint
ALTER TYPE "public"."finance_account_purpose" ADD VALUE IF NOT EXISTS 'fixed_assets';--> statement-breakpoint
ALTER TYPE "public"."finance_account_purpose" ADD VALUE IF NOT EXISTS 'accumulated_depreciation';--> statement-breakpoint
ALTER TYPE "public"."finance_account_purpose" ADD VALUE IF NOT EXISTS 'depreciation_expense';--> statement-breakpoint
ALTER TYPE "public"."finance_account_purpose" ADD VALUE IF NOT EXISTS 'capital_wip';--> statement-breakpoint
ALTER TYPE "public"."finance_account_purpose" ADD VALUE IF NOT EXISTS 'asset_disposal';--> statement-breakpoint
ALTER TYPE "public"."finance_account_purpose" ADD VALUE IF NOT EXISTS 'round_off';--> statement-breakpoint
ALTER TYPE "public"."finance_account_purpose" ADD VALUE IF NOT EXISTS 'exchange_gain_loss';--> statement-breakpoint
ALTER TYPE "public"."finance_account_purpose" ADD VALUE IF NOT EXISTS 'retained_surplus';--> statement-breakpoint
ALTER TYPE "public"."finance_account_purpose" ADD VALUE IF NOT EXISTS 'opening_balance';--> statement-breakpoint
ALTER TYPE "public"."finance_account_purpose" ADD VALUE IF NOT EXISTS 'tds_payable';--> statement-breakpoint
ALTER TYPE "public"."finance_account_purpose" ADD VALUE IF NOT EXISTS 'tds_receivable';--> statement-breakpoint
ALTER TYPE "public"."finance_account_purpose" ADD VALUE IF NOT EXISTS 'gst_input';--> statement-breakpoint
ALTER TYPE "public"."finance_account_purpose" ADD VALUE IF NOT EXISTS 'gst_output';--> statement-breakpoint
ALTER TYPE "public"."finance_account_purpose" ADD VALUE IF NOT EXISTS 'sales_income';--> statement-breakpoint
ALTER TYPE "public"."finance_account_purpose" ADD VALUE IF NOT EXISTS 'purchase_expense';--> statement-breakpoint
ALTER TYPE "public"."finance_account_purpose" ADD VALUE IF NOT EXISTS 'bank_charges';--> statement-breakpoint
ALTER TYPE "public"."finance_account_purpose" ADD VALUE IF NOT EXISTS 'other_income';--> statement-breakpoint

-- The chart becomes a tree ----------------------------------------------------

ALTER TABLE "finance_accounts" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "finance_accounts" ADD COLUMN "is_group" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "finance_accounts" ADD COLUMN "subtype" text;--> statement-breakpoint
ALTER TABLE "finance_accounts" ADD COLUMN "currency" text;--> statement-breakpoint
ALTER TABLE "finance_accounts" ADD COLUMN "cash_flow" text;--> statement-breakpoint
ALTER TABLE "finance_accounts" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "finance_accounts" ADD CONSTRAINT "finance_accounts_parent_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."finance_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_accounts" ADD CONSTRAINT "finance_accounts_subtype" CHECK (subtype is null or subtype in ('cash', 'bank', 'receivable', 'payable', 'stock', 'stock_received_not_billed', 'fixed_asset', 'accumulated_depreciation', 'capital_wip', 'tax', 'advance', 'investment', 'current_asset', 'current_liability', 'loan', 'provision', 'capital_fund', 'restricted_fund', 'retained_surplus', 'temporary', 'income', 'expense', 'cost_of_goods', 'depreciation', 'stock_adjustment', 'round_off', 'exchange_gain_loss'));--> statement-breakpoint
ALTER TABLE "finance_accounts" ADD CONSTRAINT "finance_accounts_currency" CHECK (currency is null or currency ~ '^[A-Z]{3}$');--> statement-breakpoint
ALTER TABLE "finance_accounts" ADD CONSTRAINT "finance_accounts_cash_flow" CHECK (cash_flow is null or cash_flow in ('operating', 'investing', 'financing'));--> statement-breakpoint
ALTER TABLE "finance_accounts" ADD CONSTRAINT "finance_accounts_group_purpose" CHECK (not is_group or purpose is null);--> statement-breakpoint
CREATE INDEX "finance_accounts_parent" ON "finance_accounts" USING btree ("parent_id");--> statement-breakpoint

-- Lines carry a party, a fund and a currency ------------------------------------

ALTER TABLE "finance_journal_lines" ADD COLUMN "party_id" uuid;--> statement-breakpoint
ALTER TABLE "finance_journal_lines" ADD COLUMN "fund_id" uuid;--> statement-breakpoint
ALTER TABLE "finance_journal_lines" ADD COLUMN "currency" text;--> statement-breakpoint
ALTER TABLE "finance_journal_lines" ADD COLUMN "amount_fc" bigint;--> statement-breakpoint
ALTER TABLE "finance_journal_lines" ADD COLUMN "exchange_rate" numeric(20, 10);--> statement-breakpoint
ALTER TABLE "finance_journal_lines" ADD CONSTRAINT "finance_lines_fc" CHECK ((currency is null) = (amount_fc is null) and (currency is null) = (exchange_rate is null));--> statement-breakpoint
CREATE INDEX "finance_lines_party" ON "finance_journal_lines" USING btree ("party_id");--> statement-breakpoint
CREATE INDEX "finance_lines_fund" ON "finance_journal_lines" USING btree ("fund_id");--> statement-breakpoint

-- The day an entry counts on, and the transaction that wrote it ----------------

ALTER TABLE "finance_journal_entries" ADD COLUMN "posting_date" date;--> statement-breakpoint
-- The append-only guard is set aside for this one backfill, as the owner, and
-- put back at once: it is the migration filling a new column, not an edit.
ALTER TABLE "finance_journal_entries" DISABLE TRIGGER "finance_entries_append_only";--> statement-breakpoint
UPDATE "finance_journal_entries" SET "posting_date" = ("occurred_at" AT TIME ZONE 'Asia/Kolkata')::date;--> statement-breakpoint
ALTER TABLE "finance_journal_entries" ENABLE TRIGGER "finance_entries_append_only";--> statement-breakpoint
ALTER TABLE "finance_journal_entries" ALTER COLUMN "posting_date" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "finance_journal_entries" ADD COLUMN "tx_id" xid8 DEFAULT pg_current_xact_id() NOT NULL;--> statement-breakpoint
CREATE INDEX "finance_entries_posting" ON "finance_journal_entries" USING btree ("institution_id","posting_date");--> statement-breakpoint

CREATE TABLE "finance_settings" (
	"institution_id" uuid PRIMARY KEY NOT NULL,
	"base_currency" text DEFAULT 'INR' NOT NULL,
	"fiscal_year_start_month" smallint DEFAULT 4 NOT NULL,
	"time_zone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"legal_name" text,
	"address" text,
	"gstin" text,
	"state_code" text,
	"pan" text,
	"tan" text,
	"round_invoices" boolean DEFAULT true NOT NULL,
	"stock_valuation" text DEFAULT 'moving_average' NOT NULL,
	"allow_negative_stock" boolean DEFAULT false NOT NULL,
	"over_receipt_bp" integer DEFAULT 0 NOT NULL,
	"block_expired_batches" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_settings_currency" CHECK (base_currency ~ '^[A-Z]{3}$'),
	CONSTRAINT "finance_settings_fy_month" CHECK (fiscal_year_start_month between 1 and 12),
	CONSTRAINT "finance_settings_gstin" CHECK (gstin is null or gstin ~ '^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]Z[0-9A-Z]$'),
	CONSTRAINT "finance_settings_state" CHECK (state_code is null or state_code ~ '^[0-9]{2}$'),
	CONSTRAINT "finance_settings_pan" CHECK (pan is null or pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
	CONSTRAINT "finance_settings_over_receipt" CHECK (over_receipt_bp between 0 and 10000)
);
--> statement-breakpoint
ALTER TABLE "finance_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finance_fiscal_years" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"label" text NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by" text,
	"closing_entry_id" uuid,
	"reopened_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_fiscal_years_order" CHECK (ends_on > starts_on and ends_on - starts_on < 550),
	CONSTRAINT "finance_fiscal_years_status" CHECK (status in ('open', 'closed')),
	CONSTRAINT "finance_fiscal_years_closed" CHECK ((status = 'closed') = (closed_at is not null))
);
--> statement-breakpoint
ALTER TABLE "finance_fiscal_years" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finance_cost_centers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"parent_id" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_cost_centers_code_text" CHECK (length(trim(code)) > 0)
);
--> statement-breakpoint
ALTER TABLE "finance_cost_centers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finance_funds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"grantor" text,
	"sanction_ref" text,
	"sanctioned_paise" bigint,
	"starts_on" date,
	"ends_on" date,
	"note" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_funds_kind" CHECK (kind in ('unrestricted', 'restricted', 'endowment', 'grant')),
	CONSTRAINT "finance_funds_dates" CHECK (ends_on is null or starts_on is null or ends_on >= starts_on),
	CONSTRAINT "finance_funds_sanction" CHECK (sanctioned_paise is null or sanctioned_paise >= 0)
);
--> statement-breakpoint
ALTER TABLE "finance_funds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finance_currencies" (
	"institution_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"symbol" text,
	"minor_units" smallint DEFAULT 2 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_currencies_institution_id_code_pk" PRIMARY KEY("institution_id","code"),
	CONSTRAINT "finance_currencies_code" CHECK (code ~ '^[A-Z]{3}$'),
	CONSTRAINT "finance_currencies_minor" CHECK (minor_units between 0 and 4)
);
--> statement-breakpoint
ALTER TABLE "finance_currencies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finance_exchange_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"on" date NOT NULL,
	"rate" numeric(20, 10) NOT NULL,
	"source" text,
	"entered_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_exchange_rates_positive" CHECK (rate > 0)
);
--> statement-breakpoint
ALTER TABLE "finance_exchange_rates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finance_series" (
	"institution_id" uuid NOT NULL,
	"doc_type" text NOT NULL,
	"prefix" text NOT NULL,
	"padding" smallint DEFAULT 4 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_series_institution_id_doc_type_pk" PRIMARY KEY("institution_id","doc_type"),
	CONSTRAINT "finance_series_padding" CHECK (padding between 1 and 10),
	CONSTRAINT "finance_series_prefix" CHECK (length(prefix) between 1 and 40)
);
--> statement-breakpoint
ALTER TABLE "finance_series" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finance_series_counters" (
	"institution_id" uuid NOT NULL,
	"doc_type" text NOT NULL,
	"scope" text NOT NULL,
	"last_value" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "finance_series_counters_institution_id_doc_type_scope_pk" PRIMARY KEY("institution_id","doc_type","scope"),
	CONSTRAINT "finance_series_counters_positive" CHECK (last_value >= 0)
);
--> statement-breakpoint
ALTER TABLE "finance_series_counters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finance_approval_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"doc_type" text NOT NULL,
	"min_amount_paise" bigint NOT NULL,
	"approver" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_approval_rules_amount" CHECK (min_amount_paise >= 0)
);
--> statement-breakpoint
ALTER TABLE "finance_approval_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finance_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"doc_type" text NOT NULL,
	"doc_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"decision" text NOT NULL,
	"decided_by" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_approvals_decision" CHECK (decision in ('approved', 'rejected')),
	CONSTRAINT "finance_approvals_reason" CHECK (decision = 'approved' or length(trim(coalesce(note, ''))) >= 3)
);
--> statement-breakpoint
ALTER TABLE "finance_approvals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finance_staff" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"capability" text NOT NULL,
	"warehouse_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_staff_capability" CHECK (capability in ('storekeeper', 'purchaser', 'approver'))
);
--> statement-breakpoint
ALTER TABLE "finance_staff" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "finance_settings" ADD CONSTRAINT "finance_settings_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_fiscal_years" ADD CONSTRAINT "finance_fiscal_years_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_fiscal_years" ADD CONSTRAINT "finance_fiscal_years_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_fiscal_years" ADD CONSTRAINT "finance_fiscal_years_closing_entry_id_finance_journal_entries_id_fk" FOREIGN KEY ("closing_entry_id") REFERENCES "public"."finance_journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_cost_centers" ADD CONSTRAINT "finance_cost_centers_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_cost_centers" ADD CONSTRAINT "finance_cost_centers_parent_id_finance_cost_centers_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."finance_cost_centers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_funds" ADD CONSTRAINT "finance_funds_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_currencies" ADD CONSTRAINT "finance_currencies_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_exchange_rates" ADD CONSTRAINT "finance_exchange_rates_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_exchange_rates" ADD CONSTRAINT "finance_exchange_rates_entered_by_users_id_fk" FOREIGN KEY ("entered_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_series" ADD CONSTRAINT "finance_series_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_series_counters" ADD CONSTRAINT "finance_series_counters_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_approval_rules" ADD CONSTRAINT "finance_approval_rules_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_approvals" ADD CONSTRAINT "finance_approvals_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_approvals" ADD CONSTRAINT "finance_approvals_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_staff" ADD CONSTRAINT "finance_staff_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_staff" ADD CONSTRAINT "finance_staff_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "finance_fiscal_years_label" ON "finance_fiscal_years" USING btree ("institution_id","label");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_cost_centers_code" ON "finance_cost_centers" USING btree ("institution_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_funds_code" ON "finance_funds" USING btree ("institution_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_exchange_rates_day" ON "finance_exchange_rates" USING btree ("institution_id","currency","on");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_approval_rules_step" ON "finance_approval_rules" USING btree ("institution_id","doc_type","min_amount_paise");--> statement-breakpoint
CREATE INDEX "finance_approvals_doc" ON "finance_approvals" USING btree ("doc_type","doc_id");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_staff_once" ON "finance_staff" USING btree ("institution_id","user_id","capability");--> statement-breakpoint
CREATE POLICY "finance_settings_tenant_isolation" ON "finance_settings" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_fiscal_years_tenant_isolation" ON "finance_fiscal_years" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_cost_centers_tenant_isolation" ON "finance_cost_centers" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_funds_tenant_isolation" ON "finance_funds" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_currencies_tenant_isolation" ON "finance_currencies" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_exchange_rates_tenant_isolation" ON "finance_exchange_rates" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_series_tenant_isolation" ON "finance_series" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_series_counters_tenant_isolation" ON "finance_series_counters" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_approval_rules_tenant_isolation" ON "finance_approval_rules" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_approvals_tenant_isolation" ON "finance_approvals" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_staff_tenant_isolation" ON "finance_staff" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint

-- Two fiscal years never overlap ------------------------------------------------
ALTER TABLE "finance_fiscal_years" ADD CONSTRAINT "finance_fiscal_years_no_overlap"
  EXCLUDE USING gist ("institution_id" WITH =, daterange("starts_on", "ends_on", '[]') WITH &&);--> statement-breakpoint

-- The day an entry counts on ------------------------------------------------------
--
-- A poster may say the day (a document posts on its posting date); otherwise it
-- is the day occurred_at fell on in the institution's zone. Every period and
-- fiscal-year rule below reads this column, so "which month is this in" has one
-- answer whoever asks. Named so it fires before the period check, which Postgres
-- orders by name.
CREATE OR REPLACE FUNCTION finance_entry_posting_date() RETURNS trigger AS $$
DECLARE
  zone text;
BEGIN
  IF NEW.posting_date IS NULL THEN
    SELECT s.time_zone INTO zone FROM finance_settings s WHERE s.institution_id = NEW.institution_id;
    NEW.posting_date := (NEW.occurred_at AT TIME ZONE coalesce(zone, 'Asia/Kolkata'))::date;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "finance_entries_date"
  BEFORE INSERT ON "finance_journal_entries"
  FOR EACH ROW EXECUTE FUNCTION finance_entry_posting_date();--> statement-breakpoint

-- Nothing lands in a closed month, or a closed fiscal year ------------------------
--
-- The same rule as migration 0003, now on the posting date, and widened to the
-- year: a closed fiscal year is closed in every month whether or not each was
-- closed on its own.
CREATE OR REPLACE FUNCTION finance_period_is_open() RETURNS trigger AS $$
DECLARE
  state text;
BEGIN
  SELECT p.status INTO state
    FROM finance_periods p
   WHERE p.institution_id = NEW.institution_id
     AND p.year = extract(year from NEW.posting_date)::smallint
     AND p.month = extract(month from NEW.posting_date)::smallint;

  IF state = 'closed' THEN
    RAISE EXCEPTION 'that accounting period is closed'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'finance_period_closed',
            HINT = 'post it to an open month, or reopen that one with a reason';
  END IF;

  IF EXISTS (
    SELECT 1 FROM finance_fiscal_years f
     WHERE f.institution_id = NEW.institution_id
       AND f.status = 'closed'
       AND NEW.posting_date BETWEEN f.starts_on AND f.ends_on
  ) THEN
    RAISE EXCEPTION 'that fiscal year is closed'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'finance_fiscal_year_closed',
            HINT = 'post it to an open year, or reopen that one with a reason';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- A line is written with its entry, onto an account that can take it -----------
--
-- The append-only rule stopped an entry being edited, but not a balanced pair
-- of new lines being added to one later -- into a month that had since closed.
-- Lines are now accepted only from the transaction that wrote their entry,
-- which is the only honest time to write them.
--
-- A group of accounts carries no postings: its balance is its children's, and a
-- line on it would be a balance belonging to nothing. An account kept in a
-- foreign currency takes only lines that say how much of that currency.
CREATE OR REPLACE FUNCTION finance_line_is_acceptable() RETURNS trigger AS $$
DECLARE
  acct record;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM finance_journal_entries e
     WHERE e.id = NEW.entry_id AND e.tx_id = pg_current_xact_id()
  ) THEN
    RAISE EXCEPTION 'a line is written with its entry, in the same transaction'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'finance_lines_with_entry';
  END IF;

  SELECT a.is_group, a.currency INTO acct FROM finance_accounts a WHERE a.id = NEW.account_id;
  IF acct.is_group THEN
    RAISE EXCEPTION 'a group of accounts takes no postings; post to one of its accounts'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'finance_lines_group_account';
  END IF;
  IF acct.currency IS NOT NULL AND NEW.currency IS DISTINCT FROM acct.currency THEN
    RAISE EXCEPTION 'that account is kept in %; the line must say how much', acct.currency
      USING ERRCODE = 'check_violation', CONSTRAINT = 'finance_lines_account_currency';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "finance_lines_acceptable"
  BEFORE INSERT ON "finance_journal_lines"
  FOR EACH ROW EXECUTE FUNCTION finance_line_is_acceptable();--> statement-breakpoint

-- The chart's tree ----------------------------------------------------------------
--
-- A child sits under a group of its own type, the tree has no loops, and an
-- account that has been posted to keeps its type, its currency and its being a
-- ledger rather than a group -- changing any of those would change what last
-- year's statements said.
CREATE OR REPLACE FUNCTION finance_accounts_tree() RETURNS trigger AS $$
DECLARE
  parent record;
  cur uuid;
  depth int := 0;
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  IF NEW.parent_id IS NOT NULL THEN
    SELECT a.is_group, a.type INTO parent FROM finance_accounts a WHERE a.id = NEW.parent_id;
    IF NOT parent.is_group THEN
      RAISE EXCEPTION 'an account sits under a group, not under another account'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'finance_accounts_parent_group';
    END IF;
    IF parent.type <> NEW.type THEN
      RAISE EXCEPTION 'an account sits under a group of its own type'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'finance_accounts_parent_type';
    END IF;
    cur := NEW.parent_id;
    WHILE cur IS NOT NULL LOOP
      IF cur = NEW.id THEN
        RAISE EXCEPTION 'an account cannot sit under itself'
          USING ERRCODE = 'check_violation', CONSTRAINT = 'finance_accounts_loop';
      END IF;
      depth := depth + 1;
      IF depth > 12 THEN
        RAISE EXCEPTION 'the chart is twelve levels deep at most'
          USING ERRCODE = 'check_violation', CONSTRAINT = 'finance_accounts_depth';
      END IF;
      SELECT a.parent_id INTO cur FROM finance_accounts a WHERE a.id = cur;
    END LOOP;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF (NEW.type <> OLD.type OR NEW.is_group <> OLD.is_group OR NEW.currency IS DISTINCT FROM OLD.currency)
       AND EXISTS (SELECT 1 FROM finance_journal_lines l WHERE l.account_id = NEW.id) THEN
      RAISE EXCEPTION 'an account that has been posted to keeps its type, its currency and its kind'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'finance_accounts_has_postings';
    END IF;
    IF (OLD.is_group AND NOT NEW.is_group OR NEW.type <> OLD.type)
       AND EXISTS (SELECT 1 FROM finance_accounts c WHERE c.parent_id = NEW.id) THEN
      RAISE EXCEPTION 'a group with accounts under it stays a group of its type'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'finance_accounts_has_children';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "finance_accounts_tree"
  BEFORE INSERT OR UPDATE ON "finance_accounts"
  FOR EACH ROW EXECUTE FUNCTION finance_accounts_tree();--> statement-breakpoint

-- Cost centres: a tree without loops --------------------------------------------
CREATE OR REPLACE FUNCTION finance_cost_centers_tree() RETURNS trigger AS $$
DECLARE
  cur uuid := NEW.parent_id;
  depth int := 0;
BEGIN
  WHILE cur IS NOT NULL LOOP
    IF cur = NEW.id OR depth > 12 THEN
      RAISE EXCEPTION 'a cost centre cannot sit under itself'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'finance_cost_centers_loop';
    END IF;
    depth := depth + 1;
    SELECT c.parent_id INTO cur FROM finance_cost_centers c WHERE c.id = cur;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "finance_cost_centers_tree"
  BEFORE INSERT OR UPDATE ON "finance_cost_centers"
  FOR EACH ROW EXECUTE FUNCTION finance_cost_centers_tree();--> statement-breakpoint

-- Rows that are records, kept as written --------------------------------------------
--
-- The journal's own append-only rule, for the other tables that are evidence
-- rather than state: approvals now, the party and stock ledgers and an asset's
-- history later. A cascade from offboarding the institution is let through.
CREATE OR REPLACE FUNCTION finance_kept() RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'a % row is kept as it was written', TG_TABLE_NAME
    USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_kept';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "finance_approvals_kept"
  BEFORE UPDATE OR DELETE ON "finance_approvals"
  FOR EACH ROW EXECUTE FUNCTION finance_kept();
