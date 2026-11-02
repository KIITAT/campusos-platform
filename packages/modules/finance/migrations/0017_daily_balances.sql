-- P1-10b: daily balances kept from the journal (REL-03, decisions B1 to B6).
-- One row per account, posting day, fund, cost centre and closing flag; a trigger on
-- every insert of journal lines adds that statement's sums. The reports read these
-- rows instead of every line. The journal stays the record: finance_rebuild_daily_balances
-- recomputes a tenant's rows from it.
-- Pre-flight: none. A new table; nothing existing is refused. The backfill reads every
-- line once (about a minute at 11M lines); postings wait for this file's transaction.
-- Rollback (a later migration, or by hand as the owner), then run finance at its previous version:
--   DROP TRIGGER finance_lines_balances ON finance_journal_lines;
--   DROP FUNCTION finance_lines_into_balances();
--   DROP FUNCTION finance_rebuild_daily_balances(uuid);
--   DROP TABLE finance_daily_balances;

CREATE TABLE "finance_daily_balances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"posting_date" date NOT NULL,
	"fund_id" uuid,
	"cost_center" text,
	"closing" boolean NOT NULL,
	"debit_paise" bigint NOT NULL,
	"credit_paise" bigint NOT NULL,
	CONSTRAINT "finance_daily_balances_key" UNIQUE NULLS NOT DISTINCT("institution_id","account_id","posting_date","fund_id","cost_center","closing")
);--> statement-breakpoint
ALTER TABLE "finance_daily_balances" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "finance_daily_balances" ADD CONSTRAINT "finance_daily_balances_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_daily_balances" ADD CONSTRAINT "finance_daily_balances_account_id_finance_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."finance_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "finance_daily_balances_tenant_isolation" ON "finance_daily_balances" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint

CREATE OR REPLACE FUNCTION finance_lines_into_balances() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  -- Sorted by the key, so one statement locks its balance rows in a fixed order.
  INSERT INTO finance_daily_balances AS b
         (institution_id, account_id, posting_date, fund_id, cost_center, closing, debit_paise, credit_paise)
  SELECT n.institution_id, n.account_id, e.posting_date, n.fund_id, n.cost_center,
         (e.source_ref LIKE 'year-close:%' OR EXISTS (
            SELECT 1 FROM finance_journal_entries c WHERE c.id = e.reversal_of AND c.source_ref LIKE 'year-close:%')),
         sum(n.debit_paise), sum(n.credit_paise)
    FROM new_lines n JOIN finance_journal_entries e ON e.id = n.entry_id
   GROUP BY 1, 2, 3, 4, 5, 6
   ORDER BY 1, 2, 3, 4, 5, 6
  ON CONFLICT ON CONSTRAINT finance_daily_balances_key DO UPDATE
     SET debit_paise = b.debit_paise + excluded.debit_paise,
         credit_paise = b.credit_paise + excluded.credit_paise;
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER "finance_lines_balances" AFTER INSERT ON "finance_journal_lines"
  REFERENCING NEW TABLE AS new_lines FOR EACH STATEMENT EXECUTE FUNCTION finance_lines_into_balances();--> statement-breakpoint

CREATE OR REPLACE FUNCTION finance_rebuild_daily_balances(tenant uuid) RETURNS bigint
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  written bigint;
BEGIN
  DELETE FROM finance_daily_balances WHERE institution_id = tenant;
  INSERT INTO finance_daily_balances
         (institution_id, account_id, posting_date, fund_id, cost_center, closing, debit_paise, credit_paise)
  SELECT l.institution_id, l.account_id, e.posting_date, l.fund_id, l.cost_center,
         (e.source_ref LIKE 'year-close:%' OR EXISTS (
            SELECT 1 FROM finance_journal_entries c WHERE c.id = e.reversal_of AND c.source_ref LIKE 'year-close:%')),
         sum(l.debit_paise), sum(l.credit_paise)
    FROM finance_journal_lines l JOIN finance_journal_entries e ON e.id = l.entry_id
   WHERE l.institution_id = tenant
   GROUP BY 1, 2, 3, 4, 5, 6;
  GET DIAGNOSTICS written = ROW_COUNT;
  RETURN written;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION finance_rebuild_daily_balances(uuid) FROM PUBLIC;--> statement-breakpoint

SELECT finance_rebuild_daily_balances(t.institution_id)
  FROM (SELECT DISTINCT institution_id FROM finance_journal_entries) t;
