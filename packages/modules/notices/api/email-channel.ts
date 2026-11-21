import { sql } from 'drizzle-orm'
import type { NotificationChannel } from './operations'

export const emailNotificationChannel: NotificationChannel = {
  id: 'email',
  async deliver(tx, deliveries) {
    const first = deliveries[0]
    if (process.env.CAMPUSOS_NOTIFICATION_EMAIL !== '1' || !first) return
    const tenant = first.institutionId
    if (deliveries.some((delivery) => delivery.institutionId !== tenant)) {
      throw new Error('Email delivery batch spans institutions.')
    }

    // One parameter keeps a board fan-out within the query's parameter limit.
    // Build the UUID array once so Postgres can probe the notification index.
    const ids = JSON.stringify(deliveries.map((delivery) => delivery.notificationId))
    await tx.execute(sql`
      insert into background_jobs (institution_id, actor_id, kind, dedupe_key, payload, max_attempts)
      select n.institution_id, null, 'notices.email', 'notices.email:' || n.id::text,
             jsonb_build_object('notificationId', n.id), 5
        from notifications n
        join users u on u.id = n.user_id and u.institution_id = n.institution_id
       where n.institution_id = ${tenant}
         and n.id = any(array(select value::uuid from jsonb_array_elements_text(${ids}::jsonb)))
         and u.erased_at is null and u.role <> 'pending' and nullif(btrim(u.email), '') is not null
         and not exists (
           select 1 from notification_email_opt_outs o
            where o.institution_id = n.institution_id and o.user_id = n.user_id
         )
      on conflict (institution_id, dedupe_key) do nothing
    `)
  },
}
