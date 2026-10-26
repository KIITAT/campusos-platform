-- ACC-18. Submitting the same payment form twice made two receipts and two
-- journal entries, because nothing tied the second request to the first.
--
-- fee_idempotency_keys holds one claim per idempotency key: the operation
-- writes it first, in its own transaction, so it commits with the receipt it
-- guards or not at all. A second request with the key waits on the primary key
-- for the first to end, then gets the first one's receipt back (decision 187).
-- Kept for the life of the receipt; offboarding removes it with the
-- institution. RLS and the tenant policy as on every fees table.
--
-- Rollback: a later migration dropping the table. It holds no money and no
-- personal content, only ids and a hash; dropping it loses the protection, not
-- data. Preferred, per decision 162: restore the pre-upgrade backup with fees
-- 0.5.2, whose code never reads it.

CREATE TABLE "fee_idempotency_keys" (
	"institution_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"operation" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"result_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fee_idempotency_keys_pkey" PRIMARY KEY("institution_id","actor_id","operation","key"),
	CONSTRAINT "fee_idempotency_keys_key" CHECK (key ~ '^[A-Za-z0-9._:-]{8,128}$')
);
--> statement-breakpoint
ALTER TABLE "fee_idempotency_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fee_idempotency_keys" ADD CONSTRAINT "fee_idempotency_keys_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_idempotency_keys" ADD CONSTRAINT "fee_idempotency_keys_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "fee_idempotency_keys_tenant_isolation" ON "fee_idempotency_keys" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
