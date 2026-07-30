/* ---------- cross-source player matching ----------
   Sources spell players differently (suffixes, punctuation) and name
   team defenses differently ("Broncos D/ST" vs "Denver Broncos"), so
   picks re-link across sources by normalized name + position, with a
   name-only fallback that refuses ambiguous matches. DSTs match by
   team code. Shared by the app and Draft Edge list comparison. */

export function makeId(name, team) {
  return (
    String(name).toLowerCase().replace(/[^a-z0-9]/g, "") +
    "-" +
    String(team || "").toLowerCase()
  );
}

export function normName(name) {
  return String(name)
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, "")
    .replace(/[^a-z]/g, "");
}

export const TEAM_ALIAS = { jac: "jax", la: "lar", wsh: "was", sd: "lac" };

export function dstKey(team) {
  const t = String(team || "").toLowerCase();
  return `dst|${TEAM_ALIAS[t] || t}`;
}

export function buildMatchMaps(players) {
  const byKey = new Map(); // "name|pos" and "dst|team"
  const byName = new Map(); // normName -> player, or null when ambiguous
  for (const p of players) {
    if (p.pos === "DST") {
      byKey.set(dstKey(p.team), p);
      continue;
    }
    const n = normName(p.name);
    byKey.set(`${n}|${p.pos}`, p);
    byName.set(n, byName.has(n) ? null : p);
  }
  return { byKey, byName };
}

export function matchPlayer(maps, name, pos, team) {
  if (pos === "DST") return maps.byKey.get(dstKey(team)) || null;
  const n = normName(name);
  return maps.byKey.get(`${n}|${pos}`) || maps.byName.get(n) || null;
}
