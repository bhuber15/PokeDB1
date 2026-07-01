# Card-Shop Software Market Brief

**Date:** June 2026
**Purpose:** Understand what proven card-shop software does, where it adds value, and what it means for the PokeDB build and the owner conversation.

---

## 1. The market is mature and specialised

There is a whole category of software built *specifically* for trading-card and hobby-game shops. The main players:

| Product | What it is | Notes |
|---|---|---|
| **BinderPOS** (now owned by TCGplayer) | POS + inventory for TCG stores, built on Shopify | US-centric; 2.5% commission on TCGplayer-integration sales |
| **TCG Sync (Storefront Pro)** | All-in-one: storefront, POS, buylist, events, deckbuilder, marketplace sync | 1,210 stores / 46 countries; UK company; syncs 7 marketplaces |
| **Storepass** | Buylist, autopricing, POS, catalogs | Pitches itself as a BinderPOS/Crystal Commerce migration path |
| **ShadowPOS** | POS for TCG/local game stores | Autopricing, buylist, multi-channel |
| **Crystal Commerce** | The old incumbent — omni-channel inventory sync | Many shops are now *migrating away* from it |

**Takeaway:** Generic POS (Square, Shopify, Lightspeed) is what shops *start* on and then outgrow, because it can't do per-card pricing, buylist, or marketplace sync. The specialised tools exist precisely because card retail has needs generic retail doesn't.

---

## 2. The proven feature set (what they all share)

Every serious platform converges on roughly the same features. This is, in effect, a validated spec for "what a card shop needs":

1. **POS with live inventory sync** — ring up walk-ins; stock updates everywhere instantly. ✅ *We have the core of this.*
2. **Buylist / trade-in with automatic store credit** — "search card → here's what we pay in cash or credit." Configurable rules per card. **This is the single biggest thing specialised software does that generic POS can't.**
3. **Autopricing** — sell prices auto-derived from live market data, with store-configurable rules. ✅ *We have a basic version (margin multiplier).*
4. **Multi-channel marketplace sync** — one inventory pushed to TCGplayer, Cardmarket, eBay, Shopify; a sale on any channel decrements the others.
5. **Online storefront** — branded webshop sharing the same inventory.
6. **Events / tournaments** — ticketing, attendee tracking (Friday Night Magic, pre-releases).
7. **Deckbuilder + "what's in stock"** — customer pastes a decklist, sees what you have.
8. **Customer accounts** — wishlists, store credit balances, notify-when-in-stock.
9. **Card scanning / recognition** — AI identifies a card from a photo.
10. **Graded-card management** — PSA/BGS/CGC tracking.

---

## 3. The economics that justify those features

From shop-operator sources:

- **Singles carry 45%+ margin. Sealed product is only 15–20%.** A £100 booster box might net £15–20 before overhead. **Singles keep the lights on.**
- **Buylist is survival.** You can't have a healthy singles inventory without buying cards in cheaply — usually from the public. The shops that thrive are the ones who price buy-ins *fast and consistently across staff*.
- **The shop's cost is liquidity + labour** — cash tied up in stock, and hours spent pricing/sorting/listing. Software earns its keep by *reducing labour* (intake, pricing) and *protecting margin* (consistent buy pricing).
- **Fraud/chargebacks** hit 79% of merchants; every £1 of fraud costs ~£4.61. Relevant the moment they sell online.

**Implication for us:** the highest-value features are **buylist-with-store-credit** and **fast singles intake** — they hit the exact money-and-labour pressure points. Events, loyalty, deckbuilder are nice but secondary for a brand-new shop.

---

## 4. UK-specific finding that affects our build ⚠️

**Cardmarket — not TCGplayer — is the European/UK reference price.**

- **Cardmarket** is Europe's dominant marketplace, prices in **EUR**, ~5% seller fees.
- **TCGplayer** is the **US** marketplace, prices in **USD**, ~10.25% fees.
- UK buyers and sellers price off **Cardmarket**.

Our app currently pulls prices from the free Pokémon TCG API, which carries **TCGplayer (USD)** prices — we then convert USD→GBP. That works as an approximation, but a UK shop pricing against US data (then a rough FX conversion) will be subtly *off* from what local customers see on Cardmarket. **For accurate UK pricing we should move to a Cardmarket (EUR) data source.**

Pricing-data options for that:
- **JustTCG** — clean developer API, free tier, condition-specific prices, multi-game.
- **PokéTrace** — returns TCGplayer + eBay sold + Cardmarket in one response.
- **Cardmarket's own API** — EUR only, OAuth 1.0 (painful), and they restrict bulk price-only polling.
- **RapidAPI Cardmarket wrapper** — free 100 req/day, ~$9.90/mo for 3,000/day.
- **TCGdex** — free Pokémon catalog (no prices, but multi-language card data).

**Brexit note:** cross-border EU↔UK sales now carry customs/VAT friction, so UK shops increasingly sell domestic. (A UK-focused 0%-fee Cardmarket alternative, "Card Synced," exists for this reason.)

---

## 5. The frontier: AI scan-to-list (the labour killer)

The newest tools attack the singles-intake bottleneck directly:

- **TCG Automate, NeoSatoshi, Shiny, Eyevo, Ludex, CollX** — point a camera at a card, AI identifies set/variant/rarity in **under a second at ~96% accuracy**, auto-prices it, and generates a ready-to-publish eBay/TCGplayer listing.
- **Batch/multi-card scanning** — process a stack quickly; "value your entire bulk in minutes."

This is where the manual hours go in a card shop (photograph → identify → price → list), so it's the highest-leverage automation. It's also the hardest to build well (needs an image-recognition model), but third-party scan APIs can be integrated rather than built from scratch.

---

## 6. What this means for PokeDB (build vs. buy — the honest version)

**The uncomfortable truth:** mature, card-specific platforms start at **£15–150/month**, and TCG Sync's mid tier is **£1,000 setup + 2% of TCG sales**. We are competing with proven products.

**When a custom build genuinely wins:**
- **No per-transaction tax.** Incumbents take ~2–2.5% of TCG sales. A shop doing £200k/yr in singles pays them ~£4k/yr *forever*. A custom build has no cut.
- **Exactly their workflow** — not a generic one they bend around.
- **They own the data and the system** — no lock-in, no migration risk if a vendor folds (note Crystal Commerce's customers are fleeing).
- It doubles as a longer-term asset/IP.

**When buying off-the-shelf wins:**
- If the priority is *open fast and cheap* with marketplace sync working on day one.
- Marketplace integrations (eBay, Cardmarket) are genuinely hard and ongoing to maintain — the incumbents' real moat.

**Where PokeDB stands:** the core (POS, inventory, price lookup) is solid and matches what the incumbents start with. The proven, high-value roadmap that mirrors the market:

1. **Buylist + store credit** (highest value, fully buildable by us, no external approval needed)
2. **Cardmarket/GBP-accurate pricing** (data-source swap — improves every existing feature)
3. **eBay sync** *(if owner confirms online selling)* — high value, high effort, needs eBay API approval
4. **Scan-to-list intake** (biggest labour saver; integrate a scan API rather than build the model)
5. Later: events, wishlists/notify, deckbuilder, loyalty

---

## 7. How this reframes the owner conversation

The research lets you ask grounded questions instead of abstract ones. The proven value drivers tell you what *matters*:

- **Buying stock:** "How do you plan to buy cards from the public — collections, individual cards? Cash or store credit? Who decides the price?" → sizes the buylist need.
- **Selling online:** "Will you sell on eBay / Cardmarket / your own site, or in-store only?" → decides whether multi-channel sync (the hard, expensive part) is even in scope.
- **Singles volume:** "How many singles a week do you expect to take in and list?" → sizes the intake/scanning need.
- **Pricing stance:** "Do you want to price off Cardmarket like UK customers see, or US TCGplayer?" → settles the data-source question.
- **Events:** "Will you run tournaments or play nights?" → in or out of scope.

And the demo becomes a discovery tool: show him the working POS and price lookup, and watch which of the proven features he instinctively reaches for or misses.

---

## Sources

- [BinderPOS / TCGplayer POS](https://seller.tcgplayer.com/point-of-sale) · [BinderPOS Buylist](https://seller.tcgplayer.com/blog/articles/grow-your-inventory-leveraging-the-binderpos-buylist-feature) · [BinderPOS fees](https://seller.tcgplayer.com/blog/articles/unlocking-the-power-of-binderpos-understanding-the-fee-structure)
- [TCG Sync](https://tcgsync.com/) · [TCG Sync — Crystal Commerce alternative](https://tcgsync.com/alternatives/crystal-commerce-alternative)
- [Storepass](https://storepass.co/) · [ShadowPOS](https://shadowpos.com/) · [SortSwift](https://sortswift.com/) · [TCG Automate](https://www.tcgautomate.com/)
- [Cardmarket vs TCGplayer — which price to trust](https://lensapp.io/card-scanner/cardmarket-vs-tcgplayer/) · [Cardmarket 2026 guide](https://www.cardpulse.club/blog/cardmarket-complete-guide-2026) · [Card Synced (Cardmarket/Brexit alternative)](https://cardsynced.com/compare/cardmarket)
- [Trade-in values & shop economics — Keystone Games](https://www.keystonegames.net/blogs/keystone-games-community-news-1/the-two-sides-of-the-counter-understanding-card-trade-in-values)
- [JustTCG pricing API](https://justtcg.com/) · [PokéTrace developer API](https://poketrace.com/developers) · [Cardmarket API docs](https://help.cardmarket.com/en/cardmarket-api) · [Developer guide to Pokémon price APIs](https://www.pokemonpricetracker.com/blog/posts/developer-guide-pokemon-api)
- [eBay/Pokémon listing tools — NeoSatoshi](https://neosatoshi.com/ebay-pokemon-card-listing-tool) · [Best Pokémon scanner apps 2026 — Eyevo](https://eyevotcg.com/blog/best-pokemon-card-scanner-apps-2026/)
