import { test } from 'node:test'
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Returns are a staff job by policy (spec 2026-08-16): the refund/void
// endpoints already allow staff, so the lookup endpoints that find the sale
// must too — an admin-only gate here silently makes returns owner-only at
// the counter. Aggregate reporting stays admin-only.
const STAFF_LOOKUP_ROUTES = [
  'app/api/sales/search/route.ts',
  'app/api/sales/history/route.ts',
]

test('sale-lookup routes gate on requireStaff, not requireAdmin', () => {
  for (const route of STAFF_LOOKUP_ROUTES) {
    const src = readFileSync(join(process.cwd(), route), 'utf8')
    assert.ok(src.includes('requireStaff('), `${route} must call requireStaff`)
    assert.ok(!src.includes('requireAdmin('), `${route} must not gate the whole handler behind requireAdmin`)
  }
})

test('aggregate report routes stay admin-only', () => {
  for (const route of [
    'app/api/reports/sales/route.ts',
    'app/api/reports/cash-up/route.ts',
    'app/api/sales/route.ts',
  ]) {
    const src = readFileSync(join(process.cwd(), route), 'utf8')
    assert.ok(src.includes('requireAdmin('), `${route} must keep requireAdmin`)
  }
})
