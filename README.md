# Draft Day — live fantasy football draft tracker

A mobile-first snake-draft tracker built for iPhone/iPad. Deploys as a pure
static site — fully compatible with the **Cloudflare Pages free tier** (no
Functions, KV, or databases required).

## Features

- Configurable league size, rounds, and your draft slot; snake order handled automatically
- Keeper support: pre-assign players to any team + round; those slots are filled and skipped
- Tap-to-mark picks for every team, undo, and full out-of-order editing (fix any past pick, fill any empty slot)
- Searchable player pool with rank, position, team, and bye week; position filters and target stars
- Sticker-wall draft board, roster view with position counts
- Value badges (+N) when a player falls past their ADP or rank
- **Drop-in rankings**: the app seeds from `public/players.csv` at load
- Draft progress auto-saves to `localStorage` (per device/browser)

## Updating rankings

### Option 1 — One tap in the app (no deploy needed)

The **Update rankings** button (Setup screen and More tab) calls
`/api/rankings`, a Cloudflare Pages Function deployed with this site
(`functions/api/rankings.js`). It fetches live consensus ADP from Fantasy
Football Calculator's free public API server-side (no API key, no CORS
issues), normalized to the app's format with position, team, bye, and ADP.
Pick your scoring format (Standard / Half PPR / PPR) next to the button.

Notes:
- Pages Functions are included in the free tier (100,000 requests/day —
  effectively unlimited for a personal tool). Responses cache for 30 min.
- This source is **consensus mock-draft ADP**, not ESPN's editorial cheat
  sheet. Great for live-draft value; if you specifically want ESPN's exact
  ranks, use the CSV workflow below.
- The function only exists on the deployed site. `npm run dev` won't serve
  it — use `npx wrangler pages dev` to test functions locally.

### Option 2 — Drop-in CSV ("drop and go")

**Tracking your list's date:** put a comment as the first line of
`players.csv`, e.g. `# updated: 2026-08-30`. The app shows this on the
Setup screen and More tab as "Last updated" for your CSV list (falling back
to the file's Last-Modified header when the comment is missing). This
matters most for a manually converted ESPN sheet, where staleness is easy
to lose track of. The setup screen also has a **Rankings source** chooser —
tap "My CSV list" or "Live ADP" to switch; the app remembers your choice
and shows what's currently loaded and when it was last updated.

1. Get the latest rankings as CSV (export from a rankings site, or convert a
   PDF cheat sheet — any converter or spreadsheet works).
2. Overwrite `public/players.csv` with the new file.
3. Redeploy (git push, or re-upload — see below). Done.

The CSV is flexible. A header row is recommended; columns can be in any order:

```csv
rank,name,pos,team,bye,adp
1,Ja'Marr Chase,WR,CIN,10,1.2
2,Bijan Robinson,RB,ATL,5,2.0
```

- `rank`, `name` — required (rank falls back to line order if missing)
- `pos` — QB / RB / WR / TE / K / DST (D/ST, DEF, PK are normalized)
- `team`, `bye` — optional but recommended
- `adp` — optional; powers the value badges (rank is used as fallback)
- Tab-separated and headerless data also parse; loose lines like
  `12. Nico Collins WR HOU` work too

Load order on the device: saved draft state in localStorage wins (so a
redeploy mid-draft never clobbers your board), then `players.csv`. Use
**More → Reload from players.csv** to pull the newly deployed file on demand,
or the paste/upload panel to override without any deploy at all. Existing
picks, keepers, and targets are re-matched by player name when rankings
change.

## Local development

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # outputs static site to dist/
```

## Deploying to Cloudflare Pages (free tier)

### Option A — Git integration (recommended)

1. Push this folder to a GitHub/GitLab repo.
2. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git**.
3. Framework preset: **Vite** (or set manually):
   - Build command: `npm run build`
   - Build output directory: `dist`
4. Deploy. Every future `git push` (including just a new `players.csv`)
   triggers a rebuild automatically. Free tier includes 500 builds/month —
   plenty.

### Option B — Direct upload (no git)

```bash
npm install
npm run build
npx wrangler pages deploy dist
```

Or build locally and drag the `dist/` folder into
**Workers & Pages → Create → Pages → Upload assets** in the dashboard.
Note: direct upload deploys the *built* `dist` folder, so run
`npm run build` after changing `players.csv`.

## Data & limitations

- Draft state lives in `localStorage`: per device, per browser. Clearing
  Safari website data (or using Private Browsing) removes/blocks it.
- The one-tap update relies on a third-party public API; if it ever changes
  shape or goes away, the CSV workflow keeps working unchanged. You can
  sanity-check the upstream directly in a browser:
  `https://fantasyfootballcalculator.com/api/v1/adp/half-ppr?teams=12&year=2026`
- After the first load, everything runs client-side; only `players.csv`
  requires a network request, and only when seeding or reloading.
