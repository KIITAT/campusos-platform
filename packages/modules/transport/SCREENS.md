# Transport screens

| Page | Access | Implemented workflow |
| --- | --- | --- |
| `/m/transport` | Institution members | Own assignments; administrators see all assignments and can allocate/release a seat. |
| `/m/transport/routes` | Administrators | Route/stop registers; choose an unassigned vehicle; add an ordered stop to a route. |
| `/m/transport/vehicles` | Administrators | Vehicle register and capacity setup. |

Assignments use live student, route and labelled stop choices. Stops identify their route in the selector; the API rejects a stop from another route. Release choices include active assignments only. The host's existing role-gated navigation and entitlement checks apply; API authority is checked again independently.
