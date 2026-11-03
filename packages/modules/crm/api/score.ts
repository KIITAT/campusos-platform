/**
 * A lead's score, 0 to 100: how complete it is, how good its source is, how far
 * down the pipeline it sits and how much has been done on it. A rule, not a model
 * (Odoo's is predictive; ours is explainable and needs no training data).
 */
export interface Scorable {
  email?: string | null; phone?: string | null; company?: string | null; contactName?: string | null; gstin?: string | null
  expectedValuePaise?: number | null; expectedClose?: string | null; source: string; kind: string; stageProbability?: number | null; priority?: number
}
const SOURCE_POINTS: Record<string, number> = { referral: 15, existing_customer: 15, event: 8, website: 8, cold_call: 3, other: 0 }
export function leadScore(lead: Scorable, doneActivities = 0): number {
  let n = 10
  if (lead.email) n += 10
  if (lead.phone) n += 10
  if (lead.company) n += 5
  if (lead.contactName) n += 5
  if (lead.gstin) n += 10
  if (lead.expectedValuePaise) n += 10
  if (lead.expectedClose) n += 5
  n += SOURCE_POINTS[lead.source] ?? 0
  if (lead.kind === 'opportunity') n += 10
  n += Math.round((lead.stageProbability ?? 0) / 5)
  n += Math.min(doneActivities, 3) * 5
  n += (lead.priority ?? 0) * 2
  return Math.min(100, n)
}
