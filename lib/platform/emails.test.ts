import { test } from 'node:test'
import assert from 'node:assert'
import { welcomeEmail, trialEndingEmail, paymentFailedEmail, suspendedEmail } from './emails'

test('welcome email carries the setup link and shop name', () => {
  const msg = welcomeEmail({ to: 'o@shop.com', shopName: 'Brads Cards', setupUrl: 'https://brads.example.com/setup?token=abc' })
  assert.equal(msg.to, 'o@shop.com')
  assert.ok(msg.text.includes('https://brads.example.com/setup?token=abc'))
  assert.ok(msg.text.includes('Brads Cards'))
})

test('lifecycle emails link back to the shop', () => {
  for (const msg of [
    trialEndingEmail({ to: 'o@shop.com', shopName: 'Brads Cards', shopUrl: 'https://brads.example.com/settings' }),
    paymentFailedEmail({ to: 'o@shop.com', shopName: 'Brads Cards', shopUrl: 'https://brads.example.com/settings' }),
  ]) {
    assert.ok(msg.text.includes('https://brads.example.com/settings'))
    assert.ok(msg.subject.length > 0)
  }
  assert.ok(suspendedEmail({ to: 'o@shop.com', shopName: 'Brads Cards' }).text.includes('Brads Cards'))
})
