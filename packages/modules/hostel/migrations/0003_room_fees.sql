-- P1-03e (ACC-28, decision 576): a fee per bed per term on a room, charged to
-- the student's fee account when fees is enabled.
--
-- Pre-flight: none needed (a new nullable column; the check holds for null).
--
-- Rollback:
--   ALTER TABLE hostel_rooms DROP CONSTRAINT hostel_rooms_term_fee;
--   ALTER TABLE hostel_rooms DROP COLUMN term_fee_paise;
ALTER TABLE "hostel_rooms" ADD COLUMN "term_fee_paise" bigint;
--> statement-breakpoint
ALTER TABLE "hostel_rooms" ADD CONSTRAINT "hostel_rooms_term_fee" CHECK (term_fee_paise is null or term_fee_paise > 0);
