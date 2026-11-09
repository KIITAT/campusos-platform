-- P1-05d: what the Form 140 and 144 statement files need (ACC-31).
-- Pre-flight: none; new nullable columns and a new table. The backfill sets return codes
-- only on the starter sections whose codes the published annexure states without a reading.
-- Rollback (a later migration, or by hand as the owner), then run finance at 0.19.0:
--   DROP TABLE finance_tds_deductor;
--   ALTER TABLE finance_tds_sections DROP COLUMN return_code, DROP COLUMN nr_return_code, DROP COLUMN nr_remittance;
--   ALTER TABLE finance_parties DROP COLUMN tds_status, DROP COLUMN country_code,
--     DROP COLUMN foreign_tax_id, DROP COLUMN foreign_address;

ALTER TABLE "finance_tds_sections" ADD COLUMN "return_code" text;--> statement-breakpoint
ALTER TABLE "finance_tds_sections" ADD COLUMN "nr_return_code" text;--> statement-breakpoint
ALTER TABLE "finance_tds_sections" ADD COLUMN "nr_remittance" text;--> statement-breakpoint
ALTER TABLE "finance_tds_sections" ADD CONSTRAINT "finance_tds_sections_nr_remittance" CHECK (nr_remittance is null or nr_remittance ~ '^[0-9]{2}$');--> statement-breakpoint
ALTER TABLE "finance_tds_sections" ADD CONSTRAINT "finance_tds_sections_return_code" CHECK (return_code is null or return_code ~ '^[0-9]{4}$');--> statement-breakpoint
ALTER TABLE "finance_tds_sections" ADD CONSTRAINT "finance_tds_sections_nr_return_code" CHECK (nr_return_code is null or nr_return_code ~ '^[0-9]{4}$');--> statement-breakpoint
UPDATE "finance_tds_sections" SET "return_code" = CASE "code"
  WHEN 'CONTRACT-IND' THEN '1023' WHEN 'CONTRACT' THEN '1024' WHEN 'PROF' THEN '1027'
  WHEN 'TECH' THEN '1026' WHEN 'COMM' THEN '1006' END
 WHERE "code" IN ('CONTRACT-IND', 'CONTRACT', 'PROF', 'TECH', 'COMM') AND "return_code" IS NULL;--> statement-breakpoint

ALTER TABLE "finance_parties" ADD COLUMN "tds_status" smallint;--> statement-breakpoint
ALTER TABLE "finance_parties" ADD COLUMN "country_code" text;--> statement-breakpoint
ALTER TABLE "finance_parties" ADD COLUMN "foreign_tax_id" text;--> statement-breakpoint
ALTER TABLE "finance_parties" ADD COLUMN "foreign_address" text;--> statement-breakpoint
ALTER TABLE "finance_parties" ADD CONSTRAINT "finance_parties_tds_status" CHECK (tds_status is null or tds_status between 1 and 10);--> statement-breakpoint
ALTER TABLE "finance_parties" ADD CONSTRAINT "finance_parties_country_code" CHECK (country_code is null or country_code ~ '^[0-9]{2,3}$');--> statement-breakpoint
ALTER TABLE "finance_parties" ADD CONSTRAINT "finance_parties_foreign_lengths" CHECK (coalesce(length(foreign_tax_id), 0) <= 25 and coalesce(length(foreign_address), 0) <= 150);--> statement-breakpoint

CREATE TABLE "finance_tds_deductor" (
	"institution_id" uuid PRIMARY KEY NOT NULL,
	"deductor_type" text NOT NULL,
	"address1" text NOT NULL,
	"address2" text,
	"address3" text,
	"address4" text,
	"address5" text,
	"country" text DEFAULT 'INDIA' NOT NULL,
	"state_code" text NOT NULL,
	"pincode" text NOT NULL,
	"email" text NOT NULL,
	"phone_country" text DEFAULT '91' NOT NULL,
	"phone" text NOT NULL,
	"responsible_name" text NOT NULL,
	"responsible_designation" text NOT NULL,
	"responsible_pan" text NOT NULL,
	"responsible_address1" text NOT NULL,
	"responsible_address2" text,
	"responsible_address3" text,
	"responsible_address4" text,
	"responsible_address5" text,
	"responsible_country" text DEFAULT 'INDIA' NOT NULL,
	"responsible_state_code" text NOT NULL,
	"responsible_pincode" text NOT NULL,
	"responsible_email" text NOT NULL,
	"responsible_phone_country" text DEFAULT '91' NOT NULL,
	"responsible_phone" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_tds_deductor_type" CHECK (deductor_type in ('A','S','D','E','G','H','L','N','K','M','P','T','J','B','Q','F')),
	CONSTRAINT "finance_tds_deductor_states" CHECK (state_code ~ '^[0-9]{2}$' and responsible_state_code ~ '^[0-9]{2}$'),
	CONSTRAINT "finance_tds_deductor_pins" CHECK (pincode ~ '^[1-9][0-9]{5}$' and responsible_pincode ~ '^[1-9][0-9]{5}$'),
	CONSTRAINT "finance_tds_deductor_phones" CHECK (phone ~ '^[0-9]{6,10}$' and responsible_phone ~ '^[0-9]{6,10}$' and phone_country ~ '^[0-9]{1,5}$' and responsible_phone_country ~ '^[0-9]{1,5}$'),
	CONSTRAINT "finance_tds_deductor_pan" CHECK (responsible_pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$')
);--> statement-breakpoint
ALTER TABLE "finance_tds_deductor" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "finance_tds_deductor" ADD CONSTRAINT "finance_tds_deductor_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "finance_tds_deductor_tenant_isolation" ON "finance_tds_deductor" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
