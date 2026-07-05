// Standalone scripts run outside Next, which normally loads .env.local.
// Import this FIRST in every script (before anything that touches lib/db),
// since module imports execute in order.
import { loadEnvConfig } from '@next/env'

loadEnvConfig(process.cwd())
