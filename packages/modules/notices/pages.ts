import { flag, param, type PluginPage, type PluginSection } from '@campusos/module-framework'
import { board, inbox, mailConfigured, noticeView, type Actor } from './api'

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
          filesText: n.files ? String(n.files) : '',
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
          { key: 'title', label: 'Notice', href: '/m/notices/notice?id={id}' },
          { key: 'state', label: 'Kind', kind: 'status', alertWhen: 'draft' },
          { key: 'filesText', label: 'Documents' },
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
                {
                  name: 'attachment',
                  label: 'A document to go with it',
                  kind: 'file' as const,
                  accept: 'application/pdf,image/png,image/jpeg',
                  hint: 'PDF, PNG or JPEG, up to 10 MB. More can be attached while it is a draft.',
                  optional: true,
                },
                { name: 'expiresAt', label: 'Show until', kind: 'date' as const, optional: true },
                { name: 'pinned', label: 'Pin to the top', kind: 'checkbox' as const, optional: true },
                { name: 'publish', label: 'Publish now', kind: 'checkbox' as const, optional: true },
              ],
            },
            {
              kind: 'form' as const,
              title: 'Attach a document to a draft',
              note: 'Fixed once the notice is published: what everybody was sent is what stays.',
              submit: 'Attach',
              path: '/board/attachments',
              fields: [
                { name: 'noticeId', label: 'Draft', kind: 'select' as const, options: 'drafts' },
                { name: 'file', label: 'Document', kind: 'file' as const, accept: 'application/pdf,image/png,image/jpeg', hint: 'PDF, PNG or JPEG, up to 10 MB' },
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
    path: '/notice',
    title: 'Notice',
    roles: [...READERS],
    async load(actor, req) {
      const v = await noticeView(actor as Actor, param(req, 'id') ?? '')
      const kb = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)
      return {
        v,
        documents: v.documents.map((d) => ({
          ...d,
          kind: d.type === 'application/pdf' ? 'PDF' : d.type === 'image/png' ? 'PNG' : 'JPEG',
          sizeText: kb(d.size),
          sha: d.sha256.slice(0, 12),
          href: `/api/v1/modules/notices/board/attachment?id=${d.id}`,
        })),
        removable: v.notice.publishedAt ? [] : v.documents.map((d) => ({ value: d.id, label: d.name })),
      }
    },
    record: (data) => {
      const v = data.v as Awaited<ReturnType<typeof noticeView>> | undefined
      if (typeof v?.notice?.id !== 'string') return null
      const n = v.notice
      return {
        title: n.title,
        subtitle: n.departmentCode ? `For ${n.departmentCode}` : undefined,
        status: { label: n.publishedAt ? n.kind : 'draft' },
        fields: [
          { label: 'Published', value: n.publishedAt, kind: 'when' },
          { label: 'By', value: n.authorName },
          { label: 'For', value: n.audienceRoles.length ? n.audienceRoles.join(', ') : 'everybody' },
          { label: 'Shown until', value: n.expiresAt, kind: 'date' },
          ...(v.canPost ? [{ label: 'Read', value: `${n.readCount} of ${n.reach}` }] : []),
        ],
      }
    },
    sections: (data) => {
      const v = data.v as Awaited<ReturnType<typeof noticeView>> | undefined
      if (typeof v?.notice?.id !== 'string') return [{ kind: 'note', text: 'No such notice.' }]
      const draft = !v.notice.publishedAt
      const out: PluginSection[] = [
        { kind: 'prose', text: v.notice.body },
        {
          kind: 'table',
          title: 'Documents',
          rows: 'documents',
          empty: 'None.',
          columns: [
            { key: 'name', label: 'Document', href: '{href}' },
            { key: 'kind', label: 'Kind', kind: 'code' },
            { key: 'sizeText', label: 'Size' },
            { key: 'sha', label: 'SHA-256', kind: 'code' },
          ],
        },
      ]
      if (v.canPost && draft) {
        out.push(
          {
            kind: 'form',
            title: 'Attach a document',
            submit: 'Attach',
            path: '/board/attachments',
            fields: [
              { name: 'noticeId', label: 'Notice', kind: 'hidden', value: v.notice.id },
              { name: 'file', label: 'Document', kind: 'file', accept: 'application/pdf,image/png,image/jpeg', hint: 'PDF, PNG or JPEG, up to 10 MB' },
            ],
          },
          {
            kind: 'form',
            title: 'Take a document off',
            submit: 'Take it off',
            path: '/board/attachments/remove',
            fields: [{ name: 'attachmentId', label: 'Document', kind: 'select', options: 'removable' }],
          },
          {
            kind: 'form',
            title: 'Publish',
            note: 'Everybody it is for gets it in their inbox, with its documents.',
            submit: 'Publish',
            path: '/board/publish',
            fields: [{ name: 'noticeId', label: 'Notice', kind: 'hidden', value: v.notice.id }],
          },
        )
      }
      return out
    },
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
