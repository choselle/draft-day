import { describe, it, expect } from "vitest";
import {
  EDGE_DEFAULTS,
  normalizeEdgeSettings,
  stageGapThreshold,
  strongGapThreshold,
  consensusBand,
  AVAIL_MARGIN,
  costOf,
  availabilityFor,
  availabilityText,
  buildEdgeIndex,
  chooseIndicator,
  recommendationFor,
  edgeExplanation,
  buildEdgeRows,
  filterEdgeRows,
  positionPairNote,
  formatGap,
} from "./draftEdge.js";
import { buildMatchMaps, matchPlayer, normName } from "./playerMatch.js";

/* Minimal player factory matching the app's shape */
let seq = 0;
const P = (rank, name, pos, team, extra = {}) => ({
  id: `${String(name).toLowerCase().replace(/[^a-z0-9]/g, "")}-${String(
    team
  ).toLowerCase()}-${seq++}`,
  rank,
  name,
  pos,
  team,
  bye: "",
  adp: null,
  ...extra,
});

/* A typical mid-draft context: pick 20 on the board, my next pick is
   30, the one after is 42. */
const CTX = {
  currentPick: 20,
  nextPick: 30,
  waitPick: 30,
  windowEnd: 42,
  totalPicks: 160,
  numTeams: 10,
  primaryName: "FantasyPros",
  comparisonName: "ESPN",
};

describe("settings", () => {
  it("defaults to enabled, FantasyPros primary vs ESPN comparison, subtle", () => {
    const s = normalizeEdgeSettings(null);
    expect(s).toEqual({
      enabled: true,
      primary: "fantasypros",
      comparison: "csv",
      level: "subtle",
    });
    expect(EDGE_DEFAULTS.level).toBe("subtle");
  });

  it("preserves saved choices, including disabled", () => {
    const s = normalizeEdgeSettings(
      { enabled: false, primary: "csv", comparison: "web", level: "detailed" },
      ["csv", "fantasypros", "web"]
    );
    expect(s.enabled).toBe(false);
    expect(s.primary).toBe("csv");
    expect(s.comparison).toBe("web");
    expect(s.level).toBe("detailed");
  });

  it("never allows the same list in both roles", () => {
    const s = normalizeEdgeSettings(
      { primary: "csv", comparison: "csv" },
      ["csv", "fantasypros", "web"]
    );
    expect(s.primary).toBe("csv");
    expect(s.comparison).not.toBe("csv");
  });

  it("falls back when a saved source no longer exists", () => {
    const s = normalizeEdgeSettings(
      { primary: "import", comparison: "csv" },
      ["csv", "fantasypros"]
    );
    expect(["csv", "fantasypros"]).toContain(s.primary);
    expect(s.comparison).not.toBe(s.primary);
  });

  it("coerces an invalid display level", () => {
    expect(normalizeEdgeSettings({ level: "loud" }).level).toBe("subtle");
  });
});

describe("draft-stage-aware thresholds", () => {
  it("requires bigger gaps later in the draft", () => {
    expect(stageGapThreshold(10)).toBeLessThan(stageGapThreshold(150));
    expect(stageGapThreshold(1)).toBeGreaterThanOrEqual(4);
  });

  it("treats a 10-pick gap as meaningful early but not late", () => {
    expect(10).toBeGreaterThanOrEqual(stageGapThreshold(20));
    expect(10).toBeLessThan(stageGapThreshold(180));
  });

  it("derives strong and consensus bands from the base threshold", () => {
    expect(strongGapThreshold(50)).toBe(stageGapThreshold(50) * 2);
    expect(consensusBand(50)).toBeGreaterThanOrEqual(2);
    expect(consensusBand(50)).toBeLessThan(stageGapThreshold(50) + 1);
  });
});

describe("buildEdgeIndex — matching and gaps", () => {
  it("computes positive and negative gaps (comparison − primary)", () => {
    const active = [P(1, "Nico Collins", "WR", "HOU")];
    const primary = [P(5, "Nico Collins", "WR", "HOU")];
    const comparison = [P(23, "Nico Collins", "WR", "HOU")];
    const { index } = buildEdgeIndex(active, primary, comparison);
    const e = index.get(active[0].id);
    expect(e.primaryRank).toBe(5);
    expect(e.comparisonRank).toBe(23);
    expect(e.gap).toBe(18); // primary values him 18 spots more

    const { index: index2 } = buildEdgeIndex(active, comparison, primary);
    expect(index2.get(active[0].id).gap).toBe(-18);
  });

  it("matches across suffix and punctuation differences", () => {
    const active = [P(2, "Marvin Harrison Jr.", "WR", "ARI")];
    const primary = [P(9, "Marvin Harrison", "WR", "ARI")];
    const { index } = buildEdgeIndex(active, primary, primary);
    expect(index.get(active[0].id).primaryRank).toBe(9);
  });

  it("matches DSTs by team code, including alias differences", () => {
    const active = [P(30, "Jaguars D/ST", "DST", "JAC")];
    const other = [P(28, "Jacksonville Jaguars", "DST", "JAX")];
    const { index } = buildEdgeIndex(active, other, other);
    expect(index.get(active[0].id).primaryRank).toBe(28);
  });

  it("leaves the gap null when a player is missing from one list", () => {
    const active = [P(1, "Puka Nacua", "WR", "LAR")];
    const primary = [P(4, "Puka Nacua", "WR", "LAR")];
    const comparison = [P(1, "Someone Else", "RB", "DAL")];
    const { index } = buildEdgeIndex(active, primary, comparison);
    const e = index.get(active[0].id);
    expect(e.primaryRank).toBe(4);
    expect(e.comparisonRank).toBeNull();
    expect(e.gap).toBeNull();
  });

  it("refuses ambiguous name-only matches instead of merging", () => {
    const active = [P(50, "Josh Allen", "WR", "JAX")]; // pos matches neither
    const list = [P(3, "Josh Allen", "QB", "BUF"), P(90, "Josh Allen", "TE", "JAX")];
    const { index } = buildEdgeIndex(active, list, list);
    expect(index.get(active[0].id).primaryRank).toBeNull();
  });

  it("reports primary-list players with no active match", () => {
    const active = [P(1, "Nico Collins", "WR", "HOU")];
    const primary = [
      P(5, "Nico Collins", "WR", "HOU"),
      P(6, "Rookie Nobody", "RB", "CHI"),
    ];
    const { primaryOnly } = buildEdgeIndex(active, primary, primary);
    expect(primaryOnly.map((p) => p.name)).toEqual(["Rookie Nobody"]);
  });

  it("prefers the active player's ADP, then either list's", () => {
    const active = [P(1, "A Player", "WR", "KC", { adp: 12 })];
    const primary = [P(2, "A Player", "WR", "KC", { adp: 20 })];
    const { index } = buildEdgeIndex(active, primary, primary);
    expect(index.get(active[0].id).adp).toBe(12);
  });
});

describe("availability", () => {
  it("uses ADP first, then comparison rank, for draft-room cost", () => {
    expect(costOf({ adp: 31, comparisonRank: 50, primaryRank: 10 })).toBe(31);
    expect(costOf({ adp: null, comparisonRank: 50, primaryRank: 10 })).toBe(50);
    expect(costOf({ adp: null, comparisonRank: null, primaryRank: 10 })).toBe(10);
  });

  it("classifies closing / uncertain / likely around my next pick", () => {
    const at = (cost) => availabilityFor({ adp: cost }, CTX);
    expect(at(25)).toBe("closing"); // gone before pick 30
    expect(at(30)).toBe("uncertain");
    expect(at(30 + AVAIL_MARGIN - 1)).toBe("uncertain");
    expect(at(30 + AVAIL_MARGIN)).toBe("likely");
  });

  it("returns null without a cost or without a next pick", () => {
    expect(availabilityFor({ adp: null }, CTX)).toBeNull();
    expect(availabilityFor({ adp: 40 }, { ...CTX, waitPick: null })).toBeNull();
  });

  it("describes availability with round context", () => {
    expect(availabilityText({ adp: 25 }, CTX)).toBe("May be gone near 3.05");
    expect(availabilityText({ adp: 40 }, CTX)).toBe("Likely there at 3.10");
    expect(availabilityText({ adp: 31 }, CTX)).toBe("Toss-up at 3.10");
  });

  it("falls back to plain pick numbers without a league size", () => {
    const noTeams = { ...CTX, numTeams: null };
    expect(availabilityText({ adp: 25 }, noTeams)).toBe("May be gone near pick 25");
  });

  it("says nothing when availability is unknown", () => {
    expect(availabilityText({ adp: null }, CTX)).toBeNull();
    expect(availabilityText({ adp: 40 }, { ...CTX, waitPick: null })).toBeNull();
  });
});

describe("chooseIndicator — one badge, by priority", () => {
  it("puts Closing above even a strong value gap", () => {
    const e = { primaryRank: 13, comparisonRank: 25, gap: 12, adp: 25 };
    expect(chooseIndicator(e, CTX)).toEqual({ type: "closing", label: "Closing" });
  });

  it("shows Value +X when the primary list is meaningfully higher", () => {
    const e = { primaryRank: 30, comparisonRank: 40, gap: 10, adp: 40 };
    expect(chooseIndicator(e, CTX)).toEqual({ type: "value", label: "Value +10" });
  });

  it("labels premiums with the comparison source's name", () => {
    const e = { primaryRank: 40, comparisonRank: 26, gap: -14, adp: 40 };
    expect(chooseIndicator(e, { ...CTX, comparisonName: "Sleeper" })).toEqual({
      type: "premium",
      label: "Sleeper +14",
    });
    expect(chooseIndicator(e, { ...CTX, comparisonName: "Yahoo" }).label).toBe(
      "Yahoo +14"
    );
  });

  it("shows Likely There for watchlisted players inside the window", () => {
    const e = { primaryRank: 34, comparisonRank: 35, gap: 1, adp: 38 };
    expect(chooseIndicator(e, { ...CTX, isTarget: true })).toEqual({
      type: "likely",
      label: "Likely There",
    });
    /* the same player unwatchlisted with a tiny gap gets no badge */
    expect(chooseIndicator(e, CTX)).toBeNull();
  });

  it("shows Consensus only for watchlisted players in the window", () => {
    const e = { primaryRank: 30, comparisonRank: 31, gap: 1, adp: 31 };
    expect(chooseIndicator(e, { ...CTX, isTarget: true }).type).toBe(
      "consensus"
    );
    expect(chooseIndicator(e, CTX)).toBeNull();
  });

  it("doesn't spam Closing on obvious consensus picks at the top", () => {
    // Pick 1.01: the consensus #2 trivially "won't last" — no badge
    const e = { primaryRank: 2, comparisonRank: 2, gap: 0, adp: 2 };
    const start = { ...CTX, currentPick: 1, waitPick: 20, windowEnd: 21 };
    expect(chooseIndicator(e, start)).toBeNull();
    // ...but a watchlisted player in the same spot warns
    expect(chooseIndicator(e, { ...start, isTarget: true }).type).toBe(
      "closing"
    );
  });

  it("stays quiet when nothing is meaningful", () => {
    // small gap, well outside the next-two-picks window
    const e = { primaryRank: 70, comparisonRank: 73, gap: 3, adp: 75 };
    expect(chooseIndicator(e, CTX)).toBeNull();
  });

  it("never emits a comparison badge without both ranks", () => {
    const e = { primaryRank: 10, comparisonRank: null, gap: null, adp: 60 };
    const badge = chooseIndicator(e, CTX);
    expect(badge === null || badge.type === "closing" || badge.type === "likely").toBe(
      true
    );
    expect(["value", "premium", "consensus"]).not.toContain(badge && badge.type);
  });

  it("respects the stage threshold: the same gap goes quiet late", () => {
    const e = { primaryRank: 140, comparisonRank: 150, gap: 10, adp: 210 };
    const late = {
      ...CTX,
      currentPick: 180,
      waitPick: 190,
      windowEnd: 200,
    };
    expect(chooseIndicator(e, late)).toBeNull(); // 10 < threshold(180)
    const early = { ...CTX };
    const e2 = { ...e, adp: 40 };
    expect(chooseIndicator(e2, early).type).toBe("value"); // 10 >= threshold(20)
  });
});

describe("recommendations — deterministic and explainable", () => {
  it("classifies closing value as Target now", () => {
    const e = { primaryRank: 13, comparisonRank: 25, gap: 12, adp: 25 };
    const r = recommendationFor(e, CTX);
    expect(r.key).toBe("target-now");
    expect(r.blurb).toContain("FantasyPros");
  });

  it("classifies a strongly negative closing gap as Reach risk", () => {
    const e = { primaryRank: 30, comparisonRank: 20, gap: -10, adp: 22 };
    const r = recommendationFor(e, CTX);
    expect(r.key).toBe("reach-risk");
    expect(r.blurb).toContain("ESPN");
  });

  it("classifies likely-available strong value as Potential discount", () => {
    const e = { primaryRank: 30, comparisonRank: 40, gap: 10, adp: 40 };
    expect(recommendationFor(e, CTX).key).toBe("potential-discount");
  });

  it("classifies uncertain value as Target next round", () => {
    const e = { primaryRank: 25, comparisonRank: 31, gap: 6, adp: 31 };
    expect(recommendationFor(e, CTX).key).toBe("target-next-round");
  });

  it("agreeing lists read as Consensus", () => {
    const e = { primaryRank: 35, comparisonRank: 36, gap: 1, adp: 38 };
    expect(recommendationFor(e, CTX).key).toBe("consensus");
  });

  it("updates as the draft advances past the player", () => {
    const e = { primaryRank: 50, comparisonRank: 60, gap: 10, adp: 55 };
    const early = recommendationFor(e, CTX); // cost 55 far beyond pick 30
    expect(early.key).toBe("potential-discount");
    const later = recommendationFor(e, {
      ...CTX,
      currentPick: 50,
      waitPick: 58,
      windowEnd: 70,
    });
    expect(later.key).toBe("target-now"); // now inside the closing window
  });

  it("uses whichever source names are selected", () => {
    const e = { primaryRank: 30, comparisonRank: 40, gap: 10, adp: 40 };
    const r = recommendationFor(e, {
      ...CTX,
      primaryName: "Imported",
      comparisonName: "Live ADP",
    });
    expect(r.blurb).toContain("Imported");
    expect(r.blurb).toContain("Live ADP");
  });
});

describe("explanations", () => {
  it("names both sources and the gap size", () => {
    const e = { primaryRank: 5, comparisonRank: 23, gap: 18, adp: 20 };
    const s = edgeExplanation(e, CTX);
    expect(s).toContain("FantasyPros");
    expect(s).toContain("ESPN");
    expect(s).toContain("18 spots");
    expect(s).toContain("#5");
    expect(s).toContain("#23");
  });

  it("explains a one-list player instead of comparing", () => {
    const e = { primaryRank: 12, comparisonRank: null, gap: null, adp: null };
    const s = edgeExplanation(e, CTX);
    expect(s).toContain("don't appear in the ESPN list");
    expect(s).toContain("no comparison");
  });

  it("uses cautious availability language", () => {
    const e = { primaryRank: 30, comparisonRank: 40, gap: 10, adp: 40 };
    expect(edgeExplanation(e, CTX)).toContain("isn't guaranteed");
  });

  it("estimates the departure round for closing players", () => {
    const e = { primaryRank: 13, comparisonRank: 25, gap: 12, adp: 25 };
    expect(edgeExplanation(e, CTX)).toContain("gone near pick 3.05");
  });
});

describe("edge rows + filters", () => {
  const active = [
    P(1, "Value Guy", "WR", "HOU", { adp: 40 }), // gap +10, likely
    P(2, "Closing Guy", "RB", "SF", { adp: 25 }), // closing
    P(3, "Premium Guy", "TE", "LV", { adp: 40 }), // gap -14
    P(4, "Drafted Guy", "WR", "DAL", { adp: 10 }),
    P(5, "Far Guy", "QB", "BUF", { adp: 120 }), // outside window
  ];
  const withRanks = (ranks) =>
    active.map((p, i) => ({ ...p, rank: ranks[i] }));
  const primary = withRanks([30, 13, 40, 8, 100]);
  const comparison = withRanks([40, 25, 26, 9, 103]);
  const { index } = buildEdgeIndex(active, primary, comparison);
  const draftedIds = new Map([
    [active[3].id, { overall: 10, teamIdx: 2, playerId: active[3].id }],
  ]);
  const rows = buildEdgeRows(active, index, CTX, {
    draftedIds,
    targets: [active[0].id],
  });

  it("attaches indicators and recommendations to available players", () => {
    expect(rows[0].indicator.type).toBe("value");
    expect(rows[1].indicator.type).toBe("closing");
    expect(rows[1].rec.key).toBe("target-now"); // gap +12 and closing
    expect(rows[2].indicator.type).toBe("premium");
  });

  it("drops indicators and recs for drafted players", () => {
    expect(rows[3].drafted).toBeTruthy();
    expect(rows[3].indicator).toBeNull();
    expect(rows[3].rec).toBeNull();
  });

  it("filters drafted players out by default", () => {
    const f = filterEdgeRows(
      rows,
      { pos: "ALL", availableOnly: true, watchOnly: false, cat: "ALL", window: "all" },
      CTX
    );
    expect(f.map((r) => r.player.name)).not.toContain("Drafted Guy");
  });

  it("recomputes after an undo (player back in the pool)", () => {
    const undone = buildEdgeRows(active, index, CTX, {
      draftedIds: new Map(),
      targets: [],
    });
    expect(undone[3].drafted).toBeNull();
    expect(undone[3].rec).not.toBeNull();
  });

  it("supports position, watchlist, category, and window filters", () => {
    const base = { pos: "ALL", availableOnly: true, watchOnly: false, cat: "ALL", window: "all" };
    expect(
      filterEdgeRows(rows, { ...base, pos: "RB" }, CTX).map((r) => r.player.name)
    ).toEqual(["Closing Guy"]);
    expect(
      filterEdgeRows(rows, { ...base, watchOnly: true }, CTX).map((r) => r.player.name)
    ).toEqual(["Value Guy"]);
    expect(
      filterEdgeRows(rows, { ...base, cat: "closing" }, CTX).map((r) => r.player.name)
    ).toEqual(["Closing Guy"]);
    expect(
      filterEdgeRows(rows, { ...base, cat: "premiums" }, CTX).map((r) => r.player.name)
    ).toEqual(["Premium Guy"]);
    const near = filterEdgeRows(rows, { ...base, window: "next2" }, CTX);
    expect(near.map((r) => r.player.name)).not.toContain("Far Guy");
  });
});

describe("position comparison notes", () => {
  it("describes disagreements in plain language", () => {
    const a = {
      player: { name: "Player A" },
      entry: { primaryRank: 10, comparisonRank: 22 },
    };
    const b = {
      player: { name: "Player B" },
      entry: { primaryRank: 22, comparisonRank: 17 },
    };
    const note = positionPairNote(a, b, CTX);
    expect(note).toContain("FantasyPros prefers Player A by 12 spots");
    expect(note).toContain("ESPN prefers Player B by 5 spots");
  });

  it("stays silent when the sources agree on the order", () => {
    const a = { player: { name: "A" }, entry: { primaryRank: 10, comparisonRank: 11 } };
    const b = { player: { name: "B" }, entry: { primaryRank: 12, comparisonRank: 15 } };
    expect(positionPairNote(a, b, CTX)).toBeNull();
  });
});

describe("shared matching helpers stay reused", () => {
  it("normalizes suffixes and punctuation the same way the app does", () => {
    expect(normName("Ja'Marr Chase")).toBe(normName("JaMarr Chase"));
    expect(normName("Michael Pittman Jr.")).toBe(normName("Michael Pittman"));
  });

  it("matches through the shared maps", () => {
    const maps = buildMatchMaps([P(1, "Bijan Robinson", "RB", "ATL")]);
    expect(matchPlayer(maps, "Bijan Robinson", "RB", "ATL")).not.toBeNull();
  });
});

describe("formatting", () => {
  it("formats gaps with an explicit sign", () => {
    expect(formatGap(12)).toBe("+12");
    expect(formatGap(-7)).toBe("-7");
    expect(formatGap(0)).toBe("0");
    expect(formatGap(null)).toBe("—");
  });
});
