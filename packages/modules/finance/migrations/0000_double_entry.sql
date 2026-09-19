-- The books. Applied by the host at install time, in this order.

CREATE TYPE "public"."finance_account_type" AS ENUM('asset', 'liability', 'equity', 'income', 'expense');--> statement-breakpoint
CREATE TYPE "public"."finance_account_purpose" AS ENUM('cash', 'bank', 'fees_receivable', 'fee_income', 'fee_waiver', 'salaries_expense', 'employer_cost', 'salaries_payable', 'withholdings_payable');--> statement-breakpoint

CREATE TABLE "finance_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"type" "finance_account_type" NOT NULL,
	"purpose" "finance_account_purpose",
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_accounts_code_present" CHECK (length(trim(code)) > 0)
);
--> statement-breakpoint
ALTER TABLE "finance_accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE TABLE "finance_journal_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"memo" text NOT NULL,
	"source_module" text NOT NULL,
	"source_ref" text NOT NULL,
	"reversal_of" uuid,
	"posted_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_entries_memo" CHECK (length(trim(memo)) > 0)
);
--> statement-breakpoint
ALTER TABLE "finance_journal_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE TABLE "finance_journal_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"debit_paise" bigint DEFAULT 0 NOT NULL,
	"credit_paise" bigint DEFAULT 0 NOT NULL,
	"cost_center" text,
	"memo" text,
	CONSTRAINT "finance_lines_one_side" CHECK (debit_paise >= 0 AND credit_paise >= 0 AND (debit_paise = 0) <> (credit_paise = 0))
);
--> statement-breakpoint
ALTER TABLE "finance_journal_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

ALTER TABLE "finance_accounts" ADD CONSTRAINT "finance_accounts_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_journal_entries" ADD CONSTRAINT "finance_journal_entries_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_journal_entries" ADD CONSTRAINT "finance_journal_entries_reversal_of_fk" FOREIGN KEY ("reversal_of") REFERENCES "public"."finance_journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_journal_entries" ADD CONSTRAINT "finance_journal_entries_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_journal_lines" ADD CONSTRAINT "finance_journal_lines_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_journal_lines" ADD CONSTRAINT "finance_journal_lines_entry_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."finance_journal_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_journal_lines" ADD CONSTRAINT "finance_journal_lines_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."finance_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "finance_accounts_code" ON "finance_accounts" USING btree ("institution_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_accounts_purpose" ON "finance_accounts" USING btree ("institution_id","purpose") WHERE purpose is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "finance_entries_source" ON "finance_journal_entries" USING btree ("institution_id","source_module","source_ref");--> statement-breakpoint
CREATE INDEX "finance_entries_occurred" ON "finance_journal_entries" USING btree ("institution_id","occurred_at");--> statement-breakpoint
CREATE INDEX "finance_lines_entry" ON "finance_journal_lines" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX "finance_lines_account" ON "finance_journal_lines" USING btree ("account_id");--> statement-breakpoint

CREATE POLICY "finance_accounts_tenant_isolation" ON "finance_accounts" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_journal_entries_tenant_isolation" ON "finance_journal_entries" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_journal_lines_tenant_isolation" ON "finance_journal_lines" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint

-- The one invariant that makes this a ledger ---------------------------------
--
-- No row-level check can see its siblings, and the lines of an entry are
-- necessarily inserted one at a time -- so the balance is asserted at COMMIT by
-- a deferred constraint trigger. A caller that writes three lines and forgets
-- the fourth gets its transaction refused rather than a quietly lopsided book.
--
-- The application checks the same thing first, which is not redundant: it is
-- what turns this into a readable error instead of a Postgres exception.
CREATE OR REPLACE FUNCTION finance_entry_balances() RETURNS trigger AS $$
DECLARE
  target uuid;
  d bigint;
  c bigint;
BEGIN
  target := COALESCE(NEW.entry_id, OLD.entry_id);

  -- Gone entirely: the entry was deleted and took its lines with it.
  IF NOT EXISTS (SELECT 1 FROM finance_journal_entries e WHERE e.id = target) THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(sum(l.debit_paise), 0), COALESCE(sum(l.credit_paise), 0)
    INTO d, c
    FROM finance_journal_lines l
   WHERE l.entry_id = target;

  IF d <> c THEN
    RAISE EXCEPTION 'journal entry % is out of balance: debits %, credits %', target, d, c
      USING ERRCODE = 'check_violation';
  END IF;

  IF d = 0 THEN
    RAISE EXCEPTION 'journal entry % has no lines', target
      USING ERRCODE = 'check_violation',
            HINT = 'an entry of nothing is not an entry';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER finance_lines_balance
  AFTER INSERT OR UPDATE OR DELETE ON "finance_journal_lines"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION finance_entry_balances();
--> statement-breakpoint

-- An entry written with no lines at all would never trip the trigger above,
-- because that one only fires on lines. This is the same check from the other
-- side.
CREATE OR REPLACE FUNCTION finance_entry_has_lines() RETURNS trigger AS $$
DECLARE
  d bigint;
  c bigint;
BEGIN
  SELECT COALESCE(sum(l.debit_paise), 0), COALESCE(sum(l.credit_paise), 0)
    INTO d, c
    FROM finance_journal_lines l
   WHERE l.entry_id = NEW.id;

  IF d = 0 AND c = 0 THEN
    RAISE EXCEPTION 'journal entry % has no lines', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF d <> c THEN
    RAISE EXCEPTION 'journal entry % is out of balance: debits %, credits %', NEW.id, d, c
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER finance_entries_balance
  AFTER INSERT ON "finance_journal_entries"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION finance_entry_has_lines();
--> statement-breakpoint

-- Append-only ----------------------------------------------------------------
--
-- Not "requires an audited reason", which is what the fee ledger uses: a posted
-- entry cannot be amended at all, for any reason, by anybody. That is what makes
-- the journal evidence rather than a cache of the current opinion. The
-- correction path is a reversing entry, which is what an accountant would do on
-- paper and what an auditor expects to find.
--
-- A cascade is exempt, at depth > 1: deleting the institution offboards the
-- tenant and its books going with it is the point.
CREATE OR REPLACE FUNCTION finance_append_only() RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  RAISE EXCEPTION 'a posted journal entry cannot be changed or deleted'
    USING ERRCODE = 'check_violation',
          HINT = 'post a reversing entry instead';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER finance_entries_append_only
  BEFORE UPDATE OR DELETE ON "finance_journal_entries"
  FOR EACH ROW EXECUTE FUNCTION finance_append_only();
--> statement-breakpoint

CREATE TRIGGER finance_lines_append_only
  BEFORE UPDATE OR DELETE ON "finance_journal_lines"
  FOR EACH ROW EXECUTE FUNCTION finance_append_only();
