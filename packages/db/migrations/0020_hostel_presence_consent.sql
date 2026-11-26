-- P2-22a: a consent purpose for hostel presence (library and class status, curfew alerts).
-- Pre-flight: none (the constraint is only widened).
-- Rollback (manual, destructive of the new rows):
--   DELETE FROM guardian_consents WHERE purpose = 'hostel_presence';
--   ALTER TABLE guardian_consents DROP CONSTRAINT guardian_consents_purpose;
--   ALTER TABLE guardian_consents ADD CONSTRAINT guardian_consents_purpose CHECK (purpose in ('privacy_notice', 'care_self_checks', 'apaar'));
ALTER TABLE guardian_consents DROP CONSTRAINT guardian_consents_purpose;
--> statement-breakpoint
ALTER TABLE guardian_consents ADD CONSTRAINT guardian_consents_purpose CHECK (purpose in ('privacy_notice', 'care_self_checks', 'apaar', 'hostel_presence'));
