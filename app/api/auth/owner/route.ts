import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { getSession } from '@/lib/auth'

export async function POST(req: NextRequest) {
  const { password } = await req.json()
  const hash = process.env.OWNER_PASSWORD_HASH
  if (!hash) return NextResponse.json({ error: 'Server not configured' }, { status: 500 })
  const valid = await bcrypt.compare(password, hash)
  if (!valid) return NextResponse.json({ error: 'Invalid password' }, { status: 401 })
  const session = await getSession()
  session.isOwnerLoggedIn = true
  await session.save()
  return NextResponse.json({ ok: true })
}

export async function DELETE() {
  const session = await getSession()
  session.destroy()
  return NextResponse.json({ ok: true })
}
