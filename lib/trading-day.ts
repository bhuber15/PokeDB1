// lib/trading-day.ts
//
// The shop's trading day runs on Europe/London, but timestamps are stored as
// UTC text ("YYYY-MM-DD HH:MM:SS", SQLite datetime('now')). During BST the two
// disagree between 23:00 UTC and midnight, so "same day" checks must compare
// London calendar days, not UTC prefixes.
//
// Dependency-free on purpose: used by both domain code and client components
// (see AGENTS.md client-bundle boundary).

const londonDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
})

/** Europe/London calendar day (YYYY-MM-DD) of a stored UTC timestamp. */
export function londonDayOfUtc(utcText: string): string {
  return londonDay.format(new Date(utcText.replace(' ', 'T') + 'Z'))
}

/** Whether a stored UTC timestamp falls on the same London calendar day as `now`. */
export function isSameLondonDay(utcText: string, now: Date = new Date()): boolean {
  return londonDayOfUtc(utcText) === londonDay.format(now)
}
