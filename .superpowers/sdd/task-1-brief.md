### Task 1: Project Scaffold

**Files:**
- Create: Next.js project (via npx)
- Create: `drizzle.config.ts`
- Create: `.env.local`
- Create: `lib/db/index.ts`

- [ ] **Step 1: Scaffold Next.js project**

```bash
npx create-next-app@latest . --typescript --tailwind --app --no-src-dir --import-alias "@/*" --yes
```

Expected: Next.js 15 project created in current directory.

- [ ] **Step 2: Install dependencies**

```bash
npm install @libsql/client drizzle-orm iron-session bcryptjs qrcode
npm install -D drizzle-kit @types/bcryptjs @types/qrcode tsx
```

- [ ] **Step 3: Install shadcn/ui**

```bash
npx shadcn@latest init --defaults
npx shadcn@latest add button input label card dialog table badge separator toast
```

- [ ] **Step 4: Create Turso database**

```bash
curl -sSfL https://get.tur.so/install.sh | bash
turso auth login
turso db create pokedb
turso db show pokedb --url
turso db tokens create pokedb
```

Save the database URL (starts with `libsql://`) and auth token.

- [ ] **Step 5: Create .env.local**

```bash
# .env.local
TURSO_DATABASE_URL=libsql://your-db-name.turso.io
TURSO_AUTH_TOKEN=your-auth-token
SESSION_SECRET=replace-with-64-char-hex-string
OWNER_PASSWORD_HASH=fill-in-task-3
POKEMON_TCG_API_KEY=optional-get-free-key-at-pokemontcg-io
HIGH_VALUE_THRESHOLD=50
MARGIN_MULTIPLIER=0.85
NEXT_PUBLIC_MARGIN_MULTIPLIER=0.85
```

Generate SESSION_SECRET:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

- [ ] **Step 6: Create Turso client**

```typescript
// lib/db/index.ts
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import * as schema from './schema'

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!,
})

export const db = drizzle(client, { schema })
```

- [ ] **Step 7: Create drizzle config**

```typescript
// drizzle.config.ts
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './lib/db/schema.ts',
  out: './lib/db/migrations',
  dialect: 'turso',
  dbCredentials: {
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN!,
  },
})
```

- [ ] **Step 8: Verify dev server starts**

```bash
npm run dev
```

Expected: Server starts at http://localhost:3000 with no errors.

- [ ] **Step 9: Commit**

```bash
git init
git add .
git commit -m "chore: scaffold Next.js 15 + Turso + Drizzle + shadcn/ui"
```

---

