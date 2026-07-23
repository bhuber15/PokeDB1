import { join } from 'node:path'

// Shared between global-setup (seeding) and the specs (direct DB assertions).
// Must match TURSO_DATABASE_URL in .env.test. Never points at a real database.
export const E2E_DB_PATH = join(process.cwd(), '.e2e', 'e2e.db')
export const OWNER_PASSWORD = 'test-owner-password'
export const STAFF_PIN = '1234'
// Admin-role staff PIN — needed for admin-gated flows (CSV import/export,
// inventory delete). Distinct from STAFF_PIN so existing specs keep
// exercising the ordinary cashier role.
export const ADMIN_PIN = '9999'
