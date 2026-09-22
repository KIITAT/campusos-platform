-- Closing a month, and what a department was given for the year.
--
-- The close is the thing a ledger is judged on. Everything else in this module
-- is arithmetic that can be recomputed; a closed period is a promise that the
-- numbers somebody reported last quarter are the numbers that are still there.
--
-- So the rule lives in the database. Every module in the product posts into
-- this journal, and a closed month that only some code paths respect is not a
-- closed month -- it is a convention with a deadline.

CREATE TYPE "public"."finance_period_status" AS ENUM('open', 'closed');--> statement-breakpoint

CREATE TABLE "finance_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"year" smallint NOT NULL,
	"month" smallint NOT NULL,
	"status" "finance_period_status" DEFAULT 'open' NOT NULL,
	"closed_by" text,
	"closed_at" timestamp with time zone,
	"reopened_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_periods_year" CHECK (year between 1900 and 2200),
	CONSTRAINT "finance_periods_month" CHECK (month between 1 and 12),
	CONSTRAINT "finance_periods_closed" CHECK ((status = 'closed') = (closed_at is not null))
);
--> statement-breakpoint
ALTER TABLE "finance_periods" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE TABLE "finance_budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"year" smallint NOT NULL,
	"cost_center" text NOT NULL,
	"account_id" uuid NOT NULL,
	"amount_paise" bigint NOT NULL,
	"hard_limit" boolean DEFAULT false NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_budgets_year" CHECK (year between 1900 and 2200),
	CONSTRAINT "finance_budgets_amount" CHECK (amount_paise >= 0)
);
--> statement-breakpoint
ALTER TABLE "finance_budgets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

ALTER TABLE "finance_periods" ADD CONSTRAINT "finance_periods_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_periods" ADD CONSTRAINT "finance_periods_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_budgets" ADD CONSTRAINT "finance_budgets_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_budgets" ADD CONSTRAINT "finance_budgets_account_id_finance_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."finance_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "finance_periods_month" ON "finance_periods" USING btree ("institution_id","year","month");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_budgets_line" ON "finance_budgets" USING btree ("institution_id","year","cost_center","account_id");--> statement-breakpoint

CREATE POLICY "finance_periods_tenant_isolation" ON "finance_periods" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_budgets_tenant_isolation" ON "finance_budgets" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint

-- Nothing lands in a closed month ------------------------------------------
--
-- Checked against occurred_at, not against when the row was written: an entry
-- backdated into March is exactly the thing closing March was meant to stop,
-- and it is the only way the rule can be got round otherwise.
--
-- A month with no row is open. Requiring every month to be pre-created would
-- mean a ledger that refuses to post the day somebody starts using it.
CREATE OR REPLACE FUNCTION finance_period_is_open() RETURNS trigger AS $$
DECLARE
  state text;
BEGIN
  SELECT p.status INTO state
    FROM finance_periods p
   WHERE p.institution_id = NEW.institution_id
     AND p.year = extract(year from NEW.occurred_at)::smallint
     AND p.month = extract(month from NEW.occurred_at)::smallint;

  IF state = 'closed' THEN
    RAISE EXCEPTION 'that accounting period is closed'
      USING ERRCODE = 'check_violation',
            HINT = 'post it to an open month, or reopen that one with a reason';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER finance_entries_period_open
  BEFORE INSERT ON "finance_journal_entries"
  FOR EACH ROW EXECUTE FUNCTION finance_period_is_open();
