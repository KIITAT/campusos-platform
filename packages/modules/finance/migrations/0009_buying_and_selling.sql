-- Buying and selling: material requests, requests for quotation, supplier
-- quotations, orders, goods receipts and delivery notes, and recurring invoices.
-- What has been received or billed against an order is a sum over the
-- documents, and the database refuses more than was ordered (decision 152).

CREATE TABLE "finance_material_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"number" text,
	"purpose" text DEFAULT 'purchase' NOT NULL,
	"requested_by" text,
	"cost_center" text,
	"warehouse_id" uuid,
	"required_by" date,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"docstatus" text DEFAULT 'draft' NOT NULL,
	"submitted_at" timestamp with time zone,
	"submitted_by" text,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" text,
	"cancel_reason" text,
	"amended_from" uuid,
	CONSTRAINT "finance_material_requests_purpose" CHECK (purpose in ('purchase', 'issue')),
	CONSTRAINT "finance_material_requests_numbered" CHECK (docstatus = 'draft' or number is not null)
);
--> statement-breakpoint
ALTER TABLE "finance_material_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finance_material_request_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"item_id" uuid NOT NULL,
	"qty_milli" bigint NOT NULL,
	"note" text,
	CONSTRAINT "finance_material_request_lines_qty" CHECK (qty_milli > 0)
);
--> statement-breakpoint
ALTER TABLE "finance_material_request_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finance_rfqs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"number" text,
	"posting_date" date NOT NULL,
	"respond_by" date,
	"terms" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"docstatus" text DEFAULT 'draft' NOT NULL,
	"submitted_at" timestamp with time zone,
	"submitted_by" text,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" text,
	"cancel_reason" text,
	"amended_from" uuid,
	CONSTRAINT "finance_rfqs_numbered" CHECK (docstatus = 'draft' or number is not null)
);
--> statement-breakpoint
ALTER TABLE "finance_rfqs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finance_rfq_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"rfq_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"item_id" uuid NOT NULL,
	"qty_milli" bigint NOT NULL,
	"request_line_id" uuid,
	CONSTRAINT "finance_rfq_lines_qty" CHECK (qty_milli > 0)
);
--> statement-breakpoint
ALTER TABLE "finance_rfq_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finance_rfq_suppliers" (
	"institution_id" uuid NOT NULL,
	"rfq_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	CONSTRAINT "finance_rfq_suppliers_rfq_id_party_id_pk" PRIMARY KEY("rfq_id","party_id")
);
--> statement-breakpoint
ALTER TABLE "finance_rfq_suppliers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finance_supplier_quotations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"number" text,
	"rfq_id" uuid,
	"party_id" uuid NOT NULL,
	"quoted_on" date NOT NULL,
	"valid_till" date,
	"currency" text NOT NULL,
	"terms" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"docstatus" text DEFAULT 'draft' NOT NULL,
	"submitted_at" timestamp with time zone,
	"submitted_by" text,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" text,
	"cancel_reason" text,
	"amended_from" uuid,
	CONSTRAINT "finance_supplier_quotations_numbered" CHECK (docstatus = 'draft' or number is not null)
);
--> statement-breakpoint
ALTER TABLE "finance_supplier_quotations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finance_supplier_quotation_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"quotation_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"item_id" uuid NOT NULL,
	"qty_milli" bigint NOT NULL,
	"rate_fc" bigint NOT NULL,
	"tax_template_id" uuid,
	"lead_days" integer,
	"rfq_line_id" uuid,
	CONSTRAINT "finance_supplier_quotation_lines_qty" CHECK (qty_milli > 0 and rate_fc >= 0)
);
--> statement-breakpoint
ALTER TABLE "finance_supplier_quotation_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finance_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"number" text,
	"party_id" uuid NOT NULL,
	"posting_date" date NOT NULL,
	"deliver_by" date,
	"valid_till" date,
	"currency" text NOT NULL,
	"exchange_rate" numeric(20, 10) DEFAULT '1' NOT NULL,
	"place_of_supply" text,
	"warehouse_id" uuid,
	"net_fc" bigint DEFAULT 0 NOT NULL,
	"tax_fc" bigint DEFAULT 0 NOT NULL,
	"total_fc" bigint DEFAULT 0 NOT NULL,
	"total_paise" bigint DEFAULT 0 NOT NULL,
	"cost_center" text,
	"fund_id" uuid,
	"from_quotation_id" uuid,
	"supplier_quotation_id" uuid,
	"terms" text,
	"memo" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"docstatus" text DEFAULT 'draft' NOT NULL,
	"submitted_at" timestamp with time zone,
	"submitted_by" text,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" text,
	"cancel_reason" text,
	"amended_from" uuid,
	CONSTRAINT "finance_orders_kind" CHECK (kind in ('purchase_order', 'sales_order', 'quotation')),
	CONSTRAINT "finance_orders_numbered" CHECK (docstatus = 'draft' or number is not null),
	CONSTRAINT "finance_orders_rate" CHECK (exchange_rate > 0)
);
--> statement-breakpoint
ALTER TABLE "finance_orders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finance_order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"item_id" uuid NOT NULL,
	"description" text NOT NULL,
	"qty_milli" bigint NOT NULL,
	"rate_fc" bigint NOT NULL,
	"discount_bp" integer DEFAULT 0 NOT NULL,
	"amount_fc" bigint NOT NULL,
	"tax_template_id" uuid,
	"warehouse_id" uuid,
	"cost_center" text,
	"request_line_id" uuid,
	"quotation_line_id" uuid,
	"deliver_by" date,
	CONSTRAINT "finance_order_lines_qty" CHECK (qty_milli > 0 and rate_fc >= 0),
	CONSTRAINT "finance_order_lines_discount" CHECK (discount_bp between 0 and 10000)
);
--> statement-breakpoint
ALTER TABLE "finance_order_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finance_order_closures" (
	"order_id" uuid PRIMARY KEY NOT NULL,
	"institution_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"closed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_order_closures_reason" CHECK (length(trim(reason)) >= 5)
);
--> statement-breakpoint
ALTER TABLE "finance_order_closures" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finance_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"is_return" boolean DEFAULT false NOT NULL,
	"return_against" uuid,
	"number" text,
	"party_id" uuid NOT NULL,
	"posting_date" date NOT NULL,
	"order_id" uuid,
	"challan_no" text,
	"transporter" text,
	"currency" text NOT NULL,
	"exchange_rate" numeric(20, 10) DEFAULT '1' NOT NULL,
	"total_paise" bigint DEFAULT 0 NOT NULL,
	"cost_center" text,
	"memo" text,
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
	CONSTRAINT "finance_receipts_kind" CHECK (kind in ('purchase_receipt', 'delivery_note')),
	CONSTRAINT "finance_receipts_return" CHECK (is_return = (return_against is not null)),
	CONSTRAINT "finance_receipts_numbered" CHECK (docstatus = 'draft' or number is not null)
);
--> statement-breakpoint
ALTER TABLE "finance_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finance_receipt_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"item_id" uuid NOT NULL,
	"order_line_id" uuid,
	"return_of_line_id" uuid,
	"warehouse_id" uuid NOT NULL,
	"qty_milli" bigint NOT NULL,
	"rejected_milli" bigint DEFAULT 0 NOT NULL,
	"rate_fc" bigint NOT NULL,
	"amount_paise" bigint DEFAULT 0 NOT NULL,
	"batch_id" uuid,
	"serials" text[],
	CONSTRAINT "finance_receipt_lines_qty" CHECK (qty_milli >= 0 and rejected_milli >= 0 and qty_milli + rejected_milli > 0),
	CONSTRAINT "finance_receipt_lines_rate" CHECK (rate_fc >= 0)
);
--> statement-breakpoint
ALTER TABLE "finance_receipt_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finance_recurring" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"template_invoice_id" uuid NOT NULL,
	"every" text NOT NULL,
	"next_on" date NOT NULL,
	"ends_on" date,
	"auto_submit" boolean DEFAULT false NOT NULL,
	"stopped_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_recurring_every" CHECK (every in ('month', 'quarter', 'year')),
	CONSTRAINT "finance_recurring_ends" CHECK (ends_on is null or ends_on >= next_on)
);
--> statement-breakpoint
ALTER TABLE "finance_recurring" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "finance_material_requests" ADD CONSTRAINT "finance_material_requests_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_material_requests" ADD CONSTRAINT "finance_material_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_material_requests" ADD CONSTRAINT "finance_material_requests_warehouse_id_finance_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."finance_warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_material_request_lines" ADD CONSTRAINT "finance_material_request_lines_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_material_request_lines" ADD CONSTRAINT "finance_material_request_lines_request_id_finance_material_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."finance_material_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_material_request_lines" ADD CONSTRAINT "finance_material_request_lines_item_id_finance_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."finance_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_rfqs" ADD CONSTRAINT "finance_rfqs_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_rfq_lines" ADD CONSTRAINT "finance_rfq_lines_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_rfq_lines" ADD CONSTRAINT "finance_rfq_lines_rfq_id_finance_rfqs_id_fk" FOREIGN KEY ("rfq_id") REFERENCES "public"."finance_rfqs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_rfq_lines" ADD CONSTRAINT "finance_rfq_lines_item_id_finance_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."finance_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_rfq_lines" ADD CONSTRAINT "finance_rfq_lines_request_line_id_finance_material_request_lines_id_fk" FOREIGN KEY ("request_line_id") REFERENCES "public"."finance_material_request_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_rfq_suppliers" ADD CONSTRAINT "finance_rfq_suppliers_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_rfq_suppliers" ADD CONSTRAINT "finance_rfq_suppliers_rfq_id_finance_rfqs_id_fk" FOREIGN KEY ("rfq_id") REFERENCES "public"."finance_rfqs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_rfq_suppliers" ADD CONSTRAINT "finance_rfq_suppliers_party_id_finance_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."finance_parties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_supplier_quotations" ADD CONSTRAINT "finance_supplier_quotations_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_supplier_quotations" ADD CONSTRAINT "finance_supplier_quotations_rfq_id_finance_rfqs_id_fk" FOREIGN KEY ("rfq_id") REFERENCES "public"."finance_rfqs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_supplier_quotations" ADD CONSTRAINT "finance_supplier_quotations_party_id_finance_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."finance_parties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_supplier_quotation_lines" ADD CONSTRAINT "finance_supplier_quotation_lines_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_supplier_quotation_lines" ADD CONSTRAINT "finance_supplier_quotation_lines_quotation_id_finance_supplier_quotations_id_fk" FOREIGN KEY ("quotation_id") REFERENCES "public"."finance_supplier_quotations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_supplier_quotation_lines" ADD CONSTRAINT "finance_supplier_quotation_lines_item_id_finance_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."finance_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_supplier_quotation_lines" ADD CONSTRAINT "finance_supplier_quotation_lines_tax_template_id_finance_tax_templates_id_fk" FOREIGN KEY ("tax_template_id") REFERENCES "public"."finance_tax_templates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_supplier_quotation_lines" ADD CONSTRAINT "finance_supplier_quotation_lines_rfq_line_id_finance_rfq_lines_id_fk" FOREIGN KEY ("rfq_line_id") REFERENCES "public"."finance_rfq_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_orders" ADD CONSTRAINT "finance_orders_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_orders" ADD CONSTRAINT "finance_orders_party_id_finance_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."finance_parties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_orders" ADD CONSTRAINT "finance_orders_warehouse_id_finance_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."finance_warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_orders" ADD CONSTRAINT "finance_orders_fund_id_finance_funds_id_fk" FOREIGN KEY ("fund_id") REFERENCES "public"."finance_funds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_orders" ADD CONSTRAINT "finance_orders_from_quotation_id_finance_orders_id_fk" FOREIGN KEY ("from_quotation_id") REFERENCES "public"."finance_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_orders" ADD CONSTRAINT "finance_orders_supplier_quotation_id_finance_supplier_quotations_id_fk" FOREIGN KEY ("supplier_quotation_id") REFERENCES "public"."finance_supplier_quotations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_orders" ADD CONSTRAINT "finance_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_order_lines" ADD CONSTRAINT "finance_order_lines_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_order_lines" ADD CONSTRAINT "finance_order_lines_order_id_finance_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."finance_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_order_lines" ADD CONSTRAINT "finance_order_lines_item_id_finance_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."finance_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_order_lines" ADD CONSTRAINT "finance_order_lines_tax_template_id_finance_tax_templates_id_fk" FOREIGN KEY ("tax_template_id") REFERENCES "public"."finance_tax_templates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_order_lines" ADD CONSTRAINT "finance_order_lines_warehouse_id_finance_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."finance_warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_order_lines" ADD CONSTRAINT "finance_order_lines_request_line_id_finance_material_request_lines_id_fk" FOREIGN KEY ("request_line_id") REFERENCES "public"."finance_material_request_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_order_closures" ADD CONSTRAINT "finance_order_closures_order_id_finance_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."finance_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_order_closures" ADD CONSTRAINT "finance_order_closures_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_order_closures" ADD CONSTRAINT "finance_order_closures_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_receipts" ADD CONSTRAINT "finance_receipts_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_receipts" ADD CONSTRAINT "finance_receipts_return_against_finance_receipts_id_fk" FOREIGN KEY ("return_against") REFERENCES "public"."finance_receipts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_receipts" ADD CONSTRAINT "finance_receipts_party_id_finance_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."finance_parties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_receipts" ADD CONSTRAINT "finance_receipts_order_id_finance_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."finance_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_receipts" ADD CONSTRAINT "finance_receipts_entry_id_finance_journal_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."finance_journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_receipts" ADD CONSTRAINT "finance_receipts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_receipt_lines" ADD CONSTRAINT "finance_receipt_lines_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_receipt_lines" ADD CONSTRAINT "finance_receipt_lines_receipt_id_finance_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."finance_receipts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_receipt_lines" ADD CONSTRAINT "finance_receipt_lines_item_id_finance_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."finance_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_receipt_lines" ADD CONSTRAINT "finance_receipt_lines_order_line_id_finance_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."finance_order_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_receipt_lines" ADD CONSTRAINT "finance_receipt_lines_return_of_line_id_finance_receipt_lines_id_fk" FOREIGN KEY ("return_of_line_id") REFERENCES "public"."finance_receipt_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_receipt_lines" ADD CONSTRAINT "finance_receipt_lines_warehouse_id_finance_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."finance_warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_receipt_lines" ADD CONSTRAINT "finance_receipt_lines_batch_id_finance_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."finance_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_recurring" ADD CONSTRAINT "finance_recurring_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_recurring" ADD CONSTRAINT "finance_recurring_template_invoice_id_finance_invoices_id_fk" FOREIGN KEY ("template_invoice_id") REFERENCES "public"."finance_invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "finance_material_requests_number" ON "finance_material_requests" USING btree ("institution_id","number");--> statement-breakpoint
CREATE INDEX "finance_material_request_lines_request" ON "finance_material_request_lines" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_rfqs_number" ON "finance_rfqs" USING btree ("institution_id","number");--> statement-breakpoint
CREATE INDEX "finance_rfq_lines_rfq" ON "finance_rfq_lines" USING btree ("rfq_id");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_supplier_quotations_number" ON "finance_supplier_quotations" USING btree ("institution_id","number");--> statement-breakpoint
CREATE INDEX "finance_supplier_quotation_lines_quotation" ON "finance_supplier_quotation_lines" USING btree ("quotation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_orders_number" ON "finance_orders" USING btree ("institution_id","kind","number");--> statement-breakpoint
CREATE INDEX "finance_orders_party" ON "finance_orders" USING btree ("institution_id","party_id");--> statement-breakpoint
CREATE INDEX "finance_order_lines_order" ON "finance_order_lines" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "finance_order_lines_request" ON "finance_order_lines" USING btree ("request_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_receipts_number" ON "finance_receipts" USING btree ("institution_id","kind","number");--> statement-breakpoint
CREATE INDEX "finance_receipt_lines_receipt" ON "finance_receipt_lines" USING btree ("receipt_id");--> statement-breakpoint
CREATE INDEX "finance_receipt_lines_order" ON "finance_receipt_lines" USING btree ("order_line_id");--> statement-breakpoint
CREATE POLICY "finance_material_requests_tenant_isolation" ON "finance_material_requests" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_material_request_lines_tenant_isolation" ON "finance_material_request_lines" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_rfqs_tenant_isolation" ON "finance_rfqs" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_rfq_lines_tenant_isolation" ON "finance_rfq_lines" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_rfq_suppliers_tenant_isolation" ON "finance_rfq_suppliers" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_supplier_quotations_tenant_isolation" ON "finance_supplier_quotations" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_supplier_quotation_lines_tenant_isolation" ON "finance_supplier_quotation_lines" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_orders_tenant_isolation" ON "finance_orders" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_order_lines_tenant_isolation" ON "finance_order_lines" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_order_closures_tenant_isolation" ON "finance_order_closures" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_receipts_tenant_isolation" ON "finance_receipts" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_receipt_lines_tenant_isolation" ON "finance_receipt_lines" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_recurring_tenant_isolation" ON "finance_recurring" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint

-- Every step of buying and selling is a document -------------------------------------
ALTER TABLE "finance_material_requests" ADD CONSTRAINT "finance_material_requests_docstatus" CHECK (docstatus in ('draft', 'submitted', 'cancelled'));--> statement-breakpoint
ALTER TABLE "finance_material_requests" ADD CONSTRAINT "finance_material_requests_amended_from_fk" FOREIGN KEY ("amended_from") REFERENCES "finance_material_requests"("id") ON DELETE restrict;--> statement-breakpoint
CREATE TRIGGER "finance_material_requests_docstatus" BEFORE INSERT OR UPDATE OR DELETE ON "finance_material_requests" FOR EACH ROW EXECUTE FUNCTION campusos_docstatus_guard();--> statement-breakpoint
CREATE TRIGGER "finance_material_request_lines_draft" BEFORE INSERT OR UPDATE OR DELETE ON "finance_material_request_lines" FOR EACH ROW EXECUTE FUNCTION finance_child_of_draft('finance_material_requests', 'request_id');--> statement-breakpoint

ALTER TABLE "finance_rfqs" ADD CONSTRAINT "finance_rfqs_docstatus" CHECK (docstatus in ('draft', 'submitted', 'cancelled'));--> statement-breakpoint
ALTER TABLE "finance_rfqs" ADD CONSTRAINT "finance_rfqs_amended_from_fk" FOREIGN KEY ("amended_from") REFERENCES "finance_rfqs"("id") ON DELETE restrict;--> statement-breakpoint
CREATE TRIGGER "finance_rfqs_docstatus" BEFORE INSERT OR UPDATE OR DELETE ON "finance_rfqs" FOR EACH ROW EXECUTE FUNCTION campusos_docstatus_guard();--> statement-breakpoint
CREATE TRIGGER "finance_rfq_lines_draft" BEFORE INSERT OR UPDATE OR DELETE ON "finance_rfq_lines" FOR EACH ROW EXECUTE FUNCTION finance_child_of_draft('finance_rfqs', 'rfq_id');--> statement-breakpoint
CREATE TRIGGER "finance_rfq_suppliers_draft" BEFORE INSERT OR UPDATE OR DELETE ON "finance_rfq_suppliers" FOR EACH ROW EXECUTE FUNCTION finance_child_of_draft('finance_rfqs', 'rfq_id');--> statement-breakpoint

ALTER TABLE "finance_supplier_quotations" ADD CONSTRAINT "finance_supplier_quotations_docstatus" CHECK (docstatus in ('draft', 'submitted', 'cancelled'));--> statement-breakpoint
ALTER TABLE "finance_supplier_quotations" ADD CONSTRAINT "finance_supplier_quotations_amended_from_fk" FOREIGN KEY ("amended_from") REFERENCES "finance_supplier_quotations"("id") ON DELETE restrict;--> statement-breakpoint
CREATE TRIGGER "finance_supplier_quotations_docstatus" BEFORE INSERT OR UPDATE OR DELETE ON "finance_supplier_quotations" FOR EACH ROW EXECUTE FUNCTION campusos_docstatus_guard();--> statement-breakpoint
CREATE TRIGGER "finance_supplier_quotation_lines_draft" BEFORE INSERT OR UPDATE OR DELETE ON "finance_supplier_quotation_lines" FOR EACH ROW EXECUTE FUNCTION finance_child_of_draft('finance_supplier_quotations', 'quotation_id');--> statement-breakpoint

ALTER TABLE "finance_orders" ADD CONSTRAINT "finance_orders_docstatus" CHECK (docstatus in ('draft', 'submitted', 'cancelled'));--> statement-breakpoint
ALTER TABLE "finance_orders" ADD CONSTRAINT "finance_orders_amended_from_fk" FOREIGN KEY ("amended_from") REFERENCES "finance_orders"("id") ON DELETE restrict;--> statement-breakpoint
CREATE TRIGGER "finance_orders_docstatus" BEFORE INSERT OR UPDATE OR DELETE ON "finance_orders" FOR EACH ROW EXECUTE FUNCTION campusos_docstatus_guard();--> statement-breakpoint
CREATE TRIGGER "finance_order_lines_draft" BEFORE INSERT OR UPDATE OR DELETE ON "finance_order_lines" FOR EACH ROW EXECUTE FUNCTION finance_child_of_draft('finance_orders', 'order_id');--> statement-breakpoint

ALTER TABLE "finance_receipts" ADD CONSTRAINT "finance_receipts_docstatus" CHECK (docstatus in ('draft', 'submitted', 'cancelled'));--> statement-breakpoint
ALTER TABLE "finance_receipts" ADD CONSTRAINT "finance_receipts_amended_from_fk" FOREIGN KEY ("amended_from") REFERENCES "finance_receipts"("id") ON DELETE restrict;--> statement-breakpoint
CREATE TRIGGER "finance_receipts_docstatus" BEFORE INSERT OR UPDATE OR DELETE ON "finance_receipts" FOR EACH ROW EXECUTE FUNCTION campusos_docstatus_guard();--> statement-breakpoint
CREATE TRIGGER "finance_receipt_lines_draft" BEFORE INSERT OR UPDATE OR DELETE ON "finance_receipt_lines" FOR EACH ROW EXECUTE FUNCTION finance_child_of_draft('finance_receipts', 'receipt_id');--> statement-breakpoint

CREATE TRIGGER "finance_order_closures_kept" BEFORE UPDATE OR DELETE ON "finance_order_closures" FOR EACH ROW EXECUTE FUNCTION finance_kept();--> statement-breakpoint

ALTER TABLE "finance_invoices" ADD CONSTRAINT "finance_invoices_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."finance_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_invoice_lines" ADD CONSTRAINT "finance_invoice_lines_order_line_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."finance_order_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_invoice_lines" ADD CONSTRAINT "finance_invoice_lines_receipt_line_fk" FOREIGN KEY ("receipt_line_id") REFERENCES "public"."finance_receipt_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_stock_entries" ADD CONSTRAINT "finance_stock_entries_request_fk" FOREIGN KEY ("material_request_id") REFERENCES "public"."finance_material_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- Nobody receives more than was ordered -------------------------------------------------
--
-- What has arrived against an order line, net of what went back, stays within
-- what was ordered plus the tolerance the institution allows. Checked when a
-- receipt is submitted, counting every submitted receipt for the same lines.
CREATE OR REPLACE FUNCTION finance_receipt_within_order() RETURNS trigger AS $$
DECLARE
  tolerance int;
  over record;
BEGIN
  IF NOT (NEW.docstatus = 'submitted' AND OLD.docstatus = 'draft') THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM finance_receipt_lines l WHERE l.receipt_id = NEW.id) THEN
    RAISE EXCEPTION 'a receipt needs at least one line'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'finance_receipt_empty';
  END IF;
  SELECT coalesce(s.over_receipt_bp, 0) INTO tolerance FROM finance_settings s WHERE s.institution_id = NEW.institution_id;
  tolerance := coalesce(tolerance, 0);
  SELECT ol.id, ol.qty_milli AS ordered,
         sum(CASE WHEN r.is_return THEN -rl.qty_milli ELSE rl.qty_milli END) AS moved
    INTO over
    FROM finance_receipt_lines rl
    JOIN finance_receipts r ON r.id = rl.receipt_id
    JOIN finance_order_lines ol ON ol.id = rl.order_line_id
   WHERE rl.order_line_id IN (SELECT x.order_line_id FROM finance_receipt_lines x WHERE x.receipt_id = NEW.id)
     AND (r.docstatus = 'submitted' OR r.id = NEW.id)
   GROUP BY ol.id, ol.qty_milli
  HAVING sum(CASE WHEN r.is_return THEN -rl.qty_milli ELSE rl.qty_milli END) > ol.qty_milli + (ol.qty_milli * tolerance) / 10000
   LIMIT 1;
  IF over.id IS NOT NULL THEN
    RAISE EXCEPTION 'that is more than was ordered'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'finance_receipt_over_order';
  END IF;
  IF NEW.number IS NULL THEN
    RAISE EXCEPTION 'a receipt is numbered as it is submitted'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'finance_receipt_unnumbered';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "finance_receipts_within_order"
  BEFORE UPDATE ON "finance_receipts"
  FOR EACH ROW EXECUTE FUNCTION finance_receipt_within_order();--> statement-breakpoint

-- Nobody is billed for more than arrived ------------------------------------------------
--
-- An invoice line that names a receipt line bills at most what that line
-- accepted; one that names an order line and no receipt bills at most what was
-- ordered. Credit and debit notes count against.
CREATE OR REPLACE FUNCTION finance_invoice_within_supply() RETURNS trigger AS $$
DECLARE
  over_receipt uuid;
  over_order uuid;
BEGIN
  IF NOT (NEW.docstatus = 'submitted' AND OLD.docstatus = 'draft') THEN
    RETURN NEW;
  END IF;

  SELECT rl.id INTO over_receipt
    FROM finance_invoice_lines il
    JOIN finance_invoices i ON i.id = il.invoice_id
    JOIN finance_receipt_lines rl ON rl.id = il.receipt_line_id
   WHERE il.receipt_line_id IN (SELECT x.receipt_line_id FROM finance_invoice_lines x WHERE x.invoice_id = NEW.id)
     AND (i.docstatus = 'submitted' OR i.id = NEW.id)
   GROUP BY rl.id, rl.qty_milli
  HAVING sum(CASE WHEN i.is_return THEN -il.qty_milli ELSE il.qty_milli END) > rl.qty_milli
   LIMIT 1;
  IF over_receipt IS NOT NULL THEN
    RAISE EXCEPTION 'that bills more than was received'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'finance_invoice_over_receipt';
  END IF;

  SELECT ol.id INTO over_order
    FROM finance_invoice_lines il
    JOIN finance_invoices i ON i.id = il.invoice_id
    JOIN finance_order_lines ol ON ol.id = il.order_line_id
   WHERE il.order_line_id IN (SELECT x.order_line_id FROM finance_invoice_lines x WHERE x.invoice_id = NEW.id AND x.receipt_line_id IS NULL)
     AND il.receipt_line_id IS NULL
     AND (i.docstatus = 'submitted' OR i.id = NEW.id)
   GROUP BY ol.id, ol.qty_milli
  HAVING sum(CASE WHEN i.is_return THEN -il.qty_milli ELSE il.qty_milli END) > ol.qty_milli
   LIMIT 1;
  IF over_order IS NOT NULL THEN
    RAISE EXCEPTION 'that bills more than was ordered'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'finance_invoice_over_order';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "finance_invoices_within_supply"
  BEFORE UPDATE ON "finance_invoices"
  FOR EACH ROW EXECUTE FUNCTION finance_invoice_within_supply();
