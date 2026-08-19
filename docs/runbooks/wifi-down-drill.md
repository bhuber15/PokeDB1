# Wifi-down drill (till)

One page for the counter. Print it, tape it under the till.

## What just happened
The amber bar at the top means the till has lost the internet. The page you
are on keeps working; anything that needs the server does not.

## Keep selling — with two rules
- **Cash and card sales work.** Items already in the basket check out
  normally; the button says **Queue sale** instead of Confirm. The sale is
  saved on this machine and sends itself when the connection returns
  (a queued-sales panel appears on the POS until it drains).
- **Rule 1: don't close the tab and don't refresh.** Queued sales live in
  this browser tab's storage. The app warns you if you try to leave with
  unsent sales — heed it.
- **Rule 2: no store credit while offline.** The till can't check a balance,
  so store-credit payment is locked. Take cash or card, or ask the customer
  to come back.

## Paused until the connection returns
- **Search** (the catalogue lives on the server) — you can only sell what is
  already in the basket. Scan-by-QR also needs the server.
- **Buys** — do not buy cards or products in; nothing is queued for buys.
  Write the offer on paper and ring it when the bar clears.
- **Refunds and voids** — same. Note the receipt number, do it when back.

## When the amber bar clears
1. Watch the queued-sales panel drain (it retries every 30 seconds; each
   sends with a success message).
2. If an entry shows a conflict (e.g. stock ran out under a queued sale),
   it stays put with Retry/Discard — get the owner to resolve it.
3. Ring anything you wrote down on paper (buys, refunds).

## If it's been more than an hour
Phone the owner. Check the router before blaming the till: is other wifi
working? The till is fine — it will catch up the moment the network is back.
