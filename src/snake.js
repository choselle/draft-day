/* ---------- snake-draft math ----------
   Shared by the app and Draft Edge (round-context availability). */
export function teamForPick(overall, numTeams) {
  const r = Math.floor((overall - 1) / numTeams);
  const i = (overall - 1) % numTeams;
  return r % 2 === 0 ? i : numTeams - 1 - i;
}
export function overallFor(teamIdx, round, numTeams) {
  const r = round - 1;
  const i = r % 2 === 0 ? teamIdx : numTeams - 1 - teamIdx;
  return r * numTeams + i + 1;
}
export function pickLabel(overall, numTeams) {
  const r = Math.floor((overall - 1) / numTeams) + 1;
  const i = ((overall - 1) % numTeams) + 1;
  return `${r}.${String(i).padStart(2, "0")}`;
}
