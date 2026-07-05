import './load-env'
import { db } from '../lib/db'
import { staff } from '../lib/db/schema'
import bcrypt from 'bcryptjs'

async function seed() {
  const pinHash = await bcrypt.hash('1234', 10)
  const [member] = await db.insert(staff)
    .values({ name: 'Admin', pinHash, role: 'admin' })
    .returning({ id: staff.id })
  console.log(`Seeded admin staff (id=${member.id}) with PIN 1234`)
  process.exit(0)
}

seed().catch(e => { console.error(e); process.exit(1) })
