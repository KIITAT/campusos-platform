-- Fixed assets: categories, the register, depreciation schedules and an asset's
-- history (decision 153).

CREATE TABLE "finance_asset_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"name" text NOT NULL,
	"asset_account_id" uuid NOT NULL,
	"accumulated_account_id" uuid NOT NULL,
	"depreciation_account_id" uuid NOT NULL,
	"method" text NOT NULL,
	"life_months" integer,
	"rate_bp" integer,
	"residual_bp" integer DEFAULT 0 NOT NULL,
	"frequency" text DEFAULT 'month' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_asset_categories_method" CHECK (method in ('slm', 'wdv', 'none')),
	CONSTRAINT "finance_asset_categories_basis" CHECK ((method <> 'slm' or (life_months between 1 and 1200)) and (method <> 'wdv' or (rate_bp between 1 and 10000))),
	CONSTRAINT "finance_asset_categories_residual" CHECK (residual_bp between 0 and 10000),
	CONSTRAINT "finance_asset_categories_frequency" CHECK (frequency in ('month', 'year'))
);
--> statement-breakpoint
ALTER TABLE "finance_asset_categories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finance_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"number" text,
	"name" text NOT NULL,
	"category_id" uuid NOT NULL,
	"item_id" uuid,
	"serial_id" uuid,
	"invoice_line_id" uuid,
	"supplier_id" uuid,
	"location_id" uuid,
	"custodian_id" text,
	"cost_center" text,
	"fund_id" uuid,
	"purchased_on" date NOT NULL,
	"in_use_on" date NOT NULL,
	"gross_paise" bigint NOT NULL,
	"opening_accumulated_paise" bigint DEFAULT 0 NOT NULL,
	"existing" text DEFAULT 'no' NOT NULL,
	"warranty_till" date,
	"insured_till" date,
	"tag_code" text,
	"note" text,
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
	CONSTRAINT "finance_assets_numbered" CHECK (docstatus = 'draft' or number is not null),
	CONSTRAINT "finance_assets_gross" CHECK (gross_paise > 0),
	CONSTRAINT "finance_assets_opening" CHECK (opening_accumulated_paise >= 0 and opening_accumulated_paise <= gross_paise),
	CONSTRAINT "finance_assets_dates" CHECK (in_use_on >= purchased_on),
	CONSTRAINT "finance_assets_existing" CHECK (existing in ('no', 'yes'))
);
--> statement-breakpoint
ALTER TABLE "finance_assets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finance_depreciation_schedule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"period_end" date NOT NULL,
	"amount_paise" bigint NOT NULL,
	"accumulated_after_paise" bigint NOT NULL,
	"entry_id" uuid,
	CONSTRAINT "finance_depreciation_schedule_amount" CHECK (amount_paise >= 0)
);
--> statement-breakpoint
ALTER TABLE "finance_depreciation_schedule" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finance_asset_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"on" date NOT NULL,
	"to_location_id" uuid,
	"to_custodian_id" text,
	"to_cost_center" text,
	"cost_paise" bigint,
	"amount_paise" bigint,
	"vendor_id" uuid,
	"finding" text,
	"next_due_on" date,
	"note" text,
	"entry_id" uuid,
	"recorded_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_asset_events_kind" CHECK (kind in ('transfer', 'maintenance', 'verification', 'impairment', 'sold', 'scrapped')),
	CONSTRAINT "finance_asset_events_finding" CHECK (kind <> 'verification' or finding in ('found', 'elsewhere', 'missing')),
	CONSTRAINT "finance_asset_events_amounts" CHECK ((cost_paise is null or cost_paise >= 0) and (amount_paise is null or amount_paise >= 0))
);
--> statement-breakpoint
ALTER TABLE "finance_asset_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "finance_asset_categories" ADD CONSTRAINT "finance_asset_categories_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_asset_categories" ADD CONSTRAINT "finance_asset_categories_asset_account_id_finance_accounts_id_fk" FOREIGN KEY ("asset_account_id") REFERENCES "public"."finance_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_asset_categories" ADD CONSTRAINT "finance_asset_categories_accumulated_account_id_finance_accounts_id_fk" FOREIGN KEY ("accumulated_account_id") REFERENCES "public"."finance_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_asset_categories" ADD CONSTRAINT "finance_asset_categories_depreciation_account_id_finance_accounts_id_fk" FOREIGN KEY ("depreciation_account_id") REFERENCES "public"."finance_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_assets" ADD CONSTRAINT "finance_assets_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_assets" ADD CONSTRAINT "finance_assets_category_id_finance_asset_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."finance_asset_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_assets" ADD CONSTRAINT "finance_assets_item_id_finance_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."finance_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_assets" ADD CONSTRAINT "finance_assets_serial_id_finance_serials_id_fk" FOREIGN KEY ("serial_id") REFERENCES "public"."finance_serials"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_assets" ADD CONSTRAINT "finance_assets_supplier_id_finance_parties_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."finance_parties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_assets" ADD CONSTRAINT "finance_assets_location_id_finance_warehouses_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."finance_warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_assets" ADD CONSTRAINT "finance_assets_custodian_id_users_id_fk" FOREIGN KEY ("custodian_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_assets" ADD CONSTRAINT "finance_assets_fund_id_finance_funds_id_fk" FOREIGN KEY ("fund_id") REFERENCES "public"."finance_funds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_assets" ADD CONSTRAINT "finance_assets_entry_id_finance_journal_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."finance_journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_assets" ADD CONSTRAINT "finance_assets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_depreciation_schedule" ADD CONSTRAINT "finance_depreciation_schedule_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_depreciation_schedule" ADD CONSTRAINT "finance_depreciation_schedule_asset_id_finance_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."finance_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_depreciation_schedule" ADD CONSTRAINT "finance_depreciation_schedule_entry_id_finance_journal_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."finance_journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_asset_events" ADD CONSTRAINT "finance_asset_events_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_asset_events" ADD CONSTRAINT "finance_asset_events_asset_id_finance_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."finance_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_asset_events" ADD CONSTRAINT "finance_asset_events_to_location_id_finance_warehouses_id_fk" FOREIGN KEY ("to_location_id") REFERENCES "public"."finance_warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_asset_events" ADD CONSTRAINT "finance_asset_events_to_custodian_id_users_id_fk" FOREIGN KEY ("to_custodian_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_asset_events" ADD CONSTRAINT "finance_asset_events_vendor_id_finance_parties_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."finance_parties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_asset_events" ADD CONSTRAINT "finance_asset_events_entry_id_finance_journal_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."finance_journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_asset_events" ADD CONSTRAINT "finance_asset_events_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "finance_asset_categories_name" ON "finance_asset_categories" USING btree ("institution_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_assets_number" ON "finance_assets" USING btree ("institution_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_assets_tag" ON "finance_assets" USING btree ("institution_id","tag_code") WHERE tag_code is not null;--> statement-breakpoint
CREATE INDEX "finance_assets_category" ON "finance_assets" USING btree ("institution_id","category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_depreciation_schedule_period" ON "finance_depreciation_schedule" USING btree ("asset_id","period_end");--> statement-breakpoint
CREATE INDEX "finance_depreciation_schedule_due" ON "finance_depreciation_schedule" USING btree ("institution_id","period_end");--> statement-breakpoint
CREATE INDEX "finance_asset_events_asset" ON "finance_asset_events" USING btree ("asset_id");--> statement-breakpoint
CREATE POLICY "finance_asset_categories_tenant_isolation" ON "finance_asset_categories" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_assets_tenant_isolation" ON "finance_assets" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_depreciation_schedule_tenant_isolation" ON "finance_depreciation_schedule" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_asset_events_tenant_isolation" ON "finance_asset_events" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE "finance_assets" ADD CONSTRAINT "finance_assets_docstatus" CHECK (docstatus in ('draft', 'submitted', 'cancelled'));--> statement-breakpoint
ALTER TABLE "finance_assets" ADD CONSTRAINT "finance_assets_amended_from_fk" FOREIGN KEY ("amended_from") REFERENCES "finance_assets"("id") ON DELETE restrict;--> statement-breakpoint
CREATE TRIGGER "finance_assets_docstatus" BEFORE INSERT OR UPDATE OR DELETE ON "finance_assets" FOR EACH ROW EXECUTE FUNCTION campusos_docstatus_guard();--> statement-breakpoint

ALTER TABLE "finance_serials" ADD CONSTRAINT "finance_serials_asset_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."finance_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_invoice_lines" ADD CONSTRAINT "finance_invoice_lines_asset_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."finance_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_items" ADD CONSTRAINT "finance_items_asset_category_fk" FOREIGN KEY ("asset_category_id") REFERENCES "public"."finance_asset_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- A depreciation row is posted once, then fixed ------------------------------------------
--
-- The schedule is worked out when an asset is capitalised. A row not yet posted
-- may be dropped -- the asset was sold, the rest of its schedule will never
-- happen -- but a posted row is history: its amount and its entry stay.
CREATE OR REPLACE FUNCTION finance_depreciation_row_kept() RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF OLD.entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'posted depreciation is kept as it was posted'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'finance_depreciation_posted';
  END IF;
  IF TG_OP = 'UPDATE' AND (
       NEW.amount_paise <> OLD.amount_paise OR NEW.period_end <> OLD.period_end
       OR NEW.asset_id <> OLD.asset_id OR NEW.accumulated_after_paise <> OLD.accumulated_after_paise) THEN
    RAISE EXCEPTION 'a depreciation row is posted, or dropped, never rewritten'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'finance_depreciation_rewritten';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "finance_depreciation_schedule_kept"
  BEFORE UPDATE OR DELETE ON "finance_depreciation_schedule"
  FOR EACH ROW EXECUTE FUNCTION finance_depreciation_row_kept();--> statement-breakpoint

-- An asset's history is kept -------------------------------------------------------------
CREATE TRIGGER "finance_asset_events_kept"
  BEFORE UPDATE OR DELETE ON "finance_asset_events"
  FOR EACH ROW EXECUTE FUNCTION finance_kept();--> statement-breakpoint

-- An asset is disposed of once, and nothing happens to it afterwards -----------------------
CREATE OR REPLACE FUNCTION finance_asset_event_fits() RETURNS trigger AS $$
DECLARE
  state text;
BEGIN
  SELECT a.docstatus INTO state FROM finance_assets a WHERE a.id = NEW.asset_id;
  IF state IS DISTINCT FROM 'submitted' THEN
    RAISE EXCEPTION 'only an asset in the books has a history'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'finance_asset_event_not_capitalised';
  END IF;
  IF EXISTS (
    SELECT 1 FROM finance_asset_events e
     WHERE e.asset_id = NEW.asset_id AND e.kind IN ('sold', 'scrapped')
  ) THEN
    RAISE EXCEPTION 'that asset has been disposed of'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'finance_asset_disposed';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "finance_asset_events_fit"
  BEFORE INSERT ON "finance_asset_events"
  FOR EACH ROW EXECUTE FUNCTION finance_asset_event_fits();--> statement-breakpoint

-- An asset is not cancelled once it has depreciated or moved -------------------------------
CREATE OR REPLACE FUNCTION finance_asset_cancel_clean() RETURNS trigger AS $$
BEGIN
  IF NEW.docstatus = 'cancelled' AND OLD.docstatus = 'submitted' AND (
       EXISTS (SELECT 1 FROM finance_depreciation_schedule d WHERE d.asset_id = NEW.id AND d.entry_id IS NOT NULL)
    OR EXISTS (SELECT 1 FROM finance_asset_events e WHERE e.asset_id = NEW.id)) THEN
    RAISE EXCEPTION 'an asset that has depreciated or has a history is disposed of, not cancelled'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'finance_asset_cancel_used';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "finance_assets_cancel_clean"
  BEFORE UPDATE ON "finance_assets"
  FOR EACH ROW EXECUTE FUNCTION finance_asset_cancel_clean();
