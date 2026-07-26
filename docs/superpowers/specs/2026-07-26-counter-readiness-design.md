# Counter readiness — design (2026-07-26)

## Why

The business-side blind-spot review (2026-07-26) flagged "the physical counter" as the
biggest silent theme before shop demos: receipt printers, cash drawers, card terminals,
barcode scanners, tablets, offline. A code audit for this design found the product is
further ahead than the docs said — most counter capabilities exist; what's missing is
small, and most of the fix is collateral, not code. This spec records the audit result,
the two code changes worth making now, and the explicit not-now decisions.

## What already exists (code-verified 2026-07-26)

- **Receipts & buy slips**: browser print via popup + `window.print()`
  (`components/pos/ReceiptDialog.tsx`, `components/buylist/BuySlipDialog.tsx`,
  `lib/receipt-html.ts`), plus email receipts (`/api/sales/[id]/receipt`, Resend-gated).
- **Labels**: 62mm QR labels + bulk label sheets (`components/inventory/QRLabel.tsx`,
  `lib/printLabelSheet.ts`).
- **Scanning**: the POS search input is a keyboard-wedge target — any USB/Bluetooth
  scanner that types + Enter works; UUID-shaped input routes to QR inventory lookup
  (`components/pos/SearchBar.tsx`). Hands-free refocus after each search.
- **Offline sales**: mid-checkout network failure enqueues the sale in localStorage and
  replays it idempotently (`clientUuid`) every 30 s and on the `online` event; definitive
  rejections park as conflicts for human retry/discard (`lib/sale-queue.ts`,
  `components/pos/SaleQueue.tsx`, landed in Package D `5cb8568`, extended by F6).
- **Cash handling**: quick-tender buttons, change due, split tender, store credit,
  cash-up domain (`lib/domain/cash-ups.ts`).

## Gaps and their disposition

| Gap | Decision |
|---|---|
| Card terminal integration | **Not now.** Stub spec `2026-07-22-card-terminal-integration-stub.md` stands; blocked on which terminal pilot shops own (interview probe added to collateral). Keyed-total into the shop's existing SumUp/Zettle is the launch answer. |
| Cash-drawer kick / native ESC/POS / silent printing | **Not now — document.** Drawers wired to the receipt printer pop via the printer driver's "open drawer on print" setting; that answer goes in collateral. Epson ePOS / Star WebPRNT / QZ Tray evaluated only once a pilot shop's actual printer model is known. |
| Sustained offline trading | **Not now — document.** Search is server-side, so a dead connection blocks new baskets by design (server-canonical prices). Mitigation is written: phone hotspot + paper fallback sheet. No service worker / PWA. |
| No visible offline indicator | **Build (A).** The queue protects checkout silently; demos and staff should *see* the state. |
| Tablet layout un-audited | **Build (B).** "Demo on their device" is a stated pre-sprint requirement; the nav measurably overflows at 768 px for admin (8 labelled links ≈ 870 px), and the POS grid hard-codes a 360 px cart column. |

## Design

### A. Offline status chip (POS only)

- `useOnlineStatus()` hook in `components/shared/` — `navigator.onLine` seeded on mount
  (SSR-safe: initial `true` to avoid hydration mismatch), subscribes to `online`/`offline`.
- Amber pill rendered in the POS header row (next to `GameFilter`): **"Offline — sales
  will queue"**. Disappears when back online.
- POS-only on purpose: other pages (buylist, inventory) have no offline queue, so a
  global chip would overpromise. The chip is presentational; zero behavior change to the
  queue itself.
- Test: colocated component test (existing style: `components/**/**.test.tsx`) driving
  `online`/`offline` events.

### B. Tablet pass (768×1024 portrait, 1024×768 landscape)

- **Nav** (`components/layout/Nav.tsx`): link labels `hidden lg:inline`; icons keep
  `aria-label` + `title` so icon-only mode stays accessible. Badge (wants count) survives.
- **POS grid** (`app/(app)/pos/page.tsx`): keep two columns on tablets with a slimmer
  cart (~300 px) and fall to a single column only below `md`; swap
  `calc(100vh - 120px)` for `dvh` (iPad Safari toolbar collapse). Exact classes settled
  visually in the browser at both orientations.
- Verify checkout dialog, receipt dialog, sale-queue panel at both sizes; screenshots
  are the proof artifact.
- Desktop must be pixel-unchanged at ≥1280 (e2e runs there).

## Error handling

No domain or API surface changes. The chip must never block selling — if the hook
misreports online state, checkout still works because the queue path is untouched.

## Testing

`npm test`, `npm run lint`, `npm run test:e2e` (first run in a fresh worktree is a
cold-cache throwaway — rerun warm), plus browser-pane screenshots at both tablet
orientations against the local sandbox DB.

## Out-of-repo collateral (pointers only, content lives in the business vault)

Alongside this code change: a hardware/counter page in the business wiki (correcting the
stale "no offline story" claim), a counter Q&A block + interview probes in the demo crib
sheet, an offline paper-fallback sheet, and a hardware-compatibility line on the
marketing site. Per vault rules, none of that content is duplicated in this repo.
