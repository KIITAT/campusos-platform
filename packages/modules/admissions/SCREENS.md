# Admissions screens

Implemented through the standard CampusOS plugin renderer; no custom host route is required. Both pages are office-only and use live institution-scoped options rather than raw IDs.

| Page | Implemented workflow |
| --- | --- |
| `/m/admissions` | Enquiry register; record applicant contact and enquiry notes; applications shortcut. |
| `/m/admissions/applications` | Application register; enquiry/programme/intake selection, with the applicant's own name, email, date of birth and category when not the enquirer's; offer/reject/withdraw with reason; "Accept and enrol" an offered application into a section, creating the student account (or linking an existing one), the roll number and, when Fees is on, the term's invoice. |

Academic programmes/terms and student identities must exist first. Only students with a current, non-erased identity appear for acceptance. Applications in terminal states are not offered as decision or acceptance choices. APIs independently enforce roles and states.
