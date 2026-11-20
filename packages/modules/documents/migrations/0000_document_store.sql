-- P2-19: document store and audited signing (MG-71; decisions D850 to D859).
-- Rollback (nothing else depends on these; keep the applied migration and the evidence in production):
--   DROP FUNCTION dpdp_subject.erase_documents(text), dpdp_retention.purge_documents(uuid);
--   DROP TABLE documents_signatures, documents_sign_requests, documents_files;
--   DROP FUNCTION documents_signature_guard(), documents_request_guard(), documents_file_guard();
DO $$
BEGIN
  IF to_regclass('public.documents_files') IS NOT NULL OR to_regclass('public.documents_sign_requests') IS NOT NULL
     OR to_regclass('public.documents_signatures') IS NOT NULL THEN
    RAISE EXCEPTION 'the documents tables already exist';
  END IF;
  IF to_regnamespace('dpdp_subject') IS NULL OR to_regnamespace('dpdp_retention') IS NULL
     OR to_regclass('public.audit_chain') IS NULL THEN
    RAISE EXCEPTION 'core migrations 0008, 0012 and 0016 must be applied first';
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE public.documents_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE,
  subject_user_id text NOT NULL REFERENCES public.users(id),
  kind text NOT NULL CHECK (kind IN ('record','offer','contract','agreement')),
  scope text NOT NULL CHECK (scope IN ('office','student_academic','signer')),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 140),
  media_type text NOT NULL CHECK (media_type IN ('application/pdf','image/png','image/jpeg')),
  body bytea NOT NULL CHECK (octet_length(body) BETWEEN 1 AND 5242880),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  retention_basis text, authority_ref text, retain_until timestamptz,
  UNIQUE(institution_id,id),
  CHECK ((kind='record')=(scope<>'signer')),
  CHECK ((scope='signer' AND media_type='application/pdf' AND
    retention_basis IS NOT NULL AND retention_basis IN ('specified_purpose','legal_obligation') AND
    authority_ref IS NOT NULL AND length(btrim(authority_ref)) BETWEEN 5 AND 240 AND
    retain_until IS NOT NULL AND isfinite(retain_until) AND
    retain_until>=created_at+interval '8 days' AND retain_until<=created_at+interval '10 years')
    OR (scope<>'signer' AND retain_until IS NULL AND retention_basis IS NULL AND authority_ref IS NULL))
);
--> statement-breakpoint
CREATE INDEX documents_files_page ON public.documents_files(institution_id,created_at DESC,id DESC);
--> statement-breakpoint
CREATE INDEX documents_files_subject ON public.documents_files(subject_user_id);
--> statement-breakpoint
CREATE TABLE public.documents_sign_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE, document_id uuid NOT NULL,
  signer_id text NOT NULL REFERENCES public.users(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','signed','declined','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  viewed_at timestamptz, decided_at timestamptz,
  code_digest text, recipient_digest text, code_expires_at timestamptz, code_issued_at timestamptz,
  UNIQUE(institution_id,id), UNIQUE(institution_id,document_id),
  FOREIGN KEY(institution_id,document_id) REFERENCES public.documents_files(institution_id,id) ON DELETE CASCADE,
  CHECK (expires_at>created_at AND expires_at<=created_at+interval '168 hours'),
  CHECK ((status='pending')=(decided_at IS NULL)),
  CHECK ((code_digest IS NULL AND recipient_digest IS NULL AND code_expires_at IS NULL) OR
    (status='pending' AND code_digest IS NOT NULL AND recipient_digest IS NOT NULL AND code_expires_at IS NOT NULL
      AND code_issued_at IS NOT NULL AND code_digest ~ '^[0-9a-f]{64}$'
      AND recipient_digest ~ '^[0-9a-f]{64}$' AND code_expires_at<=expires_at))
);
--> statement-breakpoint
CREATE INDEX documents_requests_signer ON public.documents_sign_requests(signer_id);
--> statement-breakpoint
CREATE TABLE public.documents_signatures (
  id uuid PRIMARY KEY,
  institution_id uuid NOT NULL REFERENCES public.institutions(id) ON DELETE CASCADE, document_id uuid NOT NULL, request_id uuid NOT NULL,
  signer_id text NOT NULL REFERENCES public.users(id),
  signed_at timestamptz NOT NULL,
  method text NOT NULL CHECK (method='account_mailbox_v1'),
  intent_version text NOT NULL CHECK (intent_version='documents-assent-v1'),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  UNIQUE(institution_id,document_id), UNIQUE(institution_id,request_id),
  FOREIGN KEY(institution_id,document_id) REFERENCES public.documents_files(institution_id,id) ON DELETE CASCADE,
  FOREIGN KEY(institution_id,request_id) REFERENCES public.documents_sign_requests(institution_id,id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX documents_signatures_signer ON public.documents_signatures(signer_id);
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['documents_files','documents_sign_requests','documents_signatures'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY %I ON public.%I TO campusos_app USING
      (institution_id=nullif(current_setting(''app.institution_id'',true),'''')::uuid) WITH CHECK
      (institution_id=nullif(current_setting(''app.institution_id'',true),'''')::uuid)',t||'_tenant_isolation',t);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.documents_file_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM users u WHERE u.id=NEW.subject_user_id
        AND u.institution_id=NEW.institution_id AND u.erased_at IS NULL
        AND (NEW.scope<>'student_academic' OR u.role='student'))
        OR NEW.sha256<>encode(sha256(NEW.body),'hex') THEN
      RAISE EXCEPTION 'invalid document subject or hash' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN
    IF pg_trigger_depth()>1 THEN RETURN OLD; END IF;
    IF EXISTS (SELECT 1 FROM documents_signatures s
      WHERE (s.institution_id,s.document_id)=(OLD.institution_id,OLD.id)) THEN
      IF OLD.retain_until<=clock_timestamp() THEN RETURN OLD; END IF;
    ELSIF OLD.created_at<=clock_timestamp()-interval '90 days' OR EXISTS (
      SELECT 1 FROM users u WHERE u.id=OLD.subject_user_id
        AND u.institution_id=OLD.institution_id AND u.erased_at IS NOT NULL
    ) THEN RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'stored document is immutable' USING ERRCODE='23514';
END $$;
--> statement-breakpoint
CREATE TRIGGER documents_file_guard BEFORE INSERT OR UPDATE OR DELETE ON public.documents_files
  FOR EACH ROW EXECUTE FUNCTION public.documents_file_guard();
--> statement-breakpoint
CREATE FUNCTION public.documents_request_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF pg_trigger_depth()>1 THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'request is retained with document' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'pending' OR NEW.viewed_at IS NOT NULL OR NEW.code_digest IS NOT NULL
       OR NOT EXISTS (SELECT 1 FROM documents_files d WHERE
           (d.institution_id,d.id,d.subject_user_id,d.scope)=(NEW.institution_id,NEW.document_id,NEW.signer_id,'signer')) THEN
      RAISE EXCEPTION 'invalid signing request' USING ERRCODE='23514';
    END IF;
  ELSE
    IF (OLD.id,OLD.institution_id,OLD.document_id,OLD.signer_id,OLD.created_at,OLD.expires_at)
       IS DISTINCT FROM
       (NEW.id,NEW.institution_id,NEW.document_id,NEW.signer_id,NEW.created_at,NEW.expires_at)
       OR OLD.status<>'pending' OR (OLD.viewed_at IS NOT NULL AND NEW.viewed_at IS DISTINCT FROM OLD.viewed_at)
       OR (NEW.status='signed' AND NOT EXISTS (SELECT 1 FROM documents_signatures s
         WHERE (s.institution_id,s.request_id,s.document_id)=(NEW.institution_id,NEW.id,NEW.document_id))) THEN
      RAISE EXCEPTION 'invalid signing transition' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER documents_request_guard BEFORE INSERT OR UPDATE OR DELETE ON public.documents_sign_requests
  FOR EACH ROW EXECUTE FUNCTION public.documents_request_guard();
--> statement-breakpoint
CREATE FUNCTION public.documents_signature_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' AND pg_trigger_depth()>1 THEN RETURN OLD; END IF;
  IF TG_OP='INSERT' AND EXISTS (
    SELECT 1 FROM documents_sign_requests r JOIN documents_files d
      ON (d.institution_id,d.id)=(r.institution_id,r.document_id)
      JOIN audit_log a ON a.id=NEW.id
    WHERE (r.institution_id,r.id,r.document_id,r.signer_id)=(NEW.institution_id,NEW.request_id,NEW.document_id,NEW.signer_id)
      AND r.status='pending' AND r.viewed_at IS NOT NULL AND r.code_digest IS NOT NULL
      AND NEW.signed_at>=r.viewed_at AND NEW.signed_at<r.expires_at AND NEW.signed_at<r.code_expires_at
      AND NEW.sha256=d.sha256 AND NEW.sha256=encode(sha256(d.body),'hex')
      AND a.institution_id=NEW.institution_id AND a.actor_id=NEW.signer_id
      AND a.module_id='documents' AND a.action='document.assented'
      AND a.entity='documents_files' AND a.entity_id=NEW.document_id::text
      AND a.detail=jsonb_build_object('requestId',NEW.request_id,'signerId',NEW.signer_id,
        'signedAt',to_char(NEW.signed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'method',NEW.method,'intentVersion',NEW.intent_version,'sha256',NEW.sha256,
        'recipientDigest',r.recipient_digest)
  ) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'signing evidence is append-only and requires matching sealed audit'
    USING ERRCODE='23514';
END $$;
--> statement-breakpoint
CREATE TRIGGER documents_signature_guard BEFORE INSERT OR UPDATE OR DELETE ON public.documents_signatures
  FOR EACH ROW EXECUTE FUNCTION public.documents_signature_guard();
--> statement-breakpoint
REVOKE TRUNCATE ON public.documents_files,public.documents_sign_requests,public.documents_signatures FROM PUBLIC,campusos_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE ON public.documents_files TO campusos_app;
--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON public.documents_sign_requests TO campusos_app;
--> statement-breakpoint
GRANT SELECT,INSERT ON public.documents_signatures TO campusos_app;
--> statement-breakpoint
CREATE FUNCTION dpdp_subject.erase_documents(who text) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE n integer;
BEGIN
  DELETE FROM documents_files d WHERE d.subject_user_id=who
    AND EXISTS (SELECT 1 FROM users u WHERE u.id=who AND u.institution_id=d.institution_id AND u.erased_at IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM documents_signatures s WHERE (s.institution_id,s.document_id)=(d.institution_id,d.id));
  GET DIAGNOSTICS n=ROW_COUNT;
  RETURN jsonb_build_object('documents_files',n);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION dpdp_subject.erase_documents(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION dpdp_subject.erase_documents(text) TO campusos_app;
--> statement-breakpoint
CREATE FUNCTION dpdp_retention.purge_documents(inst uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE n integer; m integer;
BEGIN
  PERFORM 1 FROM documents_files d WHERE d.institution_id=inst AND (
    d.created_at<=now()-interval '90 days' OR d.retain_until<=now() OR EXISTS (
      SELECT 1 FROM documents_sign_requests r WHERE (r.institution_id,r.document_id)=(d.institution_id,d.id)
        AND r.status='pending' AND r.code_expires_at<=now())) ORDER BY d.id FOR UPDATE;
  UPDATE documents_sign_requests SET code_digest=NULL,recipient_digest=NULL,code_expires_at=NULL
    WHERE institution_id=inst AND status='pending' AND code_expires_at<=now();
  GET DIAGNOSTICS m=ROW_COUNT;
  DELETE FROM documents_files d WHERE d.institution_id=inst AND (
    (d.retain_until<=now() AND EXISTS (
      SELECT 1 FROM documents_signatures s WHERE (s.institution_id,s.document_id)=(d.institution_id,d.id))) OR
    (d.created_at<=now()-interval '90 days' AND NOT EXISTS (
      SELECT 1 FROM documents_signatures s WHERE (s.institution_id,s.document_id)=(d.institution_id,d.id))));
  GET DIAGNOSTICS n=ROW_COUNT;
  RETURN jsonb_build_object('documents_files',n,'documents_challenges',m);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION dpdp_retention.purge_documents(uuid) FROM PUBLIC;
