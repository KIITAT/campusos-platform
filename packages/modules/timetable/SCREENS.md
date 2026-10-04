# Timetable screens: build spec

This is the hand-off for the screens of the `timetable` module. The engine
is done: **41 routes**, a local solver, and tests:
- `solver.test.ts`: 7 tests, pure;
- `timetable.test.ts`: 4 tests, against the database.

The screens are not built. `pages.ts` exports an empty list, and
`manifest.navEntries` is empty.

The page vocabulary, the host's form posting, GET filter forms and the table
options are the same as finance. Read §0 of
`packages/modules/finance/SCREENS.md`, and `kit.ts` there for helpers, before
building.

**How to pick it up**

1. Write `screens/*.ts` and export `pages` from `pages.ts`.
2. Add `navEntries`: Timetable (office) and My timetable (faculty).
3. Typecheck, then run `pnpm test` in this package.

## 0. Rules for this module

**Roles** (`api/core.ts`):

| Group | Who | May |
|---|---|---|
| OFFICE | `institution_admin`, `super_admin` | build everything |
| READERS | OFFICE + `hod` | read everything |
| Teachers | `faculty` | read their own live week and PDF; list and add or remove their own unavailability; read their own eligibility |

**URL scheme.** The engine's `next` already uses these:
- `/m/timetable/run?id=` for a draft;
- `/m/timetable/runs?termId=` for the list of drafts;
- `/m/timetable/live?termId=` for the live timetable.

**Term.** Most pages take `?termId=`. Default it to the current term.
Academic `GET /api/v1/modules/academic/structure` lists the terms (`terms[].isCurrent`).

**Days.** ISO weekday: 1 = Monday … 7 = Sunday. Periods are numbered from 1
within a day.

**Grids.** `runGrid`, `liveGrid` and `myTimetable` return
`grid: { title, subtitle, days:[{day,label}], rows:[{period, time, d1..d7}], meetings[] }`.
Render it as a table:
- columns: `period`, `time`, then one per `days[i]` with key `d<day>`;
- `fixedOrder: true`;
- each cell is already-formatted text, such as `CS201 · Dr Rao · R101`.

## 1. Pages

| Path | Title | Roles | Load | Sections and forms |
|---|---|---|---|---|
| `/` | Timetable | READERS | `GET /check?termId=`, `GET /runs?termId=` | figures: periods per week, classes with needs/classes, teaching asked for vs capacity; a `note` per `problems[]` (`stop` is danger, `warn` is warn); shortcuts to every page below; a **Draft a timetable** form (§2) |
| `/week` | Periods | OFFICE (read: READERS) | `GET /periods?termId=` (`own` says whether the term has its own week) | table: day (name), period, starts, ends, label; **Lay out days** form posting to `POST /periods/generate`; **Add period** posting to `POST /periods` `{termId?, dayOfWeek, index, startsAt, endsAt, label?}`; a delete per row posting to `POST /periods/delete` `{periodId}` |
| `/rooms` | Rooms | OFFICE | `GET /rooms` | table: code, building, capacity, kind, available; form posting to `POST /rooms` `{roomId (select), kind, available}` |
| `/cohorts` | Cohorts and batches | OFFICE | `GET /sections` | table: name, members, expected size, size used, part of (`parent`); form posting to `POST /sections` `{sectionId, expectedSize?, parentSectionId?}`. Note: "A1 part of A means A's lectures never overlap A1's labs; A1 and A2 may run side by side" |
| `/teachers` | Teachers | OFFICE | `GET /teachers`, `GET /settings` | table: name, role, max per day/week/in a row (`effective.*`; own values marked), eligibility rows; form posting to `POST /teachers` `{userId, maxPerDay?, maxPerWeek?, maxConsecutive?, note?}`; **Defaults** form posting to `POST /settings` |
| `/eligibility` | Who may teach what | OFFICE (faculty: own, read-only) | `GET /eligibility?userId=&courseId=` | GET filter (teacher, course); table: teacher, course, department, programme, year, preference; **Add** form posting to `POST /eligibility` (§2); **Import CSV** form posting to `POST /eligibility/import` `{file}` (`accept: .csv`); a delete per row posting to `POST /eligibility/delete` `{id}` |
| `/unavailable` | Unavailable | OFFICE; faculty see and add their own | `GET /unavailable?userId=` | table: who (teacher, room or cohort), day, period (blank = whole day), reason; form posting to `POST /unavailable` (§2); a delete per row posting to `POST /unavailable/delete` `{id}` |
| `/classes` | Classes and needs | OFFICE (read: READERS) | `GET /needs?termId=`, `GET /pins?termId=` | table: course, section, year, size, teacher, candidates (alert at 0), `summary`, periods per week; forms: **Set need** posting to `POST /needs` (§2), **Needs from credits** posting to `POST /needs/defaults` `{termId, periodsPerCredit, kind, roomKind}`, delete need posting to `POST /needs/delete` `{needId}`; pins table and **Pin** form posting to `POST /pins` (§2), unpin posting to `POST /pins/delete` `{pinId}` |
| `/runs` | Drafts | READERS | `GET /runs?termId=` | table: created (`when`), by, status (badge), placed/blocks, unplacedBlocks (alert > 0), issues, score, seconds; row link `/run?id={id}` |
| `/run?id=` | Draft | READERS | `GET /runs/detail?runId=`, `GET /runs/grid?runId=&sectionId=\|teacherId=\|roomId=`, `GET /runs/workload?runId=` | see §3 |
| `/live` | Live timetable | READERS (faculty: own) | `GET /live?termId=&sectionId=\|teacherId=\|roomId=`, `GET /live/workload?termId=` | as the draft's grid section: lens picker, grid, workload; PDF links to `/api/v1/modules/timetable/live/pdf?...` (one, or `all=sections\|teachers\|rooms`) |
| `/my` | My timetable | `faculty`, `hod` | `GET /my` | grid; link to `/api/v1/modules/timetable/my/pdf`; link to `/unavailable` to mark when they cannot teach |

## 2. Forms (fields map to the route's schema)

| Form | Route | Fields |
|---|---|---|
| Lay out days | `POST /periods/generate` | `termId` (blank = standing week); `days` (`checkboxes`, 1–7); `startsAt` (`09:00`); `minutes`; `count`; `breaks` (text, `"2:10, 4:40"` = 10 min after period 2, 40 after 4). It replaces only the days named |
| Add eligibility | `POST /eligibility` | `userId` (select teachers); at least one of `courseId`, `departmentId`, `programId`, `yearOfStudy` (1–10); `preference` 1–5 (radio, default 3) |
| Import CSV | `POST /eligibility/import` | `file`. Columns: `email, course code, department code, programme code, year, preference`; header optional; any bad row writes nothing (`400 bad_rows`, the message lists up to 5 lines) |
| Unavailable | `POST /unavailable` | exactly one of `userId`, `roomId`, `sectionId` (faculty: none, it is them); `dayOfWeek`; `period` (blank = whole day); `reason` |
| Set need | `POST /needs` | `offeringId`; `kind` (lecture, lab, tutorial…); `periodsPerWeek`; `blockLength` (2 or 3 for a lab; `periodsPerWeek` must divide by it); `roomKind` (matches a room's kind; blank = classroom); `roomId` (a fixed room, optional). Upserts by (class, kind) |
| Pin | `POST /pins` | `offeringId`; `facultyUserId` (pins the teacher; replaces any other teacher pin); `dayOfWeek` + `period` (pins one block's start; needs a need); `needKind`; `roomId` (only with a time); `note` |
| Draft a timetable | `POST /runs` | `termId`; `seed` (optional: same seed and same data give the same timetable); `iterations` (optional, ≤ 300000; default 150 × blocks; the time limit comes from settings); `keepTeachers` (checkbox, default on: classes keep the teachers they have); `keepLive` (checkbox: keep live meetings, timetable around them). The answer's `next` goes to the draft |

## 3. The draft page `/run?id=`

**Record.** Title "Draft timetable, {term.name}". Status `run.status`
(draft gray, applied green, superseded and discarded gray). Fields: seed,
created, blocks/placed, seconds, cost (`run.cost.total`).

**Sections:**
1. **Notes:**
   - one danger note per `unplaced[]`: `{class} — {count} block(s): {reason}`;
   - one warn note per `issues[]`: `{class}: {message}`. The codes are
     `no_eligible_teacher`, `teachers_full` and `pin_refused`.
2. **Teacher changes** table (`teacherChanges`): class, from, to. These are
   what apply will change.
3. **Lens picker.** `links` built from the grid answer's `index.sections`,
   `index.teachers` and `index.rooms`. Each `{id, name, meetings, hours}`
   links to `?id=&sectionId=` (or `teacherId=`, `roomId=`).
4. **The grid** (§0), and under it **Keep this meeting**: a select of
   `grid.meetings` (each carries `entryId`), with a form posting to
   `POST /runs/pin` `{entryId, keep: time|teacher|both}`.
5. **Workload** table (`GET /runs/workload`):
   - columns: teacher, periods, classes, d1..d6, busiest day vs max per day
     (alert when equal), utilisation %;
   - `unstaffed` as a figure.
6. **Actions:**
   - **Apply** (OFFICE, draft only) posts to `POST /runs/apply` `{runId}`.
     The answer goes to `/live`.
   - **Discard** posts to `POST /runs/discard`.
   - **Print** links to `/api/v1/modules/timetable/runs/pdf?runId=&all=sections`
     (also `teachers` and `rooms`, or one lens).

**Refusals to expect:**

| Error | Meaning |
|---|---|
| `409 not_a_draft` | the run was already applied or discarded |
| `409 slot_has_history` | a meeting with attendance or a class change would be removed; draft again (the new draft locks it) |
| `409 clash` / `academic_slots_room_no_overlap` | something was timetabled by hand since the draft; draft again |
| `409 no_periods` / `nothing_to_place` | from **Draft** |

## 4. What the engine guarantees (for the help text)

**Hard rules.** A draft never breaks these:
- a teacher, room or cohort is in one place at a time;
- cohorts that share students, or a batch and its section, never overlap;
- only eligible or pinned teachers teach;
- unavailability is respected;
- the room's kind and seats fit the class;
- multi-period blocks stay inside a day, between breaks;
- teachers stay within their per-day limit; their per-week limit holds when
  teachers are assigned;
- pins and meetings with history stay put.

**Soft rules.** Preference, spreading a class over days, few idle periods,
consecutive limits and an even load are weighed against each other.

**What does not fit** is reported with a reason. It is never forced in.
