/* global __ENV, __VU, __ITER -- k6 runtime globals */
// Read-only load profile (P1-10a, decisions 339 and 340). Run against `next start`
// on the host, with the load database seeded by scripts/load/seed.ts at LOAD_SCALE=full.
import http from 'k6/http'
import { check, sleep } from 'k6'

const BASE = __ENV.BASE || 'http://host.docker.internal:3000'
const ROOT = __ENV.ROOT || 'localhost:3000'
const TENANTS = Number(__ENV.TENANTS || 50)
const USERS = ['acc0', 'acc1', 'stu0', 'stu1', 'stu2', 'stu3', 'stu4', 'stu5', 'stu6', 'stu7']

export const options = {
  stages: [{ duration: '60s', target: 500 }, { duration: '5m', target: 500 }, { duration: '30s', target: 0 }],
  thresholds: { http_req_duration: ['p(95)<500'], http_req_failed: ['rate<0.01'] },
}

export default function () {
  const v = __VU - 1
  const slug = 'load-' + String(v % TENANTS).padStart(2, '0')
  const user = USERS[Math.floor(v / TENANTS) % USERS.length]
  const params = { headers: { Host: `${slug}.${ROOT}`, Cookie: `authjs.session-token=load-${slug}-${user}` } }
  const odd = __ITER % 2 === 1
  const path = user.startsWith('acc')
    ? (odd ? '/api/v1/modules/finance/trial-balance?from=2025-04-01&to=2026-03-31' : '/api/v1/modules/finance/invoices?n=50')
    : (odd ? '/api/v1/me' : '/api/v1/modules/notices/board?n=20')
  const res = http.get(BASE + path, params)
  check(res, { 'status 200': (r) => r.status === 200 })
  sleep(1)
}
