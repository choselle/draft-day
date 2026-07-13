import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";

/* ============================================================
   DRAFT DAY — live fantasy football draft tracker
   - Snake draft with configurable league size, rounds, your slot
   - KEEPERS: pre-assign players to any team + round before pick 1;
     those slots are filled and skipped automatically
   - Tap-to-mark picks, undo, and full out-of-order editing:
     fix or reassign any past pick, or fill any empty board slot
   - Searchable player pool: name, position, team, bye
   - Rankings seed at runtime from public/players-<scoring>.csv
     (players-ppr.csv, players-standard.csv; Half PPR uses the PPR
     sheet since ESPN doesn't publish one; final fallback players.csv)
     — overwrite those files and redeploy to update ("drop and go");
     in-app paste/upload of any CSV (rank/name/pos/team/bye/ADP)
     overrides at any time
   - Value badges when a player falls past their rank or ADP
   - Sticker-wall draft board, roster view, auto-saves progress
   ============================================================ */

const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST"];

/* Where each rankings source comes from, shown throughout the UI.
   A CSV can override its own name with a first line like "# source: FantasyPros". */
const CSV_SOURCE_NAME = "ESPN";
const WEB_SOURCE_NAME = "FantasyFootballCalculator.com";

const POS_COLOR = {
  QB: "#EF6461",
  RB: "#4EC488",
  WR: "#5BA8F5",
  TE: "#F2A44A",
  K: "#B58CE6",
  DST: "#98A4B3",
};

function makeId(name, team) {
  return (
    String(name).toLowerCase().replace(/[^a-z0-9]/g, "") +
    "-" +
    String(team || "").toLowerCase()
  );
}

function normName(name) {
  return String(name)
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, "")
    .replace(/[^a-z]/g, "");
}

/* ---------- snake-draft math ---------- */
function teamForPick(overall, numTeams) {
  const r = Math.floor((overall - 1) / numTeams);
  const i = (overall - 1) % numTeams;
  return r % 2 === 0 ? i : numTeams - 1 - i;
}
function overallFor(teamIdx, round, numTeams) {
  const r = round - 1;
  const i = r % 2 === 0 ? teamIdx : numTeams - 1 - teamIdx;
  return r * numTeams + i + 1;
}
function pickLabel(overall, numTeams) {
  const r = Math.floor((overall - 1) / numTeams) + 1;
  const i = ((overall - 1) % numTeams) + 1;
  return `${r}.${String(i).padStart(2, "0")}`;
}

/* ---------- responsive: wide screens get the split dashboard ---------- */
const WIDE_QUERY = "(min-width: 1000px)";
function useIsWide() {
  const [wide, setWide] = useState(
    () =>
      typeof window !== "undefined" && window.matchMedia(WIDE_QUERY).matches
  );
  useEffect(() => {
    const mq = window.matchMedia(WIDE_QUERY);
    const onChange = (e) => setWide(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return wide;
}

/* ---------- rankings import parser ----------
   Accepts pasted text or CSV/TSV file contents. Handles:
   - Header rows (rank,name,pos,team,bye,adp — any order)
   - Headerless rows: "12, Nico Collins, WR, HOU, 6" or tab-separated
   - Loose lines: "12. Nico Collins WR HOU"                        */
function parseImport(text) {
  const POS_ALIASES = { "D/ST": "DST", DEF: "DST", DS: "DST", PK: "K" };
  const normPos = (t) => {
    const up = String(t).toUpperCase().trim();
    const mapped = POS_ALIASES[up] || up;
    return POSITIONS.includes(mapped) ? mapped : null;
  };

  let updatedNote = null;
  let sourceNote = null;
  const lines = [];
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l) continue;
    if (l.startsWith("#") || l.startsWith("//")) {
      const s = l.match(/source[:\s-]+(.+)/i);
      if (s) {
        sourceNote = s[1].trim();
        continue;
      }
      const m = l.match(/updat(?:ed?)?[:\s-]*(.+)/i);
      if (m) updatedNote = m[1].trim();
      continue;
    }
    lines.push(l);
  }
  if (!lines.length)
    return { players: [], errors: ["Nothing to parse."], updatedNote, sourceNote };

  const delimFor = (line) =>
    line.includes("\t") ? "\t" : line.includes(",") ? "," : null;

  // Header detection
  let colMap = null;
  let startIdx = 0;
  const first = lines[0];
  const firstDelim = delimFor(first);
  if (firstDelim) {
    const cells = first.split(firstDelim).map((c) => c.trim().toLowerCase());
    if (cells.some((c) => c.includes("name") || c.includes("player"))) {
      colMap = {};
      /* Exact header names claim their column first, so e.g. "position"
         wins pos before "position_rank" can fuzzy-match it. */
      const EXACT = {
        rank: "rank", overall_rank: "rank", rk: "rank", "#": "rank",
        name: "name", player: "name",
        pos: "pos", position: "pos",
        team: "team", tm: "team", nfl: "team",
        bye: "bye", bye_week: "bye",
        adp: "adp",
        tier: "tier",
      };
      cells.forEach((c, idx) => {
        const key = EXACT[c];
        if (key && colMap[key] == null) colMap[key] = idx;
      });
      const taken = new Set(Object.values(colMap));
      cells.forEach((c, idx) => {
        if (taken.has(idx)) return;
        const assign = (key) => {
          if (colMap[key] == null) {
            colMap[key] = idx;
            taken.add(idx);
          }
        };
        if (c.includes("name") || c.includes("player")) assign("name");
        else if (c.includes("adp")) assign("adp");
        else if (c.includes("pos")) assign("pos");
        else if (c.includes("bye")) assign("bye");
        else if (c.includes("team")) assign("team");
        else if (c.includes("tier")) assign("tier");
        else if (c.includes("rank")) assign("rank");
        else if (c.includes("updat") || c.includes("date")) assign("updated");
      });
      startIdx = 1;
    }
  }

  const players = [];
  const errors = [];

  for (let li = startIdx; li < lines.length; li++) {
    const line = lines[li];
    let rank = null,
      name = null,
      pos = null,
      team = null,
      bye = "",
      adp = null,
      tier = null;

    if (colMap && colMap.name != null) {
      const cells = line.split(delimFor(line) || ",").map((c) => c.trim());
      if (!updatedNote && colMap.updated != null && cells[colMap.updated])
        updatedNote = cells[colMap.updated];
      name = cells[colMap.name] || "";
      if (colMap.pos != null) pos = normPos(cells[colMap.pos] || "");
      if (colMap.team != null) team = (cells[colMap.team] || "").toUpperCase();
      if (colMap.bye != null)
        bye = String(cells[colMap.bye] || "").replace(/\D/g, "");
      if (colMap.rank != null)
        rank = parseInt(String(cells[colMap.rank]).replace(/\D/g, ""), 10);
      if (colMap.adp != null) {
        const a = parseFloat(String(cells[colMap.adp]).replace(/[^\d.]/g, ""));
        if (Number.isFinite(a)) adp = Math.round(a);
      }
      if (colMap.tier != null) {
        const t = parseInt(String(cells[colMap.tier]).replace(/\D/g, ""), 10);
        if (Number.isFinite(t)) tier = t;
      }
    } else {
      // Heuristic parse
      const d = delimFor(line);
      const tokens = (d ? line.split(d) : line.split(/\s+/))
        .map((t) => t.trim())
        .filter(Boolean);
      const nameParts = [];
      const numbers = [];
      for (const tok of tokens) {
        const clean = tok.replace(/\.$/, "");
        const p = normPos(clean);
        if (p && pos === null) {
          pos = p;
          continue;
        }
        if (/^\d{1,3}$/.test(clean)) {
          numbers.push(parseInt(clean, 10));
          continue;
        }
        if (/^[A-Z]{2,3}$/.test(clean) && team === null && nameParts.length) {
          team = clean;
          continue;
        }
        nameParts.push(tok.replace(/^\d+[.)]\s*/, ""));
      }
      name = nameParts.join(" ").trim();
      if (numbers.length) rank = numbers[0];
      if (numbers.length > 1) bye = String(numbers[1]);
    }

    if (!name) {
      errors.push(`Line ${li + 1}: couldn't find a player name — skipped.`);
      continue;
    }
    players.push({
      id: makeId(name, team || String(players.length)),
      rank: Number.isFinite(rank) ? rank : players.length + 1,
      name,
      pos: pos || "WR",
      team: team || "",
      bye,
      adp,
      tier,
    });
  }

  players.sort((a, b) => a.rank - b.rank);
  players.forEach((p, i) => (p.rank = i + 1));
  return { players, errors, updatedNote, sourceNote };
}

/* ---------- cross-source player matching ----------
   Sources spell players differently (suffixes, punctuation) and name
   team defenses differently ("Broncos D/ST" vs "Denver Broncos"), so
   picks re-link across sources by normalized name + position, with a
   name-only fallback that refuses ambiguous matches. DSTs match by
   team code. */
const TEAM_ALIAS = { jac: "jax", la: "lar", wsh: "was", sd: "lac" };
function dstKey(team) {
  const t = String(team || "").toLowerCase();
  return `dst|${TEAM_ALIAS[t] || t}`;
}
function buildMatchMaps(players) {
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
function matchPlayer(maps, name, pos, team) {
  if (pos === "DST") return maps.byKey.get(dstKey(team)) || null;
  const n = normName(name);
  return maps.byKey.get(`${n}|${pos}`) || maps.byName.get(n) || null;
}

/* ---------- storage (browser localStorage — per device) ---------- */
const STORAGE_KEY = "draftday-state-v1";
function loadState() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v ? JSON.parse(v) : null;
  } catch {
    return null;
  }
}
function saveState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* storage unavailable (private mode?) — session-only */
  }
}
function clearState() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
}

/* Last pasted/uploaded list, kept so "Imported" stays a source you can
   switch back to mid-draft after trying ESPN or Live ADP. */
const IMPORT_KEY = "draftday-import-v1";
function saveStoredImport(data) {
  try {
    localStorage.setItem(IMPORT_KEY, JSON.stringify(data));
  } catch {}
}
function loadStoredImport() {
  try {
    const v = localStorage.getItem(IMPORT_KEY);
    return v ? JSON.parse(v) : null;
  } catch {
    return null;
  }
}

/* ---------- live player meta (Sleeper, free/no key, CORS-open) ----------
   Injuries, roster status, depth charts, and bio for the detail sheet.
   The full dump is ~14MB raw so it's slimmed to ~200KB and cached in
   localStorage for a day (Sleeper asks for ~once-daily calls). */
const META_KEY = "draftday-playermeta-v1";
const META_TTL = 24 * 60 * 60 * 1000;
const META_POS = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);

function loadPlayerMeta() {
  try {
    const v = localStorage.getItem(META_KEY);
    return v ? JSON.parse(v) : null;
  } catch {
    return null;
  }
}

async function fetchPlayerMeta() {
  const res = await fetch("https://api.sleeper.app/v1/players/nfl");
  if (!res.ok) throw new Error(`Sleeper returned ${res.status}`);
  const all = await res.json();
  const players = {};
  for (const id in all) {
    const p = all[id];
    if (!p || !p.team) continue;
    const fps = p.fantasy_positions || [];
    if (!fps.some((f) => META_POS.has(f))) continue;
    const rec = {
      inj: p.injury_status || null,
      part: p.injury_body_part || null,
      note: p.injury_notes || null,
      practice: p.practice_participation || null,
      status: p.status || null,
      news: p.news_updated || null,
      age: p.age || null,
      exp: p.years_exp != null ? p.years_exp : null,
      ht: p.height || null,
      wt: p.weight || null,
      college: p.college || null,
      num: p.number || null,
      depthPos: p.depth_chart_position || null,
      depthOrd: p.depth_chart_order || null,
      team: p.team,
    };
    if (p.position === "DEF") {
      players[`dst-${String(p.team).toLowerCase()}`] = rec;
    } else {
      /* Index under both Sleeper's normalized key and ours (which also
         strips Jr/III suffixes) so either side's naming matches. */
      if (p.search_full_name) players[p.search_full_name] = rec;
      const ours = normName(p.full_name || "");
      if (ours && !players[ours]) players[ours] = rec;
    }
  }
  const data = { fetched: Date.now(), players };
  try {
    localStorage.setItem(META_KEY, JSON.stringify(data));
  } catch {}
  return data;
}

/* Badge text for a player's injury/roster situation, or null if healthy */
const INJ_LABEL = {
  Questionable: "Q",
  Doubtful: "D",
  Out: "O",
  IR: "IR",
  PUP: "PUP",
  Sus: "SUS",
  COV: "C",
  NA: "NA",
  DNR: "DNR",
};
function injuryTag(meta) {
  if (!meta) return null;
  if (meta.inj) return INJ_LABEL[meta.inj] || meta.inj.slice(0, 3).toUpperCase();
  const s = meta.status;
  if (s && /injured reserve/i.test(s)) return "IR";
  if (s && /suspend/i.test(s)) return "SUS";
  if (s && /physically unable/i.test(s)) return "PUP";
  return null;
}

function fmtHeight(ht) {
  const n = parseInt(ht, 10);
  if (!Number.isFinite(n) || n < 48) return ht || null;
  return `${Math.floor(n / 12)}'${n % 12}"`;
}

/* ============================================================ */

export default function DraftDay() {
  const saved = useMemo(loadState, []);
  const [phase, setPhase] = useState((saved && saved.phase) || "setup"); // setup | draft
  const [numTeams, setNumTeams] = useState((saved && saved.numTeams) || 10);
  const [numRounds, setNumRounds] = useState((saved && saved.numRounds) || 16);
  const [mySlot, setMySlot] = useState((saved && saved.mySlot) || 1); // 1-based
  const [teamNames, setTeamNames] = useState((saved && saved.teamNames) || []);
  const [players, setPlayers] = useState((saved && saved.players) || []);
  const [picks, setPicks] = useState(() =>
    ((saved && saved.picks) || []).map((p, i) => ({
      seq: p.seq != null ? p.seq : i + 1,
      ...p,
    }))
  ); // manual picks: {overall, seq, teamIdx, playerId, name, pos, team}
  const [keepers, setKeepers] = useState((saved && saved.keepers) || []); // {playerId, name, pos, team, teamIdx, round}
  const [targets, setTargets] = useState((saved && saved.targets) || []); // player ids
  const [scoring, setScoring] = useState((saved && saved.scoring) || "ppr");
  const [rankingsSource, setRankingsSource] = useState(
    (saved && saved.rankingsSource) || "csv"
  ); // csv | web | import
  const [rankingsMeta, setRankingsMeta] = useState(
    (saved && saved.rankingsMeta) || null
  ); // { kind, label, updated }
  const [seedStatus, setSeedStatus] = useState("idle"); // idle | loading | done | error
  const [webStatus, setWebStatus] = useState("idle"); // idle | loading | done | error

  const [tab, setTab] = useState("players"); // players | board | roster | more
  const [search, setSearch] = useState("");
  const [posFilter, setPosFilter] = useState("ALL");
  const [showDrafted, setShowDrafted] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [assignSlot, setAssignSlot] = useState(null); // overall being filled/replaced out of order
  const [editOverall, setEditOverall] = useState(null); // pick being edited in modal
  const [showNames, setShowNames] = useState(false);
  const [importText, setImportText] = useState("");
  const [importPreview, setImportPreview] = useState(null);
  const [toast, setToast] = useState(null);
  const fileRef = useRef(null);
  const importFileName = useRef(null);
  const toastTimer = useRef(null);
  const seqRef = useRef(
    ((saved && saved.picks) || []).reduce(
      (m, p, i) => Math.max(m, p.seq != null ? p.seq : i + 1),
      0
    ) + 1
  );

  /* state is initialized synchronously from localStorage above */

  /* autosave */
  useEffect(() => {
    const t = setTimeout(() => {
      saveState({
        phase,
        numTeams,
        numRounds,
        mySlot,
        teamNames,
        players,
        picks,
        keepers,
        targets,
        scoring,
        rankingsSource,
        rankingsMeta,
      });
    }, 400);
    return () => clearTimeout(t);
  }, [phase, numTeams, numRounds, mySlot, teamNames, players, picks, keepers, targets, scoring, rankingsSource, rankingsMeta]);

  const flash = useCallback((msg) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }, []);

  /* ---------- rankings: seed from /players.csv & replacement ---------- */
  const playersRef = useRef(players);
  useEffect(() => {
    playersRef.current = players;
  }, [players]);

  /* Swap in a new player list, re-linking picks, keepers, and targets
     by normalized player name so a mid-draft update never loses the board. */
  const applyNewRankings = useCallback(
    (incoming, announceMsg, meta) => {
      const maps = buildMatchMaps(incoming);
      setPicks((prev) =>
        prev.map((pk) => {
          const match = matchPlayer(maps, pk.name, pk.pos, pk.team);
          return match ? { ...pk, playerId: match.id } : pk;
        })
      );
      setKeepers((prev) =>
        prev.map((k) => {
          const match = matchPlayer(maps, k.name, k.pos, k.team);
          return match ? { ...k, playerId: match.id } : k;
        })
      );
      setTargets((prev) => {
        const oldById = new Map(playersRef.current.map((p) => [p.id, p]));
        return prev
          .map((id) => {
            const old = oldById.get(id);
            const match = old
              ? matchPlayer(maps, old.name, old.pos, old.team)
              : null;
            return match ? match.id : null;
          })
          .filter(Boolean);
      });
      setPlayers(incoming);
      if (meta) setRankingsMeta(meta);
      if (announceMsg) flash(announceMsg);
    },
    [flash]
  );

  /* Fetch the drop-in seed file shipped with the site. Tries the file for
     the selected scoring (public/players-<scoring>.csv) first, then falls
     back to the generic public/players.csv. */
  const seedFromFile = useCallback(
    async (announce, fmtOverride) => {
      const format = typeof fmtOverride === "string" ? fmtOverride : scoring;
      setSeedStatus("loading");
      /* ESPN publishes PPR and Standard sheets only; their PPR list is
         near-identical to Half PPR, so Half PPR falls back to the PPR file. */
      const candidates =
        format === "half-ppr"
          ? ["players-half-ppr.csv", "players-ppr.csv", "players.csv"]
          : [`players-${format}.csv`, "players.csv"];
      for (const fileName of candidates) {
        try {
          const res = await fetch(`${import.meta.env.BASE_URL}${fileName}`, {
            cache: "no-store",
          });
          if (!res.ok) throw new Error(`${fileName} not found`);
          /* Hosts with SPA fallback answer missing files with index.html */
          if ((res.headers.get("content-type") || "").includes("text/html"))
            throw new Error(`${fileName} not found`);
          const text = await res.text();
          const lastMod = res.headers.get("last-modified");
          const parsed = parseImport(text);
          if (!parsed.players.length) throw new Error(`${fileName} was empty`);
          const updated =
            parsed.updatedNote ||
            (lastMod
              ? new Date(lastMod).toLocaleDateString(undefined, {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                })
              : null);
          const sourceName = parsed.sourceNote || CSV_SOURCE_NAME;
          applyNewRankings(
            parsed.players,
            announce
              ? `Loaded ${parsed.players.length} ${sourceName} players from ${fileName}`
              : null,
            { kind: "csv", label: `${sourceName} (${fileName})`, updated }
          );
          setRankingsSource("csv");
          setSeedStatus("done");
          return;
        } catch {
          /* try the next candidate file */
        }
      }
      setSeedStatus("error");
      if (announce)
        flash(
          `Couldn't load the ${CSV_SOURCE_NAME} CSVs — previous list kept.`
        );
    },
    [applyNewRankings, scoring, flash]
  );

  /* One-click live update via the site's /api/rankings Pages Function
     (works on the deployed site — no redeploy or GitHub push needed) */
  const updateFromWeb = useCallback(
    async (fmtOverride) => {
      const format = typeof fmtOverride === "string" ? fmtOverride : scoring;
      setWebStatus("loading");
      try {
        const res = await fetch(
          `${import.meta.env.BASE_URL}api/rankings?format=${format}&teams=${numTeams}`,
          { cache: "no-store" }
        );
        const data = await res.json();
        if (!res.ok || !data.players || !data.players.length) {
          throw new Error((data && data.error) || "No players returned");
        }
        const incoming = data.players.map((p, i) => ({
          id: makeId(p.name, p.team),
          rank: p.rank || i + 1,
          name: p.name,
          pos: p.pos,
          team: p.team || "",
          bye: p.bye || "",
          adp: p.adp != null ? p.adp : null,
        }));
        applyNewRankings(
          incoming,
          `Updated: ${incoming.length} players from ${WEB_SOURCE_NAME} (${data.format} ADP, ${data.year})`,
          {
            kind: "web",
            label: `${WEB_SOURCE_NAME} ADP (${data.format}, ${data.year} season)`,
            updated: new Date().toLocaleString(undefined, {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            }),
          }
        );
        setRankingsSource("web");
        setWebStatus("done");
      } catch {
        setWebStatus("error");
        flash("Web update failed — use your CSV list instead.");
      }
    },
    [scoring, numTeams, applyNewRankings, flash]
  );

  /* Changing scoring re-loads rankings from the active source so the list
     always matches the format. A hand-imported list is never clobbered. */
  const changeScoring = useCallback(
    (value) => {
      setScoring(value);
      if (rankingsSource === "web") updateFromWeb(value);
      else if (rankingsSource === "csv") seedFromFile(true, value);
    },
    [rankingsSource, updateFromWeb, seedFromFile]
  );

  /* Seed on first load when there are no saved rankings,
     using whichever source was last selected */
  const didInit = useRef(false);
  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    if (!playersRef.current.length) {
      if (rankingsSource === "web") updateFromWeb();
      else seedFromFile(true);
    }
  }, [rankingsSource, seedFromFile, updateFromWeb]);

  /* ---------- derived draft state ---------- */
  const totalPicks = numTeams * numRounds;
  const myIdx = mySlot - 1;

  // Keepers materialized onto the board
  const keeperPicks = useMemo(
    () =>
      keepers
        .filter((k) => k.round <= numRounds && k.teamIdx < numTeams)
        .map((k) => ({
          overall: overallFor(k.teamIdx, k.round, numTeams),
          teamIdx: k.teamIdx,
          playerId: k.playerId,
          name: k.name,
          pos: k.pos,
          team: k.team,
          keeper: true,
        })),
    [keepers, numTeams, numRounds]
  );

  const allPicks = useMemo(() => {
    const m = new Map();
    keeperPicks.forEach((p) => m.set(p.overall, p));
    picks.forEach((p) => {
      if (!m.has(p.overall)) m.set(p.overall, p);
    });
    return m; // Map overall -> pick
  }, [keeperPicks, picks]);

  const currentPick = useMemo(() => {
    for (let p = 1; p <= totalPicks; p++) {
      if (!allPicks.has(p)) return p;
    }
    return null;
  }, [allPicks, totalPicks]);

  const draftDone = currentPick === null;
  const onClockIdx = draftDone ? null : teamForPick(currentPick, numTeams);
  const iAmOnClock = onClockIdx === myIdx;

  const draftedIds = useMemo(() => {
    const m = new Map();
    allPicks.forEach((p) => m.set(p.playerId, p));
    return m;
  }, [allPicks]);

  const nameFor = useCallback(
    (idx) => {
      const custom = teamNames[idx];
      if (custom && custom.trim()) return custom.trim();
      return idx === myIdx ? "You" : `Team ${idx + 1}`;
    },
    [teamNames, myIdx]
  );

  const picksUntilMine = useMemo(() => {
    if (draftDone) return null;
    let myNext = null;
    for (let p = currentPick; p <= totalPicks; p++) {
      if (!allPicks.has(p) && teamForPick(p, numTeams) === myIdx) {
        myNext = p;
        break;
      }
    }
    if (myNext === null) return null;
    let count = 0;
    for (let p = currentPick; p < myNext; p++) {
      if (!allPicks.has(p)) count++;
    }
    return count;
  }, [currentPick, allPicks, myIdx, numTeams, totalPicks, draftDone]);

  // Slot a tapped player would fill (assign mode overrides the clock)
  const activeSlot = assignSlot != null ? assignSlot : currentPick;
  const activeSlotTeam =
    activeSlot != null ? teamForPick(activeSlot, numTeams) : null;

  const filteredPlayers = useMemo(() => {
    const q = search.trim().toLowerCase();
    return players
      .filter((p) => {
        const picked = draftedIds.has(p.id);
        if (picked && !showDrafted) return false;
        if (posFilter === "★") {
          if (!targets.includes(p.id)) return false;
        } else if (posFilter !== "ALL" && p.pos !== posFilter) return false;
        if (q) {
          const hay = `${p.name} ${p.team}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => a.rank - b.rank);
  }, [players, draftedIds, showDrafted, posFilter, targets, search]);

  /* Value vs. the slot being filled: how far past ADP (or rank) has this
     player fallen? Positive = value. */
  const valueFor = useCallback(
    (p) => {
      if (activeSlot == null) return null;
      const basis = p.adp != null ? p.adp : p.rank;
      const diff = activeSlot - basis;
      return diff >= 3 ? diff : null;
    },
    [activeSlot]
  );

  /* ---------- tiers ----------
     Explicit `tier` CSV column wins; otherwise derive per-position tiers
     from gaps in ADP (or rank): a jump of >= max(3, 12%) starts a new tier. */
  const tierOf = useMemo(() => {
    const m = new Map();
    if (players.some((p) => p.tier != null)) {
      players.forEach((p) => {
        if (p.tier != null) m.set(p.id, p.tier);
      });
      return m;
    }
    for (const pos of POSITIONS) {
      const group = players
        .filter((p) => p.pos === pos)
        .sort((a, b) => a.rank - b.rank);
      let tier = 0;
      let prev = null;
      for (const p of group) {
        const basis = p.adp != null ? p.adp : p.rank;
        if (prev == null || basis - prev >= Math.max(3, prev * 0.12)) tier++;
        m.set(p.id, tier);
        prev = basis;
      }
    }
    return m;
  }, [players]);

  /* Players who are the last available member of their positional tier.
     Only tiers that started with 3+ players badge — a group genuinely
     running out — so tiny elite tiers (Gibbs/Bijan, a one-man QB tier)
     don't cry wolf at the top of the draft. */
  const lastOfTier = useMemo(() => {
    const totals = new Map();
    const avail = new Map();
    players.forEach((p) => {
      const t = tierOf.get(p.id);
      if (t == null) return;
      const key = `${p.pos}|${t}`;
      totals.set(key, (totals.get(key) || 0) + 1);
      if (!draftedIds.has(p.id)) avail.set(key, (avail.get(key) || 0) + 1);
    });
    const s = new Set();
    players.forEach((p) => {
      if (draftedIds.has(p.id)) return;
      const t = tierOf.get(p.id);
      if (t == null) return;
      const key = `${p.pos}|${t}`;
      if (avail.get(key) === 1 && totals.get(key) >= 3) s.add(p.id);
    });
    return s;
  }, [players, draftedIds, tierOf]);

  /* ---------- my roster's bye-week load ---------- */
  const myByeCounts = useMemo(() => {
    const byId = new Map(players.map((p) => [p.id, p]));
    const counts = new Map(); // bye week -> { total, pos: {POS: n} }
    allPicks.forEach((pk) => {
      if (pk.teamIdx !== myIdx) return;
      const pl = byId.get(pk.playerId);
      const bye = pl && pl.bye;
      if (!bye || bye === "0") return;
      let e = counts.get(bye);
      if (!e) counts.set(bye, (e = { total: 0, pos: {} }));
      e.total++;
      e.pos[pk.pos] = (e.pos[pk.pos] || 0) + 1;
    });
    return counts;
  }, [players, allPicks, myIdx]);

  /* Warning text if drafting this player would crowd a bye week */
  const byeWarningFor = useCallback(
    (p) => {
      if (!p || !p.bye || p.bye === "0") return null;
      const e = myByeCounts.get(p.bye);
      if (!e) return null;
      const samePos = e.pos[p.pos] || 0;
      if (["QB", "TE", "K", "DST"].includes(p.pos) && samePos >= 1)
        return `Your other ${p.pos} also has bye ${p.bye}`;
      if (e.total >= 2)
        return `You'd have ${e.total + 1} players on bye ${p.bye}`;
      return null;
    },
    [myByeCounts]
  );

  /* ---------- actions ---------- */
  const assignPlayerToSlot = (player, overall) => {
    const teamIdx = teamForPick(overall, numTeams);
    setPicks((prev) => {
      const without = prev.filter((p) => p.overall !== overall);
      return [
        ...without,
        {
          overall,
          seq: seqRef.current++,
          teamIdx,
          playerId: player.id,
          name: player.name,
          pos: player.pos,
          team: player.team,
        },
      ];
    });
    setSelectedId(null);
    setAssignSlot(null);
    /* A confirmed pick ends the current search: restore the full list
       so the next pick starts fresh. (Cancel keeps the search, so
       comparing similar names still works.) */
    if (search) {
      setSearch("");
      if (playersMainRef.current) playersMainRef.current.scrollTo({ top: 0 });
      window.scrollTo(0, 0);
    }
    flash(
      `${player.name} → ${nameFor(teamIdx)} at ${pickLabel(overall, numTeams)}`
    );
  };

  const draftPlayer = (player) => {
    if (activeSlot == null) return;
    // Keeper slots can't be overwritten from the list
    const existing = allPicks.get(activeSlot);
    if (existing && existing.keeper) {
      flash("That slot holds a keeper — remove it from Keepers first.");
      return;
    }
    assignPlayerToSlot(player, activeSlot);
  };

  const undoPick = () => {
    if (!picks.length) return;
    const last = picks.reduce((a, b) => (a.seq > b.seq ? a : b));
    setPicks((prev) => prev.filter((p) => p.seq !== last.seq));
    flash(`Undid ${pickLabel(last.overall, numTeams)} — ${last.name}`);
  };

  const removePickAt = (overall) => {
    const pk = allPicks.get(overall);
    if (!pk) return;
    if (pk.keeper) {
      setKeepers((prev) =>
        prev.filter(
          (k) => overallFor(k.teamIdx, k.round, numTeams) !== overall
        )
      );
      flash(`Removed keeper ${pk.name} from ${pickLabel(overall, numTeams)}`);
    } else {
      setPicks((prev) => prev.filter((p) => p.overall !== overall));
      flash(`Removed ${pk.name} — ${pickLabel(overall, numTeams)} is open`);
    }
    setEditOverall(null);
  };

  const startChangePlayer = (overall) => {
    setEditOverall(null);
    setAssignSlot(overall);
    setSelectedId(null);
    setTab("players");
  };

  const addKeeper = (player, teamIdx, round) => {
    const overall = overallFor(teamIdx, round, numTeams);
    if (allPicks.has(overall)) {
      flash(
        `${pickLabel(overall, numTeams)} is already filled — pick another round.`
      );
      return false;
    }
    if (draftedIds.has(player.id)) {
      flash(`${player.name} is already on the board.`);
      return false;
    }
    setKeepers((prev) => [
      ...prev,
      {
        playerId: player.id,
        name: player.name,
        pos: player.pos,
        team: player.team,
        teamIdx,
        round,
      },
    ]);
    flash(
      `Keeper: ${player.name} → ${nameFor(teamIdx)}, round ${round} (${pickLabel(
        overall,
        numTeams
      )})`
    );
    return true;
  };

  const removeKeeper = (idx) => {
    setKeepers((prev) => prev.filter((_, i) => i !== idx));
  };

  const toggleTarget = (id) =>
    setTargets((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]
    );

  const startDraft = () => {
    if (!players.length) {
      flash("No rankings loaded yet — add players.csv or import below.");
      return;
    }
    setPhase("draft");
    setTab("players");
  };

  const restartDraft = () => {
    setPicks([]);
    setSelectedId(null);
    setAssignSlot(null);
    setEditOverall(null);
    flash("Picks cleared — keepers, rankings, and settings kept.");
  };

  const fullReset = () => {
    clearState();
    setPhase("setup");
    setPicks([]);
    setKeepers([]);
    setTargets([]);
    setPlayers([]);
    setTeamNames([]);
    setNumTeams(10);
    setNumRounds(16);
    setMySlot(1);
    setSearch("");
    setPosFilter("ALL");
    setAssignSlot(null);
    setEditOverall(null);
    setRankingsMeta(null);
    setRankingsSource("csv");
    seedFromFile(true);
  };

  const handleFile = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    importFileName.current = file.name;
    const reader = new FileReader();
    reader.onload = () => {
      setImportText(String(reader.result || ""));
      setImportPreview(parseImport(String(reader.result || "")));
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const previewImport = () => setImportPreview(parseImport(importText));

  const applyImport = () => {
    if (!importPreview || !importPreview.players.length) return;
    const incoming = importPreview.players;
    const label = importFileName.current
      ? `Uploaded file (${importFileName.current})`
      : "Pasted list";
    const updated =
      importPreview.updatedNote ||
      new Date().toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
    applyNewRankings(incoming, `Imported ${incoming.length} players.`, {
      kind: "import",
      label,
      updated,
    });
    setRankingsSource("import");
    saveStoredImport({ players: incoming, label, updated });
    importFileName.current = null;
    setImportPreview(null);
    setImportText("");
  };

  const storedImport = useMemo(loadStoredImport, [rankingsMeta]);

  /* Bring back the last pasted/uploaded list after trying another source */
  const restoreImport = useCallback(() => {
    const st = loadStoredImport();
    if (!st || !st.players || !st.players.length) {
      setRankingsSource("import");
      flash("No imported list saved yet — paste or upload one first.");
      return;
    }
    applyNewRankings(
      st.players,
      `Restored ${st.players.length} players (${st.label}).`,
      { kind: "import", label: st.label, updated: st.updated }
    );
    setRankingsSource("import");
  }, [applyNewRankings, flash]);

  const isWide = useIsWide();
  const showSplit = isWide && (tab === "players" || tab === "board");

  /* Scrolls back to the top of the player list after a searched pick
     (the pane scrolls in the wide split view, the window otherwise) */
  const playersMainRef = useRef(null);

  /* Clock bar height feeds the sticky offset of the list toolbar */
  const clockRef = useRef(null);
  const [clockH, setClockH] = useState(64);
  useEffect(() => {
    const el = clockRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setClockH(el.offsetHeight));
    ro.observe(el);
    setClockH(el.offsetHeight);
    return () => ro.disconnect();
  }, [phase]);

  /* Major navigation (tab switch, setup <-> draft) lands at the top */
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [tab, phase]);

  /* ---------- live player meta (injuries / depth charts) ---------- */
  const [metaData, setMetaData] = useState(() => loadPlayerMeta());
  const [metaStatus, setMetaStatus] = useState("idle"); // idle | loading | done | error
  const [detailId, setDetailId] = useState(null);
  const playerMeta = metaData ? metaData.players : null;

  const refreshPlayerMeta = useCallback(async () => {
    setMetaStatus("loading");
    try {
      setMetaData(await fetchPlayerMeta());
      setMetaStatus("done");
    } catch {
      setMetaStatus("error");
    }
  }, []);

  /* Refresh in the background when the cache is missing or a day old.
     Failures are silent — the app fully works without this data. */
  const didMetaInit = useRef(false);
  useEffect(() => {
    if (didMetaInit.current) return;
    didMetaInit.current = true;
    const fresh = metaData && Date.now() - metaData.fetched < META_TTL;
    if (!fresh) refreshPlayerMeta();
  }, [metaData, refreshPlayerMeta]);

  const metaFor = useCallback(
    (p) => {
      if (!playerMeta || !p) return null;
      if (p.pos === "DST") {
        /* Team codes differ between sources (ESPN JAC = Sleeper JAX) */
        const t = String(p.team).toLowerCase();
        return (
          playerMeta[`dst-${t}`] ||
          playerMeta[`dst-${TEAM_ALIAS[t] || t}`] ||
          null
        );
      }
      return playerMeta[normName(p.name)] || null;
    },
    [playerMeta]
  );

  /* ================= SETUP ================= */
  if (phase === "setup") {
    return (
      <div className="dd-root">
        <style>{CSS}</style>
        <div className="dd-setup">
          <div className="dd-brand">
            <span className="dd-brand-kick">SNAKE DRAFT TRACKER</span>
            <h1>Draft Day</h1>
            <p className="dd-sub">
              Set your league and keepers, then mark every pick live.
            </p>
          </div>

          <section className="dd-card">
            <h2 className="dd-card-title">League size</h2>
            <div className="dd-choice-row">
              {[8, 10, 12, 14, 16].map((n) => (
                <button
                  key={n}
                  className={`dd-choice ${numTeams === n ? "on" : ""}`}
                  onClick={() => {
                    setNumTeams(n);
                    if (mySlot > n) setMySlot(n);
                  }}
                >
                  {n}
                </button>
              ))}
            </div>
            {keepers.length > 0 && (
              <p className="dd-hint">
                Changing league size re-maps keeper slots — double-check them
                below.
              </p>
            )}
          </section>

          <section className="dd-card">
            <h2 className="dd-card-title">Rounds</h2>
            <div className="dd-stepper">
              <button
                onClick={() => setNumRounds((r) => Math.max(1, r - 1))}
                aria-label="Fewer rounds"
              >
                −
              </button>
              <span>{numRounds}</span>
              <button
                onClick={() => setNumRounds((r) => Math.min(30, r + 1))}
                aria-label="More rounds"
              >
                +
              </button>
            </div>
          </section>

          <section className="dd-card">
            <h2 className="dd-card-title">Your draft slot</h2>
            <div className="dd-slot-grid">
              {Array.from({ length: numTeams }, (_, i) => (
                <button
                  key={i}
                  className={`dd-slot ${mySlot === i + 1 ? "on" : ""}`}
                  onClick={() => setMySlot(i + 1)}
                >
                  {i + 1}
                </button>
              ))}
            </div>
            <p className="dd-hint">
              Pick {mySlot} of {numTeams} — snake order reverses every round.
            </p>
          </section>

          <section className="dd-card">
            <button
              className="dd-linkbtn"
              onClick={() => setShowNames((v) => !v)}
            >
              {showNames ? "Hide team names" : "Edit team names (optional)"}
            </button>
            {showNames && (
              <div className="dd-names">
                {Array.from({ length: numTeams }, (_, i) => (
                  <label key={i} className="dd-name-row">
                    <span className={i === myIdx ? "me" : ""}>
                      {i + 1}
                      {i === myIdx ? " ★" : ""}
                    </span>
                    <input
                      value={teamNames[i] || ""}
                      placeholder={i === myIdx ? "You" : `Team ${i + 1}`}
                      onChange={(e) => {
                        const next = teamNames.slice();
                        next[i] = e.target.value;
                        setTeamNames(next);
                      }}
                    />
                  </label>
                ))}
              </div>
            )}
          </section>

          <section className="dd-card">
            <h2 className="dd-card-title">
              Keepers{keepers.length ? ` (${keepers.length})` : ""}
            </h2>
            <p className="dd-hint" style={{ marginTop: 0 }}>
              Assign kept players to a team and round before pick 1. Those
              slots are filled on the board and skipped automatically.
            </p>
            <KeeperManager
              players={players}
              keepers={keepers}
              draftedIds={draftedIds}
              numTeams={numTeams}
              numRounds={numRounds}
              nameFor={nameFor}
              addKeeper={addKeeper}
              removeKeeper={removeKeeper}
            />
          </section>

          <section className="dd-card">
            <h2 className="dd-card-title">Rankings source</h2>
            <RankingsSourcePanel
              rankingsSource={rankingsSource}
              rankingsMeta={rankingsMeta}
              playerCount={players.length}
              seedStatus={seedStatus}
              webStatus={webStatus}
              scoring={scoring}
              changeScoring={changeScoring}
              seedFromFile={seedFromFile}
              updateFromWeb={updateFromWeb}
              chooseImport={() => setRankingsSource("import")}
              storedImport={storedImport}
              restoreImport={restoreImport}
              importPanel={
                <ImportPanel
                  importText={importText}
                  setImportText={setImportText}
                  importPreview={importPreview}
                  previewImport={previewImport}
                  applyImport={applyImport}
                  fileRef={fileRef}
                  handleFile={handleFile}
                />
              }
            />
          </section>

          <button className="dd-start" onClick={startDraft}>
            Start draft
          </button>
        </div>
        {toast && <div className="dd-toast">{toast}</div>}
      </div>
    );
  }

  /* ================= DRAFT ================= */
  const editingPick = editOverall != null ? allPicks.get(editOverall) : null;

  return (
    <div
      className={showSplit ? "dd-root split" : "dd-root"}
      style={{ "--clock-h": `${clockH}px` }}
    >
      <style>{CSS}</style>

      {/* On-the-clock bar */}
      <header
        ref={clockRef}
        className={`dd-clock ${iAmOnClock && assignSlot == null ? "mine" : ""}`}
      >
        {draftDone && assignSlot == null ? (
          <div className="dd-clock-main">
            <span className="dd-clock-kick">DRAFT COMPLETE</span>
            <span className="dd-clock-team">All {totalPicks} picks made</span>
          </div>
        ) : (
          <>
            <div className="dd-clock-pick">
              <span className="dd-clock-kick">PICK</span>
              <span className="dd-clock-num">
                {activeSlot != null ? pickLabel(activeSlot, numTeams) : "—"}
              </span>
            </div>
            <div className="dd-clock-main">
              <span className="dd-clock-team">
                {assignSlot != null
                  ? `FIXING ${nameFor(activeSlotTeam)}`
                  : iAmOnClock
                  ? "YOU'RE ON THE CLOCK"
                  : nameFor(onClockIdx)}
              </span>
              <span className="dd-clock-sub">
                {assignSlot != null
                  ? "Tap a player to fill this slot"
                  : iAmOnClock
                  ? "Tap a player to make your pick"
                  : picksUntilMine != null
                  ? `${picksUntilMine} pick${
                      picksUntilMine === 1 ? "" : "s"
                    } until you`
                  : "Your picks are done"}
              </span>
            </div>
          </>
        )}
        {assignSlot != null ? (
          <button className="dd-undo" onClick={() => setAssignSlot(null)}>
            Cancel
          </button>
        ) : (
          <button
            className="dd-undo"
            onClick={undoPick}
            disabled={!picks.length}
            aria-label="Undo last pick"
          >
            Undo
          </button>
        )}
      </header>

      {/* ---- PLAYERS TAB (left pane in wide split view) ---- */}
      {(tab === "players" || showSplit) && (
        <main className="dd-main" ref={playersMainRef}>
          <div className="dd-listtools">
            <div className="dd-search-wrap">
              <input
                className="dd-search"
                type="search"
                placeholder="Search name or team…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <select
                className="dd-source-quick"
                value={rankingsSource}
                aria-label="Ranking source"
                title="Ranking source"
                disabled={seedStatus === "loading" || webStatus === "loading"}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "csv") seedFromFile(true);
                  else if (v === "web") updateFromWeb();
                  else restoreImport();
                }}
              >
                <option value="csv">{CSV_SOURCE_NAME}</option>
                <option value="web">Live ADP</option>
                {(rankingsSource === "import" || storedImport) && (
                  <option value="import">Imported</option>
                )}
              </select>
            </div>
            <div className="dd-chips">
            {["ALL", ...POSITIONS, "★"].map((p) => (
              <button
                key={p}
                className={`dd-chip ${posFilter === p ? "on" : ""}`}
                style={
                  posFilter === p && POS_COLOR[p]
                    ? {
                        background: POS_COLOR[p],
                        borderColor: POS_COLOR[p],
                        color: "#10141A",
                      }
                    : undefined
                }
                onClick={() => setPosFilter(p)}
              >
                {p}
              </button>
            ))}
            <button
              className={`dd-chip ghost ${showDrafted ? "on-ghost" : ""}`}
              onClick={() => setShowDrafted((v) => !v)}
            >
              {showDrafted ? "Hiding: none" : "Show picked"}
            </button>
            </div>
          </div>

          <ul className="dd-list">
            {filteredPlayers.map((p, idx) => {
              const pickInfo = draftedIds.get(p.id);
              const isSel = selectedId === p.id;
              const val = !pickInfo ? valueFor(p) : null;
              const injTag = injuryTag(metaFor(p));
              const tier = tierOf.get(p.id);
              const showTierBreak =
                POSITIONS.includes(posFilter) &&
                tier != null &&
                tier !== (idx > 0 ? tierOf.get(filteredPlayers[idx - 1].id) : null);
              const byeWarn =
                isSel && !pickInfo && activeSlotTeam === myIdx
                  ? byeWarningFor(p)
                  : null;
              return (
                <React.Fragment key={p.id}>
                {showTierBreak && (
                  <li className="dd-tierhead">Tier {tier}</li>
                )}
                <li
                  className={`dd-row ${pickInfo ? "picked" : ""} ${
                    isSel ? "sel" : ""
                  }`}
                >
                  <button
                    className="dd-row-main"
                    onClick={() =>
                      pickInfo
                        ? setEditOverall(pickInfo.overall)
                        : setSelectedId(isSel ? null : p.id)
                    }
                  >
                    <span className="dd-rank">{p.rank}</span>
                    <span
                      className="dd-pos"
                      style={{ background: POS_COLOR[p.pos] || "#666" }}
                    >
                      {p.pos}
                    </span>
                    <span className="dd-nameblock">
                      <span className="dd-pname">{p.name}</span>
                      <span className="dd-pmeta">
                        {p.team || "—"}
                        {p.bye ? ` · Bye ${p.bye}` : ""}
                        {p.adp != null ? ` · ADP ${p.adp}` : ""}
                        {pickInfo
                          ? ` · ${pickLabel(pickInfo.overall, numTeams)} ${
                              nameFor(pickInfo.teamIdx)
                            }${pickInfo.keeper ? " · Keeper" : ""}`
                          : ""}
                      </span>
                    </span>
                    {injTag && (
                      <span
                        className={`dd-inj ${injTag === "Q" ? "q" : ""}`}
                        title="Injury / roster status"
                      >
                        {injTag}
                      </span>
                    )}
                    {!pickInfo && lastOfTier.has(p.id) && (
                      <span
                        className="dd-tierlast"
                        title={`Last available ${p.pos} in tier ${tier}`}
                      >
                        Last T{tier}
                      </span>
                    )}
                    {val != null && (
                      <span className="dd-val" title="Fallen past ADP/rank">
                        +{val}
                      </span>
                    )}
                  </button>
                  {!pickInfo && (
                    <button
                      className={`dd-star ${
                        targets.includes(p.id) ? "on" : ""
                      }`}
                      onClick={() => toggleTarget(p.id)}
                      aria-label={
                        targets.includes(p.id)
                          ? `Remove ${p.name} from targets`
                          : `Target ${p.name}`
                      }
                    >
                      ★
                    </button>
                  )}
                  {isSel && !pickInfo && activeSlot != null && (
                    <div className="dd-confirm">
                      {byeWarn && (
                        <p className="dd-byewarn">⚠ {byeWarn}</p>
                      )}
                      <button
                        className={`dd-draftbtn ${
                          activeSlotTeam === myIdx ? "mine" : ""
                        }`}
                        onClick={() => draftPlayer(p)}
                      >
                        {assignSlot != null
                          ? `Assign to ${nameFor(activeSlotTeam)} — ${pickLabel(
                              assignSlot,
                              numTeams
                            )}`
                          : iAmOnClock
                          ? `Draft to my team — ${pickLabel(
                              currentPick,
                              numTeams
                            )}`
                          : `Picked by ${nameFor(onClockIdx)} — ${pickLabel(
                              currentPick,
                              numTeams
                            )}`}
                      </button>
                      <button
                        className="dd-cancel"
                        onClick={() => setDetailId(p.id)}
                      >
                        Details
                      </button>
                      <button
                        className="dd-cancel"
                        onClick={() => setSelectedId(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </li>
                </React.Fragment>
              );
            })}
            {!filteredPlayers.length && (
              <li className="dd-empty">
                No players match. Adjust the search or filters — or turn on
                “Show picked.”
              </li>
            )}
          </ul>
        </main>
      )}

      {/* ---- BOARD TAB (right pane in wide split view) ---- */}
      {(tab === "board" || showSplit) && (
        <main className="dd-main dd-board-wrap">
          <div className="dd-board-scroll">
            <table className="dd-board">
              <thead>
                <tr>
                  <th className="dd-board-rnd">RD</th>
                  {Array.from({ length: numTeams }, (_, i) => (
                    <th key={i} className={i === myIdx ? "me" : ""}>
                      {nameFor(i)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: numRounds }, (_, r) => (
                  <tr key={r}>
                    <td className="dd-board-rnd">{r + 1}</td>
                    {Array.from({ length: numTeams }, (_, c) => {
                      const overall =
                        r % 2 === 0
                          ? r * numTeams + c + 1
                          : r * numTeams + (numTeams - c);
                      const pk = allPicks.get(overall);
                      const isCurrent = overall === currentPick;
                      const isAssign = overall === assignSlot;
                      return (
                        <td
                          key={c}
                          className={`dd-cell ${isCurrent ? "current" : ""} ${
                            isAssign ? "assign" : ""
                          } ${c === myIdx ? "mecol" : ""}`}
                        >
                          {pk ? (
                            <button
                              className="dd-sticker"
                              style={{
                                background: POS_COLOR[pk.pos] || "#666",
                              }}
                              onClick={() => setEditOverall(overall)}
                            >
                              <span className="dd-sticker-name">
                                {pk.keeper ? "🔒 " : ""}
                                {pk.name}
                              </span>
                              <span className="dd-sticker-meta">
                                {pk.pos} {pk.team}
                              </span>
                            </button>
                          ) : (
                            <button
                              className="dd-cell-empty"
                              onClick={() => {
                                setAssignSlot(overall);
                                setSelectedId(null);
                                setTab("players");
                              }}
                              aria-label={`Fill pick ${pickLabel(
                                overall,
                                numTeams
                              )}`}
                            >
                              {pickLabel(overall, numTeams)}
                            </button>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="dd-hint pad">
            Tap any sticker to fix or remove that pick. Tap an empty slot to
            fill it out of order. 🔒 = keeper. Gold column = you.
          </p>
        </main>
      )}

      {/* ---- ROSTER TAB ---- */}
      {tab === "roster" && (
        <main className="dd-main dd-pad">
          <h2 className="dd-section-title">My team — slot {mySlot}</h2>
          {(() => {
            const mine = [];
            allPicks.forEach((p) => {
              if (p.teamIdx === myIdx) mine.push(p);
            });
            mine.sort((a, b) => a.overall - b.overall);
            const counts = {};
            mine.forEach((p) => (counts[p.pos] = (counts[p.pos] || 0) + 1));
            return (
              <>
                <div className="dd-count-row">
                  {POSITIONS.map((pos) => (
                    <span
                      key={pos}
                      className="dd-count"
                      style={{ borderColor: POS_COLOR[pos] }}
                    >
                      <b style={{ color: POS_COLOR[pos] }}>{pos}</b>{" "}
                      {counts[pos] || 0}
                    </span>
                  ))}
                </div>
                {myByeCounts.size > 0 && (
                  <div className="dd-byes-row">
                    {[...myByeCounts.entries()]
                      .sort((a, b) => Number(a[0]) - Number(b[0]))
                      .map(([wk, e]) => (
                        <span
                          key={wk}
                          className={`dd-bye-chip ${
                            e.total >= 3 ? "warn3" : e.total === 2 ? "warn2" : ""
                          }`}
                        >
                          Bye {wk} · {e.total}
                        </span>
                      ))}
                  </div>
                )}
                {mine.length ? (
                  <ul className="dd-list roster">
                    {mine.map((p) => {
                      const full = players.find((x) => x.id === p.playerId);
                      const injTag = injuryTag(metaFor(full || p));
                      return (
                        <li key={p.overall} className="dd-row">
                          <button
                            className="dd-row-main"
                            onClick={() => setEditOverall(p.overall)}
                          >
                            <span className="dd-rank">
                              {pickLabel(p.overall, numTeams)}
                            </span>
                            <span
                              className="dd-pos"
                              style={{ background: POS_COLOR[p.pos] || "#666" }}
                            >
                              {p.pos}
                            </span>
                            <span className="dd-nameblock">
                              <span className="dd-pname">
                                {p.keeper ? "🔒 " : ""}
                                {p.name}
                              </span>
                              <span className="dd-pmeta">
                                {p.team || "—"}
                                {full && full.bye ? ` · Bye ${full.bye}` : ""}
                                {p.keeper ? " · Keeper" : ""}
                              </span>
                            </span>
                            {injTag && (
                              <span
                                className={`dd-inj ${
                                  injTag === "Q" ? "q" : ""
                                }`}
                              >
                                {injTag}
                              </span>
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="dd-empty">No picks yet.</p>
                )}
              </>
            );
          })()}
        </main>
      )}

      {/* ---- MORE TAB ---- */}
      {tab === "more" && (
        <main className="dd-main dd-pad">
          <h2 className="dd-section-title">
            Keepers{keepers.length ? ` (${keepers.length})` : ""}
          </h2>
          <section className="dd-card">
            <KeeperManager
              players={players}
              keepers={keepers}
              draftedIds={draftedIds}
              numTeams={numTeams}
              numRounds={numRounds}
              nameFor={nameFor}
              addKeeper={addKeeper}
              removeKeeper={removeKeeper}
            />
          </section>

          <h2 className="dd-section-title">Rankings</h2>
          <section className="dd-card">
            <RankingsSourcePanel
              compact
              rankingsSource={rankingsSource}
              rankingsMeta={rankingsMeta}
              playerCount={players.length}
              seedStatus={seedStatus}
              webStatus={webStatus}
              scoring={scoring}
              changeScoring={changeScoring}
              seedFromFile={seedFromFile}
              updateFromWeb={updateFromWeb}
              chooseImport={() => setRankingsSource("import")}
              storedImport={storedImport}
              restoreImport={restoreImport}
              importPanel={
                <ImportPanel
                  importText={importText}
                  setImportText={setImportText}
                  importPreview={importPreview}
                  previewImport={previewImport}
                  applyImport={applyImport}
                  fileRef={fileRef}
                  handleFile={handleFile}
                />
              }
            />
          </section>

          <h2 className="dd-section-title">Player data</h2>
          <section className="dd-card">
            <p className="dd-hint" style={{ margin: 0 }}>
              Live injuries, roster status, and depth charts from Sleeper —
              shown as badges on player rows and in player details.{" "}
              {metaData
                ? `Synced ${new Date(metaData.fetched).toLocaleString(
                    undefined,
                    {
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    }
                  )}.`
                : "Not synced yet."}
              {metaStatus === "error" ? " Last sync failed." : ""}
            </p>
            <button
              className="dd-btn"
              style={{ marginTop: 10 }}
              onClick={refreshPlayerMeta}
              disabled={metaStatus === "loading"}
            >
              {metaStatus === "loading" ? "Syncing…" : "Refresh player data"}
            </button>
            <p className="dd-hint">
              Auto-refreshes once a day (~3 MB download).
            </p>
          </section>

          <h2 className="dd-section-title">Draft controls</h2>
          <section className="dd-card">
            <button className="dd-btn warn" onClick={restartDraft}>
              Clear picks (keep keepers, rankings, settings)
            </button>
            <button
              className="dd-btn"
              onClick={() => setPhase("setup")}
              style={{ marginTop: 10 }}
            >
              Back to setup
            </button>
            <button
              className="dd-btn danger"
              onClick={fullReset}
              style={{ marginTop: 10 }}
            >
              Full reset (everything)
            </button>
          </section>
          <p className="dd-hint pad">
            Progress auto-saves on this device as you go. Value badges (+N)
            show how far a player has fallen past their ADP — or their rank if
            no ADP column was imported.
          </p>
        </main>
      )}

      {/* ---- EDIT PICK SHEET ---- */}
      {editingPick && (
        <div
          className="dd-sheet-backdrop"
          onClick={() => setEditOverall(null)}
        >
          <div className="dd-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="dd-sheet-head">
              <span
                className="dd-pos"
                style={{ background: POS_COLOR[editingPick.pos] || "#666" }}
              >
                {editingPick.pos}
              </span>
              <div className="dd-nameblock">
                <span className="dd-pname">
                  {editingPick.keeper ? "🔒 " : ""}
                  {editingPick.name}
                </span>
                <span className="dd-pmeta">
                  {pickLabel(editingPick.overall, numTeams)} ·{" "}
                  {nameFor(editingPick.teamIdx)}
                  {editingPick.keeper ? " · Keeper" : ""}
                </span>
              </div>
            </div>
            {editingPick.keeper ? (
              <>
                <p className="dd-hint" style={{ margin: "10px 0" }}>
                  Keepers are managed from the Keepers section. Removing frees
                  the slot and returns the player to the pool.
                </p>
                <button
                  className="dd-btn danger"
                  onClick={() => removePickAt(editingPick.overall)}
                >
                  Remove keeper
                </button>
              </>
            ) : (
              <>
                <button
                  className="dd-btn go"
                  onClick={() => startChangePlayer(editingPick.overall)}
                >
                  Change player at this pick
                </button>
                <button
                  className="dd-btn danger"
                  style={{ marginTop: 10 }}
                  onClick={() => removePickAt(editingPick.overall)}
                >
                  Remove pick (slot reopens)
                </button>
              </>
            )}
            <button
              className="dd-btn"
              style={{ marginTop: 10 }}
              onClick={() => {
                setDetailId(editingPick.playerId);
                setEditOverall(null);
              }}
            >
              Player details
            </button>
            <button
              className="dd-btn"
              style={{ marginTop: 10 }}
              onClick={() => setEditOverall(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ---- PLAYER DETAIL SHEET ---- */}
      {detailId != null &&
        (() => {
          const dp = players.find((x) => x.id === detailId);
          if (!dp) return null;
          return (
            <PlayerDetailSheet
              player={dp}
              meta={metaFor(dp)}
              pickInfo={draftedIds.get(dp.id)}
              value={valueFor(dp)}
              isTarget={targets.includes(dp.id)}
              toggleTarget={toggleTarget}
              nameFor={nameFor}
              numTeams={numTeams}
              onClose={() => setDetailId(null)}
            />
          );
        })()}

      {/* Bottom navigation — wide screens show Players+Board as one Draft view */}
      <nav className="dd-nav">
        {(isWide
          ? [
              ["players", "Draft"],
              ["roster", "My Team"],
              ["more", "More"],
            ]
          : [
              ["players", "Players"],
              ["board", "Board"],
              ["roster", "My Team"],
              ["more", "More"],
            ]
        ).map(([key, label]) => (
          <button
            key={key}
            className={`dd-nav-btn ${
              tab === key || (key === "players" && showSplit) ? "on" : ""
            }`}
            onClick={() => {
              setTab(key);
              setSelectedId(null);
            }}
          >
            {label}
          </button>
        ))}
      </nav>

      {toast && <div className="dd-toast">{toast}</div>}
    </div>
  );
}

/* ---------- keeper manager (setup + More tab) ---------- */
function KeeperManager({
  players,
  keepers,
  draftedIds,
  numTeams,
  numRounds,
  nameFor,
  addKeeper,
  removeKeeper,
}) {
  const [kTeam, setKTeam] = useState(0);
  const [kRound, setKRound] = useState(1);
  const [kSearch, setKSearch] = useState("");

  const results = useMemo(() => {
    const q = kSearch.trim().toLowerCase();
    if (!q) return [];
    return players
      .filter(
        (p) =>
          !draftedIds.has(p.id) &&
          `${p.name} ${p.team}`.toLowerCase().includes(q)
      )
      .sort((a, b) => a.rank - b.rank)
      .slice(0, 6);
  }, [players, draftedIds, kSearch]);

  return (
    <div className="dd-keeper">
      <div className="dd-keeper-selects">
        <label className="dd-select-wrap">
          <span>Team</span>
          <select
            value={kTeam}
            onChange={(e) => setKTeam(Number(e.target.value))}
          >
            {Array.from({ length: numTeams }, (_, i) => (
              <option key={i} value={i}>
                {nameFor(i)}
              </option>
            ))}
          </select>
        </label>
        <label className="dd-select-wrap">
          <span>Round</span>
          <select
            value={kRound}
            onChange={(e) => setKRound(Number(e.target.value))}
          >
            {Array.from({ length: numRounds }, (_, i) => (
              <option key={i} value={i + 1}>
                Round {i + 1} ({pickLabel(overallFor(kTeam, i + 1, numTeams), numTeams)})
              </option>
            ))}
          </select>
        </label>
      </div>
      <input
        className="dd-search small"
        type="search"
        placeholder="Search player to keep…"
        value={kSearch}
        onChange={(e) => setKSearch(e.target.value)}
      />
      {results.length > 0 && (
        <ul className="dd-keeper-results">
          {results.map((p) => (
            <li key={p.id}>
              <span
                className="dd-pos"
                style={{ background: POS_COLOR[p.pos] || "#666" }}
              >
                {p.pos}
              </span>
              <span className="dd-keeper-name">
                {p.name} <em>{p.team}</em>
              </span>
              <button
                className="dd-mini"
                onClick={() => {
                  if (addKeeper(p, kTeam, kRound)) setKSearch("");
                }}
              >
                Keep
              </button>
            </li>
          ))}
        </ul>
      )}
      {keepers.length > 0 && (
        <ul className="dd-keeper-list">
          {keepers.map((k, i) => (
            <li key={`${k.playerId}-${i}`}>
              <span className="dd-keeper-slot">
                {pickLabel(overallFor(k.teamIdx, k.round, numTeams), numTeams)}
              </span>
              <span
                className="dd-pos"
                style={{ background: POS_COLOR[k.pos] || "#666" }}
              >
                {k.pos}
              </span>
              <span className="dd-keeper-name">
                {k.name} <em>→ {nameFor(k.teamIdx)}</em>
              </span>
              <button
                className="dd-mini danger"
                onClick={() => removeKeeper(i)}
                aria-label={`Remove keeper ${k.name}`}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ---------- player detail sheet ---------- */
function PlayerDetailSheet({
  player,
  meta,
  pickInfo,
  value,
  isTarget,
  toggleTarget,
  nameFor,
  numTeams,
  onClose,
}) {
  const tag = injuryTag(meta);
  const injLine =
    meta && (meta.inj || tag)
      ? [meta.inj || tag, meta.part].filter(Boolean).join(" — ")
      : null;
  const rosterLine =
    meta && meta.status && meta.status !== "Active" ? meta.status : null;
  return (
    <div className="dd-sheet-backdrop" onClick={onClose}>
      <div className="dd-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="dd-sheet-head">
          <span
            className="dd-pos"
            style={{ background: POS_COLOR[player.pos] || "#666" }}
          >
            {player.pos}
          </span>
          <div className="dd-nameblock">
            <span className="dd-pname">{player.name}</span>
            <span className="dd-pmeta">
              {player.team || "—"}
              {meta && meta.num ? ` · #${meta.num}` : ""}
              {player.bye ? ` · Bye ${player.bye}` : ""}
            </span>
          </div>
          {!pickInfo && (
            <button
              className={`dd-star ${isTarget ? "on" : ""}`}
              onClick={() => toggleTarget(player.id)}
              aria-label={isTarget ? "Remove target" : "Target player"}
            >
              ★
            </button>
          )}
        </div>

        {(injLine || rosterLine) && (
          <div className={`dd-detail-inj ${tag === "Q" ? "q" : ""}`}>
            <b>{injLine || rosterLine}</b>
            {injLine && rosterLine ? ` · ${rosterLine}` : ""}
            {meta.practice ? ` · Practice: ${meta.practice}` : ""}
            {meta.note ? <div className="dd-detail-note">{meta.note}</div> : null}
          </div>
        )}

        <div className="dd-detail-grid">
          <div className="dd-detail-row">
            <span>Rank</span>
            <b>{player.rank}</b>
          </div>
          <div className="dd-detail-row">
            <span>ADP</span>
            <b>{player.adp != null ? player.adp : "—"}</b>
          </div>
          <div className="dd-detail-row">
            <span>Status</span>
            <b>
              {pickInfo
                ? `${pickLabel(pickInfo.overall, numTeams)} · ${nameFor(
                    pickInfo.teamIdx
                  )}`
                : value != null
                ? `Available · value +${value}`
                : "Available"}
            </b>
          </div>
          {meta && meta.depthPos && (
            <div className="dd-detail-row">
              <span>Depth chart</span>
              <b>
                {meta.depthPos}
                {meta.depthOrd || ""} · {meta.team}
              </b>
            </div>
          )}
          {meta && meta.age && (
            <div className="dd-detail-row">
              <span>Age / Exp</span>
              <b>
                {meta.age}
                {meta.exp != null
                  ? ` · ${meta.exp === 0 ? "Rookie" : `${meta.exp} yr`}`
                  : ""}
              </b>
            </div>
          )}
          {meta && (meta.ht || meta.wt) && (
            <div className="dd-detail-row">
              <span>Size</span>
              <b>
                {[fmtHeight(meta.ht), meta.wt ? `${meta.wt} lb` : null]
                  .filter(Boolean)
                  .join(" · ")}
              </b>
            </div>
          )}
          {meta && meta.college && (
            <div className="dd-detail-row">
              <span>College</span>
              <b>{meta.college}</b>
            </div>
          )}
        </div>

        {!meta && (
          <p className="dd-hint" style={{ margin: "0 0 12px" }}>
            No live player data matched — bio and injury info unavailable.
          </p>
        )}
        {meta && meta.news && (
          <p className="dd-hint" style={{ margin: "0 0 12px" }}>
            News updated{" "}
            {new Date(meta.news).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
            })}{" "}
            · Sleeper
          </p>
        )}
        <button className="dd-btn" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

/* ---------- current rankings status line ---------- */
function CurrentListLine({ meta, count, busy, topOfCard }) {
  const style = topOfCard ? { marginTop: 0, marginBottom: 12 } : undefined;
  if (busy)
    return (
      <p className="dd-hint" style={style}>
        Loading rankings…
      </p>
    );
  if (!count)
    return (
      <p className="dd-hint" style={style}>
        No rankings loaded yet.
      </p>
    );
  return (
    <p className="dd-hint" style={style}>
      Current list: <strong>{(meta && meta.label) || "Manual import"}</strong>
      {" · "}
      {count} players · Last updated:{" "}
      <strong>{(meta && meta.updated) || "unknown"}</strong>
      {meta && meta.kind === "csv" && !meta.updated && (
        <>
          {" "}
          — add a first line like <code># updated: 2026-08-30</code> (or a
          date column) to your players CSV so this date shows.
        </>
      )}
    </p>
  );
}

/* ---------- one-click web update panel (setup + More tab) ---------- */
/* ---------- rankings source panel (setup + More tab) ----------
   One place to pick where rankings come from. Import controls only
   appear when Custom CSV is the chosen source; `compact` drops the
   explainer text for the in-draft More tab. */
function RankingsSourcePanel({
  rankingsSource,
  rankingsMeta,
  playerCount,
  seedStatus,
  webStatus,
  scoring,
  changeScoring,
  seedFromFile,
  updateFromWeb,
  chooseImport,
  importPanel,
  compact,
  storedImport,
  restoreImport,
}) {
  const busy = seedStatus === "loading" || webStatus === "loading";
  return (
    <>
      <div className="dd-source-row">
        <button
          className={`dd-source ${rankingsSource === "csv" ? "on" : ""}`}
          onClick={() => seedFromFile(true)}
          disabled={busy}
        >
          <b>{CSV_SOURCE_NAME}</b>
          <small>my sheet · auto-updated</small>
        </button>
        <button
          className={`dd-source ${rankingsSource === "web" ? "on" : ""}`}
          onClick={() => updateFromWeb()}
          disabled={busy}
        >
          <b>Live ADP</b>
          <small>{WEB_SOURCE_NAME} · on demand</small>
        </button>
        <button
          className={`dd-source ${rankingsSource === "import" ? "on" : ""}`}
          onClick={chooseImport}
          disabled={busy}
        >
          <b>Custom CSV</b>
          <small>paste or upload · manual</small>
        </button>
      </div>
      <CurrentListLine
        meta={rankingsMeta}
        count={playerCount}
        busy={busy}
      />
      {rankingsSource !== "import" && (
        <div className="dd-webupdate-row" style={{ marginTop: 10 }}>
          <label className="dd-select-wrap">
            <span>Scoring</span>
            <select
              value={scoring}
              onChange={(e) => changeScoring(e.target.value)}
            >
              <option value="ppr">PPR</option>
              <option value="half-ppr">Half PPR</option>
              <option value="standard">Standard</option>
            </select>
          </label>
          {rankingsSource === "web" ? (
            <button
              className="dd-btn go webupdate"
              onClick={() => updateFromWeb()}
              disabled={busy}
            >
              {webStatus === "loading" ? "Updating…" : "Update now"}
            </button>
          ) : (
            <button
              className="dd-btn webupdate"
              onClick={() => seedFromFile(true)}
              disabled={busy}
            >
              {seedStatus === "loading" ? "Loading…" : "Reload list"}
            </button>
          )}
        </div>
      )}
      {!compact && rankingsSource === "csv" && (
        <p className="dd-hint">
          {CSV_SOURCE_NAME} sheets ship with the site and update automatically
          when new rankings are published — the latest list loads on its own.
          Half PPR uses the PPR sheet.
        </p>
      )}
      {!compact && rankingsSource === "web" && (
        <p className="dd-hint">
          Pulls live consensus ADP from {WEB_SOURCE_NAME} each time you tap
          Update — no redeploy needed.
        </p>
      )}
      {rankingsSource === "import" && (
        <>
          {!compact && (
            <p className="dd-hint">
              Your pasted or uploaded file becomes the ranking source. Headers
              like <em>rank, name, pos, team, bye, adp</em> are detected in
              any order; picks and keepers re-match by name.
            </p>
          )}
          {storedImport && storedImport.players && (
            <button
              className="dd-btn"
              style={{ marginTop: 10 }}
              onClick={restoreImport}
            >
              Use last imported list ({storedImport.players.length} players —{" "}
              {storedImport.label})
            </button>
          )}
          {importPanel}
        </>
      )}
      {seedStatus === "error" && !playerCount && (
        <p className="dd-hint" style={{ color: "#EF6461" }}>
          Couldn't load a players CSV from the site — choose Custom CSV and
          paste or upload rankings instead.
        </p>
      )}
    </>
  );
}

/* ---------- shared import panel ---------- */
function ImportPanel({
  importText,
  setImportText,
  importPreview,
  previewImport,
  applyImport,
  fileRef,
  handleFile,
}) {
  return (
    <div className="dd-import">
      <textarea
        className="dd-textarea"
        rows={5}
        placeholder={
          "Paste rankings here, e.g.\nrank,name,pos,team,bye,adp\n1, Ja'Marr Chase, WR, CIN, 10, 1"
        }
        value={importText}
        onChange={(e) => setImportText(e.target.value)}
      />
      <div className="dd-import-actions">
        <button
          className="dd-btn"
          onClick={() => fileRef.current && fileRef.current.click()}
        >
          Upload CSV / TXT
        </button>
        <button
          className="dd-btn"
          onClick={previewImport}
          disabled={!importText.trim()}
        >
          Preview
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.txt,.tsv"
          onChange={handleFile}
          style={{ display: "none" }}
        />
      </div>
      {importPreview && (
        <div className="dd-preview">
          <p>
            Parsed <strong>{importPreview.players.length}</strong> players
            {importPreview.errors.length
              ? ` · ${importPreview.errors.length} line(s) skipped`
              : ""}
            .
          </p>
          {importPreview.players.slice(0, 3).map((p) => (
            <p key={p.id} className="dd-preview-line">
              {p.rank}. {p.name} — {p.pos} {p.team}
              {p.bye ? ` (Bye ${p.bye})` : ""}
              {p.adp != null ? ` · ADP ${p.adp}` : ""}
            </p>
          ))}
          {importPreview.players.length > 0 && (
            <button className="dd-btn go" onClick={applyImport}>
              Replace rankings with these {importPreview.players.length}{" "}
              players
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------- styles ---------- */
const CSS = `
:root { color-scheme: dark; }
.dd-root {
  --bg: #14181D;
  --panel: #1C222A;
  --line: #2A323C;
  --text: #F2F4F6;
  --muted: #8C97A4;
  --gold: #F0C24B;
  min-height: 100vh;
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 16px;
  -webkit-font-smoothing: antialiased;
  padding-bottom: calc(72px + env(safe-area-inset-bottom, 0px));
  padding-left: env(safe-area-inset-left, 0px);
  padding-right: env(safe-area-inset-right, 0px);
  /* clip, not hidden: hidden would make this the scroll container and
     break position: sticky on the clock bar */
  overflow-x: clip;
}
.dd-root *, .dd-root *::before, .dd-root *::after { box-sizing: border-box; }
.dd-root button { font: inherit; cursor: pointer; -webkit-tap-highlight-color: transparent; }
.dd-root button:focus-visible, .dd-root input:focus-visible, .dd-root select:focus-visible, .dd-root textarea:focus-visible {
  outline: 2px solid var(--gold); outline-offset: 2px;
}
.dd-loading { padding: 48px 20px; text-align: center; color: var(--muted); letter-spacing: 0.08em; text-transform: uppercase; font-size: 13px; }

/* ---- setup ---- */
.dd-setup { max-width: 560px; margin: 0 auto; padding: calc(24px + env(safe-area-inset-top, 0px)) 16px 40px; }
.dd-brand { margin-bottom: 20px; }
.dd-brand-kick { font-size: 11px; letter-spacing: 0.22em; color: var(--gold); font-weight: 700; }
.dd-brand h1 { margin: 4px 0 6px; font-size: 34px; font-weight: 800; letter-spacing: -0.01em; text-transform: uppercase; }
.dd-sub { margin: 0; color: var(--muted); }
.dd-card { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 16px; margin-bottom: 14px; }
.dd-card-title { margin: 0 0 12px; font-size: 12px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--muted); font-weight: 700; }
.dd-choice-row { display: flex; gap: 8px; flex-wrap: wrap; }
.dd-choice { min-width: 52px; min-height: 48px; border-radius: 10px; border: 1px solid var(--line); background: var(--bg); color: var(--text); font-weight: 700; font-size: 17px; }
.dd-choice.on { background: var(--gold); border-color: var(--gold); color: #14181D; }
.dd-stepper { display: flex; align-items: center; gap: 18px; }
.dd-stepper button { width: 52px; height: 48px; border-radius: 10px; border: 1px solid var(--line); background: var(--bg); color: var(--text); font-size: 22px; }
.dd-stepper span { font-size: 22px; font-weight: 800; min-width: 40px; text-align: center; font-variant-numeric: tabular-nums; }
.dd-slot-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(52px, 1fr)); gap: 8px; }
.dd-slot { min-height: 48px; border-radius: 10px; border: 1px solid var(--line); background: var(--bg); color: var(--text); font-weight: 700; font-size: 16px; font-variant-numeric: tabular-nums; }
.dd-slot.on { background: var(--gold); border-color: var(--gold); color: #14181D; }
.dd-hint { color: var(--muted); font-size: 14px; margin: 10px 0 0; line-height: 1.45; }
.dd-hint code { color: var(--gold); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
.dd-hint.pad { padding: 0 16px 16px; }
.dd-linkbtn { background: none; border: none; color: var(--gold); font-weight: 600; padding: 4px 0; }
.dd-names { margin-top: 12px; display: grid; gap: 8px; }
.dd-name-row { display: flex; align-items: center; gap: 10px; }
.dd-name-row span { width: 34px; color: var(--muted); font-variant-numeric: tabular-nums; font-weight: 700; }
.dd-name-row span.me { color: var(--gold); }
.dd-name-row input { flex: 1; min-height: 44px; background: var(--bg); border: 1px solid var(--line); border-radius: 10px; color: var(--text); padding: 0 12px; font-size: 16px; }
.dd-start { width: 100%; min-height: 56px; border: none; border-radius: 14px; background: var(--gold); color: #14181D; font-size: 18px; font-weight: 800; letter-spacing: 0.04em; text-transform: uppercase; margin-top: 6px; }

/* ---- keeper manager ---- */
.dd-keeper { margin-top: 4px; }
.dd-keeper-selects { display: flex; gap: 8px; margin-bottom: 8px; }
.dd-select-wrap { flex: 1; display: flex; flex-direction: column; gap: 4px; }
.dd-select-wrap span { font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted); font-weight: 700; }
.dd-select-wrap select { min-height: 48px; background: var(--bg); border: 1px solid var(--line); border-radius: 10px; color: var(--text); padding: 0 10px; font-size: 15px; width: 100%; }
.dd-search.small { min-height: 46px; }
.dd-keeper-results { list-style: none; margin: 8px 0 0; padding: 0; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
.dd-keeper-results li { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-bottom: 1px solid var(--line); }
.dd-keeper-results li:last-child { border-bottom: none; }
.dd-keeper-name { flex: 1; min-width: 0; font-size: 15px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dd-keeper-name em { font-style: normal; color: var(--muted); font-weight: 500; font-size: 13px; }
.dd-mini { min-height: 40px; padding: 0 14px; border-radius: 8px; border: none; background: var(--gold); color: #14181D; font-weight: 800; font-size: 14px; }
.dd-mini.danger { background: none; border: 1px solid var(--line); color: #EF6461; min-width: 40px; }
.dd-keeper-list { list-style: none; margin: 12px 0 0; padding: 0; display: grid; gap: 6px; }
.dd-keeper-list li { display: flex; align-items: center; gap: 10px; background: var(--bg); border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; }
.dd-keeper-slot { font-variant-numeric: tabular-nums; font-weight: 800; color: var(--gold); font-size: 14px; min-width: 42px; }

/* ---- clock bar ---- */
.dd-clock { position: sticky; top: 0; z-index: 20; display: flex; align-items: center; gap: 12px; padding: 12px 14px; padding-top: calc(12px + env(safe-area-inset-top, 0px)); background: var(--panel); border-bottom: 1px solid var(--line); }
.dd-clock.mine { background: linear-gradient(90deg, #3A3216, #2A2712); border-bottom-color: var(--gold); }
.dd-clock-pick { display: flex; flex-direction: column; align-items: center; min-width: 58px; }
.dd-clock-kick { font-size: 10px; letter-spacing: 0.2em; color: var(--muted); font-weight: 700; }
.dd-clock.mine .dd-clock-kick { color: var(--gold); }
.dd-clock-num { font-size: 22px; font-weight: 800; font-variant-numeric: tabular-nums; }
.dd-clock-main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.dd-clock-team { font-weight: 800; font-size: 16px; text-transform: uppercase; letter-spacing: 0.03em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dd-clock.mine .dd-clock-team { color: var(--gold); }
.dd-clock-sub { font-size: 13px; color: var(--muted); }
.dd-undo { min-height: 44px; padding: 0 14px; border-radius: 10px; border: 1px solid var(--line); background: var(--bg); color: var(--text); font-weight: 700; }
.dd-undo:disabled { opacity: 0.35; cursor: default; }

/* ---- player list ---- */
.dd-main { max-width: 720px; margin: 0 auto; width: 100%; min-width: 0; }
.dd-pad { padding: 16px; }
.dd-listtools { position: sticky; top: var(--clock-h, 64px); z-index: 10; background: var(--bg); }
.dd-search-wrap { display: flex; gap: 8px; padding: 12px 14px 4px; }
.dd-search { flex: 1; min-width: 0; min-height: 48px; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; color: var(--text); padding: 0 14px; font-size: 16px; }
.dd-search::placeholder { color: var(--muted); }
.dd-chips { display: flex; gap: 6px; overflow-x: auto; padding: 10px 14px; -webkit-overflow-scrolling: touch; }
.dd-chips::-webkit-scrollbar { display: none; }
.dd-chip { flex: 0 0 auto; min-height: 40px; padding: 0 14px; border-radius: 999px; border: 1px solid var(--line); background: var(--panel); color: var(--text); font-weight: 700; font-size: 14px; }
.dd-chip.on { background: var(--text); border-color: var(--text); color: #14181D; }
.dd-chip.ghost { color: var(--muted); }
.dd-chip.on-ghost { border-color: var(--gold); color: var(--gold); }
select.dd-source-quick { appearance: none; -webkit-appearance: none; flex: 0 0 auto; max-width: 44%; min-height: 48px; border: 1px solid var(--line); border-radius: 12px; background-color: var(--panel); color: var(--gold); font-weight: 700; font-size: 14px; padding: 0 30px 0 12px; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23F0C24B' stroke-width='1.6' fill='none' stroke-linecap='round'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 12px center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
select.dd-source-quick:disabled { opacity: 0.5; }
.dd-list { list-style: none; margin: 0; padding: 0 0 16px; }
.dd-list.roster { margin-top: 12px; }
.dd-row { border-bottom: 1px solid var(--line); position: relative; }
.dd-row.sel { background: #202832; }
.dd-row.picked { opacity: 0.5; }
.dd-row-main { display: flex; align-items: center; gap: 12px; width: 100%; padding: 10px 56px 10px 14px; min-height: 56px; background: none; border: none; color: var(--text); text-align: left; }
.dd-rank { min-width: 30px; text-align: right; color: var(--muted); font-variant-numeric: tabular-nums; font-weight: 700; font-size: 14px; }
.dd-pos { flex: 0 0 auto; width: 42px; text-align: center; padding: 4px 0; border-radius: 6px; color: #10141A; font-weight: 800; font-size: 12px; letter-spacing: 0.04em; }
.dd-nameblock { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.dd-pname { font-weight: 700; font-size: 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dd-pmeta { font-size: 13px; color: var(--muted); }
.dd-val { flex: 0 0 auto; margin-left: 6px; background: rgba(78,196,136,0.15); border: 1px solid #4EC488; color: #4EC488; font-weight: 800; font-size: 12px; padding: 3px 8px; border-radius: 999px; font-variant-numeric: tabular-nums; }
.dd-star { position: absolute; right: 6px; top: 8px; width: 44px; height: 44px; border: none; background: none; color: var(--line); font-size: 20px; }
.dd-star.on { color: var(--gold); }
.dd-confirm { display: flex; gap: 8px; padding: 0 14px 12px; }
.dd-draftbtn { flex: 1; min-height: 48px; border: none; border-radius: 10px; background: var(--text); color: #14181D; font-weight: 800; font-size: 15px; padding: 0 10px; }
.dd-draftbtn.mine { background: var(--gold); }
.dd-cancel { min-height: 48px; padding: 0 14px; border-radius: 10px; border: 1px solid var(--line); background: none; color: var(--muted); font-weight: 700; }
.dd-empty { padding: 28px 16px; color: var(--muted); text-align: center; }

/* ---- board ---- */
.dd-board-wrap { padding-top: 10px; max-width: 100%; }
.dd-board-scroll { overflow-x: auto; width: 100%; max-width: 100vw; -webkit-overflow-scrolling: touch; overscroll-behavior-x: contain; }
.dd-board { border-collapse: separate; border-spacing: 0; min-width: 100%; border-top: 1px solid var(--line); border-left: 1px solid var(--line); }
.dd-board th { background: var(--panel); font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); padding: 8px 6px; border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); min-width: 96px; }
.dd-board th.me { color: var(--gold); }
.dd-board-rnd { min-width: 34px !important; width: 34px; text-align: center; color: var(--muted); font-variant-numeric: tabular-nums; font-weight: 700; background: var(--panel); position: sticky; left: 0; z-index: 2; border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); font-size: 12px; }
.dd-cell { border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); padding: 3px; height: 52px; vertical-align: middle; }
.dd-cell.mecol { background: rgba(240,194,75,0.06); }
.dd-cell.current { box-shadow: inset 0 0 0 2px var(--gold); }
.dd-cell.assign { box-shadow: inset 0 0 0 2px var(--text); background: rgba(242,244,246,0.08); }
.dd-cell-empty { display: block; width: 100%; height: 100%; min-height: 44px; background: none; border: none; color: #3A434E; font-size: 11px; font-variant-numeric: tabular-nums; }
.dd-sticker { display: block; width: 100%; border: none; text-align: left; border-radius: 6px; padding: 5px 6px; color: #10141A; }
.dd-sticker-name { display: block; font-size: 12px; font-weight: 800; line-height: 1.15; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 110px; }
.dd-sticker-meta { display: block; font-size: 10px; font-weight: 700; opacity: 0.75; }

/* ---- roster / more ---- */
.dd-section-title { font-size: 13px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--muted); margin: 18px 0 12px; }
.dd-section-title:first-child { margin-top: 6px; }
.dd-count-row { display: flex; gap: 8px; flex-wrap: wrap; }
.dd-count { border: 1px solid; border-radius: 999px; padding: 6px 12px; font-size: 14px; color: var(--text); }
.dd-btn { display: block; width: 100%; min-height: 48px; border-radius: 10px; border: 1px solid var(--line); background: var(--bg); color: var(--text); font-weight: 700; }
.dd-btn.go { background: var(--gold); border-color: var(--gold); color: #14181D; margin-top: 10px; }
.dd-btn.warn { border-color: #6B5A22; color: var(--gold); }
.dd-btn.danger { border-color: #6B2E2E; color: #EF6461; }
.dd-btn:disabled { opacity: 0.4; cursor: default; }

/* ---- tiers / bye warnings ---- */
.dd-tierhead { list-style: none; padding: 10px 14px 4px; font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--gold); font-weight: 800; }
.dd-tierlast { flex: 0 0 auto; margin-left: 6px; padding: 2px 7px; border-radius: 999px; border: 1px solid #B58CE6; color: #B58CE6; background: rgba(181,140,230,0.12); font-size: 11px; font-weight: 800; white-space: nowrap; }
.dd-confirm { flex-wrap: wrap; }
.dd-byewarn { flex-basis: 100%; margin: 0 0 8px; padding: 8px 10px; border-radius: 8px; background: rgba(242,164,74,0.1); border: 1px solid #6B5A22; color: #F2A44A; font-size: 13px; }
.dd-byes-row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.dd-bye-chip { border: 1px solid var(--line); border-radius: 999px; padding: 6px 12px; font-size: 14px; color: var(--muted); }
.dd-bye-chip.warn2 { border-color: #6B5A22; color: #F2A44A; }
.dd-bye-chip.warn3 { border-color: #6B2E2E; color: #EF6461; }

/* ---- injury badge / player details ---- */
.dd-inj { flex: 0 0 auto; margin-left: 6px; padding: 2px 7px; border-radius: 999px; border: 1px solid #EF6461; color: #EF6461; background: rgba(239,100,97,0.12); font-size: 11px; font-weight: 800; letter-spacing: 0.04em; }
.dd-inj.q { border-color: #F2A44A; color: #F2A44A; background: rgba(242,164,74,0.12); }
.dd-detail-inj { margin: 0 0 12px; padding: 10px 12px; border: 1px solid #6B2E2E; border-radius: 10px; background: rgba(239,100,97,0.08); font-size: 14px; line-height: 1.45; }
.dd-detail-inj.q { border-color: #6B5A22; background: rgba(242,164,74,0.08); }
.dd-detail-note { margin-top: 6px; color: var(--muted); font-size: 13px; }
.dd-detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 14px; margin: 0 0 12px; }
.dd-detail-row { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dd-detail-row span { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); font-weight: 700; }
.dd-detail-row b { font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dd-sheet .dd-star { position: static; width: 44px; height: 44px; flex: 0 0 auto; }

/* ---- edit sheet ---- */
.dd-sheet-backdrop { position: fixed; inset: 0; z-index: 50; background: rgba(0,0,0,0.55); display: flex; align-items: flex-end; justify-content: center; }
.dd-sheet { width: 100%; max-width: 560px; background: var(--panel); border: 1px solid var(--line); border-radius: 18px 18px 0 0; padding: 18px 16px calc(18px + env(safe-area-inset-bottom, 0px)); }
.dd-sheet-head { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }

/* ---- rankings source chooser ---- */
.dd-source-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
.dd-source { flex: 1; min-width: 0; min-height: 64px; border-radius: 12px; border: 1px solid var(--line); background: var(--bg); color: var(--text); display: flex; flex-direction: column; align-items: flex-start; justify-content: center; gap: 2px; padding: 10px 12px; text-align: left; }
.dd-source b { font-size: 15px; font-weight: 800; }
.dd-source small { font-size: 12px; color: var(--muted); white-space: normal; overflow-wrap: anywhere; line-height: 1.3; }
.dd-source.on { border-color: var(--gold); background: rgba(240,194,75,0.08); }
.dd-source.on b { color: var(--gold); }
.dd-source:disabled { opacity: 0.6; cursor: default; }

/* ---- web update panel ---- */
.dd-webupdate-row { display: flex; gap: 8px; align-items: flex-end; }
.dd-webupdate-row .dd-select-wrap { flex: 0 0 42%; }
.dd-webupdate-row .dd-btn.webupdate { flex: 1; width: auto; margin-top: 0; }

/* ---- import ---- */
.dd-import { margin-top: 12px; }
.dd-textarea { width: 100%; background: var(--bg); border: 1px solid var(--line); border-radius: 10px; color: var(--text); padding: 10px 12px; font-size: 14px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; resize: vertical; }
.dd-import-actions { display: flex; gap: 8px; margin-top: 8px; }
.dd-import-actions .dd-btn { width: auto; flex: 1; }
.dd-preview { margin-top: 10px; border-top: 1px dashed var(--line); padding-top: 10px; font-size: 14px; }
.dd-preview p { margin: 0 0 4px; }
.dd-preview-line { color: var(--muted); }

/* ---- nav / toast ---- */
.dd-nav { position: fixed; left: 0; right: 0; bottom: 0; z-index: 30; display: flex; background: var(--panel); border-top: 1px solid var(--line); padding-bottom: env(safe-area-inset-bottom, 0px); padding-left: env(safe-area-inset-left, 0px); padding-right: env(safe-area-inset-right, 0px); }
.dd-nav-btn { flex: 1; min-height: 56px; background: none; border: none; color: var(--muted); font-weight: 700; font-size: 13px; letter-spacing: 0.06em; text-transform: uppercase; border-top: 2px solid transparent; }
.dd-nav-btn.on { color: var(--gold); border-top-color: var(--gold); }
.dd-toast { position: fixed; bottom: calc(70px + env(safe-area-inset-bottom, 0px)); left: 50%; transform: translateX(-50%); z-index: 60; background: var(--text); color: #14181D; font-weight: 700; font-size: 14px; padding: 10px 16px; border-radius: 999px; max-width: 92vw; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; box-shadow: 0 6px 20px rgba(0,0,0,0.4); }

@media (prefers-reduced-motion: no-preference) {
  .dd-cell.assign { animation: dd-assign-pulse 1.2s ease-in-out infinite; }
  @keyframes dd-assign-pulse {
    0%, 100% { box-shadow: inset 0 0 0 2px rgba(242,244,246,1); }
    50% { box-shadow: inset 0 0 0 2px rgba(242,244,246,0.35); }
  }
  .dd-toast { animation: dd-pop 0.18s ease-out; }
  @keyframes dd-pop { from { opacity: 0; transform: translateX(-50%) translateY(6px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }
  .dd-sheet { animation: dd-rise 0.2s ease-out; }
  @keyframes dd-rise { from { transform: translateY(24px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
}
@media (min-width: 768px) {
  .dd-root { font-size: 17px; }
  .dd-main { max-width: 900px; }
  .dd-sheet-backdrop { align-items: center; }
  .dd-sheet { border-radius: 18px; }
}

/* ---- wide split dashboard: players list + live board side by side ---- */
@media (min-width: 1000px) {
  .dd-root.split {
    height: 100dvh;
    overflow: hidden;
    padding-bottom: 0;
    display: grid;
    grid-template-columns: minmax(360px, 430px) 1fr;
    grid-template-rows: auto minmax(0, 1fr) auto;
    grid-template-areas:
      "clock clock"
      "players board"
      "nav nav";
  }
  .dd-root.split .dd-clock { grid-area: clock; }
  .dd-root.split .dd-main {
    grid-area: players;
    overflow-y: auto;
    overscroll-behavior: contain;
    max-width: none;
    margin: 0;
    border-right: 1px solid var(--line);
  }
  .dd-root.split .dd-main.dd-board-wrap {
    grid-area: board;
    border-right: none;
    overflow: auto;
  }
  .dd-root.split .dd-nav {
    grid-area: nav;
    position: static;
  }
  /* Inside the split pane the clock is outside the scroller */
  .dd-root.split .dd-listtools { top: 0; }
  .dd-root.split .dd-sticker-name { max-width: 132px; }
}
`;
