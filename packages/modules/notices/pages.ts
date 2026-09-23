import { flag, type PluginPage } from '@campusos/module-framework'
import { board, inbox, mailConfigured, type Actor } from './api'

const POSTERS = [
  'super_admin',
  'institution_admin',
  'hod',
  'faculty',
  'accounts_staff',
  'library_staff',
  'hostel_staff',
] as const

const READERS = [...POSTERS, 'student', 'parent'] as const

export const pages: PluginPage[] = [
  {
    path: '/',
    title: 'Notices',
    menu: 'Notices',
    roles: [...READERS],
    async load(actor, req) {
      const a = actor as Actor
      const canPost = (POSTERS as readonly string[]).includes(a.role)
      const notices = await board(a, canPost && flag(req, 'drafts'))
      return {
        canPost,
        mail: mailConfigured(),
        notices: notices.map((n) => ({
          ...n,
          when: n.publishedAt ?? '',
          state: n.publishedAt ? n.kind : 'draft',
          draft: !n.publishedAt,
          audience: n.audienceRoles.length === 0 ? 'everybody' : n.audienceRoles.join(', '),
          seen: `${n.readCount} of ${n.reach}`,
        })),
        drafts: notices
          .filter((n) => !n.publishedAt)
          .map((n) => ({ value: n.id, label: n.title })),
        all: notices.map((n) => ({ value: n.id, label: n.title })),
      }
    },
    sections: (data) => [
      ...(data.canPost && !data.mail
        ? [
            {
              kind: 'note' as const,
              text:
                'No mail provider is configured, so notices land in the in-app ' +
                'inbox only. Set RESEND_API_KEY to send email copies as well.',
            },
          ]
        : []),
      {
        kind: 'table',
        rows: 'notices',
        empty: 'Nothing on the board.',
        columns: [
          { key: 'title', label: 'Notice' },
          { key: 'state', label: 'Kind', kind: 'status', alertWhen: 'draft' },
          { key: 'audience', label: 'Audience' },
          { key: 'when', label: 'Published', kind: 'date' },
          { key: 'authorName', label: 'By' },
          ...(data.canPost ? [{ key: 'seen', label: 'Read' }] : []),
        ],
      },
      ...(data.canPost
        ? [
            {
              kind: 'form' as const,
              title: 'Write a notice',
              note:
                'Publishing delivers a copy to every addressee inbox. A draft ' +
                'tells nobody, which is the failure mode worth being explicit ' +
                'about: believing you have announced something.',
              submit: 'Post',
              path: '/board',
              fields: [
                { name: 'title', label: 'Title' },
                { name: 'body', label: 'Body', kind: 'textarea' as const, rows: 6 },
                {
                  name: 'kind',
                  label: 'Kind',
                  kind: 'select' as const,
                  options: [
                    { value: 'announcement', label: 'announcement' },
                    { value: 'circular', label: 'circular' },
                    { value: 'urgent', label: 'urgent' },
                    { value: 'event', label: 'event' },
                  ],
                },
                {
                  name: 'audienceRoles',
                  label: 'Audience',
                  kind: 'select' as const,
                  optional: true,
                  hint: 'Leave unset for everybody. A lecturer may address students only.',
                  options: [
                    { value: 'student', label: 'students' },
                    { value: 'faculty', label: 'lecturers' },
                    { value: 'parent', label: 'parents' },
                  ],
                },
                { name: 'expiresAt', label: 'Show until', kind: 'date' as const, optional: true },
                { name: 'pinned', label: 'Pin to the top', kind: 'checkbox' as const, optional: true },
                { name: 'publish', label: 'Publish now', kind: 'checkbox' as const, optional: true },
              ],
            },
            {
              kind: 'form' as const,
              title: 'Publish a draft',
              submit: 'Publish',
              path: '/board/publish',
              fields: [
                { name: 'noticeId', label: 'Draft', kind: 'select' as const, options: 'drafts' },
              ],
            },
            {
              kind: 'form' as const,
              title: 'Take a notice down',
              note:
                'Audited. The inbox copies go with it, so nobody is left holding ' +
                'a link to something that is gone.',
              submit: 'Withdraw',
              path: '/board/withdraw',
              fields: [
                { name: 'noticeId', label: 'Notice', kind: 'select' as const, options: 'all' },
                { name: 'reason', label: 'Reason', hint: 'At least five characters' },
              ],
            },
          ]
        : []),
    ],
  },

  {
    path: '/inbox',
    title: 'Inbox',
    menu: 'Inbox',
    roles: [...READERS],
    async load(actor, req) {
      const a = actor as Actor
      const box = await inbox(a, flag(req, 'unread'))
      return {
        unread: box.unread,
        mail: box.emailConfigured,
        items: box.items.map((i) => ({
          ...i,
          state: i.readAt ? 'read' : 'new',
          isNew: !i.readAt,
        })),
        filters: [
          { label: 'all', href: '/m/notices/inbox', active: !flag(req, 'unread') },
          { label: 'unread', href: '/m/notices/inbox?unread=1', active: flag(req, 'unread') },
        ],
      }
    },
    sections: (data) => [
      { kind: 'links', links: data.filters as never },
      {
        kind: 'note',
        text:
          'Everything the system has told you, from every module.' +
          (data.mail ? '' : ' No mail provider is configured, so this is the only copy.'),
      },
      {
        kind: 'table',
        rows: 'items',
        empty: 'Nothing here.',
        columns: [
          { key: 'title', label: 'Notification', href: '{link}' },
          { key: 'body', label: 'Detail' },
          { key: 'moduleId', label: 'From', kind: 'code' },
          { key: 'createdAt', label: 'When', kind: 'date' },
          { key: 'state', label: '', kind: 'status', alertWhen: 'isNew' },
        ],
      },
      {
        kind: 'form',
        title: 'Mark everything read',
        submit: `Mark all ${data.unread} read`,
        path: '/inbox',
        fields: [],
      },
    ],
  },
]
