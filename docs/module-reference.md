# Module feature and interface reference

Generated from the current plugin manifests, page declarations and OpenAPI fragments.
Page roles are navigation gates, not a substitute for the operation’s per-record authorization.
Every endpoint below has a route declaration checked by the central API-contract suite.
Regenerate with UPDATE_REFERENCE=1 and scripts/module-reference.test.ts.

| Module | Version | Pages | API routes | Dependencies |
|---|---|---:|---:|---|
| [Academic Core](#academic) | 0.11.0 | 7 | 42 | None |
| [Admissions](#admissions) | 0.7.0 | 3 | 9 | academic |
| [Alumni and events](#alumni) | 0.5.0 | 4 | 12 | None |
| [Attendance & QR](#attendance) | 0.13.0 | 7 | 28 | academic, notices |
| [Student Care](#care) | 0.10.0 | 7 | 24 | academic, notices |
| [Ceremonies](#ceremonies) | 0.6.0 | 5 | 18 | academic |
| [Sales CRM](#crm) | 0.3.0 | 4 | 32 | finance, notices |
| [Enrollment](#enrollment) | 0.6.0 | 3 | 8 | academic |
| [Examinations & Grading](#examinations) | 0.16.0 | 9 | 36 | academic, notices |
| [Feedback](#feedback) | 0.7.0 | 8 | 19 | academic |
| [Fees & Finance](#fees) | 0.19.0 | 10 | 39 | academic, finance, notices |
| [Finance & Books](#finance) | 0.16.0 | 92 | 204 | None |
| [Helpdesk and grievance](#helpdesk) | 0.5.0 | 2 | 7 | None |
| [Hostel](#hostel) | 0.9.0 | 5 | 18 | academic |
| [HR & Payroll](#hr) | 0.20.0 | 18 | 134 | finance, notices |
| [Library](#library) | 0.12.0 | 5 | 18 | academic |
| [Mentoring](#mentoring) | 0.16.0 | 6 | 19 | academic, notices |
| [Communication & Notices](#notices) | 0.12.0 | 4 | 13 | academic |
| [Parent Portal](#parents) | 0.16.0 | 4 | 11 | academic |
| [Placement](#placement) | 0.10.0 | 8 | 15 | academic, notices |
| [Projects and timesheets](#projects) | 0.2.0 | 6 | 27 | finance |
| [Quizzes](#quizzes) | 0.7.0 | 7 | 22 | academic |
| [Skills](#skills) | 0.5.0 | 5 | 12 | None |
| [Timetable](#timetable) | 0.8.0 | 12 | 42 | academic |
| [Transport](#transport) | 0.4.0 | 4 | 12 | None |

<a id="academic"></a>
## Academic Core

Departments, programmes, courses, terms, cohorts, rooms and the weekly timetable.

Module roles: `super_admin`, `institution_admin`, `hod`, `faculty`, `student`.
Source: `campusos-platform/packages/modules/academic/`.

### Screens

| Path | Page | Roles |
|---|---|---|
| `/m/academic` | Timetable | institution_admin, super_admin, hod, faculty, student |
| `/m/academic/week` | This week | institution_admin, super_admin, hod, faculty, student |
| `/m/academic/structure` | Structure | institution_admin, super_admin, hod |
| `/m/academic/cohorts` | Cohorts | institution_admin, super_admin, hod |
| `/m/academic/curriculum` | Curriculum | institution_admin, super_admin, hod |
| `/m/academic/record` | Record | institution_admin, super_admin, hod, faculty, student |
| `/m/academic/import` | Import from CSV | institution_admin, super_admin |

### Operations

| Method and path | Operation | Body fields / query parameters |
|---|---|---|
| `POST /api/v1/modules/academic/departments` | Create a department | `code`, `name` |
| `POST /api/v1/modules/academic/programs` | Create a programme | `departmentId`, `code`, `name`, `level`, `durationTerms` |
| `POST /api/v1/modules/academic/courses` | Create a course | `departmentId`, `code`, `title`, `credits` |
| `POST /api/v1/modules/academic/rooms` | Create a room | `code`, `building`, `capacity` |
| `POST /api/v1/modules/academic/terms` | Create an academic term | `code`, `name`, `kind`, `startsOn`, `endsOn`, `registrationOpensOn`, `registrationClosesOn`, `addDropEndsOn`, `withdrawEndsOn` |
| `POST /api/v1/modules/academic/terms/current` | Mark a term as current | `termId` |
| `POST /api/v1/modules/academic/sections` | Create a cohort | `programId`, `label`, `admissionYear` |
| `POST /api/v1/modules/academic/sections/class-teacher` | Set or clear a cohort's class teacher, by email | `sectionId`, `email` |
| `POST /api/v1/modules/academic/departments/head` | Set or clear a department's head (a HoD), by email | `departmentId`, `email` |
| `POST /api/v1/modules/academic/sections/members` | Add a student to a cohort | `sectionId`, `userId` |
| `POST /api/v1/modules/academic/offerings` | Offer a course to a cohort in a term | `termId`, `courseId`, `sectionId`, `facultyUserId` |
| `POST /api/v1/modules/academic/slots` | Add a weekly timetable slot | `offeringId`, `roomId`, `dayOfWeek`, `startsAt`, `endsAt` |
| `GET /api/v1/modules/academic/timetable` | The weekly timetable for the current term, scoped to the caller: their cohorts if a student, what they teach if a lecturer, the whole institution for an admin | See runtime OpenAPI schema |
| `POST /api/v1/modules/academic/terms/calendar` | Set a term's registration and drop dates | `termId`, `registrationOpensOn`, `registrationClosesOn`, `addDropEndsOn`, `withdrawEndsOn` |
| `POST /api/v1/modules/academic/curricula` | Create a curriculum for a catalogue year | `programId`, `catalogYear`, `totalCredits` |
| `POST /api/v1/modules/academic/gpa-policy` | Set a grade point average rule from a date | `effectiveFrom`, `failedCredits`, `repeats` |
| `POST /api/v1/modules/academic/requirements` | Add a degree requirement and the courses that satisfy it | `curriculumId`, `code`, `title`, `kind`, `minCredits`, `minCourses`, `courseIds` |
| `POST /api/v1/modules/academic/prerequisites` | Require one course before another | `courseId`, `requiresCourseId`, `kind`, `minGradePoints` |
| `POST /api/v1/modules/academic/prerequisites/waivers` | Excuse a named student from a prerequisite | `studentId`, `courseId`, `requiresCourseId`, `reason` |
| `POST /api/v1/modules/academic/equivalences` | Record two courses as the same course, cross-listed or accepted in transfer | `courseId`, `equivalentCourseId`, `note` |
| `POST /api/v1/modules/academic/students/programs` | Declare a programme for a student | `studentId`, `programId`, `curriculumId`, `isPrimary`, `declaredOn` |
| `POST /api/v1/modules/academic/students/programs/end` | Complete, withdraw from or transfer out of a programme | `studentProgramId`, `status`, `endedOn` |
| `POST /api/v1/modules/academic/completions` | Record a passed course, earned here or accepted in transfer | `studentId`, `courseId`, `termId`, `credits`, `gradePoints`, `gradeLabel`, `passed`, `source`, `note` |
| `POST /api/v1/modules/academic/eligibility` | Whether a student may take a course, and what is missing if not | `studentId`, `courseId` |
| `POST /api/v1/modules/academic/completions/correct` | Correct a completed course, with a reason that goes on the record | `completionId`, `credits`, `gradePoints`, `gradeLabel`, `passed`, `reason` |
| `POST /api/v1/modules/academic/degree-audit` | What a student's degree still needs, and what the average is | `studentId`, `studentProgramId` |
| `POST /api/v1/modules/academic/profile` | Set a student's roll and registration numbers, phone and address (the office) | `studentId`, `rollNo`, `registrationNo`, `phone`, `addressLine`, `city`, `state`, `postalCode`, `emergencyContact`, `dateOfBirth`, `apaarId` |
| `POST /api/v1/modules/academic/consents` | Record a choice for a student: a guardian for a minor, the student once adult, or the office from a form | `studentId`, `purpose`, `decision`, `note` |
| `POST /api/v1/modules/academic/classes/change` | Cancel, move or hand to a substitute one meeting of a class | `slotId`, `onDate`, `kind`, `movedOn`, `movedStarts`, `movedEnds`, `movedRoomId`, `substituteId`, `reason` |
| `POST /api/v1/modules/academic/classes/change/withdraw` | Withdraw a change: the class meets as usual | `changeId`, `reason` |
| `GET /api/v1/modules/academic/week` | The week containing a date (date=YYYY-MM-DD), with changes applied, for the caller | See runtime OpenAPI schema |
| `GET /api/v1/modules/academic/profile` | A student's roll and registration numbers, phone and address: their own, or any for staff (studentId) | See runtime OpenAPI schema |
| `GET /api/v1/modules/academic/consents` | A student's recorded choices (studentId): the privacy notice, counselling self-checks and the APAAR ID | See runtime OpenAPI schema |
| `GET /api/v1/modules/academic/curricula` | Every curriculum, with its requirements | See runtime OpenAPI schema |
| `GET /api/v1/modules/academic/gpa-policy` | The grade point average rules, oldest first | See runtime OpenAPI schema |
| `GET /api/v1/modules/academic/prerequisites` | Every prerequisite edge | See runtime OpenAPI schema |
| `GET /api/v1/modules/academic/prerequisites/waivers` | Waivers on file, newest first | See runtime OpenAPI schema |
| `GET /api/v1/modules/academic/students/programs` | A student's declared programmes; the caller's own without a studentId | See runtime OpenAPI schema |
| `GET /api/v1/modules/academic/completions` | A student's completed courses | See runtime OpenAPI schema |
| `GET /api/v1/modules/academic/imports` | What this module can import from CSV, with each file’s columns | See runtime OpenAPI schema |
| `GET /api/v1/modules/academic/imports/template` | A CSV template: the header and one example row (binary response) | `id` (query) |
| `POST /api/v1/modules/academic/imports/run` | Check a CSV file, or with apply import it: all rows or none | `importId`, `file`, `csv`, `apply` |

<a id="admissions"></a>
## Admissions

Admissions workflows for this institution.

Module roles: `institution_admin`, `super_admin`.
Source: `campusos-platform/packages/modules/admissions/`.

### Screens

| Path | Page | Roles |
|---|---|---|
| `/m/admissions` | Admissions enquiries | institution_admin, super_admin |
| `/m/admissions/applications` | Applications and offers | institution_admin, super_admin |
| `/m/admissions/import` | Import from CSV | institution_admin, super_admin |

### Operations

| Method and path | Operation | Body fields / query parameters |
|---|---|---|
| `GET /api/v1/modules/admissions/enquiries` | List enquiries | See runtime OpenAPI schema |
| `GET /api/v1/modules/admissions/applications` | List applications | See runtime OpenAPI schema |
| `POST /api/v1/modules/admissions/enquiries` | Record an enquiry | `name`, `email`, `phone`, `note` |
| `POST /api/v1/modules/admissions/applications` | Submit an application | `enquiryId`, `programId`, `termId` |
| `POST /api/v1/modules/admissions/applications/decision` | Offer, reject or withdraw | `applicationId`, `decision`, `reason` |
| `POST /api/v1/modules/admissions/applications/accept` | Accept and link academic student | `applicationId`, `studentId` |
| `GET /api/v1/modules/admissions/imports` | What this module can import from CSV, with each file’s columns | See runtime OpenAPI schema |
| `GET /api/v1/modules/admissions/imports/template` | A CSV template: the header and one example row (binary response) | `id` (query) |
| `POST /api/v1/modules/admissions/imports/run` | Check a CSV file, or with apply import it: all rows or none | `importId`, `file`, `csv`, `apply` |

<a id="alumni"></a>
## Alumni and events

Alumni and events workflows for this institution.

Module roles: `institution_admin`, `super_admin`, `hod`, `faculty`, `student`, `accounts_staff`, `library_staff`, `hostel_staff`.
Source: `campusos-platform/packages/modules/alumni/`.

### Screens

| Path | Page | Roles |
|---|---|---|
| `/m/alumni` | Alumni directory | institution_admin, super_admin, hod, faculty, student, accounts_staff, library_staff, hostel_staff |
| `/m/alumni/events` | Alumni events | institution_admin, super_admin, hod, faculty, student, accounts_staff, library_staff, hostel_staff |
| `/m/alumni/registrations` | Event registrations | institution_admin, super_admin, hod, faculty, student, accounts_staff, library_staff, hostel_staff |
| `/m/alumni/import` | Import from CSV | institution_admin, super_admin |

### Operations

| Method and path | Operation | Body fields / query parameters |
|---|---|---|
| `GET /api/v1/modules/alumni/profiles` | List permitted alumni profiles | See runtime OpenAPI schema |
| `GET /api/v1/modules/alumni/events` | List events | See runtime OpenAPI schema |
| `GET /api/v1/modules/alumni/registrations` | List permitted registrations | See runtime OpenAPI schema |
| `POST /api/v1/modules/alumni/profiles` | Maintain graduate profile | `userId`, `graduationYear`, `qualification`, `employer`, `contactEmail` |
| `POST /api/v1/modules/alumni/profiles/consent` | Change own publication consent | `profileId`, `publishProfile`, `publishContact` |
| `POST /api/v1/modules/alumni/events` | Draft event | `title`, `startsOn`, `registrationDeadline`, `capacity`, `venue` |
| `POST /api/v1/modules/alumni/events/transition` | Open, close or cancel event | `eventId`, `action` |
| `POST /api/v1/modules/alumni/registrations` | Register for event | `eventId` |
| `POST /api/v1/modules/alumni/registrations/cancel` | Cancel registration | `registrationId` |
| `GET /api/v1/modules/alumni/imports` | What this module can import from CSV, with each file’s columns | See runtime OpenAPI schema |
| `GET /api/v1/modules/alumni/imports/template` | A CSV template: the header and one example row (binary response) | `id` (query) |
| `POST /api/v1/modules/alumni/imports/run` | Check a CSV file, or with apply import it: all rows or none | `importId`, `file`, `csv`, `apply` |

<a id="attendance"></a>
## Attendance & QR

Rotating-QR attendance with GPS geofencing and one-device-per-student binding.

Module roles: `super_admin`, `institution_admin`, `hod`, `faculty`, `student`.
Source: `campusos-platform/packages/modules/attendance/`.

### Screens

| Path | Page | Roles |
|---|---|---|
| `/m/attendance` | Attendance | institution_admin, super_admin, faculty, hod |
| `/m/attendance/devices` | Devices | institution_admin, super_admin |
| `/m/attendance/offline-policy` | Signed attendance policy | institution_admin, super_admin |
| `/m/attendance/device` | My attendance device | student |
| `/m/attendance/me` | My attendance | student |
| `/m/attendance/absentees` | Absentees | institution_admin, super_admin, hod, faculty |
| `/m/attendance/excuses` | Excused absence | institution_admin, super_admin, hod, faculty |

### Operations

| Method and path | Operation | Body fields / query parameters |
|---|---|---|
| `POST /api/v1/modules/attendance/scan/signed` | Verify a P-256 device signature over exact base64url JSON bytes; idempotently sync a captured scan | `payload`, `signature` |
| `POST /api/v1/modules/attendance/devices/key` | Enroll a P-256 public key with proof of possession; administrator approval required | `deviceHash`, `label`, `publicKey`, `proof` |
| `GET /api/v1/modules/attendance/devices/mine` | The caller’s device status and signing-key availability | See runtime OpenAPI schema |
| `POST /api/v1/modules/attendance/devices/revoke` | Revoke the caller’s device, or any device as administrator | `deviceId` |
| `GET /api/v1/modules/attendance/offline/policy` | Signed attendance requirements, late-sync limit, and clock tolerance | See runtime OpenAPI schema |
| `POST /api/v1/modules/attendance/offline/policy` | Set signed attendance and late-sync policy | `requireSignedScans`, `acceptLateSync`, `maxLateSyncHours`, `clockSkewSeconds` |
| `POST /api/v1/modules/attendance/sessions/prepare` | Prefetch a secret scoped to one timetable occurrence within seven days; opens no session | `slotId`, `onDate` |
| `POST /api/v1/modules/attendance/sessions/held` | Idempotently confirm that a prepared class was started, including an all-absent class | `sessionId`, `startedAt` |
| `POST /api/v1/modules/attendance/sessions/prepare/revoke` | Revoke an offline occurrence credential | `sessionId` |
| `GET /api/v1/modules/attendance/rules` | The minimum attendance, whether excused absence counts, and the zone a class date is read in | See runtime OpenAPI schema |
| `POST /api/v1/modules/attendance/rules` | Set them | `minimumPercent`, `excusedCounts`, `timeZone` |
| `GET /api/v1/modules/attendance/excuses` | Excused absences: a student’s own, a teacher’s classes’, or all for the office | See runtime OpenAPI schema |
| `POST /api/v1/modules/attendance/excuses` | Excuse absence over days, for one class or all of a student’s classes | `studentId`, `offeringId`, `fromOn`, `toOn`, `kind`, `reason` |
| `POST /api/v1/modules/attendance/excuses/revoke` | Revoke an excuse, with a reason | `excuseId`, `reason` |
| `GET /api/v1/modules/attendance/absentees` | Everybody in a class with their attendance, those short of the minimum first, and who missed the last session | `offeringId` (query) |
| `GET /api/v1/modules/attendance/summary` | A student’s attendance class by class: held, present, excused, absent, percentage, and classes needed to reach the minimum | `studentId` (query), `termId` (query) |
| `GET /api/v1/modules/attendance/sessions` | Open sessions the caller may act on | See runtime OpenAPI schema |
| `POST /api/v1/modules/attendance/sessions` | Open an attendance session for a timetable slot | `slotId` |
| `POST /api/v1/modules/attendance/sessions/close` | Close an attendance session | `sessionId` |
| `GET /api/v1/modules/attendance/sessions/qr` | The QR payload current for this instant. Derived from the session secret and the clock, so poll it at roughly the rotation interval rather than caching it. | See runtime OpenAPI schema |
| `GET /api/v1/modules/attendance/sessions/roster` | The whole cohort for a session, marked and unmarked | See runtime OpenAPI schema |
| `POST /api/v1/modules/attendance/scan` | Mark the calling student present by scanning a rotating code | `qr`, `latitude`, `longitude`, `accuracyM`, `deviceHash`, `deviceLockConfirmed` |
| `POST /api/v1/modules/attendance/override` | Mark a student present manually. The reason is mandatory. | `sessionId`, `studentId`, `reason` |
| `GET /api/v1/modules/attendance/devices` | Devices awaiting approval (admin) | See runtime OpenAPI schema |
| `POST /api/v1/modules/attendance/devices` | Register the calling student’s device; lands pending approval | `deviceHash`, `label` |
| `POST /api/v1/modules/attendance/devices/approve` | Approve a device, revoking whatever that student had active | `deviceId` |
| `POST /api/v1/modules/attendance/geofences` | Set a room’s geofence centre and radius | `roomId`, `latitude`, `longitude`, `radiusM` |
| `GET /api/v1/modules/attendance/me` | The calling student’s own attendance history | See runtime OpenAPI schema |

<a id="care"></a>
## Student Care

Confidential self-checks a student takes for themselves (PHQ-9, GAD-7, and the institution’s own), counselling they ask for, the counsellors’ cases and appointments, and statistics the office sees only as counts.

Module roles: `super_admin`, `institution_admin`, `hod`, `faculty`, `accounts_staff`, `library_staff`, `hostel_staff`, `student`.
Source: `campusos-platform/packages/modules/care/`.

### Screens

| Path | Page | Roles |
|---|---|---|
| `/m/care` | Student care | student |
| `/m/care/check` | Self-check | student |
| `/m/care/result` | Self-check result | student, super_admin, institution_admin, hod, faculty, accounts_staff, library_staff, hostel_staff |
| `/m/care/queue` | Counselling | super_admin, institution_admin, hod, faculty, accounts_staff, library_staff, hostel_staff |
| `/m/care/case` | Counselling case | super_admin, institution_admin, hod, faculty, accounts_staff, library_staff, hostel_staff |
| `/m/care/statistics` | Counselling statistics | super_admin, institution_admin, hod, faculty, accounts_staff, library_staff, hostel_staff |
| `/m/care/settings` | Student care settings | institution_admin, super_admin |

### Operations

| Method and path | Operation | Body fields / query parameters |
|---|---|---|
| `GET /api/v1/modules/care/home` | A student’s own: the checks offered, their results, requests and appointments, the counsellors and the helpline | See runtime OpenAPI schema |
| `GET /api/v1/modules/care/instruments` | The self-checks offered: questions, answers, bands and where each comes from | See runtime OpenAPI schema |
| `GET /api/v1/modules/care/check` | One check, to take | `code` (query) |
| `POST /api/v1/modules/care/checks` | Take a self-check | `code`, `answers` |
| `GET /api/v1/modules/care/result` | One result, for the student who took it or a counsellor it was shared with | `id` (query) |
| `POST /api/v1/modules/care/results/delete` | Delete one of my results; counsellors it was shared with no longer see it | `resultId` |
| `POST /api/v1/modules/care/requests` | Ask to see a counsellor, sharing any of my results | `topic`, `urgency`, `mode`, `preferredTimes`, `message`, `resultIds` |
| `POST /api/v1/modules/care/requests/withdraw` | Withdraw my request; anything booked for it is cancelled | `requestId`, `reason` |
| `POST /api/v1/modules/care/appointments/cancel` | Cancel an appointment, by the student or the counsellor; the other is told | `appointmentId`, `reason` |
| `GET /api/v1/modules/care/queue` | A counsellor’s work: requests waiting, most urgent first; their cases; their appointments | See runtime OpenAPI schema |
| `GET /api/v1/modules/care/case` | One case, for a counsellor | `id` (query) |
| `POST /api/v1/modules/care/requests/accept` | Take a waiting request | `requestId` |
| `POST /api/v1/modules/care/requests/handover` | Hand a case to another counsellor | `requestId`, `counsellorId`, `reason` |
| `POST /api/v1/modules/care/requests/close` | Close a case with its outcome | `requestId`, `outcome`, `note` |
| `POST /api/v1/modules/care/appointments` | Offer the student a time | `requestId`, `startsAt`, `minutes`, `mode`, `place`, `noteToStudent` |
| `POST /api/v1/modules/care/appointments/record` | Record an appointment held or missed, once it has begun | `appointmentId`, `status` |
| `POST /api/v1/modules/care/notes` | Add a note to a case; kept as written | `requestId`, `body` |
| `GET /api/v1/modules/care/statistics` | Counselling statistics, as counts | `period` (query) |
| `GET /api/v1/modules/care/settings` | The helpline, the counselling centre, the counsellors and the checks | See runtime OpenAPI schema |
| `POST /api/v1/modules/care/settings` | Set the helpline, the counselling centre and the time zone | `crisisLine`, `contact`, `timeZone`, `minorBasis`, `minorBasisNote` |
| `POST /api/v1/modules/care/counsellors` | Name a member of staff a counsellor; another administrator makes them active | `userId`, `title` |
| `POST /api/v1/modules/care/counsellors/active` | Make a counsellor inactive, or active (a second administrator’s confirmation) | `userId`, `active` |
| `POST /api/v1/modules/care/instruments` | Write a check of the institution’s own, with its source | `code`, `name`, `about`, `stem`, `source`, `options`, `items`, `bands` |
| `POST /api/v1/modules/care/instruments/retire` | Stop offering one of the institution’s checks | `instrumentId` |

<a id="ceremonies"></a>
## Ceremonies

Convocation: who may graduate, found by the degree audit rather than by a list somebody typed; replies and guests; office holds; check-in on the day; and degree certificates, issued only to a student the audit cleared, revoked with a reason and reissued under a new serial.

Module roles: `super_admin`, `institution_admin`, `hod`, `faculty`, `student`.
Source: `campusos-platform/packages/modules/ceremonies/`.

### Screens

| Path | Page | Roles |
|---|---|---|
| `/m/ceremonies` | Ceremonies | institution_admin, super_admin, hod |
| `/m/ceremonies/ceremony` | Ceremony | institution_admin, super_admin, hod |
| `/m/ceremonies/certificate` | Certificate | institution_admin, super_admin, hod, student |
| `/m/ceremonies/checkin` | Check-in | institution_admin, super_admin, hod, faculty |
| `/m/ceremonies/me` | My graduation | student |

### Operations

| Method and path | Operation | Body fields / query parameters |
|---|---|---|
| `GET /api/v1/modules/ceremonies/ceremonies` | Ceremonies, with how many are on each list, cleared and issued | See runtime OpenAPI schema |
| `POST /api/v1/modules/ceremonies/ceremonies` | Plan a ceremony | `name`, `heldOn`, `venue`, `rsvpClosesOn`, `programIds`, `guestLimit` |
| `POST /api/v1/modules/ceremonies/ceremonies/status` | Move a ceremony forward | `ceremonyId`, `status` |
| `POST /api/v1/modules/ceremonies/ceremonies/eligibility` | Audit everybody graduating at a ceremony | `ceremonyId` |
| `GET /api/v1/modules/ceremonies/candidates` | The list: each student, what the audit found, holds, reply, check-in, certificate | `ceremonyId` (query) |
| `GET /api/v1/modules/ceremonies/holds` | Holds placed at a ceremony, open and cleared | `ceremonyId` (query) |
| `POST /api/v1/modules/ceremonies/holds` | Hold a candidate back, with a reason | `candidateId`, `reason` |
| `POST /api/v1/modules/ceremonies/holds/clear` | Clear a hold, with a reason | `holdId`, `reason` |
| `POST /api/v1/modules/ceremonies/respond` | Reply: attending, or conferred in absentia, and guests | `ceremonyId`, `attendance`, `guests` |
| `POST /api/v1/modules/ceremonies/checkin` | Check a graduand in on the day | `candidateId` |
| `GET /api/v1/modules/ceremonies/me` | A student's ceremonies and certificates | See runtime OpenAPI schema |
| `GET /api/v1/modules/ceremonies/certificates` | Certificates, optionally for one ceremony | See runtime OpenAPI schema |
| `POST /api/v1/modules/ceremonies/certificates/issue` | Issue certificates to cleared candidates | `ceremonyId`, `candidateIds` |
| `POST /api/v1/modules/ceremonies/certificates/revoke` | Revoke a certificate, with a reason | `certificateId`, `reason` |
| `POST /api/v1/modules/ceremonies/certificates/reissue` | Reissue a revoked certificate under a new serial | `certificateId` |
| `GET /api/v1/modules/ceremonies/certificate` | One certificate; a student sees only their own | `certificateId` (query) |
| `GET /api/v1/modules/ceremonies/certificate.pdf` | The certificate to print (binary response) | `certificateId` (query) |
| `GET /api/v1/modules/ceremonies/verify` | Check a certificate by the code printed on it | `code` (query) |

### Background jobs

- `ceremonies.eligibility`: explicitly queued; roles institution_admin, super_admin.

<a id="crm"></a>
## Sales CRM

Leads, opportunities, a sales pipeline and conversion to a finance customer and quotation.

Module roles: `institution_admin`, `super_admin`, `hod`, `faculty`, `accounts_staff`, `library_staff`, `hostel_staff`.
Source: `campusos-platform/packages/modules/crm/`.

### Screens

| Path | Page | Roles |
|---|---|---|
| `/m/crm` | Sales pipeline | institution_admin, super_admin, hod, faculty, accounts_staff, library_staff, hostel_staff |
| `/m/crm/lead` | Lead | institution_admin, super_admin, hod, faculty, accounts_staff, library_staff, hostel_staff |
| `/m/crm/settings` | Sales settings | institution_admin, super_admin, hod, faculty, accounts_staff, library_staff, hostel_staff |
| `/m/crm/report` | Forecast and team report | institution_admin, super_admin, hod, faculty, accounts_staff, library_staff, hostel_staff |

### Operations

| Method and path | Operation | Body fields / query parameters |
|---|---|---|
| `GET /api/v1/modules/crm/settings` | Stages, lost reasons and teams | See runtime OpenAPI schema |
| `GET /api/v1/modules/crm/pipeline` | The pipeline, one page at a time | `q` (query), `sort` (query), `dir` (query), `n` (query), `after` (query), `kind` (query), `status` (query) |
| `GET /api/v1/modules/crm/leads/detail` | Read a lead with its activities | `id` (query) |
| `GET /api/v1/modules/crm/forecast` | Open pipeline by stage and by expected-close month, total and probability-weighted | See runtime OpenAPI schema |
| `GET /api/v1/modules/crm/report` | Team performance: open, won, lost, win rate and why deals were lost | See runtime OpenAPI schema |
| `GET /api/v1/modules/crm/leads/duplicates` | Open leads that share a lead's e-mail, phone or company | See runtime OpenAPI schema |
| `POST /api/v1/modules/crm/stages` | Add a pipeline stage | `name`, `seq`, `probability` |
| `POST /api/v1/modules/crm/stages/update` | Rename, reorder or archive a stage | `stageId`, `name`, `seq`, `archived`, `probability` |
| `POST /api/v1/modules/crm/lost-reasons` | Add a lost reason | `name` |
| `POST /api/v1/modules/crm/lost-reasons/archive` | Archive a lost reason | `reasonId` |
| `POST /api/v1/modules/crm/teams` | Create a sales team | `name`, `managerId` |
| `POST /api/v1/modules/crm/teams/members` | Add a team member | `teamId`, `userId` |
| `POST /api/v1/modules/crm/teams/members/remove` | Remove a team member | `teamId`, `userId` |
| `POST /api/v1/modules/crm/notes` | Add a note to a lead's history | `leadId`, `body` |
| `POST /api/v1/modules/crm/scripts` | Plan the next activity after one kind finishes | `afterKind`, `nextKind`, `afterDays`, `summary` |
| `POST /api/v1/modules/crm/scripts/delete` | Remove a next-activity script | `scriptId` |
| `POST /api/v1/modules/crm/teams/auto-assign` | Switch a team's round-robin assignment on or off | `teamId`, `autoAssign` |
| `POST /api/v1/modules/crm/leads/capture` | Record a lead from outside and give it to the next salesperson | `title`, `company`, `contactName`, `email`, `phone`, `gstin`, `source`, `notes`, `expectedValue`, `expectedClose`, `priority`, `teamId` |
| `POST /api/v1/modules/crm/leads/import` | Import up to 500 leads | `rows`, `csv`, `teamId` |
| `POST /api/v1/modules/crm/leads/merge` | Merge a duplicate lead into another | `keepId`, `mergeId` |
| `POST /api/v1/modules/crm/leads` | Record a lead or an opportunity | `kind`, `title`, `company`, `contactName`, `email`, `phone`, `gstin`, `source`, `notes`, `ownerId`, `itemId`, `expectedValue`, `expectedClose`, `priority` |
| `POST /api/v1/modules/crm/leads/update` | Change an open lead | `company`, `contactName`, `email`, `phone`, `gstin`, `notes`, `itemId`, `expectedValue`, `expectedClose`, `priority`, `title`, `source`, `leadId` |
| `POST /api/v1/modules/crm/leads/qualify` | Qualify a lead as an opportunity | `leadId` |
| `POST /api/v1/modules/crm/leads/stage` | Move an opportunity to a stage | `leadId`, `stageId` |
| `POST /api/v1/modules/crm/leads/assign` | Give a lead to another owner | `leadId`, `ownerId` |
| `POST /api/v1/modules/crm/leads/won` | Mark an opportunity won | `leadId` |
| `POST /api/v1/modules/crm/leads/lost` | Mark a lead lost, with a reason | `leadId`, `reasonId`, `lostNote` |
| `POST /api/v1/modules/crm/leads/reopen` | Reopen a lost or unconverted won opportunity | `leadId` |
| `POST /api/v1/modules/crm/activities` | Schedule a call, meeting or task | `leadId`, `kind`, `summary`, `dueAt`, `remindBefore`, `assigneeId` |
| `POST /api/v1/modules/crm/activities/done` | Complete an activity | `activityId` |
| `POST /api/v1/modules/crm/leads/convert` | Convert a won opportunity to a customer and a draft quotation | `leadId`, `partyId`, `createNew`, `code` |
| `POST /api/v1/modules/crm/leads/erase` | Erase a contact on request (DPDP) | `leadId`, `reason` |

### Background jobs

- `crm.activity-reminders`: explicitly queued; roles institution_admin, accounts_staff, super_admin.

<a id="enrollment"></a>
## Enrollment

Registration windows, prerequisite checking, seat limits and waitlists, and add/drop with a dated event for every change.

Module roles: `super_admin`, `institution_admin`, `hod`, `faculty`, `student`.
Source: `campusos-platform/packages/modules/enrollment/`.

### Screens

| Path | Page | Roles |
|---|---|---|
| `/m/enrollment` | Registration | institution_admin, super_admin, hod, faculty, student |
| `/m/enrollment/roster` | Roster | institution_admin, super_admin, hod, faculty |
| `/m/enrollment/seats` | Seats | institution_admin, super_admin, hod |

### Operations

| Method and path | Operation | Body fields / query parameters |
|---|---|---|
| `POST /api/v1/modules/enrollment/register` | Register a student for an offering, or place them on its waiting list | `studentId`, `offeringId`, `effectiveOn`, `reason` |
| `POST /api/v1/modules/enrollment/drop` | Drop or withdraw from an offering, whichever the term calendar allows | `studentId`, `offeringId`, `effectiveOn`, `reason` |
| `POST /api/v1/modules/enrollment/seats` | Set how many may sit in an offering, and how many may queue | `offeringId`, `capacity`, `waitlistCapacity` |
| `GET /api/v1/modules/enrollment/seats` | Every capped offering, with seats taken and queued | See runtime OpenAPI schema |
| `GET /api/v1/modules/enrollment/roster` | Who is on an offering, with waiting-list places in order | See runtime OpenAPI schema |
| `GET /api/v1/modules/enrollment/registrations` | A student's registrations; the caller's own without a studentId | See runtime OpenAPI schema |
| `GET /api/v1/modules/enrollment/credit-load` | Registered credits for a student in a term, which is what aid eligibility reads | See runtime OpenAPI schema |
| `GET /api/v1/modules/enrollment/events` | Every add and drop in a term, with the date each counts from, for fee proration | See runtime OpenAPI schema |

<a id="examinations"></a>
## Examinations & Grading

Exam scheduling, marks entry with publish-locking, configurable grade scales and transcripts; the examination cycle -- enrolment, admit cards, backlog booking, semester grade reports, sealed question papers -- and statistics.

Module roles: `super_admin`, `institution_admin`, `hod`, `faculty`, `student`.
Source: `campusos-platform/packages/modules/examinations/`.

### Screens

| Path | Page | Roles |
|---|---|---|
| `/m/examinations` | Examinations | institution_admin, super_admin, faculty, hod |
| `/m/examinations/scales` | Grade scales | institution_admin, super_admin |
| `/m/examinations/me` | My results | student |
| `/m/examinations/booking` | Exam booking | student |
| `/m/examinations/cycle` | Examination cycle | institution_admin, super_admin, hod |
| `/m/examinations/paper` | Question paper | institution_admin, super_admin, hod, faculty |
| `/m/examinations/stats` | Exam statistics | institution_admin, super_admin, hod, faculty |
| `/m/examinations/performance` | Performance | institution_admin, super_admin, hod, faculty, student |
| `/m/examinations/import` | Import from CSV | faculty, hod, institution_admin, super_admin |

### Operations

| Method and path | Operation | Body fields / query parameters |
|---|---|---|
| `GET /api/v1/modules/examinations/exams` | Exams scheduled against one offering | See runtime OpenAPI schema |
| `POST /api/v1/modules/examinations/exams` | Schedule an exam against a course offering | `offeringId`, `name`, `kind`, `maxMarks`, `weightPercent`, `scheduledAt`, `timeZone`, `roomId` |
| `POST /api/v1/modules/examinations/exams/publish` | Publish results, locking every mark under this exam | `examId` |
| `POST /api/v1/modules/examinations/exams/unpublish` | Withdraw published results. Admin only, reason mandatory. | `examId`, `reason` |
| `GET /api/v1/modules/examinations/marks` | The marks sheet for one exam, absent students included | See runtime OpenAPI schema |
| `POST /api/v1/modules/examinations/marks` | Enter or amend marks for an unpublished exam | `examId`, `marks` |
| `POST /api/v1/modules/examinations/marks/revise` | Change a published mark. The reason is mandatory and audited. | `examId`, `studentId`, `obtained`, `absent`, `reason` |
| `POST /api/v1/modules/examinations/finalise` | Turn a course’s published marks into the academic record, correcting it where a mark has since been revised | `offeringId`, `reason` |
| `GET /api/v1/modules/examinations/scales` | Grading schemes for this institution | See runtime OpenAPI schema |
| `GET /api/v1/modules/examinations/scales/programs` | Programmes that grade on their own scale rather than the default | See runtime OpenAPI schema |
| `POST /api/v1/modules/examinations/scales/programs` | Point a programme at its own grading scale | `programId`, `schemeId` |
| `POST /api/v1/modules/examinations/scales` | Define a grading scheme: percentage, GPA, or a custom scale | `name`, `kind`, `maxPoints`, `isDefault`, `bands` |
| `GET /api/v1/modules/examinations/transcript` | A student transcript. Students may read only their own. | See runtime OpenAPI schema |
| `GET /api/v1/modules/examinations/transcript/official` | The transcript as the record has it: finalised courses and transfer credit only, nothing provisional | See runtime OpenAPI schema |
| `GET /api/v1/modules/examinations/transcript.pdf` | The same transcript as a PDF (binary response) | See runtime OpenAPI schema |
| `GET /api/v1/modules/examinations/cycle/settings` | How long before an exam its paper opens, and whether a grade report waits for feedback | See runtime OpenAPI schema |
| `POST /api/v1/modules/examinations/cycle/settings` | Set them | `paperReleaseMinutes`, `gradeReportNeedsFeedback` |
| `GET /api/v1/modules/examinations/windows` | Every term's enrolment and backlog windows | See runtime OpenAPI schema |
| `POST /api/v1/modules/examinations/windows` | Open or move a term’s enrolment or backlog window | `termId`, `kind`, `opensAt`, `closesAt`, `timeZone`, `instructions`, `internalFee`, `examFee` |
| `GET /api/v1/modules/examinations/booking` | The signed-in student's term: feedback, enrolment, admit card, backlogs and grade reports | `termId` (query) |
| `POST /api/v1/modules/examinations/enrol` | Enrol for the term’s examinations, confirming one’s details | `termId`, `confirm` |
| `GET /api/v1/modules/examinations/enrolments` | Who is enrolled for a term, and who has classes but is not | `termId` (query) |
| `POST /api/v1/modules/examinations/enrolments/cancel` | Cancel an enrolment, with a reason | `enrolmentId`, `reason` |
| `GET /api/v1/modules/examinations/admit-card.pdf` | The admit card for an enrolment (binary response) | `termId` (query), `studentId` (query) |
| `POST /api/v1/modules/examinations/backlogs` | Book a failed paper to sit again | `termId`, `courseId`, `bookingType` |
| `POST /api/v1/modules/examinations/backlogs/cancel` | Cancel a backlog booking and its fee | `bookingId`, `reason` |
| `GET /api/v1/modules/examinations/backlogs` | Backlog papers booked for a term | `termId` (query) |
| `GET /api/v1/modules/examinations/grade-report.pdf` | A term’s grade report from the official record, with SGPA and CGPA (binary response) | `termId` (query), `studentId` (query) |
| `POST /api/v1/modules/examinations/papers` | Upload a question paper (PDF), sealed until shortly before the exam | `examId`, `paper` |
| `GET /api/v1/modules/examinations/papers` | The sealed question papers for an exam, without their contents | `examId` (query) |
| `GET /api/v1/modules/examinations/paper.pdf` | A question paper, for the examination cell, from its release time (binary response) | `paperId` (query) |
| `GET /api/v1/modules/examinations/stats` | How an exam went: spread, middle, pass rate | `examId` (query) |
| `GET /api/v1/modules/examinations/performance` | One student across every published exam, beside their class | `studentId` (query) |
| `GET /api/v1/modules/examinations/imports` | What this module can import from CSV, with each file’s columns | See runtime OpenAPI schema |
| `GET /api/v1/modules/examinations/imports/template` | A CSV template: the header and one example row (binary response) | `id` (query) |
| `POST /api/v1/modules/examinations/imports/run` | Check a CSV file, or with apply import it: all rows or none | `importId`, `file`, `csv`, `apply` |

<a id="feedback"></a>
## Feedback

Questionnaires the institution writes, opened to students in windows each term: on every class and its teacher, before the mid-semester and at the end, and on facilities and the curriculum. Anonymous by construction; results shown only once enough have answered.

Module roles: `super_admin`, `institution_admin`, `hod`, `faculty`, `student`.
Source: `campusos-platform/packages/modules/feedback/`.

### Screens

| Path | Page | Roles |
|---|---|---|
| `/m/feedback` | Feedback | institution_admin, super_admin, hod |
| `/m/feedback/forms` | Questionnaires | institution_admin, super_admin, hod |
| `/m/feedback/form` | Questionnaire | institution_admin, super_admin, hod |
| `/m/feedback/window` | Window | institution_admin, super_admin, hod |
| `/m/feedback/class` | Class feedback | institution_admin, super_admin, hod, faculty |
| `/m/feedback/results` | Feedback on my classes | faculty |
| `/m/feedback/me` | Give feedback | student |
| `/m/feedback/give` | Give feedback | student |

### Operations

| Method and path | Operation | Body fields / query parameters |
|---|---|---|
| `GET /api/v1/modules/feedback/forms` | Questionnaires, with their questions and windows counted | See runtime OpenAPI schema |
| `POST /api/v1/modules/feedback/forms` | Start a questionnaire | `name`, `audience`, `description`, `scalePoints`, `scaleLow`, `scaleHigh` |
| `GET /api/v1/modules/feedback/form` | A questionnaire, its questions and the windows that used it | `formId` (query) |
| `POST /api/v1/modules/feedback/forms/publish` | Publish a questionnaire | `formId` |
| `POST /api/v1/modules/feedback/forms/retire` | Retire a questionnaire | `formId`, `reason` |
| `POST /api/v1/modules/feedback/questions` | Add a question: a point on the scale, a choice, or a comment | `formId`, `kind`, `prompt`, `section`, `options`, `required` |
| `POST /api/v1/modules/feedback/questions/scale` | Add several scale statements at once, one per line | `formId`, `section`, `prompts` |
| `POST /api/v1/modules/feedback/questions/remove` | Remove questions from a draft questionnaire | `formId`, `questionIds` |
| `GET /api/v1/modules/feedback/windows` | Feedback windows, with how many have given and how many owe | See runtime OpenAPI schema |
| `POST /api/v1/modules/feedback/windows` | Open a questionnaire to a term, between two moments | `formId`, `termId`, `title`, `opensAt`, `closesAt`, `timeZone`, `required`, `minResponses` |
| `GET /api/v1/modules/feedback/window` | A window: progress per class, who still owes, and -- once closed -- the results | `windowId` (query) |
| `POST /api/v1/modules/feedback/windows/publish` | Publish a window | `windowId` |
| `POST /api/v1/modules/feedback/windows/withdraw` | Withdraw a window | `windowId`, `reason` |
| `GET /api/v1/modules/feedback/class` | One class's results in a closed window | `windowId` (query), `offeringId` (query) |
| `GET /api/v1/modules/feedback/results` | The signed-in teacher's classes and how they were seen | See runtime OpenAPI schema |
| `GET /api/v1/modules/feedback/me` | What the signed-in student owes, has given, and missed | See runtime OpenAPI schema |
| `GET /api/v1/modules/feedback/give` | The questionnaire for one class, or for the term | `windowId` (query) |
| `POST /api/v1/modules/feedback/give` | Give feedback | `windowId`, `offeringId`, `answers` |
| `GET /api/v1/modules/feedback/completion` | Whether a student has finished the required feedback for a term | `studentId` (query), `termId` (query) |

<a id="fees"></a>
## Fees & Finance

Fee structures per programme and term, scholarships and waivers, payment recording with manual reconciliation, receipts and defaulter reporting.

Module roles: `super_admin`, `institution_admin`, `accounts_staff`, `hod`, `student`.
Source: `campusos-platform/packages/modules/fees/`.

### Screens

| Path | Page | Roles |
|---|---|---|
| `/m/fees` | Fees | institution_admin, super_admin, accounts_staff |
| `/m/fees/student-charges` | Charges on one student | institution_admin, super_admin, accounts_staff |
| `/m/fees/dues` | Dues | institution_admin, super_admin, accounts_staff, hod |
| `/m/fees/student` | Student ledger | institution_admin, super_admin, accounts_staff, hod |
| `/m/fees/me` | My fees | student |
| `/m/fees/aid` | Aid and refunds | institution_admin, super_admin |
| `/m/fees/transfer` | Pay by bank transfer | student |
| `/m/fees/letter` | Demand letter | student |
| `/m/fees/transfers` | Reported transfers | institution_admin, super_admin, accounts_staff |
| `/m/fees/accounts` | Accounts and letters | institution_admin, super_admin, accounts_staff |

### Operations

| Method and path | Operation | Body fields / query parameters |
|---|---|---|
| `GET /api/v1/modules/fees/bank-accounts` | The institution's accounts fees are paid into | See runtime OpenAPI schema |
| `POST /api/v1/modules/fees/bank-accounts` | Add an account | `label`, `accountName`, `bankName`, `branch`, `accountNumber`, `ifsc` |
| `POST /api/v1/modules/fees/bank-accounts/retire` | Retire an account | `accountId` |
| `POST /api/v1/modules/fees/transfers` | Report an RTGS, NEFT or IMPS transfer (the student who made it) | `termId`, `accountId`, `mode`, `remitterBank`, `remitterBranch`, `remitterIfsc`, `accountHolder`, `contactPhone`, `transferredOn`, `amount`, `utr`, `bankReference` |
| `GET /api/v1/modules/fees/transfers/mine` | The signed-in student's reported transfers | See runtime OpenAPI schema |
| `GET /api/v1/modules/fees/transfers` | Reported transfers, pending first | `status` (query) |
| `POST /api/v1/modules/fees/transfers/verify` | Verify a transfer against the bank statement | `claimId`, `note` |
| `POST /api/v1/modules/fees/transfers/reject` | Reject a reported transfer, with a reason | `claimId`, `reason` |
| `GET /api/v1/modules/fees/letters/settings` | Who signs demand letters, and what they say | See runtime OpenAPI schema |
| `POST /api/v1/modules/fees/letters/settings` | Set them | `signatoryName`, `signatoryTitle`, `opening`, `closing` |
| `POST /api/v1/modules/fees/letters` | Issue a numbered demand letter for a term | `termId`, `studentId`, `addressee`, `purpose` |
| `GET /api/v1/modules/fees/letters` | Demand letters: a student's own, or the office's register | See runtime OpenAPI schema |
| `GET /api/v1/modules/fees/letters/verify` | Confirm a letter by its number | `number` (query) |
| `GET /api/v1/modules/fees/demand-letter.pdf` | A demand letter as a PDF (binary response) | `letterId` (query) |
| `GET /api/v1/modules/fees/charges` | Charges on single students -- a backlog paper, a duplicate admit card -- optionally for one term | See runtime OpenAPI schema |
| `POST /api/v1/modules/fees/charges` | Charge one student, billed on their next invoice | `studentId`, `termId`, `label`, `amount`, `Idempotency-Key` (header) |
| `POST /api/v1/modules/fees/charges/cancel` | Cancel a charge not yet invoiced | `chargeId`, `reason` |
| `GET /api/v1/modules/fees/scholarships` | The scholarships this institution funds and defines | See runtime OpenAPI schema |
| `POST /api/v1/modules/fees/scholarships` | Define a scholarship: who qualifies, and how much | `code`, `name`, `kind`, `basis`, `amountPaise`, `percentBps`, `minCredits`, `minCgpa` |
| `GET /api/v1/modules/fees/aid` | Every live scholarship against one student's term, with the amount and, where not eligible, why not | See runtime OpenAPI schema |
| `POST /api/v1/modules/fees/aid/award` | Award a scholarship, settling the amount and posting it to the ledger | `scholarshipId`, `studentId`, `termId`, `reason` |
| `POST /api/v1/modules/fees/aid/revoke` | Withdraw an award, with a reason and a reversal in the books | `awardId`, `reason` |
| `GET /api/v1/modules/fees/aid/awards` | Awards made in a term | See runtime OpenAPI schema |
| `GET /api/v1/modules/fees/refund-rules` | A term's refund brackets, by the date a drop counts from | See runtime OpenAPI schema |
| `POST /api/v1/modules/fees/refund-rules` | Replace a term's refund brackets as a set | `termId`, `brackets` |
| `GET /api/v1/modules/fees/drops` | Credits already worked out for courses dropped in a term | See runtime OpenAPI schema |
| `POST /api/v1/modules/fees/drops/prorate` | Work a term's drops into credits, once each, and post them | `termId`, `studentId` |
| `GET /api/v1/modules/fees/items` | Charged fee lines, optionally for one term | See runtime OpenAPI schema |
| `POST /api/v1/modules/fees/items` | Define a charge for a programme and term | `programId`, `termId`, `label`, `amount`, `proratable`, `dueOn` |
| `POST /api/v1/modules/fees/waivers` | Grant or revise a scholarship or waiver. Reason mandatory and audited. | `studentId`, `feeItemId`, `amount`, `reason` |
| `POST /api/v1/modules/fees/waivers/revoke` | Withdraw a waiver. Reason mandatory and audited. | `waiverId`, `reason` |
| `POST /api/v1/modules/fees/payments` | Record a payment and issue a receipt number | `studentId`, `termId`, `amount`, `method`, `reference`, `receivedAt`, `notes`, `Idempotency-Key` (header) |
| `POST /api/v1/modules/fees/payments/reconcile` | Confirm a payment against the bank. Reason mandatory and audited. | `paymentId`, `reason` |
| `GET /api/v1/modules/fees/invoices` | What has been issued for a term, and for how much | See runtime OpenAPI schema |
| `POST /api/v1/modules/fees/invoices` | Issue a term's charges and post them to the books | `termId`, `studentId` |
| `POST /api/v1/modules/fees/refunds` | Return money against the payment it came in on | `paymentId`, `amount`, `reason`, `method`, `reference`, `Idempotency-Key` (header) |
| `GET /api/v1/modules/fees/ledger` | One student’s charges, waivers and payments for a term | See runtime OpenAPI schema |
| `GET /api/v1/modules/fees/dues` | Outstanding balances for a term, worst first | See runtime OpenAPI schema |
| `GET /api/v1/modules/fees/receipt.pdf` | A payment receipt as a PDF (binary response) | See runtime OpenAPI schema |

<a id="finance"></a>
## Finance & Books

Double-entry books for the whole institution: ledger, receivables and payables, GST and TDS, bank import and reconciliation, stock with batches and serials, purchasing and selling, fixed assets, funds and grants, and statements.

Module roles: `institution_admin`, `super_admin`, `accounts_staff`, `hod`, `faculty`, `library_staff`, `hostel_staff`.
Source: `campusos-platform/packages/modules/finance/`.

### Screens

| Path | Page | Roles |
|---|---|---|
| `/m/finance` | Accounts | institution_admin, super_admin, accounts_staff |
| `/m/finance/my` | Stores and purchasing | institution_admin, super_admin, accounts_staff, hod, faculty, library_staff, hostel_staff |
| `/m/finance/accounts` | Chart of accounts | institution_admin, super_admin, accounts_staff |
| `/m/finance/settings` | Settings and fiscal years | institution_admin, super_admin, accounts_staff |
| `/m/finance/reports` | Financial reports | institution_admin, super_admin, accounts_staff |
| `/m/finance/reports/trial-balance` | Trial balance | institution_admin, super_admin, accounts_staff |
| `/m/finance/reports/income-expenditure` | Income and expenditure | institution_admin, super_admin, accounts_staff |
| `/m/finance/reports/balance-sheet` | Balance sheet | institution_admin, super_admin, accounts_staff |
| `/m/finance/reports/cash` | Receipts, payments and cash flow | institution_admin, super_admin, accounts_staff |
| `/m/finance/reports/general-ledger` | General ledger | institution_admin, super_admin, accounts_staff |
| `/m/finance/reports/day-book` | Day book | institution_admin, super_admin, accounts_staff |
| `/m/finance/cost-centers` | Cost centres | institution_admin, super_admin, accounts_staff |
| `/m/finance/funds` | Funds and grants | institution_admin, super_admin, accounts_staff |
| `/m/finance/currencies` | Currencies and rates | institution_admin, super_admin, accounts_staff |
| `/m/finance/series` | Document numbering | institution_admin, super_admin |
| `/m/finance/approval-rules` | Approval rules | institution_admin, super_admin |
| `/m/finance/staff` | Jobs in the books | institution_admin, super_admin |
| `/m/finance/uoms` | Units of measure | institution_admin, super_admin, accounts_staff |
| `/m/finance/item-groups` | Item groups | institution_admin, super_admin, accounts_staff |
| `/m/finance/taxes` | Taxes and TDS | institution_admin, super_admin, accounts_staff |
| `/m/finance/segregation` | Segregation of duties | institution_admin, super_admin, accounts_staff |
| `/m/finance/approvals` | Approvals waiting | institution_admin, super_admin, accounts_staff, hod, faculty, library_staff, hostel_staff |
| `/m/finance/parties` | Customers and suppliers | institution_admin, super_admin, accounts_staff |
| `/m/finance/party` | Party account | institution_admin, super_admin, accounts_staff |
| `/m/finance/invoices` | Invoice | institution_admin, super_admin, accounts_staff |
| `/m/finance/invoice/new` | New invoice | institution_admin, super_admin, accounts_staff |
| `/m/finance/invoice` | Invoice | institution_admin, super_admin, accounts_staff |
| `/m/finance/orders` | Order | institution_admin, super_admin, accounts_staff |
| `/m/finance/order/new` | New order | institution_admin, super_admin, accounts_staff |
| `/m/finance/order` | Order | institution_admin, super_admin, accounts_staff |
| `/m/finance/receipts` | Receipt | institution_admin, super_admin, accounts_staff |
| `/m/finance/receipt/new` | New receipt | institution_admin, super_admin, accounts_staff |
| `/m/finance/receipt` | Receipt | institution_admin, super_admin, accounts_staff |
| `/m/finance/recurring` | Recurring invoices | institution_admin, super_admin, accounts_staff |
| `/m/finance/payments` | Payment | institution_admin, super_admin, accounts_staff |
| `/m/finance/payment/new` | New payment | institution_admin, super_admin, accounts_staff |
| `/m/finance/payment` | Payment | institution_admin, super_admin, accounts_staff |
| `/m/finance/vouchers` | Voucher | institution_admin, super_admin, accounts_staff |
| `/m/finance/voucher/new` | New voucher | institution_admin, super_admin, accounts_staff |
| `/m/finance/voucher` | Voucher | institution_admin, super_admin, accounts_staff |
| `/m/finance/items` | Items | institution_admin, super_admin, accounts_staff |
| `/m/finance/item` | Item | institution_admin, super_admin, accounts_staff |
| `/m/finance/warehouses` | Warehouses | institution_admin, super_admin, accounts_staff |
| `/m/finance/batches` | Batches | institution_admin, super_admin, accounts_staff |
| `/m/finance/stock-entries` | Stock entry | institution_admin, super_admin, accounts_staff, hod, faculty, library_staff, hostel_staff |
| `/m/finance/stock-entry/new` | New stock entry | institution_admin, super_admin, accounts_staff, hod, faculty, library_staff, hostel_staff |
| `/m/finance/stock-entry` | Stock entry | institution_admin, super_admin, accounts_staff, hod, faculty, library_staff, hostel_staff |
| `/m/finance/stock/balance` | Stock balance | institution_admin, super_admin, accounts_staff |
| `/m/finance/stock/ledger` | Stock ledger | institution_admin, super_admin, accounts_staff |
| `/m/finance/stock/reorder` | Reorder | institution_admin, super_admin, accounts_staff |
| `/m/finance/stock/expiry` | Expiring batches | institution_admin, super_admin, accounts_staff |
| `/m/finance/stock/serials` | Serial register | institution_admin, super_admin, accounts_staff |
| `/m/finance/stock/against-books` | Stores against books | institution_admin, super_admin, accounts_staff |
| `/m/finance/material-requests` | Material request | institution_admin, super_admin, accounts_staff, hod, faculty, library_staff, hostel_staff |
| `/m/finance/material-request/new` | New material request | institution_admin, super_admin, accounts_staff, hod, faculty, library_staff, hostel_staff |
| `/m/finance/material-request` | Material request | institution_admin, super_admin, accounts_staff, hod, faculty, library_staff, hostel_staff |
| `/m/finance/rfqs` | Requests for quotation | institution_admin, super_admin, accounts_staff |
| `/m/finance/rfq/new` | Request supplier quotations | institution_admin, super_admin, accounts_staff |
| `/m/finance/rfq` | Compare supplier offers | institution_admin, super_admin, accounts_staff |
| `/m/finance/supplier-quotations` | Supplier quotations | institution_admin, super_admin, accounts_staff |
| `/m/finance/supplier-quotation/new` | Supplier quotation | institution_admin, super_admin, accounts_staff |
| `/m/finance/supplier-quotation` | Supplier quotation | institution_admin, super_admin, accounts_staff |
| `/m/finance/commitments` | Purchase commitments | institution_admin, super_admin, accounts_staff |
| `/m/finance/assets` | Asset | institution_admin, super_admin, accounts_staff |
| `/m/finance/asset/new` | New asset | institution_admin, super_admin, accounts_staff |
| `/m/finance/asset` | Asset | institution_admin, super_admin, accounts_staff |
| `/m/finance/asset-categories` | Asset categories | institution_admin, super_admin, accounts_staff |
| `/m/finance/depreciation` | Depreciation | institution_admin, super_admin, accounts_staff |
| `/m/finance/assets/maintenance` | Maintenance due | institution_admin, super_admin, accounts_staff |
| `/m/finance/bank` | Bank accounts | institution_admin, super_admin, accounts_staff |
| `/m/finance/bank-account` | Bank statement | institution_admin, super_admin, accounts_staff |
| `/m/finance/bank-line` | Match statement line | institution_admin, super_admin, accounts_staff |
| `/m/finance/bank-rules` | Bank rules | institution_admin, super_admin, accounts_staff |
| `/m/finance/bank/reconciliation` | Bank reconciliation | institution_admin, super_admin, accounts_staff |
| `/m/finance/reports/aging` | Receivable and payable aging | institution_admin, super_admin, accounts_staff |
| `/m/finance/reports/subledgers` | Sub-ledgers against the books | institution_admin, super_admin, accounts_staff |
| `/m/finance/reports/funds` | Fund balances | institution_admin, super_admin, accounts_staff |
| `/m/finance/reports/fund` | Fund statement | institution_admin, super_admin, accounts_staff |
| `/m/finance/reports/cost-centers` | Income and expenditure by cost centre | institution_admin, super_admin, accounts_staff |
| `/m/finance/reports/gst` | GST and TDS reports | institution_admin, super_admin, accounts_staff |
| `/m/finance/reports/gstr1` | GSTR-1 | institution_admin, super_admin, accounts_staff |
| `/m/finance/reports/gstr3b` | GSTR-3B | institution_admin, super_admin, accounts_staff |
| `/m/finance/reports/cmp08` | CMP-08 working | institution_admin, super_admin, accounts_staff |
| `/m/finance/tds` | TDS returns | institution_admin, super_admin, accounts_staff |
| `/m/finance/gst/2b` | GSTR-2B against the books | institution_admin, super_admin, accounts_staff |
| `/m/finance/reports/hsn` | HSN / SAC summary | institution_admin, super_admin, accounts_staff |
| `/m/finance/reports/register` | Sales and purchase register | institution_admin, super_admin, accounts_staff |
| `/m/finance/reports/tds` | Tax deducted at source | institution_admin, super_admin, accounts_staff |
| `/m/finance/journal` | Journal | institution_admin, super_admin, accounts_staff |
| `/m/finance/periods` | Periods | institution_admin, super_admin |
| `/m/finance/budgets` | Budgets | institution_admin, super_admin |
| `/m/finance/import` | Import from CSV | institution_admin, super_admin, accounts_staff |

### Operations

| Method and path | Operation | Body fields / query parameters |
|---|---|---|
| `GET /api/v1/modules/finance/accounts` | The chart of accounts, as a tree | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/accounts` | Add an account or a group to the chart | `code`, `name`, `type`, `purpose`, `parentCode`, `isGroup`, `subtype`, `currency`, `cashFlow`, `description` |
| `POST /api/v1/modules/finance/accounts/update` | Rename, move or re-purpose an account | `accountId`, `name`, `parentCode`, `subtype`, `purpose`, `cashFlow`, `description` |
| `POST /api/v1/modules/finance/accounts/archive` | Close an account to new postings, or reopen it | `accountId`, `archived` |
| `GET /api/v1/modules/finance/journal` | Posted entries, most recent first | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/journal/lines` | The lines of one entry | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/journal` | Post one balanced entry by hand (administrators; the office uses journal vouchers) | `occurredAt`, `postingDate`, `memo`, `sourceModule`, `sourceRef`, `lines` |
| `POST /api/v1/modules/finance/journal/reverse` | Post the mirror image of an entry | `entryId`, `reason` |
| `GET /api/v1/modules/finance/trial-balance` | Trial balance with opening and closing, as a tree | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/periods` | Accounting months and whether each is open | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/periods/checklist` | What stands between a month and its close | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/periods/close` | Close a month | `year`, `month`, `reason`, `override`, `overrideReason` |
| `POST /api/v1/modules/finance/periods/reopen` | Open a closed month again, with a reason | `year`, `month`, `reason` |
| `GET /api/v1/modules/finance/budgets` | Budget against actual by cost centre for a fiscal year | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/budgets` | Set a cost centre's budget on an account for a year | `year`, `costCenter`, `accountCode`, `amount`, `amountPaise`, `hardLimit`, `note` |
| `GET /api/v1/modules/finance/settings` | The institution's book-keeping settings | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/settings` | Change the settings | `baseCurrency`, `fiscalYearStartMonth`, `timeZone`, `legalName`, `address`, `gstin`, `stateCode`, `pan`, `tan`, `roundInvoices`, `stockValuation`, `allowNegativeStock`, `overReceiptPercent`, `blockExpiredBatches`, `gstScheme`, `gstFiling`, `compositionRate` |
| `GET /api/v1/modules/finance/fiscal-years` | Fiscal years and whether each is closed | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/fiscal-years/close` | Close a fiscal year: carry its result to retained surplus | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/fiscal-years/reopen` | Reopen the latest closed fiscal year, with a reason | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/cost-centers` | Cost centres, as a tree | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/cost-centers` | Add a cost centre | `code`, `name`, `parentCode` |
| `POST /api/v1/modules/finance/cost-centers/archive` | Close or reopen a cost centre | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/funds` | Funds and grants | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/funds` | Add a fund or grant | `code`, `name`, `kind`, `grantor`, `sanctionRef`, `sanctioned`, `startsOn`, `endsOn`, `note` |
| `GET /api/v1/modules/finance/currencies` | Currencies kept, and exchange rates entered | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/currencies` | Add a currency | `code`, `name`, `symbol`, `minorUnits` |
| `POST /api/v1/modules/finance/currencies/rates` | Enter an exchange rate for a day | `currency`, `on`, `rate`, `source` |
| `POST /api/v1/modules/finance/currencies/revalue` | Value open foreign-currency balances at a day's rates (reversed the next day) | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/series` | How each kind of document is numbered | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/series` | Change how a kind of document is numbered | `docType`, `prefix`, `padding` |
| `GET /api/v1/modules/finance/approval-rules` | Who approves which documents, from what amount | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/approval-rules` | Set an approval rule | `docType`, `minAmount`, `approver` |
| `POST /api/v1/modules/finance/approval-rules/remove` | Remove an approval rule | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/approvals/decide` | Approve or refuse a draft as it stands | `docType`, `docId`, `decision`, `note` |
| `GET /api/v1/modules/finance/approvals/pending` | Drafts waiting for an approval this reader may give | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/sod` | Whether single-officer mode is on | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/sod/single-officer` | Turn single-officer mode on or off | `enabled`, `reason` |
| `GET /api/v1/modules/finance/sod/uses` | Acts single-officer mode let through | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/staff` | Staff given jobs in the books: storekeepers, purchasers, approvers | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/staff` | Give a member of staff a job | `userId`, `capability`, `warehouseId` |
| `POST /api/v1/modules/finance/staff/revoke` | Take a job back | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/taxes` | Tax templates and TDS sections | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/taxes` | Add a tax template | `name`, `kind`, `treatment`, `components` |
| `POST /api/v1/modules/finance/taxes/archive` | Retire a tax template | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/tds-sections` | Add a TDS section | `code`, `name`, `ratePercent`, `rateNoPanPercent`, `thresholdSingle`, `thresholdAnnual`, `payableAccountCode` |
| `POST /api/v1/modules/finance/taxes/india-preset` | Load the India starter set: GST accounts and slabs, TDS sections (to be checked) | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/parties` | Customers and suppliers, with what each owes or is owed | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/parties` | Add a customer or supplier | `code`, `name`, `isCustomer`, `isSupplier`, `gstin`, `pan`, `stateCode`, `gstCategory`, `address`, `email`, `phone`, `currency`, `paymentTermsDays`, `creditLimit`, `tdsSectionId`, `msme`, `msmeNumber`, `bankName`, `bankAccount`, `ifsc` |
| `POST /api/v1/modules/finance/parties/update` | Change a party | `code`, `name`, `isCustomer`, `isSupplier`, `gstin`, `pan`, `stateCode`, `gstCategory`, `address`, `email`, `phone`, `currency`, `paymentTermsDays`, `creditLimit`, `tdsSectionId`, `msme`, `msmeNumber`, `bankName`, `bankAccount`, `ifsc`, `partyId` |
| `POST /api/v1/modules/finance/parties/archive` | Archive or restore a party | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/parties/statement` | A party's statement of account | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/parties/apply-advances` | Set a party's advances and credit notes against their open invoices | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/uoms` | Units of measure | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/uoms` | Add a unit of measure | `code`, `name`, `whole` |
| `GET /api/v1/modules/finance/item-groups` | Item groups | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/item-groups` | Add an item group | `name`, `parentId`, `stockAccountId`, `expenseAccountId`, `incomeAccountId`, `taxTemplateId` |
| `GET /api/v1/modules/finance/items` | Items, with what the stores hold of each | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/items` | Add an item | `code`, `name`, `groupId`, `uom`, `nature`, `assetCategoryId`, `hsnSac`, `taxTemplateId`, `expenseAccountId`, `incomeAccountId`, `hasBatch`, `hasSerial`, `valuation`, `reorderLevel`, `reorderQty`, `standardRate`, `description` |
| `POST /api/v1/modules/finance/items/update` | Change an item | `name`, `groupId`, `assetCategoryId`, `hsnSac`, `taxTemplateId`, `expenseAccountId`, `incomeAccountId`, `valuation`, `reorderLevel`, `reorderQty`, `standardRate`, `description`, `itemId` |
| `POST /api/v1/modules/finance/items/archive` | Archive or restore an item | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/warehouses` | Stores, with what each holds | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/warehouses` | Add a store | `code`, `name`, `parentId`, `isGroup`, `stockAccountId`, `costCenter` |
| `POST /api/v1/modules/finance/warehouses/archive` | Archive or restore a store | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/batches` | Batches, with what is left of each | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/batches` | Add a batch | `itemId`, `batchNo`, `madeOn`, `expiresOn` |
| `GET /api/v1/modules/finance/stock-entries` | Stock entries: receipts, issues, transfers and counts | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/stock-entries/detail` | One stock entry with its lines | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/stock-entries` | Save a stock entry (and submit it, if asked) | `stockEntryId`, `kind`, `postingDate`, `memo`, `costCenter`, `fundId`, `accountId`, `materialRequestId`, `lines`, `submit` |
| `POST /api/v1/modules/finance/stock-entries/submit` | Submit a stock entry: move the stock and post its value | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/stock-entries/cancel` | Cancel a stock entry | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/stock-entries/delete` | Delete a draft stock entry | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/stock/balance` | Stock balance by item and store, on a day | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/stock/ledger` | Every movement of stock, with running balances | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/stock/reorder` | Items at or below their reorder level | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/stock/expiry` | Batches expired or expiring soon | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/stock/serials` | Serial numbers and where each is | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/stock/against-books` | Whether the stores and the stock accounts agree | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/invoices` | Sales or purchase invoices, with what is still owed on each | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/invoices/detail` | One invoice: lines, taxes, settlements, posting | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/invoices` | Save an invoice as a draft (and submit it, if asked) | `invoiceId`, `kind`, `partyId`, `postingDate`, `dueDate`, `billNo`, `billDate`, `currency`, `exchangeRate`, `placeOfSupply`, `reverseCharge`, `updateStock`, `warehouseId`, `tdsSectionId`, `costCenter`, `fundId`, `memo`, `terms`, `lines`, `submit` |
| `POST /api/v1/modules/finance/invoices/submit` | Submit an invoice: number it and post it | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/invoices/cancel` | Cancel an invoice | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/invoices/amend` | Copy a cancelled invoice into a new draft | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/invoices/delete` | Delete a draft invoice | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/invoices/return` | Raise a credit note or debit note against an invoice | `invoiceId`, `postingDate`, `lines`, `memo`, `submit` |
| `POST /api/v1/modules/finance/invoices/from-receipt` | Draft an invoice for what a goods receipt or delivery note brought | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/invoices/from-order` | Draft an invoice for what is left to bill on an order | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/invoices/pdf` | The invoice, printed (binary response) | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/recurring` | Recurring invoices | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/recurring` | Repeat an invoice every month, quarter or year | `invoiceId`, `every`, `nextOn`, `endsOn`, `autoSubmit` |
| `POST /api/v1/modules/finance/recurring/stop` | Stop a recurring invoice | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/recurring/run` | Raise every recurring invoice that has fallen due | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/payments` | Receipts, payments and transfers | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/payments/detail` | One payment with what it settled | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/payments/open-invoices` | A party's open invoices, oldest first | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/payments` | Save a payment as a draft (and submit it, if asked) | `paymentId`, `kind`, `partyId`, `side`, `postingDate`, `accountId`, `toAccountId`, `currency`, `exchangeRate`, `amount`, `tds`, `tdsSectionId`, `bankCharges`, `mode`, `instrumentNo`, `instrumentDate`, `reference`, `memo`, `costCenter`, `fundId`, `allocations`, `autoAllocate`, `submit` |
| `POST /api/v1/modules/finance/payments/submit` | Submit a payment | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/payments/cancel` | Cancel a payment | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/payments/amend` | Copy a cancelled payment into a new draft | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/payments/delete` | Delete a draft payment | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/payments/pdf` | The receipt or voucher, printed (binary response) | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/vouchers` | Journal vouchers | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/vouchers/detail` | One journal voucher | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/vouchers` | Save a journal voucher (and submit it, if asked) | `journalId`, `kind`, `postingDate`, `memo`, `reference`, `lines`, `submit` |
| `POST /api/v1/modules/finance/vouchers/submit` | Submit a journal voucher | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/vouchers/cancel` | Cancel a journal voucher | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/vouchers/amend` | Copy a cancelled voucher into a new draft | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/vouchers/delete` | Delete a draft voucher | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/orders` | Quotations, sales orders or purchase orders, with their status | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/orders/detail` | One order with what has been received, delivered and billed | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/orders` | Save an order as a draft (and submit it, if asked) | `orderId`, `kind`, `partyId`, `postingDate`, `deliverBy`, `validTill`, `currency`, `exchangeRate`, `placeOfSupply`, `warehouseId`, `costCenter`, `fundId`, `terms`, `memo`, `lines`, `submit` |
| `POST /api/v1/modules/finance/orders/submit` | Submit an order | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/orders/cancel` | Cancel an order nothing has moved against | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/orders/close` | Close an order short | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/orders/amend` | Copy a cancelled order into a new draft | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/orders/delete` | Delete a draft order | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/orders/from-quotation` | Draft a sales order from a quotation | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/orders/from-supplier-quotation` | Draft a purchase order from a supplier's quotation | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/orders/pdf` | The order, printed (binary response) | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/receipts` | Goods receipts and delivery notes | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/receipts/detail` | One goods receipt or delivery note | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/receipts` | Save a goods receipt or delivery note (and submit it, if asked) | `receiptId`, `kind`, `partyId`, `orderId`, `postingDate`, `challanNo`, `transporter`, `costCenter`, `memo`, `currency`, `exchangeRate`, `lines`, `submit` |
| `POST /api/v1/modules/finance/receipts/submit` | Submit a receipt: move the stock and post its value | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/receipts/cancel` | Cancel a receipt | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/receipts/delete` | Delete a draft receipt | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/receipts/return` | Return goods against a receipt or delivery note | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/receipts/from-order` | Draft a receipt or delivery note for what is left on an order | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/material-requests` | Requests to the stores | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/material-requests/detail` | One request with what has been issued and ordered | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/material-requests` | Ask the stores for something | `requestId`, `purpose`, `costCenter`, `warehouseId`, `requiredBy`, `reason`, `lines`, `submit` |
| `POST /api/v1/modules/finance/material-requests/submit` | Send a request to the stores | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/material-requests/cancel` | Withdraw a request | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/material-requests/issue` | Draft an issue from the stores for a request | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/material-requests/order` | Draft a purchase order for a request | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/rfqs` | Requests for quotation | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/rfqs/compare` | The quotations for a request, side by side | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/rfqs` | Ask suppliers for prices | `rfqId`, `postingDate`, `respondBy`, `terms`, `requestId`, `supplierIds`, `lines`, `submit` |
| `GET /api/v1/modules/finance/supplier-quotations` | Suppliers' quotations | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/supplier-quotations` | Record a supplier's quotation | `quotationId`, `rfqId`, `partyId`, `quotedOn`, `validTill`, `currency`, `terms`, `lines`, `submit` |
| `GET /api/v1/modules/finance/commitments` | Purchase orders not yet billed, by cost centre | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/asset-categories` | Asset categories and how each depreciates | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/asset-categories` | Add an asset category | `name`, `method`, `lifeYears`, `ratePercent`, `residualPercent`, `frequency`, `assetAccountId`, `accumulatedAccountId`, `depreciationAccountId` |
| `GET /api/v1/modules/finance/assets` | The fixed asset register on a day | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/assets/detail` | One asset: its schedule and its history | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/assets` | Save an asset (and capitalise it, if asked) | `assetId`, `name`, `categoryId`, `itemId`, `purchasedOn`, `inUseOn`, `gross`, `existing`, `openingAccumulated`, `depreciateFrom`, `creditAccountId`, `locationId`, `custodianId`, `costCenter`, `fundId`, `warrantyTill`, `insuredTill`, `tagCode`, `note`, `submit` |
| `POST /api/v1/modules/finance/assets/submit` | Capitalise an asset and write its depreciation schedule | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/assets/cancel` | Cancel an asset that has not depreciated or moved | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/assets/delete` | Delete a draft asset | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/assets/events` | Record a transfer, maintenance, count, write-down, sale or scrapping | `assetId`, `kind`, `on`, `toLocationId`, `toCustodianId`, `toCostCenter`, `cost`, `amount`, `vendorId`, `finding`, `nextDueOn`, `note`, `proceedsAccountId` |
| `POST /api/v1/modules/finance/depreciation/run` | Post every period of depreciation that has ended | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/depreciation` | Depreciation for a period, by category | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/assets/maintenance-due` | Maintenance due or overdue | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/bank-accounts` | Bank accounts, with their book balance and unmatched lines | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/bank-accounts` | Add a bank account | `accountId`, `bankName`, `branch`, `ifsc`, `accountNumber`, `currency` |
| `POST /api/v1/modules/finance/bank-accounts/mapping` | Say which column of this bank's downloads is which | `bankAccountId`, `date`, `valueDate`, `description`, `reference`, `withdrawal`, `deposit`, `amount`, `drCr`, `balance`, `dateOrder` |
| `POST /api/v1/modules/finance/bank-statements/import` | Import a statement: CSV, XLSX, MT940 or camt.053 | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/bank-statements/delete` | Remove a statement none of whose lines is matched | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/bank-statements` | Statements imported for a bank account | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/bank-lines` | Statement lines, by status | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/bank-lines/candidates` | The postings a statement line could be | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/bank-lines/match` | Match a statement line to a posting | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/bank-lines/unmatch` | Undo a match | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/bank-lines/ignore` | Set a statement line aside, with a note | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/bank-lines/post` | Post a statement line the books do not have yet, and match it | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/bank/auto-match` | Match every line that can only mean one posting | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/bank-rules` | Rules that post recurring bank lines | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/bank-rules` | Add a bank rule | `bankAccountId`, `contains`, `direction`, `accountId`, `costCenter`, `priority` |
| `POST /api/v1/modules/finance/bank-rules/delete` | Remove a bank rule | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/bank-rules/apply` | Post and match every unmatched line a rule recognises | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/bank/reconciliation` | The bank reconciliation statement on a day | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/reports/trial-balance` | Trial balance with opening and closing, as a tree | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/reports/subledgers` | Each sub-ledger beside its control account | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/gst/filings` | Mark a GST return filed for a period | `returnType`, `periodFrom`, `periodTo`, `filedOn`, `arn` |
| `GET /api/v1/modules/finance/gst/filings` | GST returns marked filed | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/reports/income-expenditure` | Income and expenditure for a period | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/reports/balance-sheet` | The balance sheet on a day | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/reports/cash` | Receipts and payments, and the cash flow statement | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/reports/general-ledger` | An account's ledger for a period | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/reports/day-book` | Every entry in a period | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/reports/aging` | Receivables or payables by age | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/reports/fund-statement` | A fund's statement: received, spent by head, and left | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/reports/funds` | Every fund's balance | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/reports/cost-centers` | Income and expenditure by cost centre | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/reports/gstr1` | GSTR-1 tables for a period | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/tds/challans` | Record a TDS challan against a month of deductions | `form`, `month`, `depositedOn`, `bsrCode`, `challanSerial`, `interest`, `fee`, `accountId` |
| `POST /api/v1/modules/finance/tds/challans/void` | Void a TDS challan | `challanId`, `reason` |
| `GET /api/v1/modules/finance/tds/challans` | TDS challans recorded | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/tds/quarter` | The TDS working statement for a quarter as CSV (fy, quarter, form) (binary response) | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/tds/certificate.pdf` | The TDS statement for one payee and quarter, printed (binary response) | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/tds/deductions` | The deductions of a quarter (fy, quarter, form) | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/tds/interest` | Interest on TDS deposited late | See runtime OpenAPI schema |
| `POST /api/v1/modules/finance/gst/2b` | Import a GSTR-2B JSON file (replaces that month) | `file` |
| `GET /api/v1/modules/finance/gst/2b` | A month of GSTR-2B against the purchase bills | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/gst/2b/returns` | GSTR-2B files imported | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/reports/cmp08` | CMP-08 working for a quarter (composition dealers) | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/reports/gstr3b` | GSTR-3B summary for a period | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/reports/hsn` | HSN/SAC summary | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/reports/register` | Sales or purchase register | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/reports/tds` | Tax deducted at source by section and payee | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/reports/export.csv` | A report as CSV: report=gstr1 (table=b2b\|b2cl\|b2cs\|cdnr\|cdnur\|exports\|sez), hsn, register, tds, aging, trial-balance, general-ledger (binary response) | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/imports` | What this module can import from CSV, with each file’s columns | See runtime OpenAPI schema |
| `GET /api/v1/modules/finance/imports/template` | A CSV template: the header and one example row (binary response) | `id` (query) |
| `POST /api/v1/modules/finance/imports/run` | Check a CSV file, or with apply import it: all rows or none | `importId`, `file`, `csv`, `apply` |

### Background jobs

- `finance.recurring`: daily scheduled; roles institution_admin, accounts_staff, super_admin.
- `finance.depreciation`: daily scheduled; roles institution_admin, accounts_staff, super_admin.

<a id="helpdesk"></a>
## Helpdesk and grievance

Helpdesk and grievance workflows for this institution.

Module roles: `institution_admin`, `super_admin`, `hod`, `faculty`, `student`, `accounts_staff`, `library_staff`, `hostel_staff`.
Source: `campusos-platform/packages/modules/helpdesk/`.

### Screens

| Path | Page | Roles |
|---|---|---|
| `/m/helpdesk` | Helpdesk and grievances | institution_admin, super_admin, hod, faculty, student, accounts_staff, library_staff, hostel_staff |
| `/m/helpdesk/case` | Case discussion | institution_admin, super_admin, hod, faculty, student, accounts_staff, library_staff, hostel_staff |

### Operations

| Method and path | Operation | Body fields / query parameters |
|---|---|---|
| `GET /api/v1/modules/helpdesk/cases` | List accessible cases | See runtime OpenAPI schema |
| `GET /api/v1/modules/helpdesk/cases/detail` | Read an accessible case and messages | `id` (query) |
| `POST /api/v1/modules/helpdesk/cases` | Submit case | `subject`, `description`, `kind`, `confidential` |
| `POST /api/v1/modules/helpdesk/cases/assign` | Assign officer | `caseId`, `assigneeId` |
| `POST /api/v1/modules/helpdesk/cases/messages` | Discuss case | `caseId`, `body` |
| `POST /api/v1/modules/helpdesk/cases/resolve` | Resolve case | `caseId`, `resolution` |
| `POST /api/v1/modules/helpdesk/cases/reopen` | Reopen case | `caseId`, `reason` |

<a id="hostel"></a>
## Hostel

Blocks and rooms, allocation with occupancy limits, nightly roll call, leave records and the visitor register. Uses the Attendance module for scan-based roll call when it is enabled, and a manual register when it is not.

Module roles: `super_admin`, `institution_admin`, `hostel_staff`, `student`.
Source: `campusos-platform/packages/modules/hostel/`.

### Screens

| Path | Page | Roles |
|---|---|---|
| `/m/hostel` | Hostel | institution_admin, super_admin, hostel_staff |
| `/m/hostel/rollcall` | Roll call | institution_admin, super_admin, hostel_staff |
| `/m/hostel/visitors` | Visitors | institution_admin, super_admin, hostel_staff |
| `/m/hostel/me` | My hostel | student |
| `/m/hostel/import` | Import from CSV | hostel_staff, institution_admin, super_admin |

### Operations

| Method and path | Operation | Body fields / query parameters |
|---|---|---|
| `GET /api/v1/modules/hostel/blocks` | Hostel blocks | See runtime OpenAPI schema |
| `POST /api/v1/modules/hostel/blocks` | Create a block | `code`, `name`, `kind`, `wardenUserId` |
| `GET /api/v1/modules/hostel/rooms` | Rooms with their current residents and free beds | See runtime OpenAPI schema |
| `POST /api/v1/modules/hostel/rooms` | Add rooms to a block, a floor at a time | `blockId`, `numbers`, `floor`, `capacity` |
| `POST /api/v1/modules/hostel/allocations` | Allocate a bed | `roomId`, `studentId`, `allocatedOn` |
| `POST /api/v1/modules/hostel/allocations/vacate` | Vacate a bed. Reason mandatory and audited. | `allocationId`, `vacatedOn`, `reason` |
| `POST /api/v1/modules/hostel/leave` | Record approved leave, so an empty bed is expected rather than missing | `studentId`, `fromOn`, `toOn`, `reason` |
| `GET /api/v1/modules/hostel/rollcall` | One block's roll call for a night, with every resident listed | See runtime OpenAPI schema |
| `GET /api/v1/modules/hostel/rollcall/qr` | The rotating code for a gate screen | See runtime OpenAPI schema |
| `POST /api/v1/modules/hostel/rollcall/scan` | A resident scanning in at the gate | `code`, `blockId`, `onNight` |
| `POST /api/v1/modules/hostel/rollcall/mark` | The manual register: a warden ticking names off a list | `blockId`, `studentId`, `onNight`, `status`, `note` |
| `GET /api/v1/modules/hostel/visitors` | The gate register | See runtime OpenAPI schema |
| `POST /api/v1/modules/hostel/visitors` | Sign a visitor in | `blockId`, `studentId`, `name`, `phone`, `relation`, `purpose` |
| `POST /api/v1/modules/hostel/visitors/out` | Sign a visitor out | `visitorId` |
| `GET /api/v1/modules/hostel/me` | Where a student lives, who with, and their recent nights | See runtime OpenAPI schema |
| `GET /api/v1/modules/hostel/imports` | What this module can import from CSV, with each file’s columns | See runtime OpenAPI schema |
| `GET /api/v1/modules/hostel/imports/template` | A CSV template: the header and one example row (binary response) | `id` (query) |
| `POST /api/v1/modules/hostel/imports/run` | Check a CSV file, or with apply import it: all rows or none | `importId`, `file`, `csv`, `apply` |

<a id="hr"></a>
## HR & Payroll

The whole of HR: staff records and their history (onboarding, transfers, promotions, separation and exit interviews), leave policies with allocation, carry-forward, earned and encashed days, shifts and rosters, recruitment from requisition to hire, appraisals with KRAs, goals and colleague feedback, expense claims and advances, and payroll from salary structures with configurable tax and gratuity, posting to the books. Statutory files (ECR, ESI, bank advice, tax statements) and remittance records; no statutory rate is seeded: the institution enters its own.

Module roles: `super_admin`, `institution_admin`, `accounts_staff`, `hod`, `faculty`, `library_staff`, `hostel_staff`.
Source: `campusos-platform/packages/modules/hr/`.

### Screens

| Path | Page | Roles |
|---|---|---|
| `/m/hr` | Human resources | institution_admin, super_admin, accounts_staff |
| `/m/hr/leave` | Leave | institution_admin, super_admin, accounts_staff |
| `/m/hr/payroll` | Payroll | institution_admin, super_admin, accounts_staff |
| `/m/hr/me` | My employment | faculty |
| `/m/hr/onboarding` | Onboarding | institution_admin, super_admin, accounts_staff |
| `/m/hr/lifecycle` | Employment history | institution_admin, super_admin, accounts_staff |
| `/m/hr/leave/policy` | Leave policy | institution_admin, super_admin, accounts_staff |
| `/m/hr/shifts` | Shifts | institution_admin, super_admin, accounts_staff |
| `/m/hr/recruitment` | Recruitment | institution_admin, super_admin, accounts_staff |
| `/m/hr/interviews` | My interviews | faculty, hod, institution_admin, super_admin, accounts_staff |
| `/m/hr/performance` | Performance | institution_admin, super_admin, accounts_staff |
| `/m/hr/appraisal` | Appraisal | faculty, hod, institution_admin, super_admin, accounts_staff |
| `/m/hr/claims` | Claims and advances | faculty, hod, institution_admin, super_admin, accounts_staff |
| `/m/hr/payroll/setup` | Pay setup | institution_admin, super_admin, accounts_staff |
| `/m/hr/payroll/tax` | Tax and statutory details | institution_admin, super_admin |
| `/m/hr/payroll/remit` | Remittances | institution_admin, super_admin |
| `/m/hr/payroll/returns` | Tax returns | institution_admin, super_admin |
| `/m/hr/import` | Import from CSV | institution_admin, super_admin |

### Operations

| Method and path | Operation | Body fields / query parameters |
|---|---|---|
| `GET /api/v1/modules/hr/staff` | Staff on record, with their current monthly gross | See runtime OpenAPI schema |
| `POST /api/v1/modules/hr/staff` | Add a staff record | `employeeCode`, `name`, `designation`, `department`, `employment`, `joinedOn`, `email`, `phone`, `userId` |
| `POST /api/v1/modules/hr/staff/end` | End employment. Reason mandatory and audited. | `staffId`, `leftOn`, `reason` |
| `GET /api/v1/modules/hr/leave` | Leave requests, newest first | See runtime OpenAPI schema |
| `POST /api/v1/modules/hr/leave` | File a leave request | `staffId`, `leaveTypeId`, `fromOn`, `toOn`, `reason` |
| `GET /api/v1/modules/hr/leave/types` | Leave types and their annual entitlements | See runtime OpenAPI schema |
| `POST /api/v1/modules/hr/leave/types` | Define a leave type | `code`, `name`, `annualDays`, `paid`, `allowNegative`, `encashable`, `encashmentComponents`, `maxCarryForward`, `compensatory`, `compOffValidityDays` |
| `POST /api/v1/modules/hr/leave/decide` | Approve or reject a request | `requestId`, `approve`, `note` |
| `POST /api/v1/modules/hr/leave/cancel` | Withdraw leave. Reason mandatory and audited. | `requestId`, `reason` |
| `GET /api/v1/modules/hr/leave/balances` | One person's entitlement, taken and remaining for a year | See runtime OpenAPI schema |
| `GET /api/v1/modules/hr/pay/components` | Pay lines for one person, current and historical | See runtime OpenAPI schema |
| `POST /api/v1/modules/hr/pay/components` | Set a pay line from a date | `staffId`, `code`, `label`, `kind`, `amount`, `effectiveFrom`, `wageClass` |
| `GET /api/v1/modules/hr/payroll` | Payslips, optionally for one month | See runtime OpenAPI schema |
| `POST /api/v1/modules/hr/payroll` | Generate payslips for a month | `period`, `staffId` |
| `GET /api/v1/modules/hr/payroll/paid` | Which months have been paid, and when | See runtime OpenAPI schema |
| `POST /api/v1/modules/hr/payroll/paid` | Pay a month's salaries and clear the liability | `period`, `paidOn`, `paidFrom`, `reference` |
| `GET /api/v1/modules/hr/me` | A staff member’s own record, leave balances and payslips | See runtime OpenAPI schema |
| `GET /api/v1/modules/hr/grades` | Grades, with how many people are on each | See runtime OpenAPI schema |
| `POST /api/v1/modules/hr/grades` | Define a grade | `code`, `name`, `rank`, `minPaise`, `maxPaise` |
| `GET /api/v1/modules/hr/onboarding/templates` | Onboarding checklists and their steps | See runtime OpenAPI schema |
| `POST /api/v1/modules/hr/onboarding/templates` | Define an onboarding checklist | `code`, `name`, `note`, `activities` |
| `GET /api/v1/modules/hr/onboarding` | One person's onboarding, or null | `staffId` (query) |
| `POST /api/v1/modules/hr/onboarding` | Start an onboarding from a checklist | `staffId`, `templateId`, `startedOn` |
| `GET /api/v1/modules/hr/onboarding/open` | Every open onboarding activity, oldest due first | See runtime OpenAPI schema |
| `POST /api/v1/modules/hr/onboarding/complete` | Mark an activity done | `activityId`, `note` |
| `GET /api/v1/modules/hr/changes` | Transfers, promotions, confirmations and separations, newest first | See runtime OpenAPI schema |
| `POST /api/v1/modules/hr/changes` | Record a dated change to somebody’s post | `staffId`, `kind`, `effectiveOn`, `toDesignation`, `toDepartment`, `toGradeId`, `toEmployment`, `reason` |
| `GET /api/v1/modules/hr/separations` | Separations, newest first | See runtime OpenAPI schema |
| `POST /api/v1/modules/hr/separations` | End an employment and record how | `staffId`, `kind`, `lastDayOn`, `noticeGivenOn`, `reason` |
| `GET /api/v1/modules/hr/separations/outstanding` | Separations with no exit interview held | See runtime OpenAPI schema |
| `POST /api/v1/modules/hr/separations/interview` | Record the exit interview | `staffId`, `on`, `notes`, `rehireEligible` |
| `GET /api/v1/modules/hr/service` | Days served, to a date or to the leaving date | `staffId` (query), `on` (query) |
| `GET /api/v1/modules/hr/leave/policies` | Leave policies, their lines, and how many people are on each | See runtime OpenAPI schema |
| `POST /api/v1/modules/hr/leave/policies` | Define a leave policy | `code`, `name`, `prorateJoiners`, `lines` |
| `POST /api/v1/modules/hr/leave/policies/assign` | Put somebody on a policy from a date | `staffId`, `policyId`, `effectiveFrom` |
| `GET /api/v1/modules/hr/leave/allocations` | One person's allocations for a year (staffId, year) | See runtime OpenAPI schema |
| `POST /api/v1/modules/hr/leave/allocations` | Allocate leave by hand, with a reason | `staffId`, `leaveTypeId`, `year`, `days`, `expiresOn`, `reason` |
| `POST /api/v1/modules/hr/leave/allocations/year` | Write down a year's allocations from policy, and carry-forward | `year`, `staffId` |
| `GET /api/v1/modules/hr/leave/comp-off` | Compensatory-leave claims | See runtime OpenAPI schema |
| `POST /api/v1/modules/hr/leave/comp-off` | Claim a worked day off back as leave | `staffId`, `leaveTypeId`, `workedOn`, `days`, `reason` |
| `POST /api/v1/modules/hr/leave/comp-off/decide` | Approve or reject a claim | `requestId`, `approve`, `note` |
| `GET /api/v1/modules/hr/leave/encashments` | Leave payouts | See runtime OpenAPI schema |
| `POST /api/v1/modules/hr/leave/encashments` | Ask to sell unused leave back | `staffId`, `leaveTypeId`, `year`, `days`, `period`, `reason` |
| `POST /api/v1/modules/hr/leave/encashments/decide` | Approve or reject a payout | `requestId`, `approve` |
| `GET /api/v1/modules/hr/shifts/types` | Shift types, with paid hours and whether they cross midnight | See runtime OpenAPI schema |
| `POST /api/v1/modules/hr/shifts/types` | Define a shift type | `code`, `name`, `startsAt`, `endsAt`, `breakMinutes`, `allowance` |
| `POST /api/v1/modules/hr/shifts/assign` | Put somebody on a shift over dates | `staffId`, `shiftTypeId`, `fromOn`, `toOn` |
| `POST /api/v1/modules/hr/shifts/rotate` | A weekly rotation across people and shift types | `staffIds`, `shiftTypeIds`, `fromOn`, `weeks` |
| `GET /api/v1/modules/hr/shifts/roster` | Who is on what, day by day, with approved leave shown through | `from` (query), `to` (query) |
| `GET /api/v1/modules/hr/shifts/coverage` | How many people are on each shift on a day | See runtime OpenAPI schema |
| `GET /api/v1/modules/hr/shifts/requests` | Shift requests | See runtime OpenAPI schema |
| `POST /api/v1/modules/hr/shifts/requests` | Ask to work a different shift for a while | `staffId`, `shiftTypeId`, `fromOn`, `toOn`, `reason` |
| `POST /api/v1/modules/hr/shifts/requests/decide` | Approve or reject a shift request | `requestId`, `approve`, `note` |
| `GET /api/v1/modules/hr/recruitment/requisitions` | Requisitions, with how many have been hired against each | See runtime OpenAPI schema |
| `POST /api/v1/modules/hr/recruitment/requisitions` | Ask for a post | `designation`, `department`, `positions`, `reason`, `expectedBy` |
| `POST /api/v1/modules/hr/recruitment/requisitions/decide` | Approve or reject a requisition | `requisitionId`, `approve`, `note` |
| `GET /api/v1/modules/hr/recruitment/openings` | Openings, each with its pipeline counts | See runtime OpenAPI schema |
| `POST /api/v1/modules/hr/recruitment/openings` | Advertise an approved requisition | `requisitionId`, `title`, `description`, `opensOn`, `closesOn` |
| `POST /api/v1/modules/hr/recruitment/openings/close` | Close an opening | `openingId` |
| `GET /api/v1/modules/hr/recruitment/applicants` | Applicants for an opening | `openingId` (query) |
| `POST /api/v1/modules/hr/recruitment/applicants` | Record an application | `openingId`, `name`, `email`, `phone`, `source`, `notes` |
| `POST /api/v1/modules/hr/recruitment/applicants/move` | Shortlist, reject or withdraw an applicant | `applicantId`, `to`, `note` |
| `GET /api/v1/modules/hr/recruitment/applicants/file` | One applicant: every round, every signed piece of feedback, every offer | `applicantId` (query) |
| `POST /api/v1/modules/hr/recruitment/interviews` | Schedule the next round | `applicantId`, `scheduledAt`, `panel` |
| `POST /api/v1/modules/hr/recruitment/interviews/feedback` | Give feedback on a round you sat on | `interviewId`, `rating`, `recommendation`, `notes` |
| `GET /api/v1/modules/hr/recruitment/interviews/mine` | Rounds you sit on, and whether you still owe feedback | See runtime OpenAPI schema |
| `POST /api/v1/modules/hr/recruitment/offers` | Make an offer | `applicantId`, `designation`, `department`, `employment`, `monthly`, `joiningOn`, `expiresOn` |
| `POST /api/v1/modules/hr/recruitment/offers/respond` | Record the candidate’s answer | `offerId`, `accept` |
| `POST /api/v1/modules/hr/recruitment/offers/withdraw` | Withdraw an offer, with an audited reason | `offerId`, `reason` |
| `POST /api/v1/modules/hr/recruitment/hire` | Turn an accepted offer into a staff record | `offerId`, `employeeCode`, `onboardingTemplateId` |
| `GET /api/v1/modules/hr/performance/cycles` | Review cycles, with how many appraisals stand at each step | See runtime OpenAPI schema |
| `POST /api/v1/modules/hr/performance/cycles` | Create a review cycle | `name`, `startsOn`, `endsOn` |
| `POST /api/v1/modules/hr/performance/cycles/status` | Open or close a cycle | `cycleId`, `status` |
| `GET /api/v1/modules/hr/performance/kras` | Key result areas | See runtime OpenAPI schema |
| `POST /api/v1/modules/hr/performance/kras` | Define a key result area | `code`, `name`, `description` |
| `POST /api/v1/modules/hr/performance/enrol` | Put people into a cycle with a reviewer and weighted KRAs | `cycleId`, `staffIds`, `reviewerId`, `kras` |
| `GET /api/v1/modules/hr/performance/appraisals` | Appraisals in a cycle | `cycleId` (query) |
| `GET /api/v1/modules/hr/performance/appraisal` | One appraisal: KRAs, both sets of ratings, the score, colleague feedback | `appraisalId` (query) |
| `GET /api/v1/modules/hr/performance/mine` | Appraisals where you are appraised or reviewing, and what waits on you | See runtime OpenAPI schema |
| `POST /api/v1/modules/hr/performance/self-review` | Submit your self review | `appraisalId`, `ratings`, `summary` |
| `POST /api/v1/modules/hr/performance/review` | Submit the review, which completes the appraisal | `appraisalId`, `ratings`, `summary` |
| `POST /api/v1/modules/hr/performance/feedback` | Give colleague feedback | `appraisalId`, `relation`, `strengths`, `improvements`, `rating` |
| `GET /api/v1/modules/hr/performance/goals` | Goals | See runtime OpenAPI schema |
| `POST /api/v1/modules/hr/performance/goals` | Set a goal | `staffId`, `title`, `description`, `cycleId`, `kraId`, `targetOn` |
| `POST /api/v1/modules/hr/performance/goals/update` | Record progress on a goal | `goalId`, `progress`, `status` |
| `GET /api/v1/modules/hr/claims` | Expense claims; staff see only their own | See runtime OpenAPI schema |
| `POST /api/v1/modules/hr/claims` | Submit a claim | `staffId`, `title`, `lines` |
| `GET /api/v1/modules/hr/claims/lines` | The lines of a claim, claimed and sanctioned | `claimId` (query) |
| `POST /api/v1/modules/hr/claims/decide` | Approve or reject a claim | `claimId`, `approve`, `sanction`, `note` |
| `POST /api/v1/modules/hr/claims/settle` | Settle an approved claim | `claimId`, `advanceId`, `paidOn`, `paidFrom` |
| `GET /api/v1/modules/hr/advances` | Advances with what has been recovered and what is outstanding | See runtime OpenAPI schema |
| `POST /api/v1/modules/hr/advances` | Ask for an advance | `staffId`, `purpose`, `amount` |
| `POST /api/v1/modules/hr/advances/decide` | Approve or reject an advance | `advanceId`, `approve`, `monthlyRecovery` |
| `POST /api/v1/modules/hr/advances/pay` | Hand an approved advance over | `advanceId`, `paidOn`, `paidFrom` |
| `POST /api/v1/modules/hr/advances/repay` | Record an advance repaid in money | `advanceId`, `amount`, `on`, `into` |
| `GET /api/v1/modules/hr/pay/structures` | Salary structures, their lines, and how many people are on each | See runtime OpenAPI schema |
| `POST /api/v1/modules/hr/pay/structures` | Define a salary structure | `code`, `name`, `lines` |
| `POST /api/v1/modules/hr/pay/structures/assign` | Put somebody on a structure at a base, from a date | `staffId`, `structureId`, `base`, `effectiveFrom` |
| `GET /api/v1/modules/hr/pay/tax` | Income-tax regimes and their slabs | See runtime OpenAPI schema |
| `POST /api/v1/modules/hr/pay/tax` | Enter an income-tax regime | `code`, `name`, `yearStartsMonth`, `standardDeduction`, `cessBp`, `rebateUpTo`, `rebateMax`, `rebateMarginalRelief`, `allowsDeductions`, `surcharges`, `slabs` |
| `POST /api/v1/modules/hr/pay/tax/elect` | Choose a regime for a tax year | `staffId`, `regimeId`, `taxYear` |
| `POST /api/v1/modules/hr/payroll/tax/declarations` | Replace a person's tax declarations for a year | `staffId`, `taxYear`, `rows` |
| `POST /api/v1/modules/hr/payroll/tax/previous` | Record previous employment for a year | `staffId`, `taxYear`, `income`, `tds` |
| `GET /api/v1/modules/hr/pay/gratuity` | Gratuity rules | See runtime OpenAPI schema |
| `POST /api/v1/modules/hr/pay/gratuity` | Enter a gratuity rule | `code`, `name`, `minServiceYears`, `daysPerYear`, `divisorDays`, `wageCodes`, `roundUpMonths`, `max` |
| `GET /api/v1/modules/hr/pay/gratuity/quote` | What a gratuity would come to, with the working | `staffId` (query), `ruleId` (query) |
| `POST /api/v1/modules/hr/pay/gratuity/pay` | Pay gratuity on leaving | `staffId`, `ruleId`, `paidOn`, `paidFrom` |
| `GET /api/v1/modules/hr/pay/gratuity/valuations` | Gratuity provision valuations, with the working | See runtime OpenAPI schema |
| `POST /api/v1/modules/hr/pay/gratuity/valuations` | Value the gratuity provision as at a month end | `asOf`, `method`, `ruleId`, `obligation`, `reference` |
| `GET /api/v1/modules/hr/pay/withheld` | Payslips held back, and whether released | See runtime OpenAPI schema |
| `POST /api/v1/modules/hr/pay/withhold` | Hold back somebody’s salary from a month | `staffId`, `fromPeriod`, `reason` |
| `POST /api/v1/modules/hr/pay/withhold/lift` | Stop holding back future salary | `staffId` |
| `POST /api/v1/modules/hr/pay/withheld/release` | Pay one held-back payslip | `payslipId`, `paidOn`, `paidFrom`, `reason` |
| `GET /api/v1/modules/hr/payroll/payslip.pdf` | A payslip as a PDF: one’s own, or anyone’s for the office (binary response) | `payslipId` (query) |
| `GET /api/v1/modules/hr/payroll/dues` | What each statutory head owes for a month, what was remitted and what is left | `period` (query) |
| `GET /api/v1/modules/hr/payroll/remittances` | Remittances, newest first, voided ones included | `period` (query) |
| `POST /api/v1/modules/hr/payroll/remittances` | Record money paid to a statutory authority | `head`, `period`, `state`, `amount`, `paidOn`, `paidFrom`, `challanRef`, `bsrCode`, `challanSerial`, `note` |
| `POST /api/v1/modules/hr/payroll/reissue` | Reissue a payslip: reverse its books entry and make a new one | `payslipId`, `reason` |
| `POST /api/v1/modules/hr/payroll/remittances/void` | Void a remittance with a reason; its books entry is reversed | `remittanceId`, `reason` |
| `GET /api/v1/modules/hr/payroll/tax-statement.pdf` | A person’s annual tax statement (Form 16 Part B / Form 130) (binary response) | `staffId` (query), `taxYear` (query) |
| `GET /api/v1/modules/hr/payroll/tds-quarter` | The quarterly TDS working statement for the 24Q (binary response) | `taxYear` (query), `quarter` (query) |
| `GET /api/v1/modules/hr/payroll/ecr` | The provident fund ECR text file for a month (binary response) | `period` (query) |
| `GET /api/v1/modules/hr/payroll/esi` | The ESI monthly contribution CSV for a month (binary response) | `period` (query) |
| `GET /api/v1/modules/hr/payroll/bank-advice` | The salary transfer advice CSV for a month (non-withheld payslips) (binary response) | `period` (query) |
| `GET /api/v1/modules/hr/payroll/runs` | Every payroll run: when, by whom, for how much | See runtime OpenAPI schema |
| `GET /api/v1/modules/hr/payroll/settings` | How a part month is paid | See runtime OpenAPI schema |
| `POST /api/v1/modules/hr/payroll/settings` | Set how a part month is paid | `prorationBasis`, `statutoryFrom`, `pfRegistered`, `esiRegistered`, `defaultRegimeId` |
| `GET /api/v1/modules/hr/staff/statutory` | A person's statutory details | `staffId` (query) |
| `POST /api/v1/modules/hr/staff/statutory` | Set a person's statutory details | `staffId`, `pan`, `uan`, `esiNumber`, `bankAccount`, `bankIfsc`, `workState`, `pfMember`, `pfOnActual`, `epsExcluded`, `esiExempt` |
| `GET /api/v1/modules/hr/payroll/pt-slabs` | Professional tax slabs the institution has entered | See runtime OpenAPI schema |
| `POST /api/v1/modules/hr/payroll/pt-slabs` | Set a state's professional tax slabs | `state`, `effectiveFrom`, `slabs` |
| `GET /api/v1/modules/hr/imports` | What this module can import from CSV, with each file’s columns | See runtime OpenAPI schema |
| `GET /api/v1/modules/hr/imports/template` | A CSV template: the header and one example row (binary response) | `id` (query) |
| `POST /api/v1/modules/hr/imports/run` | Check a CSV file, or with apply import it: all rows or none | `importId`, `file`, `csv`, `apply` |

<a id="library"></a>
## Library

Catalogue of titles and physical copies, issue and return at the desk, overdue fines with configurable rules, and a borrowing status view for students.

Module roles: `super_admin`, `institution_admin`, `library_staff`, `hod`, `faculty`, `student`.
Source: `campusos-platform/packages/modules/library/`.

### Screens

| Path | Page | Roles |
|---|---|---|
| `/m/library` | Library desk | institution_admin, super_admin, library_staff |
| `/m/library/catalogue` | Catalogue | institution_admin, super_admin, library_staff, faculty, student |
| `/m/library/overdue` | Overdue | institution_admin, super_admin, library_staff |
| `/m/library/me` | My library | student, faculty |
| `/m/library/import` | Import from CSV | library_staff, institution_admin, super_admin |

### Operations

| Method and path | Operation | Body fields / query parameters |
|---|---|---|
| `GET /api/v1/modules/library/titles` | Search the catalogue by title, author or ISBN | See runtime OpenAPI schema |
| `POST /api/v1/modules/library/titles` | Catalogue a new title | `isbn`, `title`, `author`, `publisher`, `year`, `category` |
| `GET /api/v1/modules/library/copies` | The physical copies of one title, with who holds each | See runtime OpenAPI schema |
| `POST /api/v1/modules/library/copies` | Add copies of a title, one accession number each | `titleId`, `accessionNos`, `shelf`, `replacement` |
| `POST /api/v1/modules/library/copies/status` | Withdraw a copy, write it off as lost, or return it to service | `copyId`, `status`, `reason` |
| `GET /api/v1/modules/library/loans` | Everything currently out, soonest due first | See runtime OpenAPI schema |
| `POST /api/v1/modules/library/loans/issue` | Issue a copy to a borrower | `copyId`, `accessionNo`, `borrowerId` |
| `POST /api/v1/modules/library/loans/return` | Take a copy back and settle the fine | `copyId`, `accessionNo`, `markLost` |
| `POST /api/v1/modules/library/loans/renew` | Extend a loan from its current due date | `loanId` |
| `POST /api/v1/modules/library/fines/waive` | Forgive part or all of a fine. Reason mandatory and audited. | `loanId`, `amount`, `reason` |
| `POST /api/v1/modules/library/fines/settle` | Record a fine paid at the desk | `loanId` |
| `GET /api/v1/modules/library/status` | One borrower's open loans, history, fines and whether they may borrow | See runtime OpenAPI schema |
| `GET /api/v1/modules/library/overdue` | Loans past their due date, longest overdue first | See runtime OpenAPI schema |
| `GET /api/v1/modules/library/settings` | Circulation rules in force, or the built-in defaults | See runtime OpenAPI schema |
| `PUT /api/v1/modules/library/settings` | Set the circulation rules | `loanDays`, `graceDays`, `finePerDay`, `maxConcurrentLoans`, `maxRenewals`, `maxFine`, `blockAtOutstanding` |
| `GET /api/v1/modules/library/imports` | What this module can import from CSV, with each file’s columns | See runtime OpenAPI schema |
| `GET /api/v1/modules/library/imports/template` | A CSV template: the header and one example row (binary response) | `id` (query) |
| `POST /api/v1/modules/library/imports/run` | Check a CSV file, or with apply import it: all rows or none | `importId`, `file`, `csv`, `apply` |

<a id="mentoring"></a>
## Mentoring

A mentor and co-mentor for every student, who see the whole of them -- record, attendance, results, fees, where they live -- keep notes, talk with them, and decide their leave. Approved leave reaches the hostel roll call.

Module roles: `super_admin`, `institution_admin`, `hod`, `faculty`, `student`.
Source: `campusos-platform/packages/modules/mentoring/`.

### Screens

| Path | Page | Roles |
|---|---|---|
| `/m/mentoring` | Mentors | institution_admin, super_admin, hod |
| `/m/mentoring/mentees` | My mentees | faculty, hod |
| `/m/mentoring/mentee` | Mentee | institution_admin, super_admin, hod, faculty |
| `/m/mentoring/leave` | Leave requests | institution_admin, super_admin, hod, faculty |
| `/m/mentoring/me` | My mentor and leave | student |
| `/m/mentoring/import` | Import from CSV | institution_admin, super_admin, hod |

### Operations

| Method and path | Operation | Body fields / query parameters |
|---|---|---|
| `GET /api/v1/modules/mentoring/assignments` | Every student, with their mentor and co-mentor now | See runtime OpenAPI schema |
| `POST /api/v1/modules/mentoring/assign` | Give students a mentor and co-mentor: one, several, or a whole section | `studentIds`, `sectionId`, `mentorId`, `coMentorId`, `reason` |
| `POST /api/v1/modules/mentoring/assignments/end` | End mentoring for students, with a reason | `studentIds`, `reason` |
| `GET /api/v1/modules/mentoring/mentees` | The signed-in teacher's mentees, with low attendance, waiting leave and unread messages | See runtime OpenAPI schema |
| `GET /api/v1/modules/mentoring/mentee` | The whole of a mentee: profile, attendance by class, results, fees, housing, leave, notes and the conversation | `studentId` (query) |
| `POST /api/v1/modules/mentoring/notes` | Write a note about a mentee, private or shared with them | `studentId`, `metOn`, `kind`, `body`, `shared` |
| `POST /api/v1/modules/mentoring/messages` | Write in a student’s thread with their mentors | `studentId`, `body` |
| `GET /api/v1/modules/mentoring/leave-types` | The kinds of leave a student may ask for | See runtime OpenAPI schema |
| `POST /api/v1/modules/mentoring/leave-types` | Add a kind of leave | `name`, `needsDocument`, `maxDays` |
| `POST /api/v1/modules/mentoring/leave-types/retire` | Stop offering a kind of leave | `leaveTypeId` |
| `POST /api/v1/modules/mentoring/leave` | Ask for leave (the student), with a supporting PDF where the kind needs one | `leaveTypeId`, `startsOn`, `endsOn`, `purpose`, `placeOfVisit`, `leavingAt`, `arrivingAt`, `contactPhone`, `document` |
| `GET /api/v1/modules/mentoring/leave/pending` | Leave waiting on the signed-in mentor, or on the office | See runtime OpenAPI schema |
| `POST /api/v1/modules/mentoring/leave/decide` | Approve or refuse a leave application | `applicationId`, `decision`, `note` |
| `POST /api/v1/modules/mentoring/leave/cancel` | Cancel one’s own leave before going | `applicationId`, `reason` |
| `GET /api/v1/modules/mentoring/leave/document.pdf` | The supporting document of a leave application (binary response) | `applicationId` (query) |
| `GET /api/v1/modules/mentoring/me` | The signed-in student's mentors, conversation, shared notes and leave | See runtime OpenAPI schema |
| `GET /api/v1/modules/mentoring/imports` | What this module can import from CSV, with each file’s columns | See runtime OpenAPI schema |
| `GET /api/v1/modules/mentoring/imports/template` | A CSV template: the header and one example row (binary response) | `id` (query) |
| `POST /api/v1/modules/mentoring/imports/run` | Check a CSV file, or with apply import it: all rows or none | `importId`, `file`, `csv`, `apply` |

<a id="notices"></a>
## Communication & Notices

Notice board and circulars scoped by role and department, plus the in-app notification centre every other module writes into, with per-person preferences and institution-mandatory categories.

Module roles: `super_admin`, `institution_admin`, `hod`, `faculty`, `accounts_staff`, `library_staff`, `hostel_staff`, `student`, `parent`.
Source: `campusos-platform/packages/modules/notices/`.

### Screens

| Path | Page | Roles |
|---|---|---|
| `/m/notices` | Notices | super_admin, institution_admin, hod, faculty, accounts_staff, library_staff, hostel_staff, student, parent |
| `/m/notices/notice` | Notice | super_admin, institution_admin, hod, faculty, accounts_staff, library_staff, hostel_staff, student, parent |
| `/m/notices/inbox` | Inbox | super_admin, institution_admin, hod, faculty, accounts_staff, library_staff, hostel_staff, student, parent |
| `/m/notices/preferences` | Notification settings | super_admin, institution_admin, hod, faculty, accounts_staff, library_staff, hostel_staff, student, parent |

### Operations

| Method and path | Operation | Body fields / query parameters |
|---|---|---|
| `GET /api/v1/modules/notices/board` | The notice board as this reader sees it | See runtime OpenAPI schema |
| `POST /api/v1/modules/notices/board` | Write a notice, published straight away or left as a draft | `title`, `body`, `kind`, `audienceRoles`, `departmentId`, `expiresAt`, `pinned`, `publish`, `attachment` |
| `POST /api/v1/modules/notices/board/publish` | Publish a draft and deliver it | `noticeId`, `queued` |
| `POST /api/v1/modules/notices/board/withdraw` | Take a notice down. Reason mandatory and audited. | `noticeId`, `reason` |
| `GET /api/v1/modules/notices/board/notice` | One notice, whole: its text and the documents that go with it | `id` (query) |
| `POST /api/v1/modules/notices/board/attachments` | Attach a document to a draft: PDF, PNG or JPEG, five at most | `noticeId`, `file` |
| `POST /api/v1/modules/notices/board/attachments/remove` | Take a document off a draft | `attachmentId` |
| `GET /api/v1/modules/notices/board/attachment` | A document on a notice, for whoever may read the notice (binary response) | `id` (query) |
| `GET /api/v1/modules/notices/inbox` | This user’s notification centre | See runtime OpenAPI schema |
| `POST /api/v1/modules/notices/inbox` | Mark one notification read, or the whole inbox | `notificationId` |
| `GET /api/v1/modules/notices/preferences` | Your notification categories | See runtime OpenAPI schema |
| `POST /api/v1/modules/notices/preferences` | Mute or unmute a category for yourself | `moduleId`, `muted` |
| `POST /api/v1/modules/notices/preferences/mandatory` | Make a category mandatory, or optional again | `moduleId`, `mandatory`, `reason` |

### Background jobs

- `notices.publish`: explicitly queued; roles institution_admin, super_admin, hod, faculty, accounts_staff, library_staff, hostel_staff.

<a id="parents"></a>
## Parent Portal

A read-only lens for parents across whichever modules an institution has enabled: attendance, results, fees, library and hostel. Owns the verified parent-student link and which child a guardian invitation is for; every figure it shows is read through the owning module.

Module roles: `super_admin`, `institution_admin`, `parent`, `student`.
Source: `campusos-platform/packages/modules/parents/`.

### Screens

| Path | Page | Roles |
|---|---|---|
| `/m/parents` | My children | parent |
| `/m/parents/access` | Who can see my record | student |
| `/m/parents/links` | Parent links | institution_admin, super_admin |
| `/m/parents/guardians` | Guardians | institution_admin, super_admin |

### Operations

| Method and path | Operation | Body fields / query parameters |
|---|---|---|
| `GET /api/v1/modules/parents/links` | Parent-student links, optionally only those awaiting a decision | See runtime OpenAPI schema |
| `POST /api/v1/modules/parents/links` | Claim a link to a student | `studentId`, `relation`, `parentId` |
| `POST /api/v1/modules/parents/links/decide` | Verify or refuse a claimed link. Reason mandatory and audited. | `linkId`, `approve`, `reason` |
| `POST /api/v1/modules/parents/links/revoke` | Withdraw a verified link. Reason mandatory and audited. | `linkId`, `approve`, `reason` |
| `POST /api/v1/modules/parents/consents` | A parent or guardian gives, refuses or withdraws a consent for a child under 18. Audited. | `studentId`, `purpose`, `decision` |
| `POST /api/v1/modules/parents/links/adult` | A student aged 18 or over keeps or ends a guardian’s access. Audited. | `linkId`, `keep` |
| `GET /api/v1/modules/parents/guardians` | Guardian invitations: open, accepted, expired or withdrawn, and for which children | See runtime OpenAPI schema |
| `POST /api/v1/modules/parents/guardians/invite` | Invite a guardian, at their own address, for a child | `email`, `studentId`, `relation`, `days` |
| `POST /api/v1/modules/parents/guardians/withdraw` | Withdraw a guardian invitation, and the access it gave | `invitationId`, `reason` |
| `GET /api/v1/modules/parents/children` | This parent’s claims, verified or not | See runtime OpenAPI schema |
| `GET /api/v1/modules/parents/child` | One child, across whichever modules the institution has enabled | See runtime OpenAPI schema |

<a id="placement"></a>
## Placement

Employer drives, academic eligibility, student applications, selection rounds and audited offers.

Module roles: `institution_admin`, `super_admin`, `hod`, `faculty`, `student`.
Source: `campusos-platform/packages/modules/placement/`.

### Screens

| Path | Page | Roles |
|---|---|---|
| `/m/placement` | Placement workspace | institution_admin, super_admin, hod, faculty, student |
| `/m/placement/companies` | Companies | institution_admin, super_admin, faculty, hod |
| `/m/placement/drives` | Recruitment drives | institution_admin, super_admin, hod, faculty, student |
| `/m/placement/applications` | Applications | institution_admin, super_admin, hod, faculty, student |
| `/m/placement/offers` | Offers | institution_admin, super_admin, hod, faculty, student |
| `/m/placement/statistics` | Placement statistics | institution_admin, super_admin, faculty, hod |
| `/m/placement/officers` | Placement officers | institution_admin, super_admin |
| `/m/placement/import` | Import from CSV | institution_admin, super_admin, faculty, hod |

### Operations

| Method and path | Operation | Body fields / query parameters |
|---|---|---|
| `GET /api/v1/modules/placement/workspace` | Placement workspace scoped to the reader | See runtime OpenAPI schema |
| `GET /api/v1/modules/placement/statistics` | Institution placement statistics for appointed officers | See runtime OpenAPI schema |
| `POST /api/v1/modules/placement/officers` | Appoint or revoke an institutional placement officer | `userId`, `active` |
| `POST /api/v1/modules/placement/companies` | Add an employer | `name`, `website` |
| `POST /api/v1/modules/placement/drives` | Draft a recruitment drive with academic eligibility | `companyId`, `programId`, `title`, `closesAt`, `minCgpa`, `maxBacklogs` |
| `POST /api/v1/modules/placement/drives/state` | Open or close a drive | `driveId`, `status` |
| `POST /api/v1/modules/placement/apply` | Apply as the signed-in eligible student | `driveId` |
| `POST /api/v1/modules/placement/withdraw` | Withdraw the signed-in student application | `applicationId` |
| `POST /api/v1/modules/placement/rounds` | Add the next selection round | `driveId`, `name` |
| `POST /api/v1/modules/placement/results` | Record a selection result without overwriting prior decisions | `applicationId`, `roundId`, `outcome`, `note` |
| `POST /api/v1/modules/placement/offers` | Issue an offer after all selection rounds and live eligibility checks | `applicationId`, `annualPaise` |
| `POST /api/v1/modules/placement/offers/respond` | Accept or decline the signed-in student offer | `offerId`, `decision` |
| `GET /api/v1/modules/placement/imports` | What this module can import from CSV, with each file’s columns | See runtime OpenAPI schema |
| `GET /api/v1/modules/placement/imports/template` | A CSV template: the header and one example row (binary response) | `id` (query) |
| `POST /api/v1/modules/placement/imports/run` | Check a CSV file, or with apply import it: all rows or none | `importId`, `file`, `csv`, `apply` |

<a id="projects"></a>
## Projects and timesheets

Projects with stages, milestones and tasks. Staff log time against tasks; the project manager approves it; the accounts office bills approved time through the books once and costs it to the project's cost centre; profitability is read from the ledger.

Module roles: `institution_admin`, `super_admin`, `hod`, `faculty`, `accounts_staff`, `library_staff`, `hostel_staff`.
Source: `campusos-platform/packages/modules/projects/`.

### Screens

| Path | Page | Roles |
|---|---|---|
| `/m/projects` | Projects | institution_admin, super_admin, hod, faculty, accounts_staff, library_staff, hostel_staff |
| `/m/projects/project` | Project | institution_admin, super_admin, hod, faculty, accounts_staff, library_staff, hostel_staff |
| `/m/projects/task` | Task | institution_admin, super_admin, hod, faculty, accounts_staff, library_staff, hostel_staff |
| `/m/projects/timesheets` | Timesheets | institution_admin, super_admin, hod, faculty, accounts_staff, library_staff, hostel_staff |
| `/m/projects/money` | Billing and costs | institution_admin, super_admin, accounts_staff |
| `/m/projects/profitability` | Project profitability | institution_admin, super_admin, accounts_staff |

### Operations

| Method and path | Operation | Body fields / query parameters |
|---|---|---|
| `GET /api/v1/modules/projects/projects` | List the projects you can see | `q` (query), `sort` (query), `dir` (query), `n` (query), `after` (query), `status` (query) |
| `GET /api/v1/modules/projects/projects/detail` | Read a project with its members, stages and milestones | `id` (query) |
| `POST /api/v1/modules/projects/projects` | Create a project on a cost centre | `code`, `name`, `description`, `managerId`, `costCenter`, `startsOn`, `endsOn`, `billable`, `partyId`, `billingRate`, `taxTemplateId`, `fundId` |
| `POST /api/v1/modules/projects/projects/update` | Change a project's details | `name`, `description`, `managerId`, `endsOn`, `billable`, `partyId`, `billingRate`, `taxTemplateId`, `fundId`, `projectId` |
| `POST /api/v1/modules/projects/projects/status` | Close or reopen a project | `projectId`, `status` |
| `POST /api/v1/modules/projects/members` | Add a member to a project | `projectId`, `userId` |
| `POST /api/v1/modules/projects/members/remove` | Remove a member from a project | `projectId`, `userId` |
| `POST /api/v1/modules/projects/stages` | Add a stage to a project | `projectId`, `name`, `seq`, `closes` |
| `POST /api/v1/modules/projects/milestones` | Add a milestone | `projectId`, `name`, `dueOn` |
| `POST /api/v1/modules/projects/milestones/reached` | Mark a milestone reached | `milestoneId` |
| `GET /api/v1/modules/projects/tasks` | List a project's tasks | `q` (query), `sort` (query), `dir` (query), `n` (query), `after` (query), `projectId` (query) |
| `POST /api/v1/modules/projects/tasks` | Add a task | `projectId`, `title`, `description`, `stageId`, `assigneeId`, `deadline`, `milestoneId` |
| `POST /api/v1/modules/projects/tasks/update` | Change a task | `title`, `description`, `stageId`, `assigneeId`, `deadline`, `milestoneId`, `taskId` |
| `GET /api/v1/modules/projects/timesheets` | List time you can see | `q` (query), `sort` (query), `dir` (query), `n` (query), `after` (query), `projectId` (query), `taskId` (query), `userId` (query), `status` (query), `queue` (query) |
| `POST /api/v1/modules/projects/timesheets` | Log time against a task | `taskId`, `userId`, `workDate`, `minutes`, `description` |
| `POST /api/v1/modules/projects/timesheets/update` | Change time not yet approved | `lineId`, `workDate`, `minutes`, `description` |
| `POST /api/v1/modules/projects/timesheets/delete` | Delete time not yet approved | `lineId` |
| `POST /api/v1/modules/projects/timesheets/decide` | Approve or reject time | `ids`, `decision`, `note` |
| `POST /api/v1/modules/projects/timesheets/reopen` | Reopen approved time that is neither billed nor costed | `lineId`, `reason` |
| `GET /api/v1/modules/projects/cost-rates` | List hourly cost rates | `q` (query), `sort` (query), `dir` (query), `n` (query), `after` (query), `userId` (query) |
| `POST /api/v1/modules/projects/cost-rates` | Set a person's hourly cost from a day | `userId`, `effectiveFrom`, `hourlyCost`, `homeCostCenter` |
| `GET /api/v1/modules/projects/billings` | List billings | `q` (query), `sort` (query), `dir` (query), `n` (query), `after` (query), `projectId` (query) |
| `POST /api/v1/modules/projects/billings` | Bill a project's approved time, once per idempotency key | `projectId`, `through`, `Idempotency-Key` (header) |
| `GET /api/v1/modules/projects/costings` | List costings | `q` (query), `sort` (query), `dir` (query), `n` (query), `after` (query), `projectId` (query), `open` (query) |
| `POST /api/v1/modules/projects/costings` | Cost a project's approved time for a month, once per idempotency key | `projectId`, `period`, `Idempotency-Key` (header) |
| `POST /api/v1/modules/projects/costings/reverse` | Reverse a costing | `costingId`, `reason` |
| `GET /api/v1/modules/projects/profitability` | Project income, expense and margin from the books | `q` (query), `sort` (query), `dir` (query), `n` (query), `after` (query), `from` (query), `to` (query) |

<a id="quizzes"></a>
## Quizzes

A question bank per course; quizzes set from it for a class, with a window, a time limit and attempts; answers scored by the machine the moment they are submitted, with item analysis for the teacher. Practice and feedback, kept apart from grades: nothing here writes a mark.

Module roles: `super_admin`, `institution_admin`, `hod`, `faculty`, `student`.
Source: `campusos-platform/packages/modules/quizzes/`.

### Screens

| Path | Page | Roles |
|---|---|---|
| `/m/quizzes` | Quizzes | institution_admin, super_admin, hod, faculty |
| `/m/quizzes/bank` | Question bank | institution_admin, super_admin, hod, faculty |
| `/m/quizzes/question` | Question | institution_admin, super_admin, hod, faculty |
| `/m/quizzes/quiz` | Quiz | institution_admin, super_admin, hod, faculty |
| `/m/quizzes/result` | Attempt | institution_admin, super_admin, hod, faculty, student |
| `/m/quizzes/me` | My quizzes | student |
| `/m/quizzes/take` | Quiz | student |

### Operations

| Method and path | Operation | Body fields / query parameters |
|---|---|---|
| `GET /api/v1/modules/quizzes/courses` | Courses whose bank this teacher may write in | See runtime OpenAPI schema |
| `GET /api/v1/modules/quizzes/questions` | A course's question bank, with each key | `courseId` (query) |
| `POST /api/v1/modules/quizzes/questions` | Add a question to a course bank | `courseId`, `kind`, `prompt`, `options`, `answer`, `accepted`, `numericAnswer`, `tolerance`, `partialCredit`, `points`, `topic`, `explanation` |
| `POST /api/v1/modules/quizzes/questions/revise` | Correct a question | `questionId`, `kind`, `prompt`, `options`, `answer`, `accepted`, `numericAnswer`, `tolerance`, `partialCredit`, `points`, `topic`, `explanation` |
| `POST /api/v1/modules/quizzes/questions/retire` | Retire a question from the bank | `questionId` |
| `GET /api/v1/modules/quizzes/question` | One question: its key, its revisions, and the quizzes that used it | `questionId` (query) |
| `GET /api/v1/modules/quizzes/quizzes` | Quizzes on the classes this teacher sees | See runtime OpenAPI schema |
| `POST /api/v1/modules/quizzes/quizzes` | Set a draft quiz for a class | `offeringId`, `title`, `instructions`, `opensAt`, `closesAt`, `timeZone`, `timeLimitMinutes`, `attemptsAllowed`, `keep`, `penaltyPercent`, `reveal`, `shuffle` |
| `POST /api/v1/modules/quizzes/quizzes/update` | Change a draft quiz | `quizId`, `title`, `instructions`, `opensAt`, `closesAt`, `timeZone`, `timeLimitMinutes`, `attemptsAllowed`, `keep`, `penaltyPercent`, `reveal`, `shuffle` |
| `GET /api/v1/modules/quizzes/quiz` | A quiz: its questions, results, item analysis and extensions | `quizId` (query) |
| `POST /api/v1/modules/quizzes/quizzes/items` | Put bank questions on a draft quiz | `quizId`, `questionIds`, `points` |
| `POST /api/v1/modules/quizzes/quizzes/items/remove` | Take questions off a draft quiz | `quizId`, `itemIds` |
| `POST /api/v1/modules/quizzes/quizzes/publish` | Publish a quiz | `quizId` |
| `POST /api/v1/modules/quizzes/quizzes/withdraw` | Withdraw a published quiz, with a reason | `quizId`, `reason` |
| `POST /api/v1/modules/quizzes/quizzes/revise` | Revise a withdrawn quiz into a new draft | `quizId` |
| `POST /api/v1/modules/quizzes/quizzes/extensions` | More time for one student | `quizId`, `studentId`, `closesAt`, `extraMinutes`, `reason` |
| `GET /api/v1/modules/quizzes/me` | A student's quizzes: open, in progress, done, and what each scored | See runtime OpenAPI schema |
| `POST /api/v1/modules/quizzes/attempts/start` | Start an attempt, or carry on with the one open | `quizId` |
| `POST /api/v1/modules/quizzes/attempts/answers` | Save answers, and submit when finished | `attemptId`, `answers`, `finish` |
| `POST /api/v1/modules/quizzes/attempts/submit` | Submit an attempt to be scored | `attemptId` |
| `GET /api/v1/modules/quizzes/attempt` | One attempt | `attemptId` (query) |
| `POST /api/v1/modules/quizzes/responses/override` | Change the machine's mark on one answer, with a reason | `responseId`, `awarded`, `reason` |

### Background jobs

- `quizzes.finalise-expired`: explicitly queued; roles institution_admin, accounts_staff, super_admin.

<a id="skills"></a>
## Skills

What students can do, judged against a scale the institution writes: by the student themselves and by their teachers, with the evidence, as a history that shows a skill growing. Kept apart from grades; depends on no other module.

Module roles: `super_admin`, `institution_admin`, `hod`, `faculty`, `student`.
Source: `campusos-platform/packages/modules/skills/`.

### Screens

| Path | Page | Roles |
|---|---|---|
| `/m/skills` | Skills | institution_admin, super_admin, hod, faculty |
| `/m/skills/framework` | Framework | institution_admin, super_admin, hod, faculty |
| `/m/skills/students` | Students | institution_admin, super_admin, hod, faculty |
| `/m/skills/student` | Student skills | institution_admin, super_admin, hod, faculty |
| `/m/skills/me` | My skills | student |

### Operations

| Method and path | Operation | Body fields / query parameters |
|---|---|---|
| `GET /api/v1/modules/skills/frameworks` | Skill frameworks, with how many skills and students each has | See runtime OpenAPI schema |
| `POST /api/v1/modules/skills/frameworks` | Define a framework and its scale | `name`, `description`, `levels` |
| `GET /api/v1/modules/skills/framework` | A framework: its scale and its skills | `frameworkId` (query) |
| `POST /api/v1/modules/skills/levels` | Add a level to the top of a scale | `frameworkId`, `name`, `descriptor` |
| `POST /api/v1/modules/skills/skills` | Add a skill to a framework | `frameworkId`, `code`, `name`, `category`, `description` |
| `POST /api/v1/modules/skills/skills/retire` | Retire skills | `skillIds` |
| `GET /api/v1/modules/skills/students` | Students, with how often each has been judged | See runtime OpenAPI schema |
| `GET /api/v1/modules/skills/profile` | A student's skills: the latest judgement from each side, the gap, and the history | `studentId` (query) |
| `GET /api/v1/modules/skills/me` | The signed-in student’s own skills profile | See runtime OpenAPI schema |
| `POST /api/v1/modules/skills/assess` | Record a teacher's judgement of a student's skill | `studentId`, `skillId`, `rank`, `evidence`, `assessedOn` |
| `POST /api/v1/modules/skills/self-assess` | Record a student's judgement of their own skill | `skillId`, `rank`, `evidence` |
| `GET /api/v1/modules/skills/coverage` | Per skill: students judged, and the average level each side gives | See runtime OpenAPI schema |

<a id="timetable"></a>
## Timetable

Builds the whole week locally: who teaches each class (by course, programme and year, with preferences) and when and where every period meets, around pins, unavailability and labs, with each cohort’s and each teacher’s timetable to read and print.

Module roles: `super_admin`, `institution_admin`, `hod`, `faculty`.
Source: `campusos-platform/packages/modules/timetable/`.

### Screens

| Path | Page | Roles |
|---|---|---|
| `/m/timetable` | Timetable | institution_admin, super_admin, hod |
| `/m/timetable/week` | Periods | institution_admin, super_admin, hod |
| `/m/timetable/rooms` | Rooms | institution_admin, super_admin |
| `/m/timetable/cohorts` | Cohorts and batches | institution_admin, super_admin |
| `/m/timetable/teachers` | Teachers | institution_admin, super_admin |
| `/m/timetable/eligibility` | Who may teach what | institution_admin, super_admin, hod, faculty |
| `/m/timetable/unavailable` | Unavailable | institution_admin, super_admin, hod, faculty |
| `/m/timetable/classes` | Classes and needs | institution_admin, super_admin, hod |
| `/m/timetable/runs` | Drafts | institution_admin, super_admin, hod |
| `/m/timetable/run` | Draft timetable | institution_admin, super_admin, hod |
| `/m/timetable/live` | Live timetable | institution_admin, super_admin, hod, faculty |
| `/m/timetable/my` | My timetable | faculty, hod |

### Operations

| Method and path | Operation | Body fields / query parameters |
|---|---|---|
| `GET /api/v1/modules/timetable/settings` | Teachers’ default limits, when the year turns over, how long the solver may think | See runtime OpenAPI schema |
| `POST /api/v1/modules/timetable/settings` | Change the defaults | `maxPerDay`, `maxPerWeek`, `maxConsecutive`, `yearStartsMonth`, `timeLimitSeconds` |
| `GET /api/v1/modules/timetable/periods` | The week's teaching periods: a term's own, or the standing week | See runtime OpenAPI schema |
| `POST /api/v1/modules/timetable/periods/generate` | Lay out days of periods in one go: first start, length, how many, breaks | `termId`, `days`, `startsAt`, `minutes`, `count`, `breaks` |
| `POST /api/v1/modules/timetable/periods` | Add one period | `termId`, `dayOfWeek`, `index`, `startsAt`, `endsAt`, `label` |
| `POST /api/v1/modules/timetable/periods/delete` | Remove a period | See runtime OpenAPI schema |
| `GET /api/v1/modules/timetable/rooms` | Rooms with their kind and whether the solver may use them | See runtime OpenAPI schema |
| `POST /api/v1/modules/timetable/rooms` | Set a room's kind -- classroom, lab, hall -- or take it out of timetabling | `roomId`, `kind`, `available` |
| `GET /api/v1/modules/timetable/sections` | Cohorts with their planned size and the section each batch is part of | See runtime OpenAPI schema |
| `POST /api/v1/modules/timetable/sections` | Set a cohort's planned size, or make it a batch of another section | `sectionId`, `expectedSize`, `parentSectionId` |
| `GET /api/v1/modules/timetable/teachers` | Teachers with their limits and how much they are eligible for | See runtime OpenAPI schema |
| `POST /api/v1/modules/timetable/teachers` | Set a teacher's own limits: periods a day, a week, in a row | `userId`, `maxPerDay`, `maxPerWeek`, `maxConsecutive`, `note` |
| `GET /api/v1/modules/timetable/eligibility` | Who may teach what -- by course, department, programme and year -- with preferences | See runtime OpenAPI schema |
| `POST /api/v1/modules/timetable/eligibility` | Say a teacher may teach something, and how keen they are | `userId`, `courseId`, `departmentId`, `programId`, `yearOfStudy`, `preference` |
| `POST /api/v1/modules/timetable/eligibility/delete` | Remove an eligibility | See runtime OpenAPI schema |
| `POST /api/v1/modules/timetable/eligibility/import` | Import eligibility from CSV: email, course, department, programme, year, preference | See runtime OpenAPI schema |
| `GET /api/v1/modules/timetable/unavailable` | When teachers, rooms or cohorts cannot be booked | See runtime OpenAPI schema |
| `POST /api/v1/modules/timetable/unavailable` | Mark a teacher, room or cohort unavailable for a day or a period (a teacher marks only themselves) | `userId`, `roomId`, `sectionId`, `dayOfWeek`, `period`, `reason` |
| `POST /api/v1/modules/timetable/unavailable/delete` | Remove an unavailability | See runtime OpenAPI schema |
| `GET /api/v1/modules/timetable/needs` | A term's classes with their weekly needs and how many teachers may take each | See runtime OpenAPI schema |
| `POST /api/v1/modules/timetable/needs` | Set a class's weekly need of one kind: lecture periods, lab blocks | `offeringId`, `kind`, `periodsPerWeek`, `blockLength`, `roomKind`, `roomId` |
| `POST /api/v1/modules/timetable/needs/delete` | Remove a need | See runtime OpenAPI schema |
| `POST /api/v1/modules/timetable/needs/defaults` | Give every class without a need one from its credits | `termId`, `periodsPerCredit`, `kind`, `roomKind` |
| `GET /api/v1/modules/timetable/pins` | What the office has pinned for a term's classes | See runtime OpenAPI schema |
| `POST /api/v1/modules/timetable/pins` | Pin a class's teacher, or a block's time and room | `offeringId`, `needKind`, `facultyUserId`, `dayOfWeek`, `period`, `roomId`, `note` |
| `POST /api/v1/modules/timetable/pins/delete` | Remove a pin | See runtime OpenAPI schema |
| `GET /api/v1/modules/timetable/check` | Whether a term is ready to timetable, and what will not fit | See runtime OpenAPI schema |
| `POST /api/v1/modules/timetable/runs` | Draft a timetable for a term with the local solver (nothing live changes) | `termId`, `seed`, `iterations`, `keepTeachers`, `keepLive` |
| `GET /api/v1/modules/timetable/runs` | Drafts and applied timetables, newest first | See runtime OpenAPI schema |
| `GET /api/v1/modules/timetable/runs/detail` | One draft: what it placed, what it could not and why, teacher changes | See runtime OpenAPI schema |
| `GET /api/v1/modules/timetable/runs/grid` | A draft seen through a cohort, a teacher or a room (sectionId, teacherId or roomId), or its index | See runtime OpenAPI schema |
| `GET /api/v1/modules/timetable/runs/workload` | Each teacher's load in a draft, against their limits | See runtime OpenAPI schema |
| `POST /api/v1/modules/timetable/runs/apply` | Make a draft the live timetable: slots replaced and teachers assigned in one go | See runtime OpenAPI schema |
| `POST /api/v1/modules/timetable/runs/discard` | Discard a draft | See runtime OpenAPI schema |
| `POST /api/v1/modules/timetable/runs/cancel` | Stop a timetable being drafted | See runtime OpenAPI schema |
| `POST /api/v1/modules/timetable/runs/pin` | Keep one of a draft's meetings -- time, teacher or both -- for the next run | `entryId`, `keep` |
| `GET /api/v1/modules/timetable/runs/pdf` | A draft printed: one cohort, teacher or room, or every one (all=sections\|teachers\|rooms) (binary response) | See runtime OpenAPI schema |
| `GET /api/v1/modules/timetable/live` | The live timetable seen through a cohort, a teacher or a room (a teacher sees their own) | See runtime OpenAPI schema |
| `GET /api/v1/modules/timetable/live/workload` | Each teacher's load in the live timetable | See runtime OpenAPI schema |
| `GET /api/v1/modules/timetable/live/pdf` | The live timetable printed: one cohort, teacher or room, or every one (all=sections\|teachers\|rooms) (binary response) | See runtime OpenAPI schema |
| `GET /api/v1/modules/timetable/my` | The signed-in teacher's own week | See runtime OpenAPI schema |
| `GET /api/v1/modules/timetable/my/pdf` | The signed-in teacher's own week, printed (binary response) | See runtime OpenAPI schema |

<a id="transport"></a>
## Transport

Transport workflows for this institution.

Module roles: `institution_admin`, `super_admin`, `hod`, `faculty`, `student`, `accounts_staff`, `library_staff`, `hostel_staff`.
Source: `campusos-platform/packages/modules/transport/`.

### Screens

| Path | Page | Roles |
|---|---|---|
| `/m/transport` | Transport assignments | institution_admin, super_admin, hod, faculty, student, accounts_staff, library_staff, hostel_staff |
| `/m/transport/routes` | Routes and stops | institution_admin, super_admin |
| `/m/transport/vehicles` | Transport vehicles | institution_admin, super_admin |
| `/m/transport/import` | Import from CSV | institution_admin, super_admin |

### Operations

| Method and path | Operation | Body fields / query parameters |
|---|---|---|
| `GET /api/v1/modules/transport/vehicles` | List vehicles | See runtime OpenAPI schema |
| `GET /api/v1/modules/transport/routes` | List routes | See runtime OpenAPI schema |
| `GET /api/v1/modules/transport/stops` | List stops | See runtime OpenAPI schema |
| `GET /api/v1/modules/transport/assignments` | List permitted assignments | See runtime OpenAPI schema |
| `POST /api/v1/modules/transport/vehicles` | Register vehicle | `registration`, `capacity` |
| `POST /api/v1/modules/transport/routes` | Add route | `name`, `vehicleId` |
| `POST /api/v1/modules/transport/stops` | Add stop | `routeId`, `name`, `position` |
| `POST /api/v1/modules/transport/assignments` | Allocate student seat | `routeId`, `stopId`, `studentId` |
| `POST /api/v1/modules/transport/assignments/release` | Release student seat | `assignmentId`, `reason` |
| `GET /api/v1/modules/transport/imports` | What this module can import from CSV, with each file’s columns | See runtime OpenAPI schema |
| `GET /api/v1/modules/transport/imports/template` | A CSV template: the header and one example row (binary response) | `id` (query) |
| `POST /api/v1/modules/transport/imports/run` | Check a CSV file, or with apply import it: all rows or none | `importId`, `file`, `csv`, `apply` |

