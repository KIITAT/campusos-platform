# Helpdesk screens

| Page | Implemented workflow |
| --- | --- |
| `/m/helpdesk` | Accessible-case register; open helpdesk issue or grievance; subject opens the discussion. |
| `/m/helpdesk/case?id=…` | Description, status, privacy label, discussion and resolution; staff assignment; participant messages; authorized resolve/reopen actions. |

The detail page does not appear as an empty navigation destination. Without a case ID it links back to the register. Unauthorized IDs do not expose content. Assignee choices include current non-erased staff only. Forms follow both current actor authority and case state; endpoints independently recheck those rules under a row lock.
