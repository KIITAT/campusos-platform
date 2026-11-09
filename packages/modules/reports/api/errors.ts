/** A refusal the page can show; shaped like PluginError (status and code), decision 500. */
export class ReportsError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, readonly code: string, message: string) { super(message) }
}

export const notPermitted = () => new ReportsError(403, 'not_permitted', 'You cannot do this in reports.')
export const notAViewer = () => new ReportsError(403, 'not_a_viewer', 'This report is not shared with your role.')
export const reportNotFound = () => new ReportsError(404, 'report_not_found', 'No such report.')
export const runNotFound = () => new ReportsError(404, 'run_not_found', 'No such run.')
export const reportArchived = () => new ReportsError(409, 'report_archived', 'This report is archived.')
export const datasetUnavailable = () => new ReportsError(409, 'dataset_unavailable', 'That dataset is not available here: its module is not enabled or no longer provides it.')
export const badReport = (message: string) => new ReportsError(400, 'bad_report', message)
export const reportStale = (message: string) => new ReportsError(409, 'report_stale', message)
export const reportTimeout = () => new ReportsError(409, 'report_timeout', 'The report took longer than 25 seconds. Add a filter or group the rows.')
export const exportTooLarge = () => new ReportsError(409, 'export_too_large', 'More than 200,000 rows: add a filter to export this report.')
