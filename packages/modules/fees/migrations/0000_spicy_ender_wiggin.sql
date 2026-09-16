-- Split from the monorepo history (0006_spicy_ender_wiggin.sql) when modules became
-- installable plugins. Applied by the host at install time, in this order.

CREATE TYPE "public"."fee_payment_method" AS ENUM('cash', 'cheque', 'bank_transfer', 'upi', 'card', 'other');--> statement-breakpoint
CREATE TABLE "fee_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"program_id" uuid NOT NULL,
	"term_id" uuid NOT NULL,
	"label" text NOT NULL,
	"amount_paise" bigint NOT NULL,
	"due_on" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fee_items_amount" CHECK (amount_paise > 0)
);
--> statement-breakpoint
ALTER TABLE "fee_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "fee_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"student_id" text NOT NULL,
	"term_id" uuid NOT NULL,
	"amount_paise" bigint NOT NULL,
	"method" "fee_payment_method" NOT NULL,
	"reference" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_by" text,
	"receipt_no" text NOT NULL,
	"reconciled_at" timestamp with time zone,
	"reconciled_by" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fee_payments_amount" CHECK (amount_paise > 0)
);
--> statement-breakpoint
ALTER TABLE "fee_payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "fee_waivers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"student_id" text NOT NULL,
	"fee_item_id" uuid NOT NULL,
	"amount_paise" bigint NOT NULL,
	"reason" text NOT NULL,
	"granted_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fee_waivers_amount" CHECK (amount_paise > 0),
	CONSTRAINT "fee_waivers_reason" CHECK (length(trim(reason)) >= 5)
);
--> statement-breakpoint
ALTER TABLE "fee_waivers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "fee_receipt_counters" (
	"institution_id" uuid PRIMARY KEY NOT NULL,
	"prefix" text DEFAULT 'R' NOT NULL,
	"next" bigint DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fee_receipt_counters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fee_items" ADD CONSTRAINT "fee_items_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_items" ADD CONSTRAINT "fee_items_program_id_academic_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."academic_programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_items" ADD CONSTRAINT "fee_items_term_id_academic_terms_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."academic_terms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_payments" ADD CONSTRAINT "fee_payments_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_payments" ADD CONSTRAINT "fee_payments_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_payments" ADD CONSTRAINT "fee_payments_term_id_academic_terms_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."academic_terms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_payments" ADD CONSTRAINT "fee_payments_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_payments" ADD CONSTRAINT "fee_payments_reconciled_by_users_id_fk" FOREIGN KEY ("reconciled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_waivers" ADD CONSTRAINT "fee_waivers_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_waivers" ADD CONSTRAINT "fee_waivers_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_waivers" ADD CONSTRAINT "fee_waivers_fee_item_id_fee_items_id_fk" FOREIGN KEY ("fee_item_id") REFERENCES "public"."fee_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_waivers" ADD CONSTRAINT "fee_waivers_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_receipt_counters" ADD CONSTRAINT "fee_receipt_counters_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fee_items_identity" ON "fee_items" USING btree ("program_id","term_id","label");--> statement-breakpoint
CREATE INDEX "fee_items_term" ON "fee_items" USING btree ("term_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fee_payments_receipt" ON "fee_payments" USING btree ("institution_id","receipt_no");--> statement-breakpoint
CREATE INDEX "fee_payments_student" ON "fee_payments" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "fee_payments_term" ON "fee_payments" USING btree ("term_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fee_waivers_once" ON "fee_waivers" USING btree ("student_id","fee_item_id");--> statement-breakpoint
CREATE INDEX "fee_waivers_student" ON "fee_waivers" USING btree ("student_id");--> statement-breakpoint
CREATE POLICY "fee_items_tenant_isolation" ON "fee_items" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "fee_payments_tenant_isolation" ON "fee_payments" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "fee_waivers_tenant_isolation" ON "fee_waivers" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "fee_receipt_counters_tenant_isolation" ON "fee_receipt_counters" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
