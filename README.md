# Chibz Apps — Draft Day

This repo deploys **chibzapps.com** as one Cloudflare Pages site:

- `/` — static landing page (`landing/index.html`) linking to the apps
- `/draftday/` — **Draft Day**, a mobile-first live fantasy football
  snake-draft tracker (Vite + React, `src/`)
- `/draftday/api/rankings` — Pages Function
  (`functions/draftday/api/rankings.js`) proxying live consensus ADP

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

### ESPN CSVs (default, updated by the bot)

The app seeds from `public/players-<scoring>.csv` for the selected scoring
format:

| Scoring  | File tried first          | Fallbacks                        |
| -------- | ------------------------- | -------------------------------- |
| PPR      | `players-ppr.csv`         | `players.csv`                    |
| Half PPR | `players-half-ppr.csv`    | `players-ppr.csv`, `players.csv` |
| Standard | `players-standard.csv`    | `players.csv`                    |

(ESPN only publishes PPR and Standard sheets and calls PPR near-identical
to Half PPR, hence the Half PPR fallback.)

A separate bot process (`lars-draft-bot`) watches ESPN's sheet and opens a
PR updating these files whenever it changes; merging the PR redeploys the
site. The ESPN header format
(`overall_rank,position,position_rank,name,team,auction_value,bye_week,source_last_update_date`)
parses as-is, and generic headers (`rank,name,pos,team,bye,adp` in any
order), TSV, headerless, and loose lines all work too.

Optional comment lines at the top of a CSV:

- `# updated: 2026-08-30` — shown as the list's "Last updated" (a date
  column also works; falls back to the HTTP Last-Modified header)
- `# source: FantasyPros` — overrides the "ESPN" source label in the UI

### Live ADP (one tap, no deploy)

The **Update rankings** button calls `/draftday/api/rankings`, which
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
npm run dev      # landing: http://localhost:5173  ·  app: http://localhost:5173/draftday/
npm run build    # static site in dist/ (landing at root, app in dist/draftday/)
```

The Vite dev server also runs the rankings Pages Function locally (see
`pagesDevShim` in `vite.config.js`), so Live ADP works in dev.

## Deployment

Cloudflare Pages, Git integration: production branch `main`, build command
`npm run build`, output directory `dist`. The `functions/` directory is
picked up automatically. Every merge to `main` (including bot ranking PRs)
triggers a deploy; PRs get preview URLs.

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
