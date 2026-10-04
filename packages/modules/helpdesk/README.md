# Helpdesk and grievance

Institution members report helpdesk issues or confidential grievances. Administrators assign a current staff member; the reporter, assigned officer and administrators discuss the issue. The officer or administrator resolves it, and the reporter or administrator can reopen it with a reason. Resolved cases reject messages and reassignment until reopened.

## Confidentiality

All cases are participant-only, including cases not explicitly marked confidential. Grievances are always confidential. Unrelated institution members receive no case listing or detail. Assigned-officer privileges require a current staff role: a demoted student loses officer read, message and resolution rights, while retaining reporter access to their own cases. Erased identities cannot be selected as assignees. The host supplies a refreshed authenticated actor and enforces module entitlement.

Tenant RLS isolates cases/messages. Composite tenant/case references reject cross-institution discussions even below the API. Case row locks serialize messages, assignment, resolve and reopen. Audit records action metadata, never the description, message or resolution text. This is not anonymous reporting, a public grievance portal, SLA automation or external ticket integration.

API base: `/api/v1/modules/helpdesk`. GET `/cases`, `/cases/detail?id=…`. POST `/cases`, `/cases/assign`, `/cases/messages`, `/cases/resolve`, `/cases/reopen`. Request schemas are included in OpenAPI.

Run `pnpm test` against isolated PostgreSQL after core/module migrations. Tests cover participant confidentiality, demotion, erased assignees, cross-tenant links/RLS, resolution races, audit redaction and role/state-dependent loaded pages.
