# willhaben-scraper

Personal apartment-hunting tool for Vienna rentals on willhaben.at. Scrapes listings matching personal criteria, generates a self-contained HTML dashboard for browsing, filtering, and tracking.

## Goal

Automate the tedious part of flat-hunting: pulling all matching listings from willhaben, scoring them against hard requirements (bathtub, cellar, storage), and presenting them in one browsable view with persistent star/hide state.

## Architecture

```
run.js         — scraper + HTML generator (Playwright, Node.js)
server.js      — thin HTTP server (port 3737)
listings.html  — generated single-page app (output artifact)
scraper.js     — browser console version (manual use)
```

Single pipeline: `run.js` scrapes → writes `listings.html` → `server.js` serves it → browser renders the SPA. No database, no framework, no build step.

## How Scraping Works (`run.js`)

Uses Playwright (Chromium) to load willhaben search result pages and extract data from the embedded `__NEXT_DATA__` JSON blob — the Next.js server-side hydration payload. No DOM parsing or CSS selectors; the structured data is cleaner and more reliable.

Paginates automatically (30 listings/page) until all results are fetched.

### Search Parameters (`URL_BUILDER`)

| Parameter | Value |
|-----------|-------|
| Districts | 14 Vienna Bezirke (AREA_IDs) |
| Rooms | 3+ (`NO_OF_ROOMS_BUCKET=3X3`) |
| Price | ≤ €1700/month |
| Area | ≥ 72 m² |
| Server-side feature filters | Off by default (noisy — sellers don't always tag) |

### Feature Detection (`detectFeatures`)

Two-pass detection per listing:

1. **Structured fields** — `ESTATE_PREFERENCE` codes (Keller=250, Abstellraum=24, Lift=4, …) and `FREE_AREA_TYPE_NAME` (Balkon, Loggia, …). Source tagged as `"field"` → solid badge border.
2. **Full-text regex** — all attribute values concatenated and searched for German synonyms (e.g. `wanne` → Badewanne, `kellerabteil` → Keller). Source tagged as `"text"` → dashed badge border.

Text detection catches listings where sellers forgot to tick the feature checkbox.

### Criteria vs. Features

**Hard criteria** (shown as ✓/✗ badges, affect `dim` state):
- Badewanne (bathtub)
- Keller (cellar)
- Abstellraum (storage room)

**Informational label** (bold, not a pass/fail):
- Outdoor — any of Balkon, Loggia, Terrasse, Dachterrasse, Garten, Wintergarten. Green bold if present, gray strikethrough if absent. Does not affect dim.

**Warning** (amber badge):
- Möbliert (furnished) — detected via `ESTATE_PREFERENCE=28` or text match

Listings missing any hard criterion get `class="dim"` → reduced opacity + slight grayscale. "Matching only" filter hides dim cards.

Feature badges strip criteria labels (already shown in criteria bar) to avoid duplication. Extra amenities (Lift, Garage, Parkplatz, Barrierefrei, …) appear as blue badges.

## Generated UI (`listings.html`)

Self-contained SPA — all HTML, CSS, and JS inline. No external dependencies.

### Header Controls

- **Sort** dropdown: Price, m², €/m² (asc/desc)
- **District** dropdown: populated from scraped data
- **Matching only** — hide dim (criteria-failing) listings
- **Starred** — show only starred listings
- **Show hidden** — reveal hidden listings at low opacity
- **↺ Re-scrape** — POST `/refresh`, polls `/status` every 1.5s, reloads on completion

### Card Layout

```
[ image | image | image ]
Title (link to willhaben)
Location / district
Price · m² · rooms · €/m²
[✓ Badewanne] [✗ Keller] [✓ Abstellraum] [Outdoor bold label]
[Lift] [Garage] ...feature badges...
Description snippet
[ ☆ Star ]  [ Hide ]
```

### Persistence

`localStorage` key `willhaben_v1` stores starred and hidden URL sets. Survives page reloads and re-scrapes.

### Dim Logic

Cards with all three hard criteria passing are normal. Cards missing any criterion get `opacity: 0.55; filter: grayscale(20%)`. On page load, JS recalculates dim state from the rendered criteria bar (allows retroactive rule changes without re-scraping).

## Server (`server.js`)

Minimal Node.js `http` server, no dependencies.

| Route | Method | Purpose |
|-------|--------|---------|
| `/` | GET | Serve `listings.html` |
| `/refresh` | POST | Spawn `node run.js`, returns 409 if already running |
| `/status` | GET | `{ scraping: bool, lastLog: string[] }` — last 5 stdout lines |

Opens browser automatically via `xdg-open` on start.

## Running

```bash
# One-off scrape
node run.js

# Serve + live re-scrape from UI
node server.js
# → http://localhost:3737
```

Requires Playwright browsers: `npx playwright install chromium`
