/**
 * Delivery channels beyond the in-app inbox.
 *
 * The inbox is the product; email is a copy of it. So this is deliberately
 * small: one function, no queue, no retry table, no provider abstraction with a
 * single implementation. If no provider is configured it reports that it sent
 * nothing, and the notification is still in the inbox where it belongs.
 *
 * `ponytail:` fire-and-forget, at most one attempt. A transient provider outage
 * loses the email copy, never the notification. If email becomes load-bearing,
 * the upgrade is an outbox row plus a retry sweep -- not a queue service.
 */

export interface Mail {
  to: string
  subject: string
  text: string
}

export interface MailResult {
  sent: number
  /** Why nothing went out, when nothing did. Never a thrown error. */
  skipped?: 'not_configured' | 'no_recipients' | 'provider_error'
}

const FROM = process.env.NOTICE_EMAIL_FROM ?? 'CampusOS <onboarding@resend.dev>'

/**
 * Resend, because it has a free tier that does not require a card and a single
 * HTTPS endpoint with no SDK. Absent an API key this is a no-op that says so,
 * which is the state every developer machine and CI run is in.
 */
export async function sendMail(messages: Mail[]): Promise<MailResult> {
  const key = process.env.RESEND_API_KEY
  if (!key) return { sent: 0, skipped: 'not_configured' }
  if (messages.length === 0) return { sent: 0, skipped: 'no_recipients' }

  try {
    const res = await fetch('https://api.resend.com/emails/batch', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      // Resend's batch endpoint takes at most 100 at a time.
      body: JSON.stringify(
        messages.slice(0, 100).map((m) => ({
          from: FROM,
          to: [m.to],
          subject: m.subject,
          text: m.text,
        })),
      ),
    })

    if (!res.ok) return { sent: 0, skipped: 'provider_error' }
    return { sent: Math.min(messages.length, 100) }
  } catch {
    // A notification that reached the inbox has done its job; an unreachable
    // mail provider must not turn publishing a notice into a 500.
    return { sent: 0, skipped: 'provider_error' }
  }
}

/** Whether an email copy will go anywhere at all, for the UI to be honest. */
export const mailConfigured = () => Boolean(process.env.RESEND_API_KEY)
