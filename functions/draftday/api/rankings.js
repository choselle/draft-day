/* Cloudflare Pages Function: GET /draftday/api/rankings?format=half-ppr&teams=12
 *
 * Proxies Fantasy Football Calculator's public ADP API (free, no API key)
 * and normalizes it to the app's player shape. Runs server-side on
 * Cloudflare's edge, so there are no CORS issues in the browser.
 *
 * Free-tier friendly: Pages Functions include 100,000 requests/day.
 * Responses are cached for 30 minutes.
 */

const FORMATS = new Set(["standard", "ppr", "half-ppr"]);
const POS_MAP = { DEF: "DST", PK: "K" };

export async function onRequestGet({ request }) {
  const url = new URL(request.url);

  const fmtParam = url.searchParams.get("format");
  const format = FORMATS.has(fmtParam) ? fmtParam : "half-ppr";

  // FFC supports 8/10/12/14-team ADP; clamp anything else
  const t = parseInt(url.searchParams.get("teams") || "12", 10);
  const teams = [8, 10, 12, 14].includes(t)
    ? t
    : t <= 8 ? 8 : t >= 14 ? 14 : t % 2 === 0 ? t : 12;

  const thisYear = new Date().getFullYear();
  let lastError = "no data";

  // Early in the offseason the current year may not have ADP yet —
  // fall back to last season rather than failing.
  for (const year of [thisYear, thisYear - 1]) {
    const upstream = `https://fantasyfootballcalculator.com/api/v1/adp/${format}?teams=${teams}&year=${year}`;
    try {
      const res = await fetch(upstream, {
        headers: { accept: "application/json" },
        cf: { cacheTtl: 1800, cacheEverything: true },
      });
      if (!res.ok) {
        lastError = `upstream returned ${res.status}`;
        continue;
      }
      const data = await res.json();
      const players = (data.players || []).map((p, i) => ({
        rank: i + 1,
        name: p.name,
        pos: POS_MAP[p.position] || p.position,
        team: p.team || "",
        bye: p.bye != null ? String(p.bye) : "",
        adp: p.adp != null ? Math.round(Number(p.adp)) : null,
      }));
      if (!players.length) {
        lastError = `no players for ${year}`;
        continue;
      }
      return Response.json(
        {
          source: "Fantasy Football Calculator consensus ADP",
          format,
          teams,
          year,
          updated: new Date().toISOString(),
          players,
        },
        { headers: { "cache-control": "public, max-age=1800" } }
      );
    } catch (err) {
      lastError = String(err && err.message ? err.message : err);
    }
  }

  return Response.json(
    { error: `Couldn't fetch rankings (${lastError}). Use the CSV import instead.` },
    { status: 502 }
  );
}
