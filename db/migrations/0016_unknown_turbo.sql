ALTER TABLE "users" ADD COLUMN "consented_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "consent_version" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "erased_at" timestamp with time zone;