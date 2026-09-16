import type { Inbox, NoticeRow, NotificationRow } from '../api/schemas'

/** Presentational only, as with the other modules. */

const KIND_STYLE: Record<string, string> = {
  urgent: 'border-red-300 bg-red-50 text-red-900',
  event: 'border-blue-300 bg-blue-50 text-blue-900',
  circular: 'border-neutral-300 bg-neutral-50 text-neutral-900',
  announcement: 'border-neutral-200 bg-white text-neutral-900',
}

export function NoticeCard({
  notice: n,
  showStats = false,
}: {
  notice: NoticeRow
  showStats?: boolean
}) {
  const draft = n.publishedAt === null

  return (
    <article className={`rounded border p-3 ${KIND_STYLE[n.kind] ?? KIND_STYLE.announcement}`}>
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-medium">
          {n.pinned && <span className="mr-2 text-xs uppercase">pinned</span>}
          {n.title}
        </h3>
        <p className="text-xs text-neutral-600">
          {draft ? (
            <span className="text-amber-700">draft — nobody has been told</span>
          ) : (
            n.publishedAt?.slice(0, 10)
          )}
          {n.authorName && ` · ${n.authorName}`}
          {n.departmentCode && ` · ${n.departmentCode}`}
        </p>
      </header>

      <p className="mt-2 whitespace-pre-wrap text-sm">{n.body}</p>

      <footer className="mt-2 flex flex-wrap gap-3 text-xs text-neutral-600">
        <span>{n.kind}</span>
        <span>
          {n.audienceRoles.length === 0
            ? 'everybody'
            : n.audienceRoles.join(', ').replace(/_/g, ' ')}
        </span>
        {n.expiresAt && <span>until {n.expiresAt.slice(0, 10)}</span>}
        {showStats && !draft && (
          <span>
            read by {n.readCount} of {n.reach}
          </span>
        )}
      </footer>
    </article>
  )
}

export function InboxList({ inbox: box }: { inbox: Inbox }) {
  if (box.items.length === 0) {
    return <p className="text-sm text-neutral-500">Nothing here.</p>
  }

  return (
    <ul className="space-y-2">
      {box.items.map((i) => (
        <li key={i.id}>
          <InboxItem item={i} />
        </li>
      ))}
    </ul>
  )
}

function InboxItem({ item }: { item: NotificationRow }) {
  const unread = item.readAt === null
  return (
    <div
      className={`rounded border p-3 ${
        unread ? 'border-neutral-400 bg-white' : 'border-neutral-200 bg-neutral-50'
      }`}
    >
      <p className="flex flex-wrap items-baseline justify-between gap-2">
        <span className={unread ? 'font-medium' : ''}>
          {item.link ? (
            <a className="underline" href={item.link}>
              {item.title}
            </a>
          ) : (
            item.title
          )}
        </span>
        <span className="text-xs text-neutral-500">
          {item.moduleId} · {item.createdAt.slice(0, 10)}
        </span>
      </p>
      <p className="mt-1 whitespace-pre-wrap text-sm text-neutral-700">{item.body}</p>
    </div>
  )
}

/** A count for the shell. Renders nothing at zero rather than a "0" badge. */
export function UnreadBadge({ count }: { count: number }) {
  if (count === 0) return null
  return (
    <span className="ml-2 rounded-full bg-neutral-900 px-1.5 py-0.5 text-xs text-white">
      {count > 99 ? '99+' : count}
    </span>
  )
}
