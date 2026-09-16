import * as z from 'zod'
import { manifest } from '../manifest'
import {
  addRoomsSchema,
  allocateSchema,
  createBlockSchema,
  grantLeaveSchema,
  markSchema,
  myHostelSchema,
  rollCallSchema,
  roomRowSchema,
  scanSchema,
  vacateSchema,
  visitorInSchema,
  visitorOutSchema,
  visitorRowSchema,
} from './schemas'

const base = manifest.apiBasePath
const err = z.object({ error: z.string(), message: z.string() })
const json = (schema: z.ZodType) => ({ 'application/json': { schema } })
const gated = {
  '403': { description: 'Forbidden, or the module is not enabled', content: json(err) },
}

export const paths = {
  [`${base}/blocks`]: {
    get: {
      summary: 'Hostel blocks',
      tags: ['hostel'],
      responses: { '200': { description: 'OK' }, ...gated },
    },
    post: {
      summary: 'Create a block',
      description:
        "A block carries a kind (mens/womens/any). Allocating a student to the wrong block is " +
        'the mistake with the worst consequences here, so it is modelled rather than left to a ' +
        'naming convention.',
      tags: ['hostel'],
      requestBody: { content: json(createBlockSchema) },
      responses: {
        '200': { description: 'Created' },
        ...gated,
        '409': { description: 'That block code is in use', content: json(err) },
      },
    },
  },

  [`${base}/rooms`]: {
    get: {
      summary: 'Rooms with their current residents and free beds',
      tags: ['hostel'],
      responses: {
        '200': { description: 'OK', content: json(z.array(roomRowSchema)) },
        ...gated,
      },
    },
    post: {
      summary: 'Add rooms to a block, a floor at a time',
      tags: ['hostel'],
      requestBody: { content: json(addRoomsSchema) },
      responses: {
        '200': { description: 'Added' },
        ...gated,
        '409': { description: 'A room number already exists', content: json(err) },
      },
    },
  },

  [`${base}/allocations`]: {
    post: {
      summary: 'Allocate a bed',
      description:
        'A room cannot exceed its capacity and a student cannot hold two beds. Both are ' +
        'enforced in Postgres -- the occupancy recount runs under a row lock, so two wardens ' +
        'reaching for the last bed cannot both win.',
      tags: ['hostel'],
      requestBody: { content: json(allocateSchema) },
      responses: {
        '200': { description: 'Allocated' },
        ...gated,
        '409': { description: 'Room full, or the student already has a bed', content: json(err) },
      },
    },
  },
  [`${base}/allocations/vacate`]: {
    post: {
      summary: 'Vacate a bed. Reason mandatory and audited.',
      description:
        'History is kept rather than overwritten: "who was in 204 last March" is a question ' +
        'hostels are asked, usually by somebody official.',
      tags: ['hostel'],
      requestBody: { content: json(vacateSchema) },
      responses: { '200': { description: 'Vacated' }, ...gated },
    },
  },

  [`${base}/leave`]: {
    post: {
      summary: 'Record approved leave, so an empty bed is expected rather than missing',
      description:
        'Overlapping leave for one student is refused by a GiST exclusion constraint: two rows ' +
        'could otherwise disagree about why the bed is empty.',
      tags: ['hostel'],
      requestBody: { content: json(grantLeaveSchema) },
      responses: { '200': { description: 'Granted' }, ...gated },
    },
  },

  [`${base}/rollcall`]: {
    get: {
      summary: "One block's roll call for a night, with every resident listed",
      description:
        '`mode` is "scan" when the Attendance module is enabled for this institution and ' +
        '"manual" when it is not. The soft dependency is visible in the response rather than ' +
        'hidden: a client renders a QR screen or a tick list from this field.',
      tags: ['hostel'],
      responses: {
        '200': { description: 'OK', content: json(rollCallSchema) },
        ...gated,
      },
    },
  },
  [`${base}/rollcall/qr`]: {
    get: {
      summary: 'The rotating code for a gate screen',
      description:
        'Requires the Attendance module: the token primitive is borrowed from it. Without it ' +
        'this returns 409 rather than a code nobody can scan.',
      tags: ['hostel'],
      responses: {
        '200': { description: 'OK' },
        ...gated,
        '409': { description: 'Attendance is not enabled', content: json(err) },
      },
    },
  },
  [`${base}/rollcall/scan`]: {
    post: {
      summary: 'A resident scanning in at the gate',
      tags: ['hostel'],
      requestBody: { content: json(scanSchema) },
      responses: {
        '200': { description: 'Recorded' },
        ...gated,
        '409': { description: 'Stale or invalid code, or already recorded', content: json(err) },
      },
    },
  },
  [`${base}/rollcall/mark`]: {
    post: {
      summary: 'The manual register: a warden ticking names off a list',
      description:
        'Always available, whether or not Attendance is enabled. A manual mark may correct a ' +
        'scan; a scan may never overwrite a warden.',
      tags: ['hostel'],
      requestBody: { content: json(markSchema) },
      responses: { '200': { description: 'Recorded' }, ...gated },
    },
  },

  [`${base}/visitors`]: {
    get: {
      summary: 'The gate register',
      tags: ['hostel'],
      responses: {
        '200': { description: 'OK', content: json(z.array(visitorRowSchema)) },
        ...gated,
      },
    },
    post: {
      summary: 'Sign a visitor in',
      tags: ['hostel'],
      requestBody: { content: json(visitorInSchema) },
      responses: { '200': { description: 'Signed in' }, ...gated },
    },
  },
  [`${base}/visitors/out`]: {
    post: {
      summary: 'Sign a visitor out',
      tags: ['hostel'],
      requestBody: { content: json(visitorOutSchema) },
      responses: {
        '200': { description: 'Signed out' },
        ...gated,
        '409': { description: 'Already signed out', content: json(err) },
      },
    },
  },

  [`${base}/me`]: {
    get: {
      summary: 'Where a student lives, who with, and their recent nights',
      tags: ['hostel'],
      responses: {
        '200': { description: 'OK', content: json(myHostelSchema) },
        ...gated,
      },
    },
  },
}
