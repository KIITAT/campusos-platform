# Documents screens

| Page | Implemented workflow |
| --- | --- |
| `/m/documents` | The documents the reader may open, newest first, each with its signing state and integrity check; administrators upload a document. The title opens the document in the same page. |
| `/m/documents?documentId=…` | The selected document: integrity, kind, signing state and retention; download the original; verify the file or a copy by digest; administrators request assent or cancel a pending request; the named signer asks for a confirmation code, records assent or declines; the signed record downloads as a separate evidence PDF. |

An unavailable or unauthorized ID shows only "Document unavailable." When an integrity check fails, the page shows the failure and no download or action. Forms follow the reader's authority and the request's state; each endpoint rechecks both under the request lock. The confirmation-code form posts to the host's mail route rather than to a module route.
