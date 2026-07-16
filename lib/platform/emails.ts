import { BRAND } from '@/lib/brand'
import type { EmailMessage } from '@/lib/email'

// Platform lifecycle emails (spec §3.5/3.6/3.9). Plain text at launch —
// deliverability beats design. All copy UK English.

export function welcomeEmail(i: { to: string; shopName: string; setupUrl: string }): EmailMessage {
  return {
    to: i.to,
    subject: `${i.shopName} is ready — finish setting up ${BRAND.name}`,
    text: [
      `Welcome to ${BRAND.name}!`,
      '',
      `${i.shopName} is provisioned and your 14-day free trial has started — no card needed.`,
      '',
      'Finish setup (takes two minutes):',
      i.setupUrl,
      '',
      'Your first five things to do:',
      '1. Set your shop password and your admin PIN (link above)',
      '2. Check pricing margins and your VAT scheme in Settings',
      '3. Add your first cards, or import your stock as CSV',
      '4. Ring up a test sale',
      '5. Add PINs for your staff',
      '',
      `Card catalogue and market prices are loading in the background and will be ready shortly.`,
      '',
      `Questions? Just reply, or email ${BRAND.supportEmail}.`,
    ].join('\n'),
  }
}

export function trialEndingEmail(i: { to: string; shopName: string; shopUrl: string }): EmailMessage {
  return {
    to: i.to,
    subject: `Your ${BRAND.name} trial ends in 3 days`,
    text: [
      `Your free trial for ${i.shopName} ends in 3 days.`,
      '',
      'To keep trading without interruption, add a payment method:',
      i.shopUrl,
      '',
      `(Settings → Billing → Manage billing.) If you do nothing, your shop will pause at the end of the trial — your data is kept safe and you can pick up where you left off.`,
      '',
      `Questions? Email ${BRAND.supportEmail}.`,
    ].join('\n'),
  }
}

export function paymentFailedEmail(i: { to: string; shopName: string; shopUrl: string }): EmailMessage {
  return {
    to: i.to,
    subject: `Payment failed for ${i.shopName} — action needed`,
    text: [
      `We couldn't take payment for ${i.shopName}.`,
      '',
      `We'll retry automatically over the next few days, but to avoid interruption please update your card now:`,
      i.shopUrl,
      '',
      `(Settings → Billing → Manage billing.)`,
      '',
      `Need help? Email ${BRAND.supportEmail}.`,
    ].join('\n'),
  }
}

export function suspendedEmail(i: { to: string; shopName: string }): EmailMessage {
  return {
    to: i.to,
    subject: `${i.shopName} has been suspended`,
    text: [
      `The subscription for ${i.shopName} has ended, so the shop is now suspended.`,
      '',
      `Your data is kept safe for 30 days. To reactivate (or to export your data), email ${BRAND.supportEmail} — we'll sort it the same day.`,
    ].join('\n'),
  }
}
