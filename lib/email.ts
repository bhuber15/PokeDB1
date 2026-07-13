import { BRAND } from '@/lib/brand'

export interface EmailMessage {
  to: string
  subject: string
  text: string
  html?: string
}

export interface SendResult {
  ok: boolean
  skipped?: boolean
  id?: string
}

// Resend via plain fetch — no SDK dependency. Without RESEND_API_KEY (dev,
// tests, single-tenant installs) sending is a logged no-op so no flow ever
// blocks on email. Failures are reported, not thrown: email is always the
// last, non-critical step of whatever triggered it.
export async function sendEmail(msg: EmailMessage, fetchImpl: typeof fetch = fetch): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    console.log(`[email skipped] to=${msg.to} subject="${msg.subject}"\n${msg.text}`)
    return { ok: false, skipped: true }
  }
  const from = process.env.EMAIL_FROM ?? `${BRAND.name} <onboarding@resend.dev>`
  const res = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from,
      to: [msg.to],
      subject: msg.subject,
      text: msg.text,
      ...(msg.html ? { html: msg.html } : {}),
    }),
  })
  if (!res.ok) {
    console.error(`[email failed] status=${res.status} to=${msg.to} subject="${msg.subject}"`)
    return { ok: false }
  }
  const body = (await res.json()) as { id?: string }
  return { ok: true, id: body.id }
}
