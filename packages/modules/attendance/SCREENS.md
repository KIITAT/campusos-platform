# Signed and offline attendance (0.4.0)

All routes below are under `/api/v1/modules/attendance`. Authentication and
institution scoping are required. Times sent to the API are UTC ISO instants;
`onDate` is a calendar date in the institution's configured time zone.

## Student device enrollment

Path `/m/attendance/device`; student only. Load `GET /devices/mine`, returning
`[{ id, deviceHash, label, status, signed }]`. Status is `pending_approval`,
`active`, or `revoked`. Generate an EC P-256 key in the platform keystore with
private-key export disabled and signing gated by biometric or device PIN.
Do not replace an existing key silently. A replacement has a new device hash
and requires fresh administrator approval.

`POST /devices/key` fields: `deviceHash` (16–200 URL-safe characters), optional
`label` (80 characters), `publicKey` (standard base64 DER SubjectPublicKeyInfo),
and `proof` (base64url DER ECDSA signature using SHA-256). Sign these exact UTF-8
bytes, without a trailing newline:

```
campusos:attendance:enroll:v1
<institutionId>
<userId>
<deviceHash>
<publicKey>
```

The response is `{ id, status }`; retain `id` as the signing device ID. Identical
enrollment is idempotent. `invalid_key_proof` means the key or possession proof
failed. `key_already_bound` requires a new device identifier and office approval.
`POST /devices/revoke { deviceId }` revokes the caller's device; administrators
may revoke any device in their institution. Existing `/devices` and
`/devices/approve` provide the office approval queue and action.

Hardware protection and the biometric/PIN gate are enforced by the native
client. The server verifies private-key possession and approved account/device
binding. It does not independently attest hardware security or the unlock
method; no platform attestation service is configured.

## Scan and outbox

Path `/m/attendance/scan`; student only. Load `GET /offline/policy` when online.
Obtain location, capture QR and capture time, then ask the platform keystore to
sign. Never enqueue an unsigned scan or regenerate a queued payload.

Encode this JSON object once as UTF-8, preserving those exact bytes:

```json
{
  "version": 1,
  "institutionId": "UUID",
  "studentId": "user ID",
  "deviceId": "approved device UUID",
  "qr": "sessionId.window.token",
  "capturedAt": "2026-10-05T09:00:00.000Z",
  "nonce": "fresh UUID",
  "latitude": 20.2961,
  "longitude": 85.8245,
  "accuracyM": 12
}
```

`POST /scan/signed { payload, signature }`: `payload` is unpadded base64url of
the exact JSON bytes; `signature` is unpadded base64url DER ECDSA/SHA-256 over
those bytes. Property order is immaterial to the server but bytes must never
change after signing. No additional properties are accepted.

Successful response:
`{ status: "present", courseCode, markedAt, capturedAt, anomalies: string[] }`.
`markedAt` is receipt time, `capturedAt` the signed capture time. An identical
nonce and payload returns the original result, including after a lost response
or after the normal submission window or device revocation, provided the
original signature still verifies. Revocation blocks new writes, not receipts
for already accepted scans. A reused nonce with different bytes
returns `nonce_reused`. Another scan for an already marked class returns
`already_marked`.

Store signed envelopes durably per account and institution. Show Pending until
the server acknowledges; replay the identical envelope on network failure.
Validation errors are terminal and remain visible for review. An expired token
must be rescanned while the class is live. Do not show a queued scan as Present.

Refusals include `wrong_identity`, `signature_invalid`, `invalid_payload`,
`no_registered_device`, `device_pending_approval`, `wrong_device`,
`malformed_qr`, `no_such_session`, `token_invalid`, `token_stale`,
`outside_session_window`, `clock_skew`, `sync_too_late`, `not_enrolled`,
`location_too_vague`, `outside_geofence`, `credential_revoked`, and
`schedule_changed`. Show the returned message. A revoked/replaced signing
device cannot upload new queued scans; the office can record a manual override
with a reason when appropriate.

The default accepts late submissions for 24 hours after capture and flags
`late_sync` once delay exceeds the greater of clock tolerance and two token
windows. QR window and capture time must agree within clock tolerance. Tokens
are verified at capture time; closed online sessions accept scans captured
before closure. The signed client timestamp is not a trusted hardware clock:
late submissions remain reviewable and are not proof of physical presence.
Geofence and enrollment checks remain in force at sync time.

## Teacher offline preparation

Path `/m/attendance/prepare`; faculty, HOD, administrators. Form fields:
`slotId` and `onDate`. Submit `POST /sessions/prepare` while online. A teacher
may prepare their own unchanged scheduled classes within seven days; an
administrator may prepare any. Changed/cancelled/rescheduled occurrences use
the existing online or manual workflow. Dates outside the term or weekday
return `schedule_changed`; outside the lookahead window returns
`preparation_window`.

Response: `{ sessionId, slotId, onDate, secret, startsAt, endsAt, windowSeconds }`.
Keep the credential in teacher-only secure device storage. It is a bearer
secret scoped to this one occurrence; never put it in a QR, student response,
analytics, or ordinary logs. Preparing does not open or count an attendance
session. Repeating preparation returns the same credential.

At class time, entirely offline, rotate the QR:

```
window = floor(epochMilliseconds / 1000 / windowSeconds)
token = base64url(HMAC-SHA256(UTF8(secret), UTF8(sessionId + ":" + window))).slice(0, 12)
qr = sessionId + "." + window + "." + token
```

The HMAC key is the UTF-8 secret string, not base64-decoded bytes. Show the QR
only between `startsAt` and `endsAt`, after the teacher presses **Start class**.
Persist `{ sessionId, startedAt }` as a local pending marker before showing
the code. `startedAt` is a UTC ISO timestamp captured at that explicit action.
Sync the marker with `POST /sessions/held` using the teacher's authenticated
account; retry the identical marker after a lost response or network failure.
Preparing alone never records the class as held.

The held endpoint creates the bounded occurrence session even with no student
scans, so an all-absent class is counted. A student's first valid scan may also
materialize the same session; concurrent activation and scan create it once.
The teacher declaration is audited once, including its reported start and late
sync flag. The authenticated teacher's timestamp is a claim, not a trusted
hardware time source. New declarations validate owner/current role, schedule,
credential revocation, start window, clock tolerance and sync policy.

Response: `{ sessionId, startedAt, openedAt, closedAt }`; the start is the first
accepted teacher declaration and session bounds remain the scheduled bounds.
An accepted held declaration is idempotent even after credential expiry or
revocation, while the owner must still have a current teaching role (or be an
administrator). Student materialization alone does not bypass validation of a
new teacher declaration. Keep unsynced markers through restart and account
sign-out, scoped to the original account; remove bearer secrets on sign-out.

`POST /sessions/prepare/revoke { sessionId }` revokes the credential; only its
owner or an administrator may do so. Further scans against it fail. Revocation
frees an unrecorded occurrence for an online session. If scans already created
its session, use that session's roster for manual corrections; opening another
returns `occurrence_recorded`. The server rejects credentials
after timetable changes and does not merge them into another session.

## Institution offline policy

Path `/m/attendance/offline-policy`; administrators only for changes. Load
`GET /offline/policy`; submit `POST /offline/policy`:

| Field | Default | Limits |
|---|---|---|
| `requireSignedScans` | true | boolean |
| `acceptLateSync` | true | boolean |
| `maxLateSyncHours` | 24 | integer 1–168 |
| `clockSkewSeconds` | 60 | integer 0–300 |

Changes are audited. Disabling `requireSignedScans` permits the legacy online
flow only for accounts that never enrolled a signing key. A keyed account
cannot downgrade to `/scan`, even after device revocation. An untouched
institution requires signatures by default. Keep the existing reasoned manual
override available for accessibility needs and devices without supported
hardware signing.
