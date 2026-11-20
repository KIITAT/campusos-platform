# Documents

An institution's store of original files, with recorded electronic assent for ordinary offers, contracts and agreements. Optional module `documents` 0.1.0, no dependencies, migration 0000.

## What it does

An administrator files one immutable document for one current member. Office records are for administrators. Academic records follow the existing student access rules: the student, a verified guardian, or staff with a teaching relation. A document for signature (offer, contract or agreement, PDF only) is visible only to administrators and to the named signer, and only once a request exists.

An administrator asks the named member for assent. The member downloads the exact PDF, asks for a confirmation code that is emailed to their current account address, and enters the code with an explicit agreement. One audit row seals the evidence (signer, request, time, method, intent and the SHA-256 of the file), and the signature row is accepted only beside that audit row. The original bytes are never altered; a separate evidence PDF can be downloaded.

Every read recomputes the SHA-256 of the stored bytes and, for a signed file, checks the evidence against the sealed audit row and its chain link. On any difference the file and evidence are withheld, the failure is audited, and the page shows "Integrity check failed". A signed-in member can also verify a document, and optionally their own copy by digest, on demand.

## Email

The module issues the code and stores only a digest. The web host mails it through the same `EMAIL_SERVER` and `EMAIL_FROM` that sign-in links use (route `POST /api/v1/document-assent/challenge`, read-only hook `assentMailer` on the plugin). Without a mail server the form answers "Document confirmation email is unavailable."

## What this is not

This records an institution's internal evidence of electronic assent. It is not a certified, Aadhaar or licensed-provider signature, and no file is marked as signed under the IT Act schedules. Wills, trusts, powers of attorney, negotiable instruments and property instruments are outside the workflow. Where a rule requires a recognised signature, use the institution's approved licensed-provider process and file the resulting PDF as an office record. There is no external signer, multi-party signing or public verification.

## Retention

Unsigned files are removed after 90 days, and when their subject is erased. A signed file is kept to its recorded end date, which is required at upload (8 days to 10 years), with a basis (`specified_purpose` or `legal_obligation`) and an authority reference. After that date the file is purged and the sealed audit record and hash remain. Data exports list file and signing metadata, never titles, bytes, addresses or code digests.

## API

Base `/api/v1/modules/documents`. GET `/files`, `/file?id=…`, `/receipt.pdf?id=…`. POST `/verify`, `/upload` (administrators), `/request` (administrators), `/sign`, `/close` (the signer declines, an administrator cancels). Request schemas are in OpenAPI. Run `pnpm test` against isolated PostgreSQL after core and module migrations.
