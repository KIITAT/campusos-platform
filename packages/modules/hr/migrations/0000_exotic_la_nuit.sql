-- Split from the monorepo history (0012_exotic_la_nuit.sql) when modules became
-- installable plugins. Applied by the host at install time, in this order.

CREATE TYPE "public"."hr_component_kind" AS ENUM('earning', 'deduction');--> statement-breakpoint
CREATE TYPE "public"."hr_employment" AS ENUM('permanent', 'contract', 'visiting', 'probation');--> statement-breakpoint
CREATE TYPE "public"."hr_leave_status" AS ENUM('pending', 'approved', 'rejected', 'cancelled');--> statement-breakpoint
CREATE TABLE "hr_leave_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"leave_type_id" uuid NOT NULL,
	"from_on" date NOT NULL,
	"to_on" date NOT NULL,
	"reason" text NOT NULL,
	"status" "hr_leave_status" DEFAULT 'pending' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hr_leave_requests_dates" CHECK (to_on >= from_on),
	CONSTRAINT "hr_leave_requests_reason" CHECK (length(trim(reason)) >= 5),
	CONSTRAINT "hr_leave_requests_decided" CHECK ((status = 'pending' and decided_at is null)
          or (status <> 'pending' and decided_at is not null))
);
--> statement-breakpoint
ALTER TABLE "hr_leave_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hr_leave_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"annual_days" smallint DEFAULT 0 NOT NULL,
	"paid" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hr_leave_types_days" CHECK (annual_days between 0 and 365)
);
--> statement-breakpoint
ALTER TABLE "hr_leave_types" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hr_pay_components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"kind" "hr_component_kind" NOT NULL,
	"amount_paise" bigint NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hr_pay_components_amount" CHECK (amount_paise > 0),
	CONSTRAINT "hr_pay_components_dates" CHECK (effective_to is null or effective_to >= effective_from),
	CONSTRAINT "hr_pay_components_code" CHECK (length(trim(code)) > 0)
);
--> statement-breakpoint
ALTER TABLE "hr_pay_components" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hr_payslips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"period" date NOT NULL,
	"gross_paise" bigint NOT NULL,
	"deductions_paise" bigint NOT NULL,
	"net_paise" bigint NOT NULL,
	"unpaid_leave_days" smallint DEFAULT 0 NOT NULL,
	"loss_of_pay_paise" bigint DEFAULT 0 NOT NULL,
	"lines" jsonb NOT NULL,
	"generated_by" text,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hr_payslips_amounts" CHECK (gross_paise >= 0 and deductions_paise >= 0),
	CONSTRAINT "hr_payslips_net" CHECK (net_paise = gross_paise - deductions_paise),
	CONSTRAINT "hr_payslips_period_start" CHECK (extract(day from period) = 1)
);
--> statement-breakpoint
ALTER TABLE "hr_payslips" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hr_staff" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"user_id" text,
	"employee_code" text NOT NULL,
	"name" text NOT NULL,
	"designation" text NOT NULL,
	"department" text,
	"employment" "hr_employment" DEFAULT 'permanent' NOT NULL,
	"joined_on" date NOT NULL,
	"left_on" date,
	"email" text,
	"phone" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hr_staff_code_shape" CHECK (length(trim(employee_code)) > 0),
	CONSTRAINT "hr_staff_dates" CHECK (left_on is null or left_on >= joined_on)
);
--> statement-breakpoint
ALTER TABLE "hr_staff" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hr_leave_requests" ADD CONSTRAINT "hr_leave_requests_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_leave_requests" ADD CONSTRAINT "hr_leave_requests_staff_id_hr_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."hr_staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_leave_requests" ADD CONSTRAINT "hr_leave_requests_leave_type_id_hr_leave_types_id_fk" FOREIGN KEY ("leave_type_id") REFERENCES "public"."hr_leave_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_leave_requests" ADD CONSTRAINT "hr_leave_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_leave_types" ADD CONSTRAINT "hr_leave_types_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_pay_components" ADD CONSTRAINT "hr_pay_components_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_pay_components" ADD CONSTRAINT "hr_pay_components_staff_id_hr_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."hr_staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_payslips" ADD CONSTRAINT "hr_payslips_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_payslips" ADD CONSTRAINT "hr_payslips_staff_id_hr_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."hr_staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_payslips" ADD CONSTRAINT "hr_payslips_generated_by_users_id_fk" FOREIGN KEY ("generated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_staff" ADD CONSTRAINT "hr_staff_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_staff" ADD CONSTRAINT "hr_staff_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hr_leave_requests_staff" ON "hr_leave_requests" USING btree ("staff_id","status");--> statement-breakpoint
CREATE INDEX "hr_leave_requests_pending" ON "hr_leave_requests" USING btree ("institution_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "hr_leave_types_code" ON "hr_leave_types" USING btree ("institution_id","code");--> statement-breakpoint
CREATE INDEX "hr_pay_components_staff" ON "hr_pay_components" USING btree ("staff_id","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "hr_payslips_once" ON "hr_payslips" USING btree ("staff_id","period");--> statement-breakpoint
CREATE INDEX "hr_payslips_period" ON "hr_payslips" USING btree ("institution_id","period");--> statement-breakpoint
CREATE UNIQUE INDEX "hr_staff_code" ON "hr_staff" USING btree ("institution_id","employee_code");--> statement-breakpoint
CREATE UNIQUE INDEX "hr_staff_user" ON "hr_staff" USING btree ("institution_id","user_id") WHERE user_id is not null;--> statement-breakpoint
CREATE INDEX "hr_staff_active" ON "hr_staff" USING btree ("institution_id","left_on");--> statement-breakpoint
CREATE POLICY "hr_leave_requests_tenant_isolation" ON "hr_leave_requests" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hr_leave_types_tenant_isolation" ON "hr_leave_types" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hr_pay_components_tenant_isolation" ON "hr_pay_components" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hr_payslips_tenant_isolation" ON "hr_payslips" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hr_staff_tenant_isolation" ON "hr_staff" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
