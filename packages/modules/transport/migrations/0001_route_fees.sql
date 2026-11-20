-- P1-03e (ACC-28, decision 578): a fee per seat per term on a route, charged to
-- the student's fee account when fees is enabled.
--
-- Pre-flight: none needed (a new nullable column; the check holds for null).
--
-- Rollback:
--   ALTER TABLE transport_routes DROP CONSTRAINT transport_routes_term_fee;
--   ALTER TABLE transport_routes DROP COLUMN term_fee_paise;
ALTER TABLE "transport_routes" ADD COLUMN "term_fee_paise" bigint;
--> statement-breakpoint
ALTER TABLE "transport_routes" ADD CONSTRAINT "transport_routes_term_fee" CHECK (term_fee_paise is null or term_fee_paise > 0);
