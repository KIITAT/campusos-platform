-- Bank accounts, the statements the bank sends, and matching them to the books.

CREATE TABLE "finance_bank_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"bank_name" text NOT NULL,
	"branch" text,
	"ifsc" text,
	"account_number" text NOT NULL,
	"csv_mapping" jsonb,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_bank_accounts_ifsc" CHECK (ifsc is null or ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$')
);
--> statement-breakpoint
ALTER TABLE "finance_bank_accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finance_bank_statements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"file_sha256" text NOT NULL,
	"format" text NOT NULL,
	"from_date" date,
	"to_date" date,
	"opening_paise" bigint,
	"closing_paise" bigint,
	"line_count" integer NOT NULL,
	"imported_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_bank_statements_format" CHECK (format in ('csv', 'xlsx', 'mt940', 'camt053'))
);
--> statement-breakpoint
ALTER TABLE "finance_bank_statements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finance_bank_statement_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"statement_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"txn_date" date NOT NULL,
	"value_date" date,
	"description" text NOT NULL,
	"reference" text,
	"withdrawal_paise" bigint DEFAULT 0 NOT NULL,
	"deposit_paise" bigint DEFAULT 0 NOT NULL,
	"balance_paise" bigint,
	"status" text DEFAULT 'unmatched' NOT NULL,
	"matched_line_id" uuid,
	"matched_by" text,
	"matched_at" timestamp with time zone,
	"note" text,
	CONSTRAINT "finance_bank_statement_lines_amount" CHECK (withdrawal_paise >= 0 and deposit_paise >= 0 and (withdrawal_paise = 0) <> (deposit_paise = 0)),
	CONSTRAINT "finance_bank_statement_lines_status" CHECK (status in ('unmatched', 'matched', 'ignored') and (status = 'matched') = (matched_line_id is not null))
);
--> statement-breakpoint
ALTER TABLE "finance_bank_statement_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finance_bank_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"bank_account_id" uuid,
	"contains" text NOT NULL,
	"direction" text DEFAULT 'any' NOT NULL,
	"account_id" uuid NOT NULL,
	"cost_center" text,
	"priority" integer DEFAULT 100 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_bank_rules_direction" CHECK (direction in ('in', 'out', 'any')),
	CONSTRAINT "finance_bank_rules_contains" CHECK (length(trim(contains)) >= 2)
);
--> statement-breakpoint
ALTER TABLE "finance_bank_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "finance_bank_accounts" ADD CONSTRAINT "finance_bank_accounts_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_bank_accounts" ADD CONSTRAINT "finance_bank_accounts_account_id_finance_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."finance_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_bank_statements" ADD CONSTRAINT "finance_bank_statements_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_bank_statements" ADD CONSTRAINT "finance_bank_statements_bank_account_id_finance_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."finance_bank_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_bank_statements" ADD CONSTRAINT "finance_bank_statements_imported_by_users_id_fk" FOREIGN KEY ("imported_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_bank_statement_lines" ADD CONSTRAINT "finance_bank_statement_lines_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_bank_statement_lines" ADD CONSTRAINT "finance_bank_statement_lines_statement_id_finance_bank_statements_id_fk" FOREIGN KEY ("statement_id") REFERENCES "public"."finance_bank_statements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_bank_statement_lines" ADD CONSTRAINT "finance_bank_statement_lines_bank_account_id_finance_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."finance_bank_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_bank_statement_lines" ADD CONSTRAINT "finance_bank_statement_lines_matched_line_id_finance_journal_lines_id_fk" FOREIGN KEY ("matched_line_id") REFERENCES "public"."finance_journal_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_bank_statement_lines" ADD CONSTRAINT "finance_bank_statement_lines_matched_by_users_id_fk" FOREIGN KEY ("matched_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_bank_rules" ADD CONSTRAINT "finance_bank_rules_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_bank_rules" ADD CONSTRAINT "finance_bank_rules_bank_account_id_finance_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."finance_bank_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_bank_rules" ADD CONSTRAINT "finance_bank_rules_account_id_finance_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."finance_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "finance_bank_accounts_account" ON "finance_bank_accounts" USING btree ("institution_id","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_bank_statements_file" ON "finance_bank_statements" USING btree ("institution_id","bank_account_id","file_sha256");--> statement-breakpoint
CREATE INDEX "finance_bank_statement_lines_statement" ON "finance_bank_statement_lines" USING btree ("statement_id");--> statement-breakpoint
CREATE INDEX "finance_bank_statement_lines_account" ON "finance_bank_statement_lines" USING btree ("institution_id","bank_account_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_bank_statement_lines_matched" ON "finance_bank_statement_lines" USING btree ("matched_line_id") WHERE matched_line_id is not null;--> statement-breakpoint
CREATE POLICY "finance_bank_accounts_tenant_isolation" ON "finance_bank_accounts" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_bank_statements_tenant_isolation" ON "finance_bank_statements" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_bank_statement_lines_tenant_isolation" ON "finance_bank_statement_lines" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_bank_rules_tenant_isolation" ON "finance_bank_rules" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint

-- A statement says what the bank said -------------------------------------------------
--
-- Imported lines are the bank's words and figures. Matching them is the
-- office's work and changes only the matching columns; the date, the narration
-- and the amount stay as the bank sent them, and a statement is never deleted
-- once a line of it has been matched.
CREATE OR REPLACE FUNCTION finance_statement_line_kept() RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'matched' THEN
      RAISE EXCEPTION 'a statement with matched lines is kept'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'finance_bank_statement_matched';
    END IF;
    RETURN OLD;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'matched_line_id', 'matched_by', 'matched_at', 'note'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'matched_line_id', 'matched_by', 'matched_at', 'note']) THEN
    RAISE EXCEPTION 'a statement line is kept as the bank sent it'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'finance_bank_statement_lines_kept';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "finance_bank_statement_lines_kept"
  BEFORE UPDATE OR DELETE ON "finance_bank_statement_lines"
  FOR EACH ROW EXECUTE FUNCTION finance_statement_line_kept();--> statement-breakpoint

-- A match is to a line on this bank's own account, moving money the same way --------
CREATE OR REPLACE FUNCTION finance_statement_match_fits() RETURNS trigger AS $$
DECLARE
  l record;
  acct uuid;
BEGIN
  IF NEW.matched_line_id IS NULL OR NEW.matched_line_id IS NOT DISTINCT FROM OLD.matched_line_id THEN
    RETURN NEW;
  END IF;
  SELECT jl.account_id, jl.debit_paise, jl.credit_paise INTO l FROM finance_journal_lines jl WHERE jl.id = NEW.matched_line_id;
  SELECT b.account_id INTO acct FROM finance_bank_accounts b WHERE b.id = NEW.bank_account_id;
  IF l.account_id IS DISTINCT FROM acct THEN
    RAISE EXCEPTION 'a statement line is matched to a posting on that bank''s own account'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'finance_bank_match_account';
  END IF;
  IF NOT ((NEW.deposit_paise > 0 AND l.debit_paise = NEW.deposit_paise)
       OR (NEW.withdrawal_paise > 0 AND l.credit_paise = NEW.withdrawal_paise)) THEN
    RAISE EXCEPTION 'a statement line is matched to a posting of the same amount, the same way'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'finance_bank_match_amount';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "finance_bank_statement_lines_match"
  BEFORE UPDATE ON "finance_bank_statement_lines"
  FOR EACH ROW EXECUTE FUNCTION finance_statement_match_fits();
