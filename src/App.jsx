import { useState, useEffect, useCallback } from 'react';
import Papa from 'papaparse';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ErrorBar, ReferenceLine, LineChart, Line, ResponsiveContainer, Cell,
} from 'recharts';

// ─── Data source ──────────────────────────────────────────────────────────────
const SHEET_CSV_URL =
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vQ-MEid0dPSaoM3X67c_DjyFdQ0lBiQQ7lCUJBxjtwnI5oz8cpo7t7rpigDep9EVyRcVrkq3UXuJzTo/pub?output=csv&gid=192547044';

// ─── Algorithm configuration ──────────────────────────────────────────────────
// Edit values here to retune the model without touching any logic below.
const ALGORITHM_CONFIG = {
  speedFig: {
    // Multiplier applied to a horse's raw speed fig based on its rank in the field.
    // Raise rank1 to reward the speed-fig leader more aggressively.
    rank1: 1.80,   // Best speed fig in the race
    rank2: 1.40,   // Second-best
    rank3: 1.10,   // Third-best
    other: 0.85,   // All others — slight penalty for below-average figures
  },

  trainerFlags: {
    // Column "Trainer Flag" values that trigger a score bonus.
    // Set to 1.00 to ignore a flag; raise above 1.0 to amplify it.
    'HOT TRAINER':   1.20,  // Trainer currently on a winning streak
    'BEST IN CLASS': 1.15,  // Trainer's record dominates at this class level
    none:            1.00,  // No flag — no adjustment
  },

  // How much the morning-line implied probability blends into the model score.
  // 0 = pure handicapping model; 1 = pure market. 0.15 means 85% model / 15% market.
  oddsWeight: 0.15,

  daysRest: {
    // Tiers for days-since-last-race. mult scales the composite score.
    // Horses outside 14–90 days face increasing penalties.
    optimal:    { min: 14,  max: 28,  mult: 1.10 }, // Peak freshness window
    good:       { min: 29,  max: 45,  mult: 1.05 }, // Acceptable
    neutral:    { min: 46,  max: 90,  mult: 1.00 }, // No adjustment
    stale:      { min: 91,  max: 150, mult: 0.90 }, // Losing fitness edge
    longLayoff: { min: 151, max: 998, mult: 0.80 }, // Ring-rusty
    firstStart: { min: 999, max: 999, mult: 0.75 }, // Debut — maximum uncertainty
  },

  wetTrack: {
    // Off-track adjustments: speed figures lose predictive value on wet surfaces.
    figScale: 0.65,               // Scales the fig contribution on wet tracks (0–1)
    removeLongLayoffPenalty: true, // Wet tracks can suit freshened horses; if true,
                                  // the longLayoff penalty is waived on wet days
  },

  simCount: 25000, // Simulation iterations — raise for tighter CIs, lower for speed
  noise:    0.08,  // Gaussian noise std dev per simulation run (Box-Muller).
                   // Raise to widen confidence intervals / model more race chaos.
};

// ─── Math helpers ─────────────────────────────────────────────────────────────

/** Box-Muller: returns one standard-normal random variate */
function gaussianRandom() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

/** Fractional/American odds string → implied win probability */
function oddsToImplied(oddsStr) {
  if (!oddsStr) return 0.10;
  const s = String(oddsStr).trim().replace(/-/g, '/');
  if (s.includes('/')) {
    const [n, d] = s.split('/').map(Number);
    if (!isNaN(n) && !isNaN(d) && d > 0) return d / (n + d);
  }
  const n = parseFloat(s);
  if (!isNaN(n) && n > 0) return 1 / (n + 1);
  return 0.10;
}

/** Wilson 95% binomial confidence interval for a proportion */
function wilsonCI(wins, n) {
  if (n === 0) return { lo: 0, hi: 0 };
  const p = wins / n;
  const z = 1.96;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n)) / denom;
  return { lo: Math.max(0, centre - margin), hi: Math.min(1, centre + margin) };
}

/** Poisson PMF — P(exactly k events given rate lambda) */
function poissonPMF(lambda, k) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let logP = k * Math.log(lambda) - lambda;
  for (let i = 1; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

/** Softmax over an array of values */
function softmax(arr) {
  const max = Math.max(...arr);
  const exps = arr.map(x => Math.exp(x - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map(e => e / sum);
}

/** Days-rest multiplier from config */
function daysRestMult(days, isWet) {
  const c = ALGORITHM_CONFIG.daysRest;
  if (days >= 999) return c.firstStart.mult;
  if (isWet && ALGORITHM_CONFIG.wetTrack.removeLongLayoffPenalty && days > 150) return c.neutral.mult;
  if (days > c.longLayoff.min) return c.longLayoff.mult;
  if (days > c.stale.min)      return c.stale.mult;
  if (days > c.neutral.min)    return c.neutral.mult;
  if (days > c.good.min)       return c.good.mult;
  if (days >= c.optimal.min)   return c.optimal.mult;
  return c.neutral.mult;
}

// ─── Core simulation ──────────────────────────────────────────────────────────

function runSimulation(horses, isWet) {
  const cfg = ALGORITHM_CONFIG;
  const n = horses.length;

  const figs   = horses.map(h => Number(h.speedFig) || 0);
  const sorted = [...figs].sort((a, b) => b - a);
  const figScale = isWet ? cfg.wetTrack.figScale : 1.0;

  const rawScores = horses.map((h, i) => {
    const fig  = figs[i];
    const rank = sorted.findIndex(f => f === fig) + 1;
    const rankMult =
      rank === 1 ? cfg.speedFig.rank1 :
      rank === 2 ? cfg.speedFig.rank2 :
      rank === 3 ? cfg.speedFig.rank3 : cfg.speedFig.other;

    const flag        = (h.trainerFlag || '').trim().toUpperCase();
    const trainerMult = cfg.trainerFlags[flag] ?? cfg.trainerFlags.none;
    const days        = Number(h.daysRest) || 999;
    const restMult    = daysRestMult(days, isWet);

    return Math.max(fig * rankMult * figScale * trainerMult * restMult, 0.01);
  });

  const modelProbs   = softmax(rawScores.map(s => Math.log(s)));
  const impliedProbs = horses.map(h => oddsToImplied(h.morningLine));
  const blended      = modelProbs.map((mp, i) =>
    (1 - cfg.oddsWeight) * mp + cfg.oddsWeight * impliedProbs[i]
  );
  const blendSum  = blended.reduce((a, b) => a + b, 0);
  const baseProbs = blended.map(p => p / blendSum);

  const wins   = new Array(n).fill(0);
  const places = new Array(n).fill(0);
  const shows  = new Array(n).fill(0);

  for (let s = 0; s < cfg.simCount; s++) {
    const noisy = baseProbs.map(p =>
      Math.exp(Math.log(p + 1e-12) + gaussianRandom() * cfg.noise)
    );
    const ns    = noisy.reduce((a, b) => a + b, 0);
    const probs = noisy.map(p => p / ns);

    const pool  = probs.slice();
    const idx   = Array.from({ length: n }, (_, i) => i);
    const order = [];

    for (let place = 0; place < Math.min(3, n); place++) {
      const total = pool.reduce((a, b) => a + b, 0);
      let r = Math.random() * total, cum = 0, chosen = 0;
      for (let j = 0; j < pool.length; j++) {
        cum += pool[j];
        if (r <= cum) { chosen = j; break; }
      }
      order.push(idx[chosen]);
      idx.splice(chosen, 1);
      pool.splice(chosen, 1);
    }

    wins[order[0]]++;
    if (order.length > 1) { places[order[0]]++; places[order[1]]++; }
    if (order.length > 2) { shows[order[0]]++; shows[order[1]]++; shows[order[2]]++; }
  }

  return horses.map((h, i) => {
    const simWin   = wins[i]   / cfg.simCount;
    const simPlace = places[i] / cfg.simCount;
    const simShow  = shows[i]  / cfg.simCount;
    const implied  = impliedProbs[i];
    const edge     = simWin - implied;
    const ci       = wilsonCI(wins[i], cfg.simCount);
    return { ...h, simWin, simPlace, simShow, implied, edge, ciLo: ci.lo, ciHi: ci.hi };
  });
}

// ─── Bet Lock ─────────────────────────────────────────────────────────────────

/**
 * Scan all simulated races and return the best Lock candidate, or null.
 * Gates (all must pass): edge > 3%, figRank <= 2, winPct > 15%, daysRest 14–150.
 * LockScore = (edge% × 1.5) + (winPct%) − (ciRange% × 0.5)
 */
function computeLock(simByRace) {
  let best = null;
  for (const [race, results] of Object.entries(simByRace)) {
    for (const r of results) {
      const edgePct  = r.edge * 100;
      const winPct   = r.simWin * 100;
      const figRank  = parseInt(r.figRank, 10);
      const days     = Number(r.daysRest) || 999;

      if (edgePct <= 3)                  continue;
      if (isNaN(figRank) || figRank > 2) continue;
      if (winPct <= 15)                  continue;
      if (days < 14 || days > 150)       continue;

      const ciRangePct = (r.ciHi - r.ciLo) * 100;
      const lockScore  = (edgePct * 1.5) + winPct - (ciRangePct * 0.5);

      if (!best || lockScore > best.lockScore) {
        best = { ...r, race, lockScore };
      }
    }
  }
  return best;
}

// ─── SUPER LOCK (future multi-track feature) ──────────────────────────────────
// computeSuperLock(locksByTrack) compares each track's Lock object
// and returns the one with the highest LockScore across all tracks.
// When 2+ tracks are loaded and simulated, display as 🎆🎆 SUPER LOCK
// banner above all other content. Currently unused — single track only.
// locksByTrack format: [{ track: "fairmount", lock: lockObject }, ...]
// function computeSuperLock(locksByTrack) {
//   if (!locksByTrack || locksByTrack.length < 2) return null;
//   return locksByTrack.reduce((best, t) =>
//     t.lock && (!best.lock || t.lock.lockScore > best.lock.lockScore) ? t : best
//   ).lock || null;
// }
// ─────────────────────────────────────────────────────────────────────────────

// ─── Theme ────────────────────────────────────────────────────────────────────
const C = {
  gold:    '#c9a84c',
  bg:      '#080c08',
  text:    '#e8dfc0',
  pos:     '#7dc070',
  neg:     '#e07070',
  surface: '#111a11',
  border:  '#1f2e1f',
  muted:   '#8a9e8a',
  input:   '#152015',
  accent:  '#7ab3e0',
};

const S = {
  app:    { background: C.bg, minHeight: '100vh', color: C.text, fontFamily: "'Georgia', serif" },
  header: { background: C.surface, borderBottom: `2px solid ${C.gold}`, padding: '14px 24px', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' },
  title:  { color: C.gold, fontSize: 26, fontWeight: 700, margin: 0, letterSpacing: 1 },
  sub:    { color: C.muted, fontSize: 12, marginTop: 2 },
  tabBar: { display: 'flex', background: C.surface, borderBottom: `1px solid ${C.border}` },
  card:   { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: 16, marginBottom: 14 },
  select: { background: C.input, color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, padding: '8px 12px', fontSize: 14, width: '100%', cursor: 'pointer' },
  input:  { background: C.input, color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, padding: '6px 10px', fontSize: 14, width: '100%', boxSizing: 'border-box' },
  table:  { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th:     { color: C.gold, padding: '8px 12px', textAlign: 'left', background: C.surface, borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' },
  td:     { padding: '7px 12px', borderBottom: `1px solid ${C.border}` },
  pill:   active => ({
    background: active ? C.gold : 'transparent', color: active ? C.bg : C.text,
    border: `1px solid ${C.gold}`, borderRadius: 20, padding: '4px 14px',
    cursor: 'pointer', fontSize: 12, fontWeight: active ? 700 : 400,
  }),
  tab: active => ({
    padding: '12px 22px', cursor: 'pointer', background: 'none', border: 'none',
    borderBottom: active ? `3px solid ${C.gold}` : '3px solid transparent',
    color: active ? C.gold : C.muted, fontSize: 15, fontWeight: active ? 700 : 400,
  }),
  btn: variant => ({
    background: variant === 'gold' ? C.gold : variant === 'neg' ? C.neg : C.surface,
    color: variant === 'gold' ? C.bg : C.text,
    border: `1px solid ${variant === 'gold' ? C.gold : variant === 'neg' ? C.neg : C.border}`,
    borderRadius: 6, padding: '8px 18px', cursor: 'pointer', fontWeight: 700, fontSize: 13,
    whiteSpace: 'nowrap',
  }),
};

// ─── Small components ─────────────────────────────────────────────────────────

function Stat({ label, value, color }) {
  return (
    <div>
      <div style={{ color: C.muted, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 }}>{label}</div>
      <div style={{ color: color || C.text, fontWeight: 600, fontSize: 13 }}>{value ?? '—'}</div>
    </div>
  );
}

function HorseCard({ horse, result, isLock }) {
  const edgeColor = result
    ? result.edge > 0.03 ? C.pos : result.edge < -0.03 ? C.neg : C.text
    : C.text;
  return (
    <div style={{ ...S.card, borderLeft: `3px solid ${isLock ? C.gold : C.border}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ color: C.gold, fontWeight: 700, fontSize: 15 }}>#{horse.postPos}</span>
          <span style={{ fontWeight: 700, fontSize: 16 }}>{horse.horseName}</span>
          {isLock && <span title="Lock of the Day" style={{ fontSize: 18 }}>🎆</span>}
        </div>
        <div style={{ color: C.muted, fontSize: 12 }}>ML: <span style={{ color: C.text }}>{horse.morningLine || '—'}</span></div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 10 }}>
        <Stat label="Jockey"       value={horse.jockey} />
        <Stat label="Trainer"      value={horse.trainer} />
        <Stat label="Speed Fig"    value={horse.speedFig || '—'} />
        <Stat label="Fig Rank"     value={horse.figRank || '—'} />
        <Stat label="Days Rest"    value={Number(horse.daysRest) >= 999 ? 'Debut' : horse.daysRest} />
        <Stat label="Trainer Flag" value={horse.trainerFlag || 'none'} />
        {result && <>
          <Stat label="Win %"   value={`${(result.simWin * 100).toFixed(1)}%`}   color={result.simWin > result.implied ? C.pos : C.text} />
          <Stat label="Implied" value={`${(result.implied * 100).toFixed(1)}%`} />
          <Stat label="Edge"    value={`${result.edge >= 0 ? '+' : ''}${(result.edge * 100).toFixed(1)}%`} color={edgeColor} />
        </>}
      </div>
    </div>
  );
}

function Countdown({ targetTime }) {
  const [txt, setTxt] = useState('');
  useEffect(() => {
    if (!targetTime) return;
    const tick = () => {
      const diff = targetTime - new Date();
      if (diff <= 0) { setTxt('POST TIME'); return; }
      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      setTxt(h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [targetTime]);
  if (!txt) return null;
  return (
    <div style={{ textAlign: 'center', margin: '10px 0 16px', fontSize: 13 }}>
      <span style={{ color: C.muted }}>Time to post: </span>
      <span style={{ color: C.gold, fontWeight: 700, fontSize: 17 }}>{txt}</span>
    </div>
  );
}

// ─── Charts ───────────────────────────────────────────────────────────────────

function WinBarChart({ results }) {
  const data = results.map(r => ({
    name: r.horseName.split(' ').slice(-1)[0],
    win:  parseFloat((r.simWin * 100).toFixed(1)),
    err:  [
      parseFloat(((r.simWin - r.ciLo) * 100).toFixed(2)),
      parseFloat(((r.ciHi  - r.simWin) * 100).toFixed(2)),
    ],
  }));
  return (
    <div style={S.card}>
      <div style={{ color: C.gold, fontWeight: 700, marginBottom: 10 }}>Win % with 95% Wilson CI</div>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={data} margin={{ top: 10, right: 20, left: 0, bottom: 44 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
          <XAxis dataKey="name" tick={{ fill: C.muted, fontSize: 11 }} angle={-35} textAnchor="end" interval={0} />
          <YAxis tick={{ fill: C.muted, fontSize: 11 }} unit="%" />
          <Tooltip
            contentStyle={{ background: C.surface, border: `1px solid ${C.border}`, color: C.text, fontSize: 12 }}
            formatter={v => [`${v}%`, 'Win %']}
          />
          <Bar dataKey="win" fill={C.gold} radius={[3, 3, 0, 0]}>
            <ErrorBar dataKey="err" width={4} strokeWidth={2} stroke={C.text} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function EdgeBarChart({ results }) {
  const data = [...results]
    .sort((a, b) => b.edge - a.edge)
    .map(r => ({
      name: r.horseName.split(' ').slice(-1)[0],
      edge: parseFloat((r.edge * 100).toFixed(1)),
    }));
  return (
    <div style={S.card}>
      <div style={{ color: C.gold, fontWeight: 700, marginBottom: 10 }}>EV / Edge — Sim Win% minus Implied%</div>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart layout="vertical" data={data} margin={{ top: 5, right: 30, left: 70, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
          <XAxis type="number" tick={{ fill: C.muted, fontSize: 11 }} unit="%" />
          <YAxis type="category" dataKey="name" tick={{ fill: C.muted, fontSize: 11 }} width={65} />
          <Tooltip
            contentStyle={{ background: C.surface, border: `1px solid ${C.border}`, color: C.text, fontSize: 12 }}
            formatter={v => [`${v}%`, 'Edge']}
          />
          <ReferenceLine x={0} stroke={C.text} strokeWidth={2} />
          <Bar dataKey="edge" radius={[0, 3, 3, 0]}>
            {data.map((d, i) => <Cell key={i} fill={d.edge >= 0 ? C.pos : C.neg} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function PoissonChart({ results }) {
  const top3   = [...results].sort((a, b) => b.simWin - a.simWin).slice(0, 3);
  const colors = [C.gold, C.pos, C.accent];
  const data   = Array.from({ length: 6 }, (_, k) => {
    const pt = { k: `k=${k}` };
    top3.forEach(r => {
      const lambda = r.simWin * 10;
      pt[r.horseName.split(' ').slice(-1)[0]] = parseFloat((poissonPMF(lambda, k) * 100).toFixed(2));
    });
    return pt;
  });
  return (
    <div style={S.card}>
      <div style={{ color: C.gold, fontWeight: 700, marginBottom: 2 }}>Poisson — Top 3 Horses</div>
      <div style={{ color: C.muted, fontSize: 11, marginBottom: 10 }}>P(k wins in 10 races) where λ = simWin% × 10</div>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={data} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
          <XAxis dataKey="k" tick={{ fill: C.muted, fontSize: 11 }} />
          <YAxis tick={{ fill: C.muted, fontSize: 11 }} unit="%" />
          <Tooltip
            contentStyle={{ background: C.surface, border: `1px solid ${C.border}`, color: C.text, fontSize: 12 }}
            formatter={v => [`${v}%`]}
          />
          <Legend wrapperStyle={{ color: C.muted, fontSize: 12 }} />
          {top3.map((r, i) => {
            const label = r.horseName.split(' ').slice(-1)[0];
            return (
              <Line
                key={i} type="monotone" dataKey={label}
                stroke={colors[i]} strokeWidth={2} dot={{ fill: colors[i], r: 4 }}
              />
            );
          })}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─── Feature 4: High Variance Banner ──────────────────────────────────────────

function VarianceBanner({ results }) {
  if (!results || results.length < 2) return null;
  const byWin  = [...results].sort((a, b) => b.simWin - a.simWin);
  const rank1  = byWin[0].simWin * 100;
  const comp   = byWin.length >= 4 ? byWin[3] : byWin[byWin.length - 1];
  const spread = rank1 - comp.simWin * 100;

  if (spread >= 12) return null;

  const base = { borderRadius: 6, padding: '10px 14px', marginTop: 12, fontSize: 13, fontWeight: 600 };

  if (spread >= 7) return (
    <div style={{ ...base, background: '#2a2200', border: '1px solid #c9a84c', color: C.text }}>
      ⚠️ COMPETITIVE FIELD — No dominant figure. Reduce stake, focus on value plays.
    </div>
  );
  if (spread >= 4) return (
    <div style={{ ...base, background: '#2a1500', border: '1px solid #e07a30', color: C.text }}>
      🚨 HIGH VARIANCE — Top contenders within {spread.toFixed(1)}% of each other. Exotics are speculative. Consider skipping.
    </div>
  );
  return (
    <div style={{ ...base, background: '#2a0a0a', border: `1px solid ${C.neg}`, color: C.text }}>
      🚫 COIN FLIP RACE — No meaningful edge exists. Field is nearly even. Model confidence: VERY LOW. Recommended: PASS.
    </div>
  );
}

// ─── Feature 2: Summary Card ──────────────────────────────────────────────────

function SummaryCard({ simByRace, defaultRace, races, lock }) {
  const [summaryRace, setSummaryRace] = useState(defaultRace || '');

  useEffect(() => {
    if (defaultRace) setSummaryRace(defaultRace);
  }, [defaultRace]);

  const simKeys = Object.keys(simByRace);
  if (simKeys.length === 0) return null;

  const effectiveRace = simByRace[summaryRace] ? summaryRace : simKeys[0];
  const results       = simByRace[effectiveRace] || [];
  if (!results.length) return null;

  const raceInfo = races.find(r => r.race === effectiveRace);
  const byWin    = [...results].sort((a, b) => b.simWin - a.simWin);
  const modelWin = byWin[0];

  // Value pick: highest +edge horse that isn't the model win
  const byEdge   = [...results].sort((a, b) => b.edge - a.edge);
  const posEdge  = byEdge.filter(r => r.edge > 0.03);
  let valuePick  = null;
  let noValue    = false;
  if (posEdge.length === 0) {
    valuePick = byEdge[0];
    noValue   = true;
  } else if (posEdge[0].horseName === modelWin.horseName) {
    const others = posEdge.filter(r => r.horseName !== modelWin.horseName);
    if (others.length > 0) {
      valuePick = others[0];
    } else {
      valuePick = byEdge.find(r => r.horseName !== modelWin.horseName) || byEdge[0];
      noValue   = true;
    }
  } else {
    valuePick = posEdge[0];
  }

  // Auto-flag categories
  const hotTrainers = results.filter(r => (r.trainerFlag || '').trim().toUpperCase() === 'HOT TRAINER');
  const layoffs     = results.filter(r => { const d = Number(r.daysRest); return d > 150 && d < 999; });
  const overlays    = results.filter(r => r.edge > 0.03);
  const fades       = [...results].sort((a, b) => a.edge - b.edge).slice(0, 2);

  const isLockRow   = name => lock?.race === effectiveRace && lock?.horseName === name;

  const divider  = { borderTop: `1px solid ${C.border}`, margin: '10px 0' };
  const row      = { fontSize: 13, padding: '4px 0', display: 'flex', alignItems: 'baseline', gap: 5, flexWrap: 'wrap' };
  const fmt      = r => `${r.morningLine || '?'} · ${(r.simWin * 100).toFixed(1)}% · ${r.edge >= 0 ? '+' : ''}${(r.edge * 100).toFixed(1)}%`;

  return (
    <div style={{ ...S.card, marginTop: 4 }}>
      {/* Header row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
        <div style={{ color: C.gold, fontWeight: 700, fontSize: 14, letterSpacing: 0.5 }}>
          RACE {effectiveRace} SUMMARY{raceInfo?.postTime ? ` — ${raceInfo.postTime}` : ''}
        </div>
        {simKeys.length > 1 && (
          <select
            style={{ ...S.select, width: 'auto', fontSize: 12, padding: '4px 8px' }}
            value={effectiveRace}
            onChange={e => setSummaryRace(e.target.value)}
          >
            {simKeys.map(k => <option key={k} value={k}>Race {k}</option>)}
          </select>
        )}
      </div>

      <div style={divider} />

      {/* Picks */}
      <div style={row}>
        <span>🥇</span>
        <span style={{ color: C.muted, width: 110, flexShrink: 0 }}>MODEL WIN:</span>
        <strong>{modelWin.horseName}</strong>
        {isLockRow(modelWin.horseName) && <span>🎆</span>}
        <span style={{ color: C.muted }}>{fmt(modelWin)}</span>
      </div>

      <div style={row}>
        <span>💰</span>
        <span style={{ color: C.muted, width: 110, flexShrink: 0 }}>VALUE PICK:</span>
        <strong>{valuePick?.horseName}</strong>
        {isLockRow(valuePick?.horseName) && <span>🎆</span>}
        <span style={{ color: noValue ? C.neg : C.muted }}>
          {fmt(valuePick)}{noValue ? ' ⚠ No value found' : ''}
        </span>
      </div>

      <div style={row}>
        <span>🎰</span>
        <span style={{ color: C.muted, width: 110, flexShrink: 0 }}>EXACTA:</span>
        <strong>{byWin[0]?.horseName} → {byWin[1]?.horseName || '—'}</strong>
      </div>

      <div style={row}>
        <span>🏆</span>
        <span style={{ color: C.muted, width: 110, flexShrink: 0 }}>TRIFECTA:</span>
        <strong>{byWin[0]?.horseName} / {byWin[1]?.horseName || '—'} / {byWin[2]?.horseName || '—'}</strong>
      </div>

      <div style={divider} />

      {/* Auto flags */}
      <div style={{ color: C.gold, fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>Auto Flags</div>

      {hotTrainers.map(r => (
        <div key={'ht' + r.horseName} style={row}>
          <span>✅</span>
          <span style={{ color: C.pos, fontWeight: 600 }}>HOT TRAINER:</span>
          <strong>{r.horseName}</strong>
          <span style={{ color: C.muted }}>— trainer flag active, +20% boost applied</span>
        </div>
      ))}

      {layoffs.map(r => (
        <div key={'lo' + r.horseName} style={row}>
          <span>⚠️</span>
          <span style={{ color: '#e0a030', fontWeight: 600 }}>LAYOFF:</span>
          <strong>{r.horseName}</strong>
          <span style={{ color: C.muted }}>
            — {r.daysRest} days, {((1 - ALGORITHM_CONFIG.daysRest.longLayoff.mult) * 100).toFixed(0)}% penalty applied
          </span>
        </div>
      ))}

      {overlays.map(r => (
        <div key={'ov' + r.horseName} style={row}>
          <span>💰</span>
          <span style={{ color: C.pos, fontWeight: 600 }}>OVERLAY:</span>
          <strong>{r.horseName}</strong>
          <span style={{ color: C.muted }}>
            at {r.morningLine} — model edge +{(r.edge * 100).toFixed(1)}%
          </span>
        </div>
      ))}

      {fades.map(r => (
        <div key={'fd' + r.horseName} style={row}>
          <span>🚫</span>
          <span style={{ color: C.neg, fontWeight: 600 }}>FADE:</span>
          <strong>{r.horseName}</strong>
          <span style={{ color: C.muted }}>
            — market {(r.implied * 100).toFixed(1)}%, model {(r.simWin * 100).toFixed(1)}% (edge {(r.edge * 100).toFixed(1)}%)
          </span>
        </div>
      ))}

      {hotTrainers.length === 0 && layoffs.length === 0 && overlays.length === 0 && (
        <div style={{ color: C.muted, fontSize: 12 }}>No flags triggered for this race.</div>
      )}

      {/* Feature 4: variance banner */}
      <VarianceBanner results={results} />
    </div>
  );
}

// ─── Bet Builder ──────────────────────────────────────────────────────────────

function BetCard({ label, horses }) {
  return (
    <div style={{ ...S.card, borderTop: `2px solid ${C.gold}`, marginBottom: 0 }}>
      <div style={{ color: C.gold, fontWeight: 700, fontSize: 12, marginBottom: 8, letterSpacing: 1 }}>{label}</div>
      {horses.map((h, i) => (
        <div key={i} style={{ fontSize: 13, marginBottom: 2 }}>
          <span style={{ color: C.muted }}>#{i + 1} </span>
          <span style={{ fontWeight: 700 }}>{h.horseName}</span>
          {h.edge !== undefined &&
            <span style={{ color: C.pos, marginLeft: 8, fontSize: 12 }}>+{(h.edge * 100).toFixed(1)}%</span>}
        </div>
      ))}
    </div>
  );
}

function BetBuilder({ results, lock }) {
  const [bets, setBets] = useState([]);
  const [form, setForm] = useState({ type: 'WIN', horse: '', stake: '', odds: '' });

  const sorted = results ? [...results].sort((a, b) => b.edge - a.edge)     : [];
  const posEV  = sorted.filter(r => r.edge > 0.03);
  const byWin  = results ? [...results].sort((a, b) => b.simWin - a.simWin) : [];

  const pnl = bets.reduce((sum, b) => {
    if (b.result === 'W') {
      const dec = 1 / (oddsToImplied(b.odds) || 0.5);
      return sum + b.stake * (dec - 1);
    }
    if (b.result === 'L') return sum - b.stake;
    return sum;
  }, 0);

  const addBet    = () => {
    if (!form.horse || !form.stake) return;
    setBets(p => [...p, { ...form, stake: parseFloat(form.stake) || 0, id: Date.now(), result: null }]);
    setForm(f => ({ ...f, horse: '', stake: '', odds: '' }));
  };
  const settle    = (id, res) => setBets(p => p.map(b => b.id === id ? { ...b, result: res } : b));
  const removeBet = id => setBets(p => p.filter(b => b.id !== id));

  if (!results) {
    return (
      <div style={{ textAlign: 'center', color: C.muted, padding: 60 }}>
        Run a simulation on the 🏇 Fairmount Park tab first.
      </div>
    );
  }

  return (
    <div style={{ padding: 20, maxWidth: 900, margin: '0 auto' }}>

      {/* Feature 3: Lock banner */}
      {lock && (
        <div style={{
          background: '#0d1f0d', border: `2px solid ${C.gold}`, borderRadius: 10,
          padding: '14px 20px', marginBottom: 24,
        }}>
          <div style={{ color: C.gold, fontWeight: 700, fontSize: 18, marginBottom: 6 }}>🎆 LOCK OF THE DAY</div>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>
            {lock.horseName} · Race {lock.race} · {lock.morningLine || '?'} · {(lock.simWin * 100).toFixed(1)}% WIN · +{(lock.edge * 100).toFixed(1)}% EDGE
          </div>
          <div style={{ color: C.muted, fontSize: 13 }}>
            Speed Fig Rank #{lock.figRank} · {lock.daysRest} days rest
            {lock.trainerFlag && lock.trainerFlag.toLowerCase() !== 'none' ? ` · ${lock.trainerFlag}` : ''}
          </div>
        </div>
      )}

      <div style={{ color: C.gold, fontWeight: 700, fontSize: 16, marginBottom: 12 }}>Recommended Bets</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12, marginBottom: 24 }}>
        {byWin[0]          && <BetCard label="WIN"       horses={[byWin[0]]} />}
        {byWin[0]          && <BetCard label="SHOW"      horses={[byWin[0]]} />}
        {byWin.length >= 2  && <BetCard label="EXACTA"   horses={byWin.slice(0, 2)} />}
        {byWin.length >= 3  && <BetCard label="TRIFECTA" horses={byWin.slice(0, 3)} />}
      </div>

      {posEV.length > 0 && (
        <>
          <div style={{ color: C.gold, fontWeight: 700, fontSize: 16, marginBottom: 12 }}>Positive Edge Horses</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 24 }}>
            {posEV.map(r => (
              <div key={r.horseName} style={{ ...S.card, padding: '10px 16px', borderLeft: `3px solid ${C.pos}`, marginBottom: 0 }}>
                <div style={{ fontWeight: 700 }}>{r.horseName}</div>
                <div style={{ color: C.pos, fontSize: 13 }}>+{(r.edge * 100).toFixed(1)}% edge</div>
                <div style={{ color: C.muted, fontSize: 12 }}>ML {r.morningLine} · Win {(r.simWin * 100).toFixed(1)}%</div>
              </div>
            ))}
          </div>
        </>
      )}

      <div style={{ color: C.gold, fontWeight: 700, fontSize: 16, marginBottom: 12 }}>Paper Bet Tracker</div>
      <div style={S.card}>
        <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr 90px 90px auto', gap: 10, alignItems: 'end' }}>
          <div>
            <div style={{ color: C.muted, fontSize: 11, marginBottom: 4 }}>TYPE</div>
            <select style={S.select} value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))}>
              {['WIN', 'PLACE', 'SHOW', 'EXACTA', 'TRIFECTA', 'SUPERFECTA'].map(t => <option key={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <div style={{ color: C.muted, fontSize: 11, marginBottom: 4 }}>HORSE(S)</div>
            <input style={S.input} value={form.horse} onChange={e => setForm(f => ({ ...f, horse: e.target.value }))} placeholder="Horse name(s)" />
          </div>
          <div>
            <div style={{ color: C.muted, fontSize: 11, marginBottom: 4 }}>STAKE $</div>
            <input style={S.input} type="number" value={form.stake} onChange={e => setForm(f => ({ ...f, stake: e.target.value }))} placeholder="2.00" />
          </div>
          <div>
            <div style={{ color: C.muted, fontSize: 11, marginBottom: 4 }}>ODDS</div>
            <input style={S.input} value={form.odds} onChange={e => setForm(f => ({ ...f, odds: e.target.value }))} placeholder="5/2" />
          </div>
          <button style={{ ...S.btn('gold'), marginTop: 18 }} onClick={addBet}>+ Add</button>
        </div>
      </div>

      {bets.length > 0 && (
        <>
          <div style={{ overflowX: 'auto' }}>
            <table style={S.table}>
              <thead>
                <tr>
                  {['Type', 'Horse(s)', 'Stake', 'Odds', 'Status', 'Settle'].map(h => (
                    <th key={h} style={S.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {bets.map(b => (
                  <tr key={b.id}>
                    <td style={S.td}><span style={{ color: C.gold, fontWeight: 700 }}>{b.type}</span></td>
                    <td style={S.td}>{b.horse}</td>
                    <td style={S.td}>${b.stake.toFixed(2)}</td>
                    <td style={S.td}>{b.odds || '—'}</td>
                    <td style={S.td}>
                      <span style={{ color: b.result === 'W' ? C.pos : b.result === 'L' ? C.neg : C.muted }}>
                        {b.result === 'W' ? 'WIN' : b.result === 'L' ? 'LOSS' : 'Open'}
                      </span>
                    </td>
                    <td style={S.td}>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {!b.result && <>
                          <button style={{ ...S.btn('gold'), padding: '3px 10px', fontSize: 12 }} onClick={() => settle(b.id, 'W')}>W</button>
                          <button style={{ ...S.btn('neg'),  padding: '3px 10px', fontSize: 12 }} onClick={() => settle(b.id, 'L')}>L</button>
                        </>}
                        <button style={{ ...S.btn(), padding: '3px 8px', fontSize: 12 }} onClick={() => removeBet(b.id)}>✕</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ textAlign: 'right', marginTop: 12, fontSize: 16, fontWeight: 700 }}>
            Running P&L:{' '}
            <span style={{ color: pnl >= 0 ? C.pos : C.neg }}>
              {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [tab,           setTab]           = useState(0);
  const [isWet,         setIsWet]         = useState(false);
  const [loading,       setLoading]       = useState(false);
  const [error,         setError]         = useState(null);
  const [allHorses,     setAllHorses]     = useState([]);
  const [availableDates,setAvailableDates]= useState([]);
  const [selectedDate,  setSelectedDate]  = useState('');
  const [races,         setRaces]         = useState([]);
  const [selectedRace,  setSelectedRace]  = useState('');
  const [simByRace,     setSimByRace]     = useState({});
  const [simRunning,    setSimRunning]    = useState(false);
  const [lastSimRace,   setLastSimRace]   = useState('');

  // Feature 1: fetch parses raceDate, builds allHorses + availableDates
  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch(SHEET_CSV_URL);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const text = await resp.text();
      const { data } = Papa.parse(text, { header: true, skipEmptyLines: true });

      const norm = row => {
        const m = {};
        for (const [k, v] of Object.entries(row)) {
          m[k.toLowerCase().replace(/[^a-z0-9]/g, '')] = v;
        }
        return {
          raceDate:    m.racedate     || m.date          || '',
          race:        m.race         || m.racenumber     || m.raceno       || '',
          postTime:    m.posttime     || m.post           || m.time         || '',
          postPos:     m.postposition || m.postpos        || m.pp           || '',
          horseName:   m.horse        || m.horsename      || m.name         || '',
          jockey:      m.jockey       || m.rider          || '',
          trainer:     m.trainer      || '',
          morningLine: m.morningline  || m.ml             || m.odds         || '',
          speedFig:    m.speedfig     || m.fig            || m.beyer        || m.figure || '',
          figRank:     m.figrank      || m.rank           || '',
          trainerFlag: m.trainerflag  || m.flag           || m.trainernote  || '',
          daysRest:    m.daysrest     || m.days           || m.dayssincelast || '999',
          winPct:      m.winpct       || m['win%']        || '',
        };
      };

      const horses = data.map(norm).filter(h => h.horseName);
      setAllHorses(horses);

      // Unique sorted dates
      const today   = new Date().toISOString().split('T')[0];
      const dates   = [...new Set(horses.map(h => h.raceDate).filter(Boolean))].sort();
      setAvailableDates(dates);

      // Default: nearest future date, else most recent past
      const future  = dates.filter(d => d >= today);
      const dflt    = future.length > 0 ? future[0] : dates[dates.length - 1] || '';
      setSelectedDate(prev => prev || dflt);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Rebuild races list + clear sims whenever date or data changes
  useEffect(() => {
    if (!allHorses.length) return;
    const filtered = selectedDate
      ? allHorses.filter(h => h.raceDate === selectedDate)
      : allHorses;

    const raceMap = {};
    filtered.forEach(h => {
      if (!raceMap[h.race]) raceMap[h.race] = { race: h.race, postTime: h.postTime, horses: [] };
      raceMap[h.race].horses.push(h);
    });
    const raceList = Object.values(raceMap)
      .sort((a, b) => a.race.localeCompare(b.race, undefined, { numeric: true }));

    setRaces(raceList);
    setSelectedRace(raceList[0]?.race ?? '');
    setSimByRace({});
    setLastSimRace('');
  }, [allHorses, selectedDate]);

  const currentRace    = races.find(r => r.race === selectedRace);
  const currentHorses  = currentRace?.horses || [];
  const currentResults = simByRace[selectedRace] || null;
  const allResults     = Object.values(simByRace).flat();
  const lock           = computeLock(simByRace);

  const postDate = (() => {
    const t = currentRace?.postTime?.trim();
    if (!t) return null;
    const d = new Date(`${new Date().toDateString()} ${t}`);
    return isNaN(d) ? null : d;
  })();

  const handleSimulate = () => {
    if (!currentHorses.length) return;
    setSimRunning(true);
    setTimeout(() => {
      try {
        const results = runSimulation(currentHorses, isWet);
        setSimByRace(p => ({ ...p, [selectedRace]: results }));
        setLastSimRace(selectedRace);
      } finally {
        setSimRunning(false);
      }
    }, 0);
  };

  const handleReset = () => {
    setSimByRace(p => { const n = { ...p }; delete n[selectedRace]; return n; });
    setLastSimRace('');
  };

  // Feature 1: date badge
  const today     = new Date().toISOString().split('T')[0];
  const dateBadge = selectedDate >= today ? 'NEXT RACE' : 'LAST CARD';
  const badgeColor = selectedDate >= today ? C.pos : C.gold;

  const scrollToDisclaimer = () =>
    document.getElementById('disclaimer')?.scrollIntoView({ behavior: 'smooth' });

  return (
    <div style={S.app}>

      {/* ── Header ── */}
      <header style={S.header}>
        <div style={{ flex: 1 }}>
          <h1 style={S.title}>🏇 The Rail</h1>
          <div style={S.sub}>
            Fairmount Park · Collinsville, IL · Speed Figure Model v3
            {' '}
            <button
              onClick={scrollToDisclaimer}
              style={{
                background: 'none', border: `1px solid ${C.border}`, borderRadius: 10,
                color: C.muted, fontSize: 10, padding: '1px 7px', cursor: 'pointer',
                marginLeft: 6, verticalAlign: 'middle',
              }}
            >
              ⓘ Entertainment Only
            </button>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ color: C.muted, fontSize: 12 }}>Track:</span>
          <button style={S.pill(!isWet)} onClick={() => setIsWet(false)}>☀ Dry</button>
          <button style={S.pill(isWet)}  onClick={() => setIsWet(true)}>🌧 Wet</button>

          {/* Feature 1: date picker */}
          {availableDates.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 8 }}>
              <select
                style={{ ...S.select, width: 'auto', fontSize: 12, padding: '4px 8px' }}
                value={selectedDate}
                onChange={e => setSelectedDate(e.target.value)}
              >
                {availableDates.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
              <span style={{
                background: badgeColor, color: C.bg, fontSize: 10, fontWeight: 700,
                padding: '2px 7px', borderRadius: 10, whiteSpace: 'nowrap',
              }}>
                {dateBadge}
              </span>
            </div>
          )}

          <button style={{ ...S.btn(), marginLeft: 4 }} onClick={fetchData} disabled={loading}>
            {loading ? '⏳' : '↺ Refresh'}
          </button>
        </div>
      </header>

      {/* ── Tabs ── */}
      <div style={S.tabBar}>
        <button style={S.tab(tab === 0)} onClick={() => setTab(0)}>🏇 Fairmount Park</button>
        <button style={S.tab(tab === 1)} onClick={() => setTab(1)}>💰 Bet Builder</button>
      </div>

      {error && (
        <div style={{ background: '#2a1010', color: C.neg, padding: '10px 24px', fontSize: 13 }}>
          ⚠ {error}
        </div>
      )}

      {/* ── Fairmount tab ── */}
      {tab === 0 && (
        <div style={{ padding: 20, maxWidth: 1000, margin: '0 auto' }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 16 }}>
            <div style={{ flex: 1, minWidth: 220 }}>
              <label style={{ color: C.muted, fontSize: 11, display: 'block', marginBottom: 4 }}>SELECT RACE</label>
              <select style={S.select} value={selectedRace} onChange={e => setSelectedRace(e.target.value)}>
                {races.map(r => (
                  <option key={r.race} value={r.race}>
                    Race {r.race}{r.postTime ? ` — ${r.postTime}` : ''}
                  </option>
                ))}
              </select>
            </div>
            <button
              style={S.btn('gold')}
              onClick={handleSimulate}
              disabled={simRunning || !currentHorses.length}
            >
              {simRunning ? '⏳ Simulating…' : '▶ Run Simulation'}
            </button>
            {currentResults && (
              <button style={S.btn()} onClick={handleReset}>Reset</button>
            )}
          </div>

          <Countdown targetTime={postDate} />

          {loading && (
            <div style={{ color: C.muted, textAlign: 'center', padding: 50 }}>Loading race data…</div>
          )}
          {!loading && !error && currentHorses.length === 0 && (
            <div style={{ color: C.muted, textAlign: 'center', padding: 50 }}>No horses found for this race.</div>
          )}

          {currentHorses.map(h => (
            <HorseCard
              key={`${h.postPos}-${h.horseName}`}
              horse={h}
              result={currentResults?.find(r => r.horseName === h.horseName)}
              isLock={lock?.horseName === h.horseName && lock?.race === selectedRace}
            />
          ))}

          {currentResults && (
            <>
              <WinBarChart  results={currentResults} />
              <EdgeBarChart results={currentResults} />
              <PoissonChart results={currentResults} />

              {/* Feature 2: Summary Card */}
              <SummaryCard
                simByRace={simByRace}
                defaultRace={lastSimRace}
                races={races}
                lock={lock}
              />

              <div style={S.card}>
                <div style={{ color: C.gold, fontWeight: 700, marginBottom: 12 }}>Full Simulation Results</div>
                <div style={{ overflowX: 'auto' }}>
                  <table style={S.table}>
                    <thead>
                      <tr>
                        {['PP', 'Horse', 'Win %', 'Place %', 'Show %', 'Implied %', 'Edge'].map(h => (
                          <th key={h} style={S.th}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {[...currentResults].sort((a, b) => b.simWin - a.simWin).map(r => (
                        <tr key={r.horseName}>
                          <td style={S.td}>{r.postPos}</td>
                          <td style={{ ...S.td, fontWeight: 700 }}>
                            {r.horseName}
                            {lock?.horseName === r.horseName && lock?.race === selectedRace && ' 🎆'}
                          </td>
                          <td style={S.td}>{(r.simWin   * 100).toFixed(1)}%</td>
                          <td style={S.td}>{(r.simPlace * 100).toFixed(1)}%</td>
                          <td style={S.td}>{(r.simShow  * 100).toFixed(1)}%</td>
                          <td style={S.td}>{(r.implied  * 100).toFixed(1)}%</td>
                          <td style={{ ...S.td, color: r.edge >= 0 ? C.pos : C.neg, fontWeight: 700 }}>
                            {r.edge >= 0 ? '+' : ''}{(r.edge * 100).toFixed(1)}%
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Bet Builder tab ── */}
      {tab === 1 && (
        <BetBuilder
          results={allResults.length > 0 ? allResults : null}
          lock={lock}
        />
      )}

      {/* ── Feature 5: Legal Disclaimer Footer ── */}
      <footer
        id="disclaimer"
        style={{
          background: '#0d120d',
          borderTop: `1px solid ${C.gold}`,
          padding: '12px 24px',
          textAlign: 'center',
          fontSize: 11,
          color: C.muted,
          lineHeight: 1.6,
          marginTop: 40,
        }}
      >
        🏇 The Rail is for entertainment and informational purposes only. Nothing on this site constitutes
        financial or betting advice. Horse racing involves significant financial risk. Please gamble
        responsibly and within your means. If you or someone you know has a gambling problem, call the
        National Problem Gambling Helpline:{' '}
        <span style={{ color: C.text, fontWeight: 600 }}>1-800-522-4700</span>
        {' '}(available 24/7, free and confidential). You must be 21 or older to wager in most jurisdictions.
      </footer>

    </div>
  );
}
