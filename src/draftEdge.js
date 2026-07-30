/* ============================================================
   DRAFT EDGE — compares two ranking lists to suggest when to
   draft a player.

   The Primary list estimates player value; the Comparison list
   estimates draft-room cost (or an alternate market opinion).
   rankingGap = comparisonRank - primaryRank:
     positive → Primary values the player more (possible value)
     negative → Comparison values them more (room takes them early)

   Everything here is pure and deterministic so it can be unit
   tested without React: thresholds scale with the current pick,
   availability comes from ADP (falling back to comparison rank),
   and one indicator is chosen per player by priority
   (Closing > Value/Premium > Likely There > Consensus).
   ============================================================ */

import { buildMatchMaps, matchPlayer } from "./playerMatch.js";
import { pickLabel } from "./snake.js";

export const EDGE_LEVELS = ["off", "subtle", "detailed"];

export const EDGE_DEFAULTS = {
  enabled: false, // opt-in from Setup or the More tab
  primary: "fantasypros", // FantasyPros
  comparison: "csv", // "csv" is the ESPN key (saved-state compatibility)
  level: "subtle",
};

/* Merge saved settings over the defaults, coercing anything invalid.
   The two roles must never point at the same list: if they collide,
   the comparison moves to the first other available source. */
export function normalizeEdgeSettings(saved, sourceKeys) {
  const s = { ...EDGE_DEFAULTS, ...(saved || {}) };
  s.enabled = !!s.enabled;
  if (!EDGE_LEVELS.includes(s.level)) s.level = EDGE_DEFAULTS.level;
  const keys =
    sourceKeys && sourceKeys.length
      ? sourceKeys
      : [EDGE_DEFAULTS.primary, EDGE_DEFAULTS.comparison];
  if (!keys.includes(s.primary)) s.primary = keys[0];
  if (!keys.includes(s.comparison) || s.comparison === s.primary)
    s.comparison = keys.find((k) => k !== s.primary) || null;
  return s;
}

/* ---------- draft-stage-aware thresholds ----------
   A 10-spot disagreement is a big deal at pick 15 and noise at
   pick 150, so the "meaningful gap" bar rises with the pick. */
export function stageGapThreshold(overallPick) {
  return Math.min(24, Math.max(4, Math.round((overallPick || 1) * 0.1)));
}
export function strongGapThreshold(overallPick) {
  return stageGapThreshold(overallPick) * 2;
}
/* Gaps at or under this band mean the lists effectively agree */
export function consensusBand(overallPick) {
  return Math.max(2, Math.round(stageGapThreshold(overallPick) / 2));
}

/* Picks of cushion required before we call a player "likely there" */
export const AVAIL_MARGIN = 3;

/* Best estimate of when the room takes this player: ADP when we have
   it, else the Comparison rank (the "market" list), else Primary. */
export function costOf(entry) {
  if (!entry) return null;
  if (entry.adp != null) return entry.adp;
  if (entry.comparisonRank != null) return entry.comparisonRank;
  return entry.primaryRank != null ? entry.primaryRank : null;
}

/* ctx.waitPick = the user's next chance to draft after the current
   decision (their next pick, or the one after when already on the
   clock). Returns 'closing' | 'likely' | 'uncertain' | null. */
export function availabilityFor(entry, ctx) {
  const cost = costOf(entry);
  if (cost == null || !ctx || ctx.waitPick == null) return null;
  if (cost < ctx.waitPick) return "closing";
  if (cost >= ctx.waitPick + AVAIL_MARGIN) return "likely";
  return "uncertain";
}

/* Availability with round context, e.g. "May be gone near 2.08" or
   "Likely there at 3.01". The estimate stays hedged — cost is an
   opinion, not a schedule. Falls back to plain-pick wording when the
   ctx has no league size, and to null when there's nothing to say. */
export function availabilityText(entry, ctx) {
  const avail = availabilityFor(entry, ctx);
  if (avail == null || !ctx) return null;
  const at = (overall) => {
    const o = Math.round(
      Math.max(1, ctx.totalPicks ? Math.min(overall, ctx.totalPicks) : overall)
    );
    return ctx.numTeams ? pickLabel(o, ctx.numTeams) : `pick ${o}`;
  };
  if (avail === "closing") return `May be gone near ${at(costOf(entry))}`;
  if (avail === "likely") return `Likely there at ${at(ctx.waitPick)}`;
  return `Toss-up at ${at(ctx.waitPick)}`;
}

/* ---------- cross-list index ----------
   The active player list (the one picks/targets reference) is the
   spine; each active player is matched into both Draft Edge lists.
   Players found in only one list get null ranks and never produce a
   comparison indicator. Primary-list players with no active match are
   reported separately so the tab can show them as info-only rows. */
export function buildEdgeIndex(activePlayers, primaryPlayers, comparisonPlayers) {
  const pMaps = buildMatchMaps(primaryPlayers);
  const cMaps = buildMatchMaps(comparisonPlayers);
  const index = new Map();
  const matchedPrimary = new Set();
  for (const p of activePlayers) {
    const pm = matchPlayer(pMaps, p.name, p.pos, p.team);
    const cm = matchPlayer(cMaps, p.name, p.pos, p.team);
    if (pm) matchedPrimary.add(pm.id);
    const primaryRank = pm ? pm.rank : null;
    const comparisonRank = cm ? cm.rank : null;
    index.set(p.id, {
      primaryRank,
      comparisonRank,
      gap:
        primaryRank != null && comparisonRank != null
          ? comparisonRank - primaryRank
          : null,
      adp:
        p.adp != null
          ? p.adp
          : pm && pm.adp != null
          ? pm.adp
          : cm && cm.adp != null
          ? cm.adp
          : null,
    });
  }
  const primaryOnly = primaryPlayers.filter((p) => !matchedPrimary.has(p.id));
  return { index, primaryOnly };
}

/* ---------- one indicator per player ----------
   Priority: Closing (time-sensitive) > meaningful Value/Premium >
   Likely There > Consensus. Returns { type, label } or null — most
   players should get no badge at all, so the timing badges only
   appear when the player is actually a decision for the user:
   watchlisted, or carrying at least mild Primary-list value. (At
   pick 1 "the consensus #1 won't last until your next turn" is
   trivially true and would badge the whole first screen.) */
export function chooseIndicator(entry, ctx) {
  if (!entry || !ctx || ctx.currentPick == null) return null;
  const { gap } = entry;
  const t = stageGapThreshold(ctx.currentPick);
  const band = consensusBand(ctx.currentPick);
  const avail = availabilityFor(entry, ctx);
  const cost = costOf(entry);
  const inWindow =
    cost != null && ctx.windowEnd != null && cost <= ctx.windowEnd;
  const cares = ctx.isTarget || (gap != null && gap >= Math.ceil(t / 2));

  if (avail === "closing" && cares)
    return { type: "closing", label: "Closing" };
  if (gap != null && gap >= t) return { type: "value", label: `Value +${gap}` };
  if (gap != null && -gap >= t)
    return { type: "premium", label: `${ctx.comparisonName} +${-gap}` };
  if (avail === "likely" && inWindow && cares)
    return { type: "likely", label: "Likely There" };
  if (
    ctx.isTarget &&
    gap != null &&
    Math.abs(gap) <= band &&
    inWindow &&
    avail != null
  )
    return { type: "consensus", label: "Consensus" };
  return null;
}

/* ---------- deterministic recommendation ----------
   Classifies a player for the Draft Edge tab from availability plus
   the ranking gap. Every label is explainable from those two inputs. */
export function recommendationFor(entry, ctx) {
  if (!entry || !ctx || ctx.currentPick == null) return null;
  const gap = entry.gap;
  const has = gap != null;
  const t = stageGapThreshold(ctx.currentPick);
  const strong = strongGapThreshold(ctx.currentPick);
  const band = consensusBand(ctx.currentPick);
  const avail = availabilityFor(entry, ctx);
  const pn = ctx.primaryName;
  const cn = ctx.comparisonName;
  const rec = (key, label, blurb) => ({ key, label, blurb });

  if (avail === "closing") {
    if (has && gap >= t)
      return rec(
        "target-now",
        "Target now",
        `${pn} sees value here, and the player may not last until your next pick.`
      );
    if (has && -gap >= strong)
      return rec(
        "reach-risk",
        "Reach risk",
        `${cn} takes this player much earlier than ${pn} would — drafting now may be a reach.`
      );
    if (has && -gap >= t)
      return rec(
        "comparison-premium",
        "Comparison premium",
        `${cn} rates this player higher, so expect them to go earlier than ${pn} suggests.`
      );
    return rec(
      "closing-window",
      "Closing window",
      "This player may not reasonably last until your next pick."
    );
  }
  if (avail === "likely") {
    if (has && gap >= strong)
      return rec(
        "potential-discount",
        "Potential discount",
        `${pn} ranks this player well above ${cn} — a discount may be there if you wait, though nothing is guaranteed.`
      );
    if (has && gap >= t)
      return rec(
        "safe-to-wait",
        "Safe to wait",
        `A reasonable chance to still be there at your next pick, with ${pn} seeing extra value.`
      );
    if (has && -gap >= t)
      return rec(
        "monitor",
        "Monitor",
        `${cn} is higher on this player than ${pn} — no clear edge in waiting.`
      );
    if (has && Math.abs(gap) <= band)
      return rec(
        "consensus",
        "Consensus",
        `${pn} and ${cn} broadly agree, and waiting looks reasonable.`
      );
    return rec(
      "safe-to-wait",
      "Safe to wait",
      "A reasonable chance to remain available at your next pick."
    );
  }
  if (has && gap >= t)
    return rec(
      "target-next-round",
      "Target next round",
      `${pn} values this player more than ${cn}; availability at your next pick is uncertain.`
    );
  if (has && -gap >= t)
    return rec(
      "comparison-premium",
      "Comparison premium",
      `${cn} rates this player higher — they may be taken earlier than ${pn} suggests.`
    );
  if (has && Math.abs(gap) <= band)
    return rec("consensus", "Consensus", `${pn} and ${cn} broadly agree on this player.`);
  return rec("monitor", "Monitor", "No clear ranking edge right now.");
}

/* Concise explanation naming both selected sources; cautious about
   availability. Used by the player detail sheet and the Edge tab. */
export function edgeExplanation(entry, ctx) {
  if (!ctx) return null;
  if (!entry || entry.primaryRank == null || entry.comparisonRank == null) {
    if (entry && entry.primaryRank != null)
      return `${ctx.primaryName} ranks this player #${entry.primaryRank}, but they don't appear in the ${ctx.comparisonName} list, so no comparison is available.`;
    if (entry && entry.comparisonRank != null)
      return `${ctx.comparisonName} ranks this player #${entry.comparisonRank}, but they don't appear in the ${ctx.primaryName} list, so no comparison is available.`;
    return null;
  }
  const gap = entry.gap;
  const avail = availabilityFor(entry, ctx);
  const spots = (n) => `${n} spot${n === 1 ? "" : "s"}`;
  let s;
  if (gap > 0)
    s = `${ctx.primaryName} ranks this player ${spots(gap)} higher than ${ctx.comparisonName} (#${entry.primaryRank} vs #${entry.comparisonRank}).`;
  else if (gap < 0)
    s = `${ctx.comparisonName} ranks this player ${spots(-gap)} higher than ${ctx.primaryName} (#${entry.comparisonRank} vs #${entry.primaryRank}).`;
  else
    s = `${ctx.primaryName} and ${ctx.comparisonName} both rank this player #${entry.primaryRank}.`;
  if (avail === "closing") {
    const cost = costOf(entry);
    s +=
      ctx.numTeams && cost != null
        ? ` They may be gone near pick ${pickLabel(
            Math.round(Math.max(1, ctx.totalPicks ? Math.min(cost, ctx.totalPicks) : cost)),
            ctx.numTeams
          )}, before your next pick.`
        : " They may not last until your next pick.";
  } else if (avail === "likely")
    s +=
      " They have a reasonable chance of lasting until your next pick, though that isn't guaranteed.";
  else if (avail === "uncertain")
    s += " Availability at your next pick is a toss-up — waiting carries some risk.";
  return s;
}

/* Rows for the Draft Edge tab: every active player with its entry,
   drafted status, availability, indicator, and recommendation. */
export function buildEdgeRows(players, index, ctx, opts) {
  const targets = new Set((opts && opts.targets) || []);
  const draftedIds = (opts && opts.draftedIds) || new Map();
  const rows = [];
  for (const p of players) {
    const entry = index ? index.get(p.id) || null : null;
    const drafted = draftedIds.get(p.id) || null;
    const isTarget = targets.has(p.id);
    const c = ctx ? { ...ctx, isTarget } : null;
    rows.push({
      player: p,
      entry,
      drafted,
      isTarget,
      cost: costOf(entry),
      availability: drafted ? null : availabilityFor(entry, ctx),
      indicator: drafted ? null : chooseIndicator(entry, c),
      rec: drafted ? null : recommendationFor(entry, c),
    });
  }
  return rows;
}

/* Filters for the full comparison view. filters:
   { pos, availableOnly, watchOnly, cat, window } */
export function filterEdgeRows(rows, filters, ctx) {
  const t = ctx ? stageGapThreshold(ctx.currentPick) : 4;
  const band = ctx ? consensusBand(ctx.currentPick) : 2;
  return rows.filter((r) => {
    if (filters.availableOnly && r.drafted) return false;
    if (filters.watchOnly && !r.isTarget) return false;
    if (filters.pos && filters.pos !== "ALL" && r.player.pos !== filters.pos)
      return false;
    if (filters.cat && filters.cat !== "ALL") {
      const g = r.entry ? r.entry.gap : null;
      if (filters.cat === "values" && !(g != null && g >= t)) return false;
      if (filters.cat === "closing" && r.availability !== "closing") return false;
      if (filters.cat === "premiums" && !(g != null && -g >= t)) return false;
      if (filters.cat === "consensus" && !(g != null && Math.abs(g) <= band))
        return false;
    }
    if (filters.window && filters.window !== "all" && ctx) {
      const limit =
        filters.window === "next"
          ? ctx.waitPick != null
            ? ctx.waitPick
            : ctx.windowEnd
          : ctx.windowEnd;
      if (r.cost == null) return false;
      if (limit != null && r.cost > limit + t) return false;
    }
    return true;
  });
}

/* Plain-language note for the position comparison view when the two
   sources disagree on the order of players a and b (a = better
   Primary rank). Returns null when the sources agree. */
export function positionPairNote(a, b, ctx) {
  if (
    !a.entry ||
    !b.entry ||
    a.entry.primaryRank == null ||
    b.entry.primaryRank == null ||
    a.entry.comparisonRank == null ||
    b.entry.comparisonRank == null
  )
    return null;
  const pDiff = b.entry.primaryRank - a.entry.primaryRank;
  const cDiff = a.entry.comparisonRank - b.entry.comparisonRank;
  if (cDiff <= 0) return null;
  const spots = (n) => `${n} spot${n === 1 ? "" : "s"}`;
  const art = /^[aeio]/i.test(ctx.comparisonName) ? "an" : "a";
  return `${ctx.primaryName} prefers ${a.player.name} by ${spots(pDiff)}, while ${ctx.comparisonName} prefers ${b.player.name} by ${spots(cDiff)}. ${a.player.name} may offer better ${ctx.primaryName} value, but ${b.player.name} may go earlier in ${art} ${ctx.comparisonName}-style room.`;
}

export function formatGap(gap) {
  if (gap == null) return "—";
  return gap > 0 ? `+${gap}` : `${gap}`;
}
