import { defineConfig } from 'drizzle-kit'
import { loadEnvConfig } from '@next/env'

loadEnvConfig(process.cwd())

export default defineConfig({
  schema: './lib/platform/schema.ts',
  out: './lib/platform/migrations',
  dialect: 'turso',
  dbCredentials: {
    url: process.env.PLATFORM_DATABASE_URL ?? 'file:./platform-dev.db',
    authToken: process.env.PLATFORM_AUTH_TOKEN,
  },
})
