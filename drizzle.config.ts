import { defineConfig } from 'drizzle-kit'
import { loadEnvConfig } from '@next/env'

// drizzle-kit runs outside Next and doesn't load .env.local by itself
loadEnvConfig(process.cwd())

export default defineConfig({
  schema: './lib/db/schema.ts',
  out: './lib/db/migrations',
  dialect: 'turso',
  dbCredentials: {
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN!,
  },
})
