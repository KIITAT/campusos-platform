CREATE TABLE notification_email_opt_outs (
  institution_id uuid NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (institution_id, user_id)
);--> statement-breakpoint
ALTER TABLE notification_email_opt_outs ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY notification_email_opt_outs_tenant_isolation ON notification_email_opt_outs TO campusos_app
  USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid)
  WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid AND
    EXISTS (SELECT 1 FROM users u WHERE u.id = notification_email_opt_outs.user_id
      AND u.institution_id = notification_email_opt_outs.institution_id));
