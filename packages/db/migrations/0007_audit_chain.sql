-- P0-02 (AUD-01): the tables of the audit chain. Generated from audit.ts;
-- 0008 adds the functions and triggers that fill and guard them.
--
-- audit_log.salt: 32 random bytes per row, set by the database (0008).
-- audit_chain: one link per audit row, per institution, in commit order.
-- platform_audit_log: events with no institution, chained in the row itself.
--
-- Forward-only and additive. Rollback is a later migration that drops the two
-- tables and the column, which discards the evidence; for an upgrade, prefer
-- restoring the pre-upgrade backup with the matching image (decision 162).

CREATE TABLE "audit_chain" (
	"audit_id" uuid PRIMARY KEY NOT NULL,
	"institution_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"prev_hash" "bytea" NOT NULL,
	"hash" "bytea" NOT NULL,
	"sealed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_chain_institution_seq" UNIQUE("institution_id","seq")
);
--> statement-breakpoint
ALTER TABLE "audit_chain" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "platform_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid,
	"actor_id" text,
	"actor_email" text,
	"module_id" text NOT NULL,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text NOT NULL,
	"reason" text NOT NULL,
	"detail" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"salt" "bytea",
	"seq" bigint NOT NULL,
	"prev_hash" "bytea" NOT NULL,
	"hash" "bytea" NOT NULL,
	CONSTRAINT "platform_audit_log_seq" UNIQUE("seq")
);
--> statement-breakpoint
ALTER TABLE "platform_audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "salt" "bytea";--> statement-breakpoint
ALTER TABLE "audit_chain" ADD CONSTRAINT "audit_chain_audit_id_audit_log_id_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."audit_log"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_chain" ADD CONSTRAINT "audit_chain_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "platform_audit_log_at" ON "platform_audit_log" USING btree ("at");--> statement-breakpoint
CREATE POLICY "audit_chain_tenant_isolation" ON "audit_chain" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);