-- Who the institution trades with, the taxes on it, and the documents that move
-- money: journal vouchers, invoices, payments, and the party ledger that says
-- what each party owes, invoice by invoice.
--
-- Rules the database keeps (decision 150): a document's lines change only
-- while it is a draft; an invoice is submitted only as its lines add up; a
-- payment settles no more than it brought; and nothing is settled against an
-- invoice beyond what it was for -- which is also what refuses cancelling an
-- invoice that payments still stand against.

CREATE TABLE "finance_parties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"is_customer" boolean DEFAULT false NOT NULL,
	"is_supplier" boolean DEFAULT false NOT NULL,
	"gstin" text,
	"pan" text,
	"state_code" text,
	"gst_category" text DEFAULT 'unregistered' NOT NULL,
	"address" text,
	"email" text,
	"phone" text,
	"currency" text,
	"payment_terms_days" integer DEFAULT 0 NOT NULL,
	"credit_limit_paise" bigint,
	"receivable_account_id" uuid,
	"payable_account_id" uuid,
	"tds_section_id" uuid,
	"msme" boolean DEFAULT false NOT NULL,
	"msme_number" text,
	"bank_name" text,
	"bank_account" text,
	"ifsc" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_parties_role" CHECK (is_customer or is_supplier),
	CONSTRAINT "finance_parties_name_text" CHECK (length(trim(name)) > 0),
	CONSTRAINT "finance_parties_gstin" CHECK (gstin is null or gstin ~ '^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]Z[0-9A-Z]$'),
	CONSTRAINT "finance_parties_pan" CHECK (pan is null or pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
	CONSTRAINT "finance_parties_state" CHECK (state_code is null or state_code ~ '^[0-9]{2}$'),
	CONSTRAINT "finance_parties_gst_category" CHECK (gst_category in ('registered', 'unregistered', 'composition', 'sez', 'overseas')),
	CONSTRAINT "finance_parties_registered" CHECK (gst_category <> 'registered' or gstin is not null),
	CONSTRAINT "finance_parties_currency" CHECK (currency is null or currency ~ '^[A-Z]{3}$'),
	CONSTRAINT "finance_parties_terms" CHECK (payment_terms_days between 0 and 3650),
	CONSTRAINT "finance_parties_ifsc" CHECK (ifsc is null or ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$')
);
--> statement-breakpoint
ALTER TABLE "finance_parties" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finance_tax_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'gst' NOT NULL,
	"treatment" text DEFAULT 'taxable' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_tax_templates_kind" CHECK (kind in ('gst', 'other')),
	CONSTRAINT "finance_tax_templates_treatment" CHECK (treatment in ('taxable', 'exempt', 'nil_rated', 'non_gst'))
);
--> statement-breakpoint
ALTER TABLE "finance_tax_templates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finance_tax_components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"component" text NOT NULL,
	"applies" text DEFAULT 'always' NOT NULL,
	"rate_bp" integer NOT NULL,
	"output_account_id" uuid,
	"input_account_id" uuid,
	CONSTRAINT "finance_tax_components_component" CHECK (component in ('cgst', 'sgst', 'utgst', 'igst', 'cess', 'other')),
	CONSTRAINT "finance_tax_components_applies" CHECK (applies in ('intra', 'inter', 'always')),
	CONSTRAINT "finance_tax_components_rate" CHECK (rate_bp between 0 and 10000)
);
--> statement-breakpoint
ALTER TABLE "finance_tax_components" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finance_tds_sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"rate_bp" integer NOT NULL,
	"rate_no_pan_bp" integer NOT NULL,
	"threshold_single_paise" bigint DEFAULT 0 NOT NULL,
	"threshold_annual_paise" bigint DEFAULT 0 NOT NULL,
	"payable_account_id" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_tds_sections_rate" CHECK (rate_bp between 0 and 10000 and rate_no_pan_bp between 0 and 10000),
	CONSTRAINT "finance_tds_sections_thresholds" CHECK (threshold_single_paise >= 0 and threshold_annual_paise >= 0)
);
--> statement-breakpoint
ALTER TABLE "finance_tds_sections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finance_journals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"number" text,
	"kind" text DEFAULT 'journal' NOT NULL,
	"posting_date" date NOT NULL,
	"memo" text NOT NULL,
	"reference" text,
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
	CONSTRAINT "finance_journals_kind" CHECK (kind in ('journal', 'contra', 'opening', 'adjustment')),
	CONSTRAINT "finance_journals_memo" CHECK (length(trim(memo)) > 0),
	CONSTRAINT "finance_journals_numbered" CHECK (docstatus = 'draft' or number is not null)
);
--> statement-breakpoint
ALTER TABLE "finance_journals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finance_journal_voucher_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"journal_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"account_id" uuid NOT NULL,
	"party_id" uuid,
	"debit_paise" bigint DEFAULT 0 NOT NULL,
	"credit_paise" bigint DEFAULT 0 NOT NULL,
	"cost_center" text,
	"fund_id" uuid,
	"currency" text,
	"amount_fc" bigint,
	"exchange_rate" numeric(20, 10),
	"memo" text,
	CONSTRAINT "finance_journal_voucher_lines_one_side" CHECK (debit_paise >= 0 and credit_paise >= 0 and (debit_paise = 0) <> (credit_paise = 0))
);
--> statement-breakpoint
ALTER TABLE "finance_journal_voucher_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finance_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"is_return" boolean DEFAULT false NOT NULL,
	"return_against" uuid,
	"number" text,
	"party_id" uuid NOT NULL,
	"posting_date" date NOT NULL,
	"due_date" date,
	"bill_no" text,
	"bill_date" date,
	"currency" text NOT NULL,
	"exchange_rate" numeric(20, 10) DEFAULT '1' NOT NULL,
	"place_of_supply" text,
	"reverse_charge" boolean DEFAULT false NOT NULL,
	"update_stock" boolean DEFAULT false NOT NULL,
	"warehouse_id" uuid,
	"order_id" uuid,
	"net_fc" bigint DEFAULT 0 NOT NULL,
	"tax_fc" bigint DEFAULT 0 NOT NULL,
	"rounding_fc" bigint DEFAULT 0 NOT NULL,
	"total_fc" bigint DEFAULT 0 NOT NULL,
	"total_paise" bigint DEFAULT 0 NOT NULL,
	"tds_section_id" uuid,
	"tds_paise" bigint DEFAULT 0 NOT NULL,
	"cost_center" text,
	"fund_id" uuid,
	"memo" text,
	"terms" text,
	"source_module" text,
	"source_ref" text,
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
	CONSTRAINT "finance_invoices_kind" CHECK (kind in ('sales', 'purchase')),
	CONSTRAINT "finance_invoices_return" CHECK (is_return = (return_against is not null)),
	CONSTRAINT "finance_invoices_numbered" CHECK (docstatus = 'draft' or number is not null),
	CONSTRAINT "finance_invoices_due" CHECK (due_date is null or due_date >= posting_date),
	CONSTRAINT "finance_invoices_rate" CHECK (exchange_rate > 0),
	CONSTRAINT "finance_invoices_pos" CHECK (place_of_supply is null or place_of_supply ~ '^[0-9]{2}$'),
	CONSTRAINT "finance_invoices_tds" CHECK (tds_paise >= 0)
);
--> statement-breakpoint
ALTER TABLE "finance_invoices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finance_invoice_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"item_id" uuid,
	"description" text NOT NULL,
	"hsn_sac" text,
	"qty_milli" bigint NOT NULL,
	"uom" text,
	"rate_fc" bigint NOT NULL,
	"discount_bp" integer DEFAULT 0 NOT NULL,
	"amount_fc" bigint NOT NULL,
	"amount_paise" bigint NOT NULL,
	"tax_template_id" uuid,
	"account_id" uuid,
	"cost_center" text,
	"fund_id" uuid,
	"warehouse_id" uuid,
	"batch_id" uuid,
	"serials" text[],
	"order_line_id" uuid,
	"receipt_line_id" uuid,
	"itc_eligible" boolean DEFAULT true NOT NULL,
	"asset_id" uuid,
	CONSTRAINT "finance_invoice_lines_qty" CHECK (qty_milli > 0),
	CONSTRAINT "finance_invoice_lines_rate" CHECK (rate_fc >= 0),
	CONSTRAINT "finance_invoice_lines_discount" CHECK (discount_bp between 0 and 10000),
	CONSTRAINT "finance_invoice_lines_description" CHECK (length(trim(description)) > 0)
);
--> statement-breakpoint
ALTER TABLE "finance_invoice_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finance_invoice_taxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"template_id" uuid,
	"component" text NOT NULL,
	"rate_bp" integer NOT NULL,
	"account_id" uuid,
	"taxable_fc" bigint NOT NULL,
	"tax_fc" bigint NOT NULL,
	"tax_paise" bigint NOT NULL,
	"ineligible_paise" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "finance_invoice_taxes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finance_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"number" text,
	"party_id" uuid,
	"side" text,
	"posting_date" date NOT NULL,
	"account_id" uuid NOT NULL,
	"to_account_id" uuid,
	"currency" text NOT NULL,
	"exchange_rate" numeric(20, 10) DEFAULT '1' NOT NULL,
	"amount_fc" bigint NOT NULL,
	"amount_paise" bigint NOT NULL,
	"tds_paise" bigint DEFAULT 0 NOT NULL,
	"tds_section_id" uuid,
	"bank_charges_paise" bigint DEFAULT 0 NOT NULL,
	"mode" text DEFAULT 'neft' NOT NULL,
	"instrument_no" text,
	"instrument_date" date,
	"reference" text,
	"memo" text,
	"cost_center" text,
	"fund_id" uuid,
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
	CONSTRAINT "finance_payments_kind" CHECK (kind in ('receive', 'pay', 'transfer')),
	CONSTRAINT "finance_payments_party_kind" CHECK ((kind = 'transfer') = (party_id is null)),
	CONSTRAINT "finance_payments_side" CHECK ((side is null) = (party_id is null) and (side is null or side in ('receivable', 'payable'))),
	CONSTRAINT "finance_payments_transfer" CHECK ((kind = 'transfer') = (to_account_id is not null) and (to_account_id is null or to_account_id <> account_id)),
	CONSTRAINT "finance_payments_amount" CHECK (amount_fc > 0 and amount_paise > 0),
	CONSTRAINT "finance_payments_deductions" CHECK (tds_paise >= 0 and bank_charges_paise >= 0),
	CONSTRAINT "finance_payments_rate" CHECK (exchange_rate > 0),
	CONSTRAINT "finance_payments_mode" CHECK (mode in ('cash', 'cheque', 'dd', 'neft', 'rtgs', 'imps', 'upi', 'card', 'wire', 'other')),
	CONSTRAINT "finance_payments_numbered" CHECK (docstatus = 'draft' or number is not null)
);
--> statement-breakpoint
ALTER TABLE "finance_payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finance_payment_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"amount_fc" bigint NOT NULL,
	CONSTRAINT "finance_payment_allocations_amount" CHECK (amount_fc > 0)
);
--> statement-breakpoint
ALTER TABLE "finance_payment_allocations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "finance_party_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"side" text NOT NULL,
	"account_id" uuid NOT NULL,
	"voucher_type" text NOT NULL,
	"voucher_id" uuid NOT NULL,
	"against_id" uuid,
	"posting_date" date NOT NULL,
	"due_date" date,
	"currency" text NOT NULL,
	"amount_fc" bigint NOT NULL,
	"amount_paise" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_party_ledger_side" CHECK (side in ('receivable', 'payable'))
);
--> statement-breakpoint
ALTER TABLE "finance_party_ledger" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "finance_parties" ADD CONSTRAINT "finance_parties_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_parties" ADD CONSTRAINT "finance_parties_receivable_account_id_finance_accounts_id_fk" FOREIGN KEY ("receivable_account_id") REFERENCES "public"."finance_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_parties" ADD CONSTRAINT "finance_parties_payable_account_id_finance_accounts_id_fk" FOREIGN KEY ("payable_account_id") REFERENCES "public"."finance_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_tax_templates" ADD CONSTRAINT "finance_tax_templates_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_tax_components" ADD CONSTRAINT "finance_tax_components_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_tax_components" ADD CONSTRAINT "finance_tax_components_template_id_finance_tax_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."finance_tax_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_tax_components" ADD CONSTRAINT "finance_tax_components_output_account_id_finance_accounts_id_fk" FOREIGN KEY ("output_account_id") REFERENCES "public"."finance_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_tax_components" ADD CONSTRAINT "finance_tax_components_input_account_id_finance_accounts_id_fk" FOREIGN KEY ("input_account_id") REFERENCES "public"."finance_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_tds_sections" ADD CONSTRAINT "finance_tds_sections_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_tds_sections" ADD CONSTRAINT "finance_tds_sections_payable_account_id_finance_accounts_id_fk" FOREIGN KEY ("payable_account_id") REFERENCES "public"."finance_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_journals" ADD CONSTRAINT "finance_journals_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_journals" ADD CONSTRAINT "finance_journals_entry_id_finance_journal_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."finance_journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_journals" ADD CONSTRAINT "finance_journals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_journal_voucher_lines" ADD CONSTRAINT "finance_journal_voucher_lines_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_journal_voucher_lines" ADD CONSTRAINT "finance_journal_voucher_lines_journal_id_finance_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."finance_journals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_journal_voucher_lines" ADD CONSTRAINT "finance_journal_voucher_lines_account_id_finance_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."finance_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_journal_voucher_lines" ADD CONSTRAINT "finance_journal_voucher_lines_party_id_finance_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."finance_parties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_journal_voucher_lines" ADD CONSTRAINT "finance_journal_voucher_lines_fund_id_finance_funds_id_fk" FOREIGN KEY ("fund_id") REFERENCES "public"."finance_funds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_invoices" ADD CONSTRAINT "finance_invoices_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_invoices" ADD CONSTRAINT "finance_invoices_return_against_finance_invoices_id_fk" FOREIGN KEY ("return_against") REFERENCES "public"."finance_invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_invoices" ADD CONSTRAINT "finance_invoices_party_id_finance_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."finance_parties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_invoices" ADD CONSTRAINT "finance_invoices_tds_section_id_finance_tds_sections_id_fk" FOREIGN KEY ("tds_section_id") REFERENCES "public"."finance_tds_sections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_invoices" ADD CONSTRAINT "finance_invoices_fund_id_finance_funds_id_fk" FOREIGN KEY ("fund_id") REFERENCES "public"."finance_funds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_invoices" ADD CONSTRAINT "finance_invoices_entry_id_finance_journal_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."finance_journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_invoices" ADD CONSTRAINT "finance_invoices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_invoice_lines" ADD CONSTRAINT "finance_invoice_lines_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_invoice_lines" ADD CONSTRAINT "finance_invoice_lines_invoice_id_finance_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."finance_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_invoice_lines" ADD CONSTRAINT "finance_invoice_lines_tax_template_id_finance_tax_templates_id_fk" FOREIGN KEY ("tax_template_id") REFERENCES "public"."finance_tax_templates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_invoice_lines" ADD CONSTRAINT "finance_invoice_lines_account_id_finance_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."finance_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_invoice_lines" ADD CONSTRAINT "finance_invoice_lines_fund_id_finance_funds_id_fk" FOREIGN KEY ("fund_id") REFERENCES "public"."finance_funds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_invoice_taxes" ADD CONSTRAINT "finance_invoice_taxes_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_invoice_taxes" ADD CONSTRAINT "finance_invoice_taxes_invoice_id_finance_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."finance_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_invoice_taxes" ADD CONSTRAINT "finance_invoice_taxes_template_id_finance_tax_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."finance_tax_templates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_invoice_taxes" ADD CONSTRAINT "finance_invoice_taxes_account_id_finance_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."finance_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_payments" ADD CONSTRAINT "finance_payments_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_payments" ADD CONSTRAINT "finance_payments_party_id_finance_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."finance_parties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_payments" ADD CONSTRAINT "finance_payments_account_id_finance_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."finance_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_payments" ADD CONSTRAINT "finance_payments_to_account_id_finance_accounts_id_fk" FOREIGN KEY ("to_account_id") REFERENCES "public"."finance_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_payments" ADD CONSTRAINT "finance_payments_tds_section_id_finance_tds_sections_id_fk" FOREIGN KEY ("tds_section_id") REFERENCES "public"."finance_tds_sections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_payments" ADD CONSTRAINT "finance_payments_fund_id_finance_funds_id_fk" FOREIGN KEY ("fund_id") REFERENCES "public"."finance_funds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_payments" ADD CONSTRAINT "finance_payments_entry_id_finance_journal_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."finance_journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_payments" ADD CONSTRAINT "finance_payments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_payment_allocations" ADD CONSTRAINT "finance_payment_allocations_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_payment_allocations" ADD CONSTRAINT "finance_payment_allocations_payment_id_finance_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."finance_payments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_payment_allocations" ADD CONSTRAINT "finance_payment_allocations_invoice_id_finance_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."finance_invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_party_ledger" ADD CONSTRAINT "finance_party_ledger_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_party_ledger" ADD CONSTRAINT "finance_party_ledger_party_id_finance_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."finance_parties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_party_ledger" ADD CONSTRAINT "finance_party_ledger_account_id_finance_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."finance_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "finance_parties_code" ON "finance_parties" USING btree ("institution_id","code");--> statement-breakpoint
CREATE INDEX "finance_parties_name" ON "finance_parties" USING btree ("institution_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_tax_templates_name" ON "finance_tax_templates" USING btree ("institution_id","name");--> statement-breakpoint
CREATE INDEX "finance_tax_components_template" ON "finance_tax_components" USING btree ("template_id");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_tds_sections_code" ON "finance_tds_sections" USING btree ("institution_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_journals_number" ON "finance_journals" USING btree ("institution_id","number");--> statement-breakpoint
CREATE INDEX "finance_journals_date" ON "finance_journals" USING btree ("institution_id","posting_date");--> statement-breakpoint
CREATE INDEX "finance_journal_voucher_lines_journal" ON "finance_journal_voucher_lines" USING btree ("journal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_invoices_number" ON "finance_invoices" USING btree ("institution_id","kind","number");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_invoices_bill" ON "finance_invoices" USING btree ("institution_id","party_id","bill_no") WHERE kind = 'purchase' and bill_no is not null and docstatus <> 'cancelled' and not is_return;--> statement-breakpoint
CREATE UNIQUE INDEX "finance_invoices_source" ON "finance_invoices" USING btree ("institution_id","source_module","source_ref") WHERE source_ref is not null and docstatus <> 'cancelled';--> statement-breakpoint
CREATE INDEX "finance_invoices_party" ON "finance_invoices" USING btree ("institution_id","party_id");--> statement-breakpoint
CREATE INDEX "finance_invoices_date" ON "finance_invoices" USING btree ("institution_id","posting_date");--> statement-breakpoint
CREATE INDEX "finance_invoice_lines_invoice" ON "finance_invoice_lines" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "finance_invoice_lines_order" ON "finance_invoice_lines" USING btree ("order_line_id");--> statement-breakpoint
CREATE INDEX "finance_invoice_lines_receipt" ON "finance_invoice_lines" USING btree ("receipt_line_id");--> statement-breakpoint
CREATE INDEX "finance_invoice_taxes_invoice" ON "finance_invoice_taxes" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_payments_number" ON "finance_payments" USING btree ("institution_id","number");--> statement-breakpoint
CREATE INDEX "finance_payments_party" ON "finance_payments" USING btree ("institution_id","party_id");--> statement-breakpoint
CREATE INDEX "finance_payments_date" ON "finance_payments" USING btree ("institution_id","posting_date");--> statement-breakpoint
CREATE UNIQUE INDEX "finance_payment_allocations_once" ON "finance_payment_allocations" USING btree ("payment_id","invoice_id");--> statement-breakpoint
CREATE INDEX "finance_party_ledger_party" ON "finance_party_ledger" USING btree ("institution_id","party_id");--> statement-breakpoint
CREATE INDEX "finance_party_ledger_against" ON "finance_party_ledger" USING btree ("against_id");--> statement-breakpoint
CREATE INDEX "finance_party_ledger_voucher" ON "finance_party_ledger" USING btree ("voucher_type","voucher_id");--> statement-breakpoint
CREATE POLICY "finance_parties_tenant_isolation" ON "finance_parties" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_tax_templates_tenant_isolation" ON "finance_tax_templates" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_tax_components_tenant_isolation" ON "finance_tax_components" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_tds_sections_tenant_isolation" ON "finance_tds_sections" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_journals_tenant_isolation" ON "finance_journals" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_journal_voucher_lines_tenant_isolation" ON "finance_journal_voucher_lines" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_invoices_tenant_isolation" ON "finance_invoices" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_invoice_lines_tenant_isolation" ON "finance_invoice_lines" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_invoice_taxes_tenant_isolation" ON "finance_invoice_taxes" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_payments_tenant_isolation" ON "finance_payments" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_payment_allocations_tenant_isolation" ON "finance_payment_allocations" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "finance_party_ledger_tenant_isolation" ON "finance_party_ledger" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint

-- Lines of the journal name real parties and funds ---------------------------------
ALTER TABLE "finance_journal_lines" ADD CONSTRAINT "finance_journal_lines_party_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."finance_parties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_journal_lines" ADD CONSTRAINT "finance_journal_lines_fund_id_fk" FOREIGN KEY ("fund_id") REFERENCES "public"."finance_funds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_parties" ADD CONSTRAINT "finance_parties_tds_section_id_fk" FOREIGN KEY ("tds_section_id") REFERENCES "public"."finance_tds_sections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- Documents: draft, submitted, cancelled (decision 123) ------------------------------
ALTER TABLE "finance_journals" ADD CONSTRAINT "finance_journals_docstatus" CHECK (docstatus in ('draft', 'submitted', 'cancelled'));--> statement-breakpoint
ALTER TABLE "finance_journals" ADD CONSTRAINT "finance_journals_amended_from_fk" FOREIGN KEY ("amended_from") REFERENCES "finance_journals"("id") ON DELETE restrict;--> statement-breakpoint
CREATE TRIGGER "finance_journals_docstatus" BEFORE INSERT OR UPDATE OR DELETE ON "finance_journals" FOR EACH ROW EXECUTE FUNCTION campusos_docstatus_guard();--> statement-breakpoint
ALTER TABLE "finance_invoices" ADD CONSTRAINT "finance_invoices_docstatus" CHECK (docstatus in ('draft', 'submitted', 'cancelled'));--> statement-breakpoint
ALTER TABLE "finance_invoices" ADD CONSTRAINT "finance_invoices_amended_from_fk" FOREIGN KEY ("amended_from") REFERENCES "finance_invoices"("id") ON DELETE restrict;--> statement-breakpoint
CREATE TRIGGER "finance_invoices_docstatus" BEFORE INSERT OR UPDATE OR DELETE ON "finance_invoices" FOR EACH ROW EXECUTE FUNCTION campusos_docstatus_guard();--> statement-breakpoint
ALTER TABLE "finance_payments" ADD CONSTRAINT "finance_payments_docstatus" CHECK (docstatus in ('draft', 'submitted', 'cancelled'));--> statement-breakpoint
ALTER TABLE "finance_payments" ADD CONSTRAINT "finance_payments_amended_from_fk" FOREIGN KEY ("amended_from") REFERENCES "finance_payments"("id") ON DELETE restrict;--> statement-breakpoint
CREATE TRIGGER "finance_payments_docstatus" BEFORE INSERT OR UPDATE OR DELETE ON "finance_payments" FOR EACH ROW EXECUTE FUNCTION campusos_docstatus_guard();--> statement-breakpoint

-- A document's lines change only while it is a draft ----------------------------------
--
-- The lifecycle guard holds the document's own row. Its lines are rows of
-- another table, and an invoice whose header cannot change but whose lines can
-- is not fixed at all -- so each child table checks its parent. TG_ARGV names
-- the parent table and the column pointing at it. A cascade from deleting a
-- draft is let through.
CREATE OR REPLACE FUNCTION finance_child_of_draft() RETURNS trigger AS $$
DECLARE
  state text;
  parent uuid;
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    parent := (to_jsonb(OLD) ->> TG_ARGV[1])::uuid;
    EXECUTE format('SELECT docstatus FROM %I WHERE id = $1', TG_ARGV[0]) INTO state USING parent;
    IF state IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'the lines of a submitted document are fixed'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'finance_lines_of_draft';
    END IF;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    parent := (to_jsonb(NEW) ->> TG_ARGV[1])::uuid;
    EXECUTE format('SELECT docstatus FROM %I WHERE id = $1', TG_ARGV[0]) INTO state USING parent;
    IF state IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'the lines of a submitted document are fixed'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'finance_lines_of_draft';
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "finance_journal_voucher_lines_draft" BEFORE INSERT OR UPDATE OR DELETE ON "finance_journal_voucher_lines" FOR EACH ROW EXECUTE FUNCTION finance_child_of_draft('finance_journals', 'journal_id');--> statement-breakpoint
CREATE TRIGGER "finance_invoice_lines_draft" BEFORE INSERT OR UPDATE OR DELETE ON "finance_invoice_lines" FOR EACH ROW EXECUTE FUNCTION finance_child_of_draft('finance_invoices', 'invoice_id');--> statement-breakpoint
CREATE TRIGGER "finance_invoice_taxes_draft" BEFORE INSERT OR UPDATE OR DELETE ON "finance_invoice_taxes" FOR EACH ROW EXECUTE FUNCTION finance_child_of_draft('finance_invoices', 'invoice_id');--> statement-breakpoint
CREATE TRIGGER "finance_payment_allocations_draft" BEFORE INSERT OR UPDATE OR DELETE ON "finance_payment_allocations" FOR EACH ROW EXECUTE FUNCTION finance_child_of_draft('finance_payments', 'payment_id');--> statement-breakpoint

-- An invoice is submitted as it adds up ------------------------------------------------
--
-- What the invoice says it comes to is what its lines and taxes come to, it has
-- at least one line, and it has posted. Checked at the moment it is submitted,
-- in the database, because a total that disagrees with its own lines is the
-- kind of error an auditor finds and a reader never does.
CREATE OR REPLACE FUNCTION finance_invoice_adds_up() RETURNS trigger AS $$
DECLARE
  net bigint;
  tax bigint;
  billed bigint;
  n int;
BEGIN
  IF NOT (NEW.docstatus = 'submitted' AND OLD.docstatus = 'draft') THEN
    RETURN NEW;
  END IF;
  SELECT count(*), coalesce(sum(l.amount_fc), 0) INTO n, net FROM finance_invoice_lines l WHERE l.invoice_id = NEW.id;
  SELECT coalesce(sum(x.tax_fc), 0) INTO tax FROM finance_invoice_taxes x WHERE x.invoice_id = NEW.id;
  IF n = 0 THEN
    RAISE EXCEPTION 'an invoice needs at least one line'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'finance_invoice_empty';
  END IF;
  -- Under reverse charge the supplier's bill carries no tax: the institution
  -- owes it to the government itself, so it is in the taxes but not the total.
  billed := tax;
  IF NEW.reverse_charge THEN
    billed := 0;
  END IF;
  IF NEW.net_fc <> net OR NEW.tax_fc <> tax OR NEW.total_fc <> net + billed + NEW.rounding_fc THEN
    RAISE EXCEPTION 'the invoice''s totals do not agree with its lines'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'finance_invoice_totals';
  END IF;
  IF NEW.entry_id IS NULL OR NEW.number IS NULL THEN
    RAISE EXCEPTION 'an invoice is numbered and posted as it is submitted'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'finance_invoice_unposted';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "finance_invoices_adds_up"
  BEFORE UPDATE ON "finance_invoices"
  FOR EACH ROW EXECUTE FUNCTION finance_invoice_adds_up();--> statement-breakpoint

-- A payment settles no more than it brought ---------------------------------------------
CREATE OR REPLACE FUNCTION finance_payment_covers() RETURNS trigger AS $$
DECLARE
  settled bigint;
  base text;
BEGIN
  IF NOT (NEW.docstatus = 'submitted' AND OLD.docstatus = 'draft') THEN
    RETURN NEW;
  END IF;
  SELECT coalesce(sum(a.amount_fc), 0) INTO settled FROM finance_payment_allocations a WHERE a.payment_id = NEW.id;
  SELECT coalesce(s.base_currency, 'INR') INTO base FROM finance_settings s WHERE s.institution_id = NEW.institution_id;
  base := coalesce(base, 'INR');
  -- Tax the payer deducted settles as much of the bill as the money did.
  IF NEW.currency = base THEN
    settled := settled - NEW.tds_paise;
  END IF;
  IF settled > NEW.amount_fc THEN
    RAISE EXCEPTION 'a payment settles no more than it brought'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'finance_payment_overallocated';
  END IF;
  IF NEW.entry_id IS NULL OR NEW.number IS NULL THEN
    RAISE EXCEPTION 'a payment is numbered and posted as it is submitted'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'finance_payment_unposted';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "finance_payments_covers"
  BEFORE UPDATE ON "finance_payments"
  FOR EACH ROW EXECUTE FUNCTION finance_payment_covers();--> statement-breakpoint

-- The party ledger is kept, and never settles an invoice twice --------------------------
CREATE TRIGGER "finance_party_ledger_kept"
  BEFORE UPDATE OR DELETE ON "finance_party_ledger"
  FOR EACH ROW EXECUTE FUNCTION finance_kept();--> statement-breakpoint

-- Checked at commit, because an invoice and the payment against it are often
-- written in one transaction and the order of their rows is nobody's business.
-- A negative outstanding means more was settled against an invoice than it was
-- for -- including an invoice cancelled while payments still stand against it,
-- which is exactly the case to refuse.
CREATE OR REPLACE FUNCTION finance_party_ledger_settles() RETURNS trigger AS $$
DECLARE
  left_fc bigint;
BEGIN
  IF NEW.against_id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT coalesce(sum(p.amount_fc), 0) INTO left_fc
    FROM finance_party_ledger p
   WHERE p.against_id = NEW.against_id AND p.party_id = NEW.party_id;
  IF left_fc < 0 THEN
    RAISE EXCEPTION 'more would be settled against that invoice than it is for'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'finance_party_ledger_oversettled',
            HINT = 'cancel the payments and credit notes against it first';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER "finance_party_ledger_settles"
  AFTER INSERT ON "finance_party_ledger"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION finance_party_ledger_settles();
