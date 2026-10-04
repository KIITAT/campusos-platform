-- Stock: items, stores, batches, serial numbers, and the stock ledger whose
-- running balance the database keeps (decision 151).

CREATE TABLE "finance_uoms" (
	"institution_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"whole" boolean DEFAULT true NOT NULL,
	CONSTRAINT "finance_uoms_institution_id_code_pk" PRIMARY KEY("institution_id","code")
);
--> statement-breakpoint
ALTER TABLE "finance_uoms" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finance_item_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"name" text NOT NULL,
	"parent_id" uuid,
	"stock_account_id" uuid,
	"expense_account_id" uuid,
	"income_account_id" uuid,
	"tax_template_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "finance_item_groups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finance_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"group_id" uuid,
	"uom" text NOT NULL,
	"is_stock" boolean DEFAULT true NOT NULL,
	"is_asset" boolean DEFAULT false NOT NULL,
	"asset_category_id" uuid,
	"hsn_sac" text,
	"tax_template_id" uuid,
	"expense_account_id" uuid,
	"income_account_id" uuid,
	"has_batch" boolean DEFAULT false NOT NULL,
	"has_serial" boolean DEFAULT false NOT NULL,
	"valuation" text,
	"reorder_level_milli" bigint,
	"reorder_qty_milli" bigint,
	"standard_rate_paise" bigint,
	"description" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_items_code_text" CHECK (length(trim(code)) > 0),
	CONSTRAINT "finance_items_asset" CHECK (not is_asset or (not is_stock and asset_category_id is not null)),
	CONSTRAINT "finance_items_tracking" CHECK (is_stock or not (has_batch or has_serial)),
	CONSTRAINT "finance_items_valuation" CHECK (valuation is null or valuation in ('moving_average', 'fifo')),
	CONSTRAINT "finance_items_reorder" CHECK ((reorder_level_milli is null or reorder_level_milli >= 0) and (reorder_qty_milli is null or reorder_qty_milli > 0))
);
--> statement-breakpoint
ALTER TABLE "finance_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finance_warehouses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"parent_id" uuid,
	"is_group" boolean DEFAULT false NOT NULL,
	"stock_account_id" uuid,
	"cost_center" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "finance_warehouses" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finance_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"batch_no" text NOT NULL,
	"made_on" date,
	"expires_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_batches_dates" CHECK (expires_on is null or made_on is null or expires_on >= made_on)
);
--> statement-breakpoint
ALTER TABLE "finance_batches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finance_serials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"serial_no" text NOT NULL,
	"status" text DEFAULT 'in_stock' NOT NULL,
	"warehouse_id" uuid,
	"batch_id" uuid,
	"asset_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_serials_status" CHECK (status in ('in_stock', 'out')),
	CONSTRAINT "finance_serials_where" CHECK ((status = 'in_stock') = (warehouse_id is not null))
);
--> statement-breakpoint
ALTER TABLE "finance_serials" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finance_stock_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"number" text,
	"kind" text NOT NULL,
	"posting_date" date NOT NULL,
	"memo" text,
	"cost_center" text,
	"fund_id" uuid,
	"account_id" uuid,
	"material_request_id" uuid,
	"entry_id" uuid,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"docstatus" text DEFAULT 'draft' NOT NULL,
	"submitted_at" timestamp with time zone,
	"submitted_by" text,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" text,
	"cancel_reason" text,
	"amended_from" uuid,
	CONSTRAINT "finance_stock_entries_kind" CHECK (kind in ('receipt', 'issue', 'transfer', 'reconciliation')),
	CONSTRAINT "finance_stock_entries_numbered" CHECK (docstatus = 'draft' or number is not null)
);
--> statement-breakpoint
ALTER TABLE "finance_stock_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finance_stock_entry_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"stock_entry_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"item_id" uuid NOT NULL,
	"from_warehouse_id" uuid,
	"to_warehouse_id" uuid,
	"qty_milli" bigint NOT NULL,
	"rate_paise" bigint,
	"batch_id" uuid,
	"serials" text[],
	"amount_paise" bigint,
	CONSTRAINT "finance_stock_entry_lines_qty" CHECK (qty_milli >= 0),
	CONSTRAINT "finance_stock_entry_lines_rate" CHECK (rate_paise is null or rate_paise >= 0)
);
--> statement-breakpoint
ALTER TABLE "finance_stock_entry_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finance_stock_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"seq" bigserial NOT NULL,
	"item_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"batch_id" uuid,
	"posting_date" date NOT NULL,
	"voucher_type" text NOT NULL,
	"voucher_id" uuid NOT NULL,
	"voucher_line_id" uuid,
	"qty_change_milli" bigint NOT NULL,
	"value_change_paise" bigint NOT NULL,
	"qty_after_milli" bigint NOT NULL,
	"value_after_paise" bigint NOT NULL,
	"serials" text[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "finance_stock_ledger" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finance_stock_bins" (
	"institution_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"qty_milli" bigint DEFAULT 0 NOT NULL,
	"value_paise" bigint DEFAULT 0 NOT NULL,
	"last_posting_date" date,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_stock_bins_item_id_warehouse_id_pk" PRIMARY KEY("item_id","warehouse_id")
);
--> statement-breakpoint
ALTER TABLE "finance_stock_bins" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finance_batch_bins" (
	"institution_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"qty_milli" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "finance_batch_bins_batch_id_warehouse_id_pk" PRIMARY KEY("batch_id","warehouse_id"),
	CONSTRAINT "finance_batch_bins_qty" CHECK (qty_milli >= 0)
);
--> statement-breakpoint
ALTER TABLE "finance_batch_bins" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finance_stock_layers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"ledger_id" uuid NOT NULL,
	"posting_date" date NOT NULL,
	"qty_left_milli" bigint NOT NULL,
	"value_left_paise" bigint NOT NULL,
	CONSTRAINT "finance_stock_layers_left" CHECK (qty_left_milli >= 0 and value_left_paise >= 0)
);
--> statement-breakpoint
ALTER TABLE "finance_stock_layers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "finance_uoms" ADD CONSTRAINT "finance_uoms_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_item_groups" ADD CONSTRAINT "finance_item_groups_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_item_groups" ADD CONSTRAINT "finance_item_groups_parent_id_finance_item_groups_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."finance_item_groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_item_groups" ADD CONSTRAINT "finance_item_groups_stock_account_id_finance_accounts_id_fk" FOREIGN KEY ("stock_account_id") REFERENCES "public"."finance_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_item_groups" ADD CONSTRAINT "finance_item_groups_expense_account_id_finance_accounts_id_fk" FOREIGN KEY ("expense_account_id") REFERENCES "public"."finance_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_item_groups" ADD CONSTRAINT "finance_item_groups_income_account_id_finance_accounts_id_fk" FOREIGN KEY ("income_account_id") REFERENCES "public"."finance_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_item_groups" ADD CONSTRAINT "finance_item_groups_tax_template_id_finance_tax_templates_id_fk" FOREIGN KEY ("tax_template_id") REFERENCES "public"."finance_tax_templates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_items" ADD CONSTRAINT "finance_items_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_items" ADD CONSTRAINT "finance_items_group_id_finance_item_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."finance_item_groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_items" ADD CONSTRAINT "finance_items_tax_template_id_finance_tax_templates_id_fk" FOREIGN KEY ("tax_template_id") REFERENCES "public"."finance_tax_templates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_items" ADD CONSTRAINT "finance_items_expense_account_id_finance_accounts_id_fk" FOREIGN KEY ("expense_account_id") REFERENCES "public"."finance_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_items" ADD CONSTRAINT "finance_items_income_account_id_finance_accounts_id_fk" FOREIGN KEY ("income_account_id") REFERENCES "public"."finance_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_warehouses" ADD CONSTRAINT "finance_warehouses_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_warehouses" ADD CONSTRAINT "finance_warehouses_parent_id_finance_warehouses_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."finance_warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_warehouses" ADD CONSTRAINT "finance_warehouses_stock_account_id_finance_accounts_id_fk" FOREIGN KEY ("stock_account_id") REFERENCES "public"."finance_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_batches" ADD CONSTRAINT "finance_batches_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_batches" ADD CONSTRAINT "finance_batches_item_id_finance_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."finance_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_serials" ADD CONSTRAINT "finance_serials_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_serials" ADD CONSTRAINT "finance_serials_item_id_finance_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."finance_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_serials" ADD CONSTRAINT "finance_serials_warehouse_id_finance_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."finance_warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_serials" ADD CONSTRAINT "finance_serials_batch_id_finance_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."finance_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_stock_entries" ADD CONSTRAINT "finance_stock_entries_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_stock_entries" ADD CONSTRAINT "finance_stock_entries_fund_id_finance_funds_id_fk" FOREIGN KEY ("fund_id") REFERENCES "public"."finance_funds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_stock_entries" ADD CONSTRAINT "finance_stock_entries_account_id_finance_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."finance_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_stock_entries" ADD CONSTRAINT "finance_stock_entries_entry_id_finance_journal_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."finance_journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_stock_entries" ADD CONSTRAINT "finance_stock_entries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_stock_entry_lines" ADD CONSTRAINT "finance_stock_entry_lines_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_stock_entry_lines" ADD CONSTRAINT "finance_stock_entry_lines_stock_entry_id_finance_stock_entries_id_fk" FOREIGN KEY ("stock_entry_id") REFERENCES "public"."finance_stock_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_stock_entry_lines" ADD CONSTRAINT "finance_stock_entry_lines_item_id_finance_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."finance_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_stock_entry_lines" ADD CONSTRAINT "finance_stock_entry_lines_from_warehouse_id_finance_warehouses_id_fk" FOREIGN KEY ("from_warehouse_id") REFERENCES "public"."finance_warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_stock_entry_lines" ADD CONSTRAINT "finance_stock_entry_lines_to_warehouse_id_finance_warehouses_id_fk" FOREIGN KEY ("to_warehouse_id") REFERENCES "public"."finance_warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_stock_entry_lines" ADD CONSTRAINT "finance_stock_entry_lines_batch_id_finance_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."finance_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_stock_ledger" ADD CONSTRAINT "finance_stock_ledger_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_stock_ledger" ADD CONSTRAINT "finance_stock_ledger_item_id_finance_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."finance_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_stock_ledger" ADD CONSTRAINT "finance_stock_ledger_warehouse_id_finance_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."finance_warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_stock_ledger" ADD CONSTRAINT "finance_stock_ledger_batch_id_finance_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."finance_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_stock_bins" ADD CONSTRAINT "finance_stock_bins_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_stock_bins" ADD CONSTRAINT "finance_stock_bins_item_id_finance_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."finance_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_stock_bins" ADD CONSTRAINT "finance_stock_bins_warehouse_id_finance_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."finance_warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_batch_bins" ADD CONSTRAINT "finance_batch_bins_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_batch_bins" ADD CONSTRAINT "finance_batch_bins_batch_id_finance_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."finance_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_batch_bins" ADD CONSTRAINT "finance_batch_bins_warehouse_id_finance_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."finance_warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_stock_layers" ADD CONSTRAINT "finance_stock_layers_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_stock_layers" ADD CONSTRAINT "finance_stock_layers_item_id_finance_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."finance_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_stock_layers" ADD CONSTRAINT "finance_stock_layers_warehouse_id_finance_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."finance_warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_stock_layers" ADD CONSTRAINT "finance_stock_layers_ledger_id_finance_stock_ledger_id_fk" FOREIGN KEY ("ledger_id") REFERENCES "public"."finance_stock_ledger"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "finance_item_groups_name" ON "finance_item_groups" USING btree ("institution_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_items_code" ON "finance_items" USING btree ("institution_id","code");--> statement-breakpoint
CREATE INDEX "finance_items_name" ON "finance_items" USING btree ("institution_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_warehouses_code" ON "finance_warehouses" USING btree ("institution_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_batches_no" ON "finance_batches" USING btree ("institution_id","item_id","batch_no");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_serials_no" ON "finance_serials" USING btree ("institution_id","item_id","serial_no");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_stock_entries_number" ON "finance_stock_entries" USING btree ("institution_id","number");--> statement-breakpoint
CREATE INDEX "finance_stock_entry_lines_entry" ON "finance_stock_entry_lines" USING btree ("stock_entry_id");--> statement-breakpoint
CREATE INDEX "finance_stock_ledger_item" ON "finance_stock_ledger" USING btree ("institution_id","item_id","warehouse_id","seq");--> statement-breakpoint
CREATE INDEX "finance_stock_ledger_voucher" ON "finance_stock_ledger" USING btree ("voucher_type","voucher_id");--> statement-breakpoint
CREATE INDEX "finance_stock_ledger_date" ON "finance_stock_ledger" USING btree ("institution_id","posting_date");--> statement-breakpoint
CREATE INDEX "finance_stock_layers_open" ON "finance_stock_layers" USING btree ("institution_id","item_id","warehouse_id","posting_date");--> statement-breakpoint
CREATE POLICY "finance_uoms_tenant_isolation" ON "finance_uoms" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_item_groups_tenant_isolation" ON "finance_item_groups" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_items_tenant_isolation" ON "finance_items" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_warehouses_tenant_isolation" ON "finance_warehouses" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_batches_tenant_isolation" ON "finance_batches" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_serials_tenant_isolation" ON "finance_serials" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_stock_entries_tenant_isolation" ON "finance_stock_entries" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_stock_entry_lines_tenant_isolation" ON "finance_stock_entry_lines" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_stock_ledger_tenant_isolation" ON "finance_stock_ledger" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_stock_bins_tenant_isolation" ON "finance_stock_bins" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_batch_bins_tenant_isolation" ON "finance_batch_bins" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_stock_layers_tenant_isolation" ON "finance_stock_layers" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE "finance_stock_entries" ADD CONSTRAINT "finance_stock_entries_docstatus" CHECK (docstatus in ('draft', 'submitted', 'cancelled'));--> statement-breakpoint
ALTER TABLE "finance_stock_entries" ADD CONSTRAINT "finance_stock_entries_amended_from_fk" FOREIGN KEY ("amended_from") REFERENCES "finance_stock_entries"("id") ON DELETE restrict;--> statement-breakpoint
CREATE TRIGGER "finance_stock_entries_docstatus" BEFORE INSERT OR UPDATE OR DELETE ON "finance_stock_entries" FOR EACH ROW EXECUTE FUNCTION campusos_docstatus_guard();--> statement-breakpoint
CREATE TRIGGER "finance_stock_entry_lines_draft" BEFORE INSERT OR UPDATE OR DELETE ON "finance_stock_entry_lines" FOR EACH ROW EXECUTE FUNCTION finance_child_of_draft('finance_stock_entries', 'stock_entry_id');--> statement-breakpoint

ALTER TABLE "finance_items" ADD CONSTRAINT "finance_items_uom_fk" FOREIGN KEY ("institution_id", "uom") REFERENCES "public"."finance_uoms"("institution_id", "code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- The stock ledger, and the running balance it keeps ------------------------------------
--
-- Every row says what the store held of the item after it. That is checked
-- against the bin -- the store's balance -- under a row lock, so two issues of
-- the last box cannot both find it there, and the bin moves in the same
-- statement. Rows go in time order per item and store: one dated before the
-- last is refused, which is what lets a running balance be true without
-- re-valuing history.
--
-- Quantity at zero means value at zero. Batches keep their own count, which
-- may not go below nothing. Serial-numbered things are moved one by one: a
-- serial comes in only if it is not already somewhere, and goes out only from
-- the store it is in.
CREATE OR REPLACE FUNCTION finance_stock_ledger_moves() RETURNS trigger AS $$
DECLARE
  bin record;
  item record;
  negative_ok boolean;
  n int;
BEGIN
  SELECT i.is_stock, i.has_batch, i.has_serial INTO item FROM finance_items i WHERE i.id = NEW.item_id;
  IF NOT item.is_stock THEN
    RAISE EXCEPTION 'only a stock item moves through the stores'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'finance_stock_not_stock';
  END IF;
  IF item.has_batch AND NEW.batch_id IS NULL THEN
    RAISE EXCEPTION 'that item is kept by batch; say which'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'finance_stock_batch_required';
  END IF;
  IF item.has_serial AND (NEW.serials IS NULL OR cardinality(NEW.serials) * 1000 <> abs(NEW.qty_change_milli)) THEN
    RAISE EXCEPTION 'that item is kept by serial number; list one for each unit'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'finance_stock_serials_required';
  END IF;

  INSERT INTO finance_stock_bins (institution_id, item_id, warehouse_id)
       VALUES (NEW.institution_id, NEW.item_id, NEW.warehouse_id)
  ON CONFLICT DO NOTHING;
  SELECT * INTO bin FROM finance_stock_bins b
   WHERE b.item_id = NEW.item_id AND b.warehouse_id = NEW.warehouse_id
     FOR UPDATE;

  IF bin.last_posting_date IS NOT NULL AND NEW.posting_date < bin.last_posting_date THEN
    RAISE EXCEPTION 'stock is posted in date order; that item last moved in that store on %', bin.last_posting_date
      USING ERRCODE = 'check_violation', CONSTRAINT = 'finance_stock_in_order';
  END IF;
  IF NEW.qty_after_milli <> bin.qty_milli + NEW.qty_change_milli
     OR NEW.value_after_paise <> bin.value_paise + NEW.value_change_paise THEN
    RAISE EXCEPTION 'the stock balance does not follow from the last movement'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'finance_stock_running_balance';
  END IF;

  SELECT s.allow_negative_stock INTO negative_ok FROM finance_settings s WHERE s.institution_id = NEW.institution_id;
  IF NEW.qty_after_milli < 0 AND NOT coalesce(negative_ok, false) THEN
    RAISE EXCEPTION 'there is not that much of it in that store'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'finance_stock_negative';
  END IF;
  IF NEW.qty_after_milli = 0 AND NEW.value_after_paise <> 0 THEN
    RAISE EXCEPTION 'an empty store holds no value'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'finance_stock_value_without_qty';
  END IF;

  UPDATE finance_stock_bins
     SET qty_milli = NEW.qty_after_milli,
         value_paise = NEW.value_after_paise,
         last_posting_date = NEW.posting_date,
         updated_at = now()
   WHERE item_id = NEW.item_id AND warehouse_id = NEW.warehouse_id;

  IF NEW.batch_id IS NOT NULL THEN
    INSERT INTO finance_batch_bins (institution_id, batch_id, warehouse_id, qty_milli)
         VALUES (NEW.institution_id, NEW.batch_id, NEW.warehouse_id, NEW.qty_change_milli)
    ON CONFLICT (batch_id, warehouse_id)
      DO UPDATE SET qty_milli = finance_batch_bins.qty_milli + EXCLUDED.qty_milli;
  END IF;

  IF NEW.serials IS NOT NULL THEN
    IF NEW.qty_change_milli > 0 THEN
      INSERT INTO finance_serials (institution_id, item_id, serial_no, status, warehouse_id, batch_id)
           SELECT NEW.institution_id, NEW.item_id, s, 'in_stock', NEW.warehouse_id, NEW.batch_id
             FROM unnest(NEW.serials) AS s
      ON CONFLICT (institution_id, item_id, serial_no)
        DO UPDATE SET status = 'in_stock', warehouse_id = EXCLUDED.warehouse_id
        WHERE finance_serials.status = 'out';
      GET DIAGNOSTICS n = ROW_COUNT;
      IF n <> cardinality(NEW.serials) THEN
        RAISE EXCEPTION 'a serial number coming in is already in stock'
          USING ERRCODE = 'check_violation', CONSTRAINT = 'finance_stock_serial_in_stock';
      END IF;
    ELSE
      UPDATE finance_serials
         SET status = 'out', warehouse_id = NULL
       WHERE item_id = NEW.item_id
         AND serial_no = ANY (NEW.serials)
         AND status = 'in_stock'
         AND warehouse_id = NEW.warehouse_id;
      GET DIAGNOSTICS n = ROW_COUNT;
      IF n <> cardinality(NEW.serials) THEN
        RAISE EXCEPTION 'a serial number going out is not in that store'
          USING ERRCODE = 'check_violation', CONSTRAINT = 'finance_stock_serial_missing';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "finance_stock_ledger_moves"
  BEFORE INSERT ON "finance_stock_ledger"
  FOR EACH ROW EXECUTE FUNCTION finance_stock_ledger_moves();--> statement-breakpoint

CREATE TRIGGER "finance_stock_ledger_kept"
  BEFORE UPDATE OR DELETE ON "finance_stock_ledger"
  FOR EACH ROW EXECUTE FUNCTION finance_kept();--> statement-breakpoint

-- The bins are the ledger's, written by its trigger and by nothing else --------------
CREATE OR REPLACE FUNCTION finance_bins_by_ledger() RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'stock balances move only with the stock ledger'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'finance_stock_bins_by_ledger';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "finance_stock_bins_by_ledger"
  BEFORE INSERT OR UPDATE OR DELETE ON "finance_stock_bins"
  FOR EACH ROW EXECUTE FUNCTION finance_bins_by_ledger();--> statement-breakpoint

CREATE TRIGGER "finance_batch_bins_by_ledger"
  BEFORE INSERT OR UPDATE OR DELETE ON "finance_batch_bins"
  FOR EACH ROW EXECUTE FUNCTION finance_bins_by_ledger();--> statement-breakpoint

-- A batch keeps its item --------------------------------------------------------------
CREATE OR REPLACE FUNCTION finance_ledger_batch_fits() RETURNS trigger AS $$
BEGIN
  IF NEW.batch_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM finance_batches b WHERE b.id = NEW.batch_id AND b.item_id = NEW.item_id
  ) THEN
    RAISE EXCEPTION 'that batch is of another item'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'finance_stock_batch_item';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "finance_stock_ledger_batch"
  BEFORE INSERT ON "finance_stock_ledger"
  FOR EACH ROW EXECUTE FUNCTION finance_ledger_batch_fits();
