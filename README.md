# Chibz Apps — Draft Day

This repo feeds **two Cloudflare Pages projects**:

- **draftday.chibzapps.com** — **Draft Day**, a mobile-first live fantasy
  football snake-draft tracker (Vite + React, `src/`), built with
  `npm run build` → `dist/`. `functions/api/rankings.js` serves
  `/api/rankings` (live consensus ADP proxy).
- **chibzapps.com** — static landing page (`landing/`), built with
  `npm run build:landing` → `dist-landing/`. Its `_redirects` sends the
  old `/draftday/*` paths to the subdomain.

Fully compatible with the **Cloudflare Pages free tier**.

## Draft Day features

- Configurable league size, rounds, and your draft slot; snake order handled automatically (defaults: 10 teams, PPR)
- Keeper support: pre-assign players to any team + round; those slots are filled and skipped
- Tap-to-mark picks for every team, undo, and full out-of-order editing (fix any past pick, fill any empty slot)
- Searchable player pool with rank, position, team, and bye week; position filters and target stars
- Sticker-wall draft board, roster view with position counts
- Value badges (+N) when a player falls past their ADP or rank
- **Drop-in rankings**: the app seeds from per-scoring CSVs in `public/`
- Draft progress auto-saves to `localStorage` (per device/browser)

## Rankings sources

### Drop-in CSVs (default, updated by the bot)

Two CSV providers ship with the site (pick one from the source tiles or
the dropdown next to the search bar; `CSV_SOURCES` in `src/App.jsx`
defines them):

| Provider    | Scoring  | File tried first                   | Fallbacks                        |
| ----------- | -------- | ---------------------------------- | -------------------------------- |
| ESPN        | PPR      | `players-ppr.csv`                  | `players.csv`                    |
| ESPN        | Half PPR | `players-half-ppr.csv`             | `players-ppr.csv`, `players.csv` |
| ESPN        | Standard | `players-standard.csv`             | `players.csv`                    |
| FantasyPros | any      | `players-fantasypros-<scoring>.csv` | —                                |

(ESPN only publishes PPR and Standard sheets and calls PPR near-identical
to Half PPR, hence the Half PPR fallback. FantasyPros publishes all three.)

A separate bot process (`lars-draft-bot`) watches the source sheets and
pushes updated files to the **`rankings-data` branch**. The app fetches
each CSV from that branch first (via raw.githubusercontent.com — no PR,
merge, or redeploy needed for a data update) and falls back to the copies
deployed with the site, which also keeps the offline path working. The ESPN header format
(`overall_rank,position,position_rank,name,team,auction_value,bye_week,source_last_update_date`)
parses as-is, and generic headers (`rank,name,pos,team,bye,adp` in any
order), TSV, headerless, and loose lines all work too.

Optional comment lines at the top of a CSV:

- `# updated: 2026-08-30` — shown as the list's "Last updated" (a date
  column also works; falls back to the HTTP Last-Modified header)
- `# source: FantasyPros` — overrides the "ESPN" source label in the UI

### Live ADP (one tap, no deploy)

The **Update rankings** button calls `/api/rankings`, which
fetches live consensus ADP from FantasyFootballCalculator.com's free public
API server-side (no API key, no CORS issues). Pick Standard / Half PPR /
PPR next to the button. Responses cache for 30 minutes; Pages Functions
free tier allows 100,000 requests/day. This is consensus mock-draft ADP,
not ESPN's editorial sheet — great for live value, different list.

### Paste/upload

The import panel accepts pasted text or a CSV/TSV file at any time and
overrides everything; a hand-imported list is never silently replaced by a
scoring switch. Existing picks, keepers, and targets re-match by player
name whenever rankings change.

## Local development

```bash
npm install
npm run dev            # app: http://localhost:5173
npm run build          # app -> dist/
npm run build:landing  # landing page -> dist-landing/
```

The Vite dev server also runs the rankings Pages Function locally (see
`pagesDevShim` in `vite.config.js`), so Live ADP works in dev.

## Deployment

Two Cloudflare Pages projects, both on Git integration against `main`:

| Project | Domain | Build command | Output |
| --- | --- | --- | --- |
| draft-day (app) | draftday.chibzapps.com | `npm run build` | `dist` |
| landing | chibzapps.com | `npm run build:landing` | `dist-landing` |

The `functions/` directory deploys with both projects (harmless on the
landing project). Every merge to `main` (including bot ranking PRs)
triggers deploys; PRs get preview URLs.

`main` is branch-protected: changes go through PRs with one approval
(repo owner exempt).

## Data & limitations

- Draft state lives in `localStorage`: per device, per browser. Clearing
  Safari website data (or using Private Browsing) removes/blocks it.
- The one-tap update relies on a third-party public API; if it ever changes
  shape or goes away, the CSV workflow keeps working unchanged. Sanity-check
  the upstream directly:
  `https://fantasyfootballcalculator.com/api/v1/adp/ppr?teams=10&year=2026`
- After the first load, everything runs client-side; only the seed CSVs
  require a network request, and only when seeding or reloading.
