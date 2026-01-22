import { useEffect, useMemo, useState } from "react";

const PLAYERS_KEY = "vereinsapp.players.v1";
const SESSION_KEY = "vereinsapp.session.v1";
const COMPLETED_KEY = "vereinsapp.completed.v1";

// Regeln
const WIN_POINTS = 2;
const LOSS_POINTS = 0;
const BYE_POINTS = 2; // Freilos = Sieg
const BYE_SETS_WON = 0;
const BYE_SETS_LOST = 0;

// TTR/Elo Parameter
const DEFAULT_TTR = 1000;
const TTR_K = 16;
const TTR_SCALE = 150;

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveJSON(key, value) {
  if (value === null || value === undefined) localStorage.removeItem(key);
  else localStorage.setItem(key, JSON.stringify(value));
}

function uid() {
  return crypto?.randomUUID?.() ?? String(Date.now() + Math.random());
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pairKey(aId, bId) {
  return aId < bId ? `${aId}__${bId}` : `${bId}__${aId}`;
}

function generateRoundPairs(playerIds, playedPairsSet) {
  const ids = [...playerIds];
  if (ids.length % 2 === 1) ids.push(null);

  let best = null;
  let bestRepeats = Infinity;

  for (let attempt = 0; attempt < 200; attempt++) {
    const s = shuffle(ids);
    const pairs = [];
    let repeats = 0;

    for (let i = 0; i < s.length; i += 2) {
      const a = s[i];
      const b = s[i + 1];

      if (a === null || b === null) {
        pairs.push([a, b]);
        continue;
      }

      const k = pairKey(a, b);
      if (playedPairsSet.has(k)) repeats++;
      pairs.push([a, b]);
    }

    if (repeats < bestRepeats) {
      bestRepeats = repeats;
      best = pairs;
      if (repeats === 0) break;
    }
  }

  return best ?? [];
}

const RESULT_OPTIONS = [
  { label: "—", value: "" },
  { label: "3–0", value: "3-0" },
  { label: "2–1", value: "2-1" },
  { label: "1–2", value: "1-2" },
  { label: "0–3", value: "0-3" },
];

function parseResult(value) {
  if (!value) return null;
  const [a, b] = value.split("-").map((x) => Number(x));
  if (![0, 1, 2, 3].includes(a) || ![0, 1, 2, 3].includes(b)) return null;
  if (a + b !== 3) return null; // exakt 3 Sätze
  return { a, b };
}

// --- TTR Funktionen (dein Ansatz, nur sauber symmetrisch) ---
function expectedScore(rA, rB) {
  return 1 / (1 + Math.pow(10, (rB - rA) / TTR_SCALE));
}

function matchDelta(rA, rB, aWon, k = TTR_K) {
  const P = expectedScore(rA, rB);
  const result = aWon ? 1 : 0;
  const deltaA = Math.round((result - P) * k);
  const deltaB = -deltaA;
  return { deltaA, deltaB };
}

export default function App() {
  const [players, setPlayers] = useState(() => {
    const p = loadJSON(PLAYERS_KEY, []);
    return Array.isArray(p) ? p : [];
  });
  const [session, setSession] = useState(() => loadJSON(SESSION_KEY, null));
  const [completed, setCompleted] = useState(() => {
    const x = loadJSON(COMPLETED_KEY, []);
    return Array.isArray(x) ? x : [];
  });

  const [name, setName] = useState("");

  useEffect(() => saveJSON(PLAYERS_KEY, players), [players]);
  useEffect(() => saveJSON(SESSION_KEY, session), [session]);
  useEffect(() => saveJSON(COMPLETED_KEY, completed), [completed]);

  // Migration: falls irgendwo ttr fehlt -> DEFAULT_TTR
  useEffect(() => {
    setPlayers((prev) =>
      prev.map((p) => ({
        ...p,
        ttr: Number.isFinite(p.ttr) ? p.ttr : DEFAULT_TTR,
      }))
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sortedPlayers = useMemo(
    () => [...players].sort((a, b) => a.name.localeCompare(b.name, "de")),
    [players]
  );

  const activeCount = useMemo(() => players.filter((p) => p.active).length, [players]);

  function addPlayer(e) {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;

    if (players.some((p) => p.name.toLowerCase() === n.toLowerCase())) return;

    setPlayers((prev) => [
      ...prev,
      { id: uid(), name: n, ttr: DEFAULT_TTR, active: true },
    ]);
    setName("");
  }

  function toggleActive(id) {
    setPlayers((prev) => prev.map((p) => (p.id === id ? { ...p, active: !p.active } : p)));
  }

  function removePlayer(id) {
    setPlayers((prev) => prev.filter((p) => p.id !== id));
  }

  function setAllActive(value) {
    setPlayers((prev) => prev.map((p) => ({ ...p, active: value })));
  }

  function startRanking() {
    const activePlayers = players.filter((p) => p.active);
    if (activePlayers.length < 2) {
      alert("Mindestens 2 anwesende Spieler auswählen.");
      return;
    }

    // Snapshot der TTRs zum Spieltag-Start (wichtig fürs Batch-Update)
    setSession({
      id: uid(),
      startedAt: new Date().toISOString(),
      rounds: 6,
      players: activePlayers.map((p) => ({ ...p })),
      matches: [],
      currentRound: 0,
      finished: false,
      finishedAt: null,
    });
  }

  function endSession() {
    setSession(null);
  }

  function drawNextRound() {
    if (!session || session.finished) return;

    const nextRound = (session.currentRound ?? 0) + 1;
    if (nextRound > session.rounds) return;

    const ids = session.players.map((p) => p.id);

    const played = new Set();
    for (const m of session.matches ?? []) {
      if (m.byeId) continue;
      played.add(pairKey(m.aId, m.bId));
    }

    const pairs = generateRoundPairs(ids, played);

    const newMatches = pairs.map(([a, b]) => {
      if (a === null || b === null) {
        const byeId = a ?? b;
        return { id: uid(), round: nextRound, byeId };
      }
      return { id: uid(), round: nextRound, aId: a, bId: b, scoreA: null, scoreB: null };
    });

    setSession((prev) => ({
      ...prev,
      currentRound: nextRound,
      matches: [...(prev.matches ?? []), ...newMatches],
    }));
  }

  const nameById = useMemo(() => {
    const map = new Map();
    if (session?.players) for (const p of session.players) map.set(p.id, p.name);
    return map;
  }, [session]);

  const currentRoundMatches = useMemo(() => {
    if (!session) return [];
    const r = session.currentRound ?? 0;
    return (session.matches ?? []).filter((m) => m.round === r);
  }, [session]);

  function setMatchResult(matchId, value) {
    if (!session || session.finished) return;

    const parsed = parseResult(value);
    setSession((prev) => ({
      ...prev,
      matches: (prev.matches ?? []).map((m) => {
        if (m.id !== matchId) return m;
        if (m.byeId) return m;
        return { ...m, scoreA: parsed ? parsed.a : null, scoreB: parsed ? parsed.b : null };
      }),
    }));
  }

  const allMatchesHaveResults = useMemo(() => {
    if (!session) return false;
    for (const m of session.matches ?? []) {
      if (m.byeId) continue;
      if (m.scoreA === null || m.scoreB === null) return false;
    }
    return (session.matches?.length ?? 0) > 0;
  }, [session]);

  const standings = useMemo(() => {
    if (!session) return [];

    const base = new Map(
      session.players.map((p) => [
        p.id,
        {
          id: p.id,
          name: p.name,
          points: 0,
          wins: 0,
          losses: 0,
          setsWon: 0,
          setsLost: 0,
          played: 0,
        },
      ])
    );

    for (const m of session.matches ?? []) {
      if (m.byeId) {
        const P = base.get(m.byeId);
        if (!P) continue;
        P.played += 1;
        P.wins += 1;
        P.points += BYE_POINTS;
        P.setsWon += BYE_SETS_WON;
        P.setsLost += BYE_SETS_LOST;
        continue;
      }

      if (m.scoreA === null || m.scoreB === null) continue;

      const A = base.get(m.aId);
      const B = base.get(m.bId);
      if (!A || !B) continue;

      A.played += 1;
      B.played += 1;

      A.setsWon += m.scoreA;
      A.setsLost += m.scoreB;
      B.setsWon += m.scoreB;
      B.setsLost += m.scoreA;

      if (m.scoreA > m.scoreB) {
        A.wins += 1;
        B.losses += 1;
        A.points += WIN_POINTS;
        B.points += LOSS_POINTS;
      } else {
        B.wins += 1;
        A.losses += 1;
        B.points += WIN_POINTS;
        A.points += LOSS_POINTS;
      }
    }

    const arr = Array.from(base.values());
    arr.sort((x, y) => {
      const sdX = x.setsWon - x.setsLost;
      const sdY = y.setsWon - y.setsLost;
      if (y.points !== x.points) return y.points - x.points;
      if (sdY !== sdX) return sdY - sdX;
      if (y.setsWon !== x.setsWon) return y.setsWon - x.setsWon;
      return x.name.localeCompare(y.name, "de");
    });
    return arr;
  }, [session]);

  const canFinish = useMemo(() => {
    if (!session) return false;
    return !session.finished && session.currentRound === session.rounds && allMatchesHaveResults;
  }, [session, allMatchesHaveResults]);

  function finishRanking() {
    if (!session) return;
    if (!canFinish) {
      alert("Zum Abschließen müssen alle Ergebnisse bis Runde 6 eingetragen sein.");
      return;
    }

    const finishedAt = new Date().toISOString();

    // 1) Snapshot speichern (Jahresrangliste)
    const snapshot = {
      id: uid(),
      finishedAt,
      sessionId: session.id,
      rounds: session.rounds,
      standings: standings.map((s) => ({ ...s })),
    };
    setCompleted((prev) => [snapshot, ...prev]);

    // 2) TTR-Update als BATCH nach Spieltag:
    //    Für jede Begegnung rechnen wir mit den TTRs vom START des Spieltags (session.players).
    const startRating = new Map(session.players.map((p) => [p.id, p.ttr]));
    const delta = new Map(session.players.map((p) => [p.id, 0]));

    for (const m of session.matches ?? []) {
      if (m.byeId) continue; // Freilos: kein TTR-Change
      if (m.scoreA === null || m.scoreB === null) continue;

      const rA = startRating.get(m.aId);
      const rB = startRating.get(m.bId);
      if (!Number.isFinite(rA) || !Number.isFinite(rB)) continue;

      const aWon = m.scoreA > m.scoreB;
      const { deltaA, deltaB } = matchDelta(rA, rB, aWon, TTR_K);

      delta.set(m.aId, (delta.get(m.aId) ?? 0) + deltaA);
      delta.set(m.bId, (delta.get(m.bId) ?? 0) + deltaB);
    }

    // Apply deltas auf "players" (deine Stammliste)
    setPlayers((prev) =>
      prev.map((p) => {
        const d = delta.get(p.id) ?? 0;
        return { ...p, ttr: (Number.isFinite(p.ttr) ? p.ttr : DEFAULT_TTR) + d };
      })
    );

    // 3) Session als abgeschlossen markieren (aber nicht löschen)
    setSession((prev) => ({
      ...prev,
      finished: true,
      finishedAt,
    }));
  }

  function resetTodaySession() {
    if (!session) return;
    const ok = window.confirm(
      "Heutige Rangliste wirklich zurücksetzen?\n(Alle Runden & Ergebnisse dieser Session gehen verloren.)"
    );
    if (!ok) return;

    setSession((prev) => ({
      ...prev,
      matches: [],
      currentRound: 0,
      finished: false,
      finishedAt: null,
    }));
  }

  function resetOverallRanking() {
    const ok = window.confirm(
      "GESAMTRANGLISTE wirklich löschen?\n(Alle abgeschlossenen Trainingstage werden gelöscht.)"
    );
    if (!ok) return;
    setCompleted([]);
  }

  const overallStandings = useMemo(() => {
    const agg = new Map();

    for (const day of completed) {
      for (const s of day.standings ?? []) {
        const key = s.id ?? `name:${String(s.name).toLowerCase()}`;
        if (!agg.has(key)) {
          agg.set(key, {
            id: s.id ?? null,
            name: s.name ?? "—",
            points: 0,
            wins: 0,
            losses: 0,
            played: 0,
            setsWon: 0,
            setsLost: 0,
            days: 0,
          });
        }
        const a = agg.get(key);
        a.points += s.points ?? 0;
        a.wins += s.wins ?? 0;
        a.losses += s.losses ?? 0;
        a.played += s.played ?? 0;
        a.setsWon += s.setsWon ?? 0;
        a.setsLost += s.setsLost ?? 0;
        a.days += 1;
      }
    }

    const arr = Array.from(agg.values());
    arr.sort((x, y) => {
      const sdX = x.setsWon - x.setsLost;
      const sdY = y.setsWon - y.setsLost;
      if (y.points !== x.points) return y.points - x.points;
      if (sdY !== sdX) return sdY - sdX;
      if (y.wins !== x.wins) return y.wins - x.wins;
      return x.name.localeCompare(y.name, "de");
    });
    return arr;
  }, [completed]);

  const drawButtonLabel = useMemo(() => {
    if (!session) return "";
    if (session.currentRound === 0) return "Runde 1 auslosen";
    const next = session.currentRound + 1;
    return next <= session.rounds ? `Runde ${next} auslosen` : "Alle Runden gelost";
  }, [session]);

  const drawDisabled = useMemo(() => {
    if (!session) return true;
    if (session.finished) return true;
    return session.currentRound >= session.rounds;
  }, [session]);

  return (
    <div style={{ maxWidth: 900, margin: "40px auto", padding: 16, fontFamily: "system-ui" }}>
      <h1 style={{ marginBottom: 8 }}>Vereinsapp – Jugendrangliste</h1>
      <p style={{ marginTop: 0, color: "#555" }}>
        Spieler anlegen · Anwesenheit setzen · Rangliste starten
      </p>

      {session ? (
        <div style={{ border: "1px solid #ddd", borderRadius: 10, padding: 16, marginTop: 16 }}>
          <h2 style={{ marginTop: 0 }}>{session.finished ? "Rangliste abgeschlossen" : "Rangliste läuft"}</h2>

          <div style={{ color: "#555", fontSize: 13, marginBottom: 10 }}>
            Gestartet: {new Date(session.startedAt).toLocaleString("de-DE")}
            {" · "}Teilnehmer: <b>{session.players.length}</b>
            {" · "}Runden: <b>{session.rounds}</b>
            {" · "}Aktuell: <b>Runde {session.currentRound}</b>
            {session.finishedAt ? (
              <>
                {" · "}Abgeschlossen: <b>{new Date(session.finishedAt).toLocaleString("de-DE")}</b>
              </>
            ) : null}
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            <button onClick={drawNextRound} disabled={drawDisabled} style={{ padding: "10px 14px" }}>
              {drawButtonLabel}
            </button>

            <button
              onClick={finishRanking}
              disabled={!canFinish}
              style={{ padding: "10px 14px" }}
              title={!canFinish ? "Erst alle Ergebnisse bis Runde 6 eintragen" : ""}
            >
              Rangliste abschließen
            </button>

            <button
              onClick={resetTodaySession}
              disabled={session.finished}
              style={{ padding: "10px 14px" }}
            >
              Heutige Rangliste zurücksetzen
            </button>

            <button onClick={endSession} style={{ padding: "10px 14px" }}>
              Zurück zur Startseite
            </button>
          </div>

          {session.currentRound > 0 && (
            <div style={{ marginTop: 14 }}>
              <h3 style={{ marginBottom: 8 }}>Paarungen & Ergebnisse – Runde {session.currentRound}</h3>

              <div style={{ border: "1px solid #eee", borderRadius: 10, overflow: "hidden" }}>
                {currentRoundMatches.map((m, idx) => {
                  if (m.byeId) {
                    return (
                      <div
                        key={m.id}
                        style={{
                          padding: 12,
                          borderTop: idx === 0 ? "none" : "1px solid #f0f0f0",
                          display: "flex",
                          justifyContent: "space-between",
                        }}
                      >
                        <div style={{ fontWeight: 600, color: "#111" }}>
                          {nameById.get(m.byeId) ?? "?"}
                        </div>
                        <div style={{ color: "#666", fontSize: 12 }}>PAUSE (+2 Punkte)</div>
                      </div>
                    );
                  }

                  const aName = nameById.get(m.aId) ?? "?";
                  const bName = nameById.get(m.bId) ?? "?";
                  const currentValue =
                    m.scoreA === null || m.scoreB === null ? "" : `${m.scoreA}-${m.scoreB}`;

                  return (
                    <div
                      key={m.id}
                      style={{
                        padding: 12,
                        borderTop: idx === 0 ? "none" : "1px solid #f0f0f0",
                        display: "flex",
                        justifyContent: "space-between",
                        gap: 12,
                        alignItems: "center",
                      }}
                    >
                      <div style={{ fontWeight: 600, color: "#111" }}>
                        {aName} <span style={{ color: "#666", fontWeight: 400 }}>vs</span> {bName}
                      </div>

                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ color: "#666", fontSize: 12 }}>Ergebnis:</span>
                        <select
                          value={currentValue}
                          onChange={(e) => setMatchResult(m.id, e.target.value)}
                          disabled={session.finished}
                          style={{ padding: "8px 10px" }}
                        >
                          {RESULT_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div style={{ marginTop: 18 }}>
                <h3 style={{ marginBottom: 8 }}>Tabelle (heute)</h3>

                <div style={{ border: "1px solid #eee", borderRadius: 10, overflow: "hidden" }}>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "40px 1fr 80px 80px 80px 140px",
                      padding: 10,
                      background: "#f7f7f7",
                      fontWeight: 600,
                      fontSize: 13,
                      color: "#111",
                      gap: 8,
                    }}
                  >
                    <div>#</div>
                    <div>Name</div>
                    <div>Pkt</div>
                    <div>Sp</div>
                    <div>S/N</div>
                    <div>Sätze</div>
                  </div>

                  {standings.map((s, i) => (
                    <div
                      key={s.id}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "40px 1fr 80px 80px 80px 140px",
                        padding: 10,
                        borderTop: "1px solid #f0f0f0",
                        gap: 8,
                        alignItems: "center",
                      }}
                    >
                      <div>{i + 1}</div>
                      <div style={{ fontWeight: 600, color: "#111" }}>{s.name}</div>
                      <div>{s.points}</div>
                      <div>{s.played}</div>
                      <div>
                        {s.wins}/{s.losses}
                      </div>
                      <div>
                        {s.setsWon}:{s.setsLost} ({s.setsWon - s.setsLost >= 0 ? "+" : ""}
                        {s.setsWon - s.setsLost})
                      </div>
                    </div>
                  ))}
                </div>

                <div style={{ marginTop: 10, color: "#555", fontSize: 12 }}>
                  Ergebnisse: 3–0, 2–1, 1–2, 0–3. Freilos: +2 Punkte, keine Satzwertung.
                </div>
              </div>
            </div>
          )}

          <div style={{ marginTop: 12, color: "#555", fontSize: 13 }}>
            Hinweis: TTR wird erst beim Abschließen des Spieltags aktualisiert.
          </div>
        </div>
      ) : (
        <>
          <div style={{ border: "1px solid #ddd", borderRadius: 10, padding: 16, marginTop: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <div>
                <h2 style={{ marginTop: 0, marginBottom: 6 }}>Gesamtrangliste</h2>
                <div style={{ color: "#555", fontSize: 13 }}>
                  Abgeschlossene Trainingstage: <b>{completed.length}</b>
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <button onClick={resetOverallRanking} style={{ padding: "10px 14px" }}>
                  Gesamtrangliste löschen
                </button>
              </div>
            </div>

            {overallStandings.length === 0 ? (
              <div style={{ color: "#777", marginTop: 10 }}>Noch keine abgeschlossenen Ranglisten.</div>
            ) : (
              <div style={{ border: "1px solid #eee", borderRadius: 10, overflow: "hidden", marginTop: 12 }}>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "40px 1fr 80px 80px 80px 140px",
                    padding: 10,
                    background: "#f7f7f7",
                    fontWeight: 600,
                    fontSize: 13,
                    color: "#111",
                    gap: 8,
                  }}
                >
                  <div>#</div>
                  <div>Name</div>
                  <div>Pkt</div>
                  <div>Sp</div>
                  <div>S/N</div>
                  <div>Sätze</div>
                </div>

                {overallStandings.map((s, i) => (
                  <div
                    key={s.id ?? `${s.name}-${i}`}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "40px 1fr 80px 80px 80px 140px",
                      padding: 10,
                      borderTop: "1px solid #f0f0f0",
                      gap: 8,
                      alignItems: "center",
                    }}
                  >
                    <div>{i + 1}</div>
                    <div style={{ fontWeight: 600, color: "#111" }}>{s.name}</div>
                    <div>{s.points}</div>
                    <div>{s.played}</div>
                    <div>
                      {s.wins}/{s.losses}
                    </div>
                    <div>
                      {s.setsWon}:{s.setsLost} ({s.setsWon - s.setsLost >= 0 ? "+" : ""}
                      {s.setsWon - s.setsLost})
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button onClick={startRanking} style={{ padding: "10px 14px" }}>
              Rangliste starten
            </button>
          </div>

          <form onSubmit={addPlayer} style={{ display: "flex", gap: 8, margin: "16px 0" }}>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name (z.B. Levin)"
              style={{ flex: 2, padding: 10 }}
            />
            <button style={{ padding: "10px 14px" }}>Hinzufügen</button>
          </form>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h2 style={{ margin: "12px 0" }}>Spielerliste</h2>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ color: "#555" }}>
                Aktiv (anwesend): <b>{activeCount}</b> / {players.length}
              </span>
              <button onClick={() => setAllActive(true)} style={{ padding: "8px 10px" }}>
                Alle an
              </button>
              <button onClick={() => setAllActive(false)} style={{ padding: "8px 10px" }}>
                Alle aus
              </button>
            </div>
          </div>

          <div style={{ border: "1px solid #ddd", borderRadius: 10, overflow: "hidden" }}>
            {sortedPlayers.length === 0 ? (
              <div style={{ padding: 16, color: "#777" }}>Noch keine Spieler angelegt.</div>
            ) : (
              sortedPlayers.map((p, idx) => (
                <div
                  key={p.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: 12,
                    borderTop: idx === 0 ? "none" : "1px solid #eee",
                    background: p.active ? "#f6fffb" : "white",
                  }}
                >
                  <input type="checkbox" checked={p.active} onChange={() => toggleActive(p.id)} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, color: "#111" }}>{p.name}</div>
                    <div style={{ fontSize: 12, color: "#666" }}>TTR: {p.ttr}</div>
                  </div>
                  <button onClick={() => removePlayer(p.id)} style={{ padding: "8px 10px" }}>
                    Löschen
                  </button>
                </div>
              ))
            )}
          </div>

          <div style={{ marginTop: 18, color: "#555", fontSize: 13 }}>
            Hinweis: Neue Spieler starten bei TTR {DEFAULT_TTR}. TTR wird nach jedem abgeschlossenen Spieltag aktualisiert.
          </div>
        </>
      )}
    </div>
  );
}
