import { useState, useMemo, useEffect, useCallback } from 'react'
import Papa from 'papaparse'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell, Legend,
} from 'recharts'

// ─── CONFIGURE ────────────────────────────────────────────────────────────────
// After publishing your Google Sheet as CSV (File → Share → Publish to web →
// select "Comma-separated values (.csv)"), paste the URL below.
// Required column headers in row 1:
//   post, name, odds, oddsNum, trainer, jockey, sire,
//   tier, style, lastRace, figure, postMult
const SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQ-MEid0dPSaoM3X67c_DjyFdQ0lBiQQ7lCUJBxjtwnI5oz8cpo7t7rpigDep9EVyRcVrkq3UXuJzTo/pub?output=csv'
// ─────────────────────────────────────────────────────────────────────────────

// ── Theme ─────────────────────────────────────────────────────────────────────
const C = {
  bg:     '#071510',
  card:   '#0d2118',
  row:    '#112a1c',
  rowAlt: '#0d2118',
  gold:   '#c9a84c',
  goldLt: '#e0c878',
  goldDk: '#7a6228',
  text:   '#f0e8d0',
  muted:  '#6a9278',
  border: '#1c4430',
  green:  '#1e5c36',
}

const STYLE_COLOR = {
  'Speed':         '#cc4444',
  'Front-Runner':  '#cc7744',
  'Speed/Stalker': '#c9a84c',
  'Mid-pack':      '#6688cc',
  'Stalker':       '#4488cc',
  'Closer':        '#9966cc',
}

// ── Fallback Field ────────────────────────────────────────────────────────────
const FALLBACK_HORSES = [
  { post:  1, name: 'Renegade',        odds: '4-1',  oddsNum:  4, trainer: 'Todd Pletcher', jockey: 'Irad Ortiz Jr',   sire: 'Into Mischief',    tier: 1, style: 'Closer',        lastRace: 'Won Arkansas Derby by 4L',     figure: 107, postMult: 0.60 },
  { post:  2, name: 'Albus',           odds: '30-1', oddsNum: 30, trainer: 'Riley Mott',    jockey: 'Manny Franco',    sire: 'Yaupon',           tier: 3, style: 'Closer',        lastRace: 'Won Wood Memorial',            figure:  86, postMult: 1.05 },
  { post:  3, name: 'Intrepido',       odds: '50-1', oddsNum: 50, trainer: 'Jeff Mullins',  jockey: 'Hector Berrios',  sire: 'Maximus Mischief', tier: 4, style: 'Stalker',       lastRace: 'G3 placed Santa Anita',        figure:  82, postMult: 1.05 },
  { post:  4, name: 'Litmus Test',     odds: '50-1', oddsNum: 50, trainer: 'Bob Baffert',   jockey: 'TBD',             sire: 'Nyquist',          tier: 4, style: 'Stalker',       lastRace: '2nd Louisiana Derby',          figure:  84, postMult: 1.05 },
  { post:  5, name: 'Right to Party',  odds: '30-1', oddsNum: 30, trainer: 'Karl Broberg',  jockey: 'TBD',             sire: 'Constitution',     tier: 3, style: 'Speed',         lastRace: '2nd Wood Memorial',            figure:  85, postMult: 1.20 },
  { post:  6, name: 'Commandment',     odds: '6-1',  oddsNum:  6, trainer: 'Brad Cox',      jockey: 'Luis Saez',       sire: 'Into Mischief',    tier: 1, style: 'Speed/Stalker', lastRace: 'Won Florida Derby by nose',    figure: 104, postMult: 0.70 },
  { post:  7, name: 'Danon Bourbon',   odds: '20-1', oddsNum: 20, trainer: 'M Ikezoe',      jockey: 'A Nishimura',     sire: 'American Pharoah', tier: 3, style: 'Mid-pack',      lastRace: 'Ships from Japan',             figure:  90, postMult: 1.00 },
  { post:  8, name: 'So Happy',        odds: '15-1', oddsNum: 15, trainer: 'Mark Glatt',    jockey: 'Mike Smith',      sire: 'Authentic',        tier: 2, style: 'Closer',        lastRace: 'Won Sunland Derby',            figure:  95, postMult: 1.15 },
  { post:  9, name: 'The Puma',        odds: '10-1', oddsNum: 10, trainer: 'G Delgado',     jockey: 'J Castellano',    sire: 'Justify',          tier: 2, style: 'Speed',         lastRace: 'Won Tampa Bay Derby',          figure: 100, postMult: 1.10 },
  { post: 10, name: 'Wonder Dean',     odds: '30-1', oddsNum: 30, trainer: 'D Takayanagi',  jockey: 'Ryusei Sakai',    sire: 'Contrail',         tier: 4, style: 'Mid-pack',      lastRace: 'Ships from Japan',             figure:  88, postMult: 1.15 },
  { post: 11, name: 'Incredibolt',     odds: '20-1', oddsNum: 20, trainer: 'Riley Mott',    jockey: 'Jaime Torres',    sire: 'Bolt d Oro',       tier: 3, style: 'Closer',        lastRace: 'Won Virginia Derby',           figure:  93, postMult: 1.05 },
  { post: 12, name: 'Chief Wallabee',  odds: '8-1',  oddsNum:  8, trainer: 'Bill Mott',     jockey: 'Junior Alvarado', sire: 'Gun Runner',       tier: 2, style: 'Front-Runner',  lastRace: '3rd Florida Derby tight',      figure: 101, postMult: 1.05 },
  { post: 14, name: 'Potente',         odds: '20-1', oddsNum: 20, trainer: 'Bob Baffert',   jockey: 'Juan Hernandez',  sire: 'Into Mischief',    tier: 3, style: 'Front-Runner',  lastRace: 'Won UAE Derby',                figure:  92, postMult: 1.05 },
  { post: 15, name: 'Emerging Market', odds: '15-1', oddsNum: 15, trainer: 'Chad Brown',    jockey: 'Flavien Prat',    sire: 'Candy Ride',       tier: 2, style: 'Stalker',       lastRace: 'Won Louisiana Derby unbeaten', figure:  96, postMult: 1.10 },
  { post: 16, name: 'Pavlovian',       odds: '30-1', oddsNum: 30, trainer: 'Doug ONeill',   jockey: 'E Maldonado',     sire: 'Pavel',            tier: 3, style: 'Speed',         lastRace: '2nd Louisiana Derby',          figure:  90, postMult: 1.10 },
  { post: 17, name: 'Six Speed',       odds: '50-1', oddsNum: 50, trainer: 'B Seemar',      jockey: 'B Hernandez Jr',  sire: 'Not This Time',    tier: 4, style: 'Front-Runner',  lastRace: '2nd UAE Derby',                figure:  85, postMult: 0.50 },
  { post: 18, name: 'Further Ado',     odds: '6-1',  oddsNum:  6, trainer: 'Brad Cox',      jockey: 'John Velazquez',  sire: 'Gun Runner',       tier: 1, style: 'Stalker',       lastRace: 'Won Blue Grass by 11 lengths', figure: 107, postMult: 1.15 },
  { post: 19, name: 'Golden Tempo',    odds: '30-1', oddsNum: 30, trainer: 'TBD',           jockey: 'TBD',             sire: 'TBD',              tier: 4, style: 'Mid-pack',      lastRace: 'Qualified via points',         figure:  83, postMult: 1.05 },
  { post: 21, name: 'Great White',     odds: '50-1', oddsNum: 50, trainer: 'DW Beckman',    jockey: 'Joseph Ramos',    sire: 'Volatile',         tier: 4, style: 'Stalker',       lastRace: '3rd Wood Memorial',            figure:  83, postMult: 0.90 },
  { post: 22, name: 'Ocelli',          odds: '50-1', oddsNum: 50, trainer: 'TBD',           jockey: 'TBD',             sire: 'TBD',              tier: 4, style: 'Mid-pack',      lastRace: 'Also-eligible entrant',        figure:  80, postMult: 0.85 },
]

// ── CSV Row Parser ────────────────────────────────────────────────────────────
function parseRow(row) {
  return {
    post:     parseInt(row.post,  10),
    name:     (row.name     || '').trim(),
    odds:     (row.odds     || '').trim(),
    oddsNum:  parseFloat(row.oddsNum),
    trainer:  (row.trainer  || '').trim(),
    jockey:   (row.jockey   || '').trim(),
    sire:     (row.sire     || '').trim(),
    tier:     parseInt(row.tier, 10),
    style:    (row.style    || '').trim(),
    lastRace: (row.lastRace || '').trim(),
    figure:   parseInt(row.figure, 10),
    postMult: parseFloat(row.postMult),
  }
}

// ── Scoring ───────────────────────────────────────────────────────────────────
const TIER_SCORE  = { 1: 100, 2: 78, 3: 54, 4: 28 }
const STYLE_SCORE = {
  'Stalker': 88, 'Closer': 83, 'Speed/Stalker': 77,
  'Mid-pack': 71, 'Front-Runner': 65, 'Speed': 61,
}

function calcP1(h) {
  const fig  = Math.min(100, Math.max(0, (h.figure - 78) / 30 * 100))
  const tier = TIER_SCORE[h.tier] ?? 28
  return Math.round(fig * 0.70 + tier * 0.30)
}

function calcP2(h) {
  const sty  = STYLE_SCORE[h.style] ?? 70
  const post = Math.min(100, Math.max(0, (h.postMult / 1.2) * 100))
  return Math.round(sty * 0.55 + post * 0.45)
}

function calcP3(h) {
  return Math.round(calcP1(h) * 0.55 + calcP2(h) * 0.45)
}

// ── Monte Carlo ───────────────────────────────────────────────────────────────
function runMonteCarlo(horses, n = 10000) {
  const scores = horses.map(h => h.p3)
  const maxS   = Math.max(...scores)
  const exps   = scores.map(s => Math.exp((s - maxS) / 20))
  const tot    = exps.reduce((a, b) => a + b, 0)
  const probs  = exps.map(e => e / tot)

  const wins   = new Array(horses.length).fill(0)
  const places = new Array(horses.length).fill(0)
  const shows  = new Array(horses.length).fill(0)

  for (let i = 0; i < n; i++) {
    const ri = horses.map((_, j) => j)
    const rp = [...probs]
    for (let pos = 0; pos < 3; pos++) {
      const s = rp.reduce((a, b) => a + b, 0)
      let r = Math.random() * s
      let j = 0
      while (j < rp.length - 1 && r > rp[j]) { r -= rp[j]; j++ }
      const idx = ri[j]
      if (pos === 0) wins[idx]++
      if (pos <= 1)  places[idx]++
      shows[idx]++
      ri.splice(j, 1)
      rp.splice(j, 1)
    }
  }

  return horses.map((h, i) => ({
    ...h,
    winPct:   +(wins[i]   / n * 100).toFixed(1),
    placePct: +(places[i] / n * 100).toFixed(1),
    showPct:  +(shows[i]  / n * 100).toFixed(1),
    ev:       +((wins[i] / n) * h.oddsNum * 2 - 2).toFixed(2),
  }))
}

// ── Shared UI ─────────────────────────────────────────────────────────────────
const GLOBAL_CSS = `
  @keyframes derby-spin { to { transform: rotate(360deg); } }
  * { box-sizing: border-box; }
  button { font-family: Georgia, serif; }
`

function StyleBadge({ style }) {
  const color = STYLE_COLOR[style] || C.muted
  return (
    <span style={{
      background: color + '22', color, border: `1px solid ${color}55`,
      borderRadius: 4, padding: '2px 8px', fontSize: 11,
      fontWeight: 'bold', fontFamily: 'monospace', whiteSpace: 'nowrap',
    }}>{style}</span>
  )
}

function TierBadge({ tier }) {
  const colors = { 1: '#c9a84c', 2: '#7ab896', 3: '#4a88aa', 4: '#666' }
  const labels = { 1: 'Elite', 2: 'Strong', 3: 'Solid', 4: 'LongShot' }
  const color  = colors[tier] || C.muted
  return (
    <span style={{
      background: color + '22', color, border: `1px solid ${color}55`,
      borderRadius: 4, padding: '2px 8px', fontSize: 11, fontWeight: 'bold',
    }}>T{tier} {labels[tier]}</span>
  )
}

function ScoreBar({ value, color = C.gold }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ width: 80, height: 7, background: C.border, borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ width: `${value}%`, height: '100%', background: color, borderRadius: 4 }} />
      </div>
      <span style={{ color, fontWeight: 'bold', minWidth: 26, fontSize: 13 }}>{value}</span>
    </div>
  )
}

function Rank({ i }) {
  if (i === 0) return <span style={{ color: C.gold,    fontWeight: 'bold' }}>1st</span>
  if (i === 1) return <span style={{ color: '#b8b8c8', fontWeight: 'bold' }}>2nd</span>
  if (i === 2) return <span style={{ color: '#cd7f32', fontWeight: 'bold' }}>3rd</span>
  return <span style={{ color: C.muted, fontSize: 12 }}>{i + 1}</span>
}

function Spinner() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: 80, gap: 16 }}>
      <div style={{
        width: 44, height: 44, borderRadius: '50%',
        border: `3px solid ${C.border}`, borderTopColor: C.gold,
        animation: 'derby-spin 0.7s linear infinite',
      }} />
      <span style={{ color: C.muted, fontSize: 13 }}>Loading from Google Sheets…</span>
    </div>
  )
}

const Th = ({ children, style = {} }) => (
  <th style={{
    padding: '9px 12px', textAlign: 'left', color: C.gold,
    borderBottom: `1px solid ${C.border}`, fontSize: 11,
    textTransform: 'uppercase', letterSpacing: '0.07em',
    fontWeight: 'bold', whiteSpace: 'nowrap', background: C.card, ...style,
  }}>{children}</th>
)

const Td = ({ children, style = {} }) => (
  <td style={{
    padding: '8px 12px', color: C.text,
    borderBottom: `1px solid ${C.border}22`, fontSize: 12, ...style,
  }}>{children}</td>
)

function SectionTitle({ children }) {
  return <h2 style={{ color: C.gold, fontSize: 20, fontWeight: 'bold', margin: '0 0 6px', fontFamily: 'Georgia, serif' }}>{children}</h2>
}

function SectionDesc({ children }) {
  return <p style={{ color: C.muted, fontSize: 13, marginBottom: 20, lineHeight: 1.6 }}>{children}</p>
}

const chartStyle = {
  contentStyle: { background: C.card, border: `1px solid ${C.border}`, color: C.text, fontSize: 12 },
  cursor: { fill: C.border + '44' },
}

// ── Tab: Field Card ───────────────────────────────────────────────────────────
function FieldCard({ horses }) {
  return (
    <div>
      <SectionTitle>2026 Kentucky Derby — Full Field</SectionTitle>
      <SectionDesc>Churchill Downs · 1¼ Miles · Dirt</SectionDesc>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <Th>#</Th><Th>Horse</Th><Th>Sire</Th><Th>Trainer</Th><Th>Jockey</Th>
              <Th>Odds</Th><Th>Style</Th><Th>Tier</Th><Th>Last Race</Th>
            </tr>
          </thead>
          <tbody>
            {horses.map((h, i) => (
              <tr key={h.post} style={{ background: i % 2 === 0 ? C.row : C.rowAlt }}>
                <Td style={{ color: C.gold, fontWeight: 'bold', fontSize: 15 }}>{h.post}</Td>
                <Td style={{ fontWeight: 'bold' }}>{h.name}</Td>
                <Td style={{ color: C.muted, fontStyle: 'italic' }}>{h.sire}</Td>
                <Td style={{ color: C.muted }}>{h.trainer}</Td>
                <Td style={{ color: C.muted }}>{h.jockey}</Td>
                <Td style={{ color: C.goldLt, fontWeight: 'bold' }}>{h.odds}</Td>
                <Td><StyleBadge style={h.style} /></Td>
                <Td><TierBadge tier={h.tier} /></Td>
                <Td style={{ color: C.muted, fontSize: 11 }}>{h.lastRace}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 20, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {Object.entries(STYLE_COLOR).map(([s, color]) => (
          <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <StyleBadge style={s} />
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Tab: Phase 1 ──────────────────────────────────────────────────────────────
function Phase1Tab({ scored }) {
  const sorted    = useMemo(() => [...scored].sort((a, b) => b.p1 - a.p1), [scored])
  const chartData = sorted.map(h => ({ name: `${h.post}.${h.name.split(' ')[0]}`, Score: h.p1 }))

  return (
    <div>
      <SectionTitle>Phase 1 — Speed &amp; Class</SectionTitle>
      <SectionDesc>
        Speed Figure (70%) measures peak ability on the figures; Class Tier (30%) reflects level of competition. Tier 1 = Elite graded-stakes class, Tier 4 = limited graded form.
      </SectionDesc>
      <div style={{ height: 270, marginBottom: 32 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} margin={{ top: 4, right: 16, bottom: 64, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
            <XAxis dataKey="name" tick={{ fill: C.muted, fontSize: 10 }} angle={-45} textAnchor="end" interval={0} />
            <YAxis tick={{ fill: C.muted, fontSize: 11 }} domain={[0, 100]} />
            <Tooltip {...chartStyle} />
            <Bar dataKey="Score" radius={[4, 4, 0, 0]}>
              {chartData.map((_, i) => (
                <Cell key={i} fill={i === 0 ? C.gold : i < 3 ? C.goldDk : C.border + 'cc'} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr><Th>Rank</Th><Th>#</Th><Th>Horse</Th><Th>Figure</Th><Th>Tier</Th><Th>Last Race</Th><Th>P1 Score</Th></tr>
          </thead>
          <tbody>
            {sorted.map((h, i) => (
              <tr key={h.post} style={{ background: i % 2 === 0 ? C.row : C.rowAlt }}>
                <Td><Rank i={i} /></Td>
                <Td style={{ color: C.gold, fontWeight: 'bold' }}>{h.post}</Td>
                <Td style={{ fontWeight: 'bold' }}>{h.name}</Td>
                <Td style={{ color: C.goldLt, fontWeight: 'bold', fontSize: 15 }}>{h.figure}</Td>
                <Td><TierBadge tier={h.tier} /></Td>
                <Td style={{ color: C.muted, fontSize: 11 }}>{h.lastRace}</Td>
                <Td><ScoreBar value={h.p1} color={i < 3 ? C.gold : C.green} /></Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Tab: Phase 2 ──────────────────────────────────────────────────────────────
function Phase2Tab({ scored }) {
  const sorted     = useMemo(() => [...scored].sort((a, b) => b.p2 - a.p2), [scored])
  const styleCounts = scored.reduce((acc, h) => {
    acc[h.style] = (acc[h.style] || 0) + 1; return acc
  }, {})

  return (
    <div>
      <SectionTitle>Phase 2 — Pace &amp; Post Position</SectionTitle>
      <SectionDesc>
        Running-style aptitude for Churchill's 1¼-mile dirt (55%) blended with post-position multiplier (45%). Stalkers and closers historically dominate the Kentucky Derby.
      </SectionDesc>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 24 }}>
        {Object.entries(styleCounts).map(([s, n]) => (
          <div key={s} style={{
            background: C.card, border: `1px solid ${(STYLE_COLOR[s] || C.muted) + '44'}`,
            borderRadius: 8, padding: '10px 16px', textAlign: 'center',
          }}>
            <div style={{ fontSize: 22, fontWeight: 'bold', color: STYLE_COLOR[s] || C.muted }}>{n}</div>
            <StyleBadge style={s} />
          </div>
        ))}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr><Th>Rank</Th><Th>#</Th><Th>Horse</Th><Th>Style</Th><Th>Post Mult</Th><Th>P2 Score</Th></tr>
          </thead>
          <tbody>
            {sorted.map((h, i) => (
              <tr key={h.post} style={{ background: i % 2 === 0 ? C.row : C.rowAlt }}>
                <Td><Rank i={i} /></Td>
                <Td style={{ color: C.gold, fontWeight: 'bold' }}>{h.post}</Td>
                <Td style={{ fontWeight: 'bold' }}>{h.name}</Td>
                <Td><StyleBadge style={h.style} /></Td>
                <Td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ width: 56, height: 6, background: C.border, borderRadius: 3, overflow: 'hidden' }}>
                      <div style={{
                        width: `${(h.postMult / 1.2) * 100}%`, height: '100%', borderRadius: 3,
                        background: h.postMult >= 1.0 ? '#4a8a5a' : '#8a4a4a',
                      }} />
                    </div>
                    <span style={{ fontWeight: 'bold', fontSize: 13, color: h.postMult >= 1.0 ? '#7aba8a' : '#ba7a7a' }}>
                      {h.postMult.toFixed(2)}×
                    </span>
                  </div>
                </Td>
                <Td><ScoreBar value={h.p2} color={i < 3 ? C.gold : C.green} /></Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Tab: Phase 3 ──────────────────────────────────────────────────────────────
function Phase3Tab({ scored }) {
  const sorted    = useMemo(() => [...scored].sort((a, b) => b.p3 - a.p3), [scored])
  const chartData = sorted.slice(0, 10).map(h => ({ name: h.name.split(' ')[0], Score: h.p3 }))

  return (
    <div>
      <SectionTitle>Phase 3 — Final Ratings</SectionTitle>
      <SectionDesc>
        Combined score: Phase 1 Speed/Class (55%) + Phase 2 Pace/Post (45%). Top 10 shown in chart.
      </SectionDesc>
      <div style={{ height: 270, marginBottom: 32 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} margin={{ top: 4, right: 16, bottom: 50, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
            <XAxis dataKey="name" tick={{ fill: C.muted, fontSize: 11 }} angle={-30} textAnchor="end" interval={0} />
            <YAxis tick={{ fill: C.muted, fontSize: 11 }} domain={[0, 100]} />
            <Tooltip {...chartStyle} />
            <Bar dataKey="Score" radius={[4, 4, 0, 0]}>
              {chartData.map((_, i) => (
                <Cell key={i} fill={i === 0 ? C.gold : i < 3 ? C.goldDk : C.border + 'cc'} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr><Th>Rank</Th><Th>#</Th><Th>Horse</Th><Th>Odds</Th><Th>P1</Th><Th>P2</Th><Th>Final Score</Th></tr>
          </thead>
          <tbody>
            {sorted.map((h, i) => (
              <tr key={h.post} style={{ background: i % 2 === 0 ? C.row : C.rowAlt }}>
                <Td><Rank i={i} /></Td>
                <Td style={{ color: C.gold, fontWeight: 'bold' }}>{h.post}</Td>
                <Td style={{ fontWeight: 'bold', color: i < 3 ? C.goldLt : C.text }}>{h.name}</Td>
                <Td style={{ color: C.goldLt }}>{h.odds}</Td>
                <Td style={{ color: C.muted }}>{h.p1}</Td>
                <Td style={{ color: C.muted }}>{h.p2}</Td>
                <Td><ScoreBar value={h.p3} color={i === 0 ? C.gold : i < 3 ? C.goldDk : C.green} /></Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Tab: Monte Carlo ──────────────────────────────────────────────────────────
function MonteCarloTab({ scored }) {
  const [results, setResults] = useState(null)
  const [running, setRunning] = useState(false)

  useEffect(() => { setResults(null) }, [scored])

  const run = () => {
    setRunning(true)
    setTimeout(() => { setResults(runMonteCarlo(scored)); setRunning(false) }, 40)
  }

  const sorted    = results ? [...results].sort((a, b) => b.winPct - a.winPct) : []
  const chartData = sorted.map(h => ({
    name:  `${h.post}.${h.name.split(' ')[0]}`,
    Win:   h.winPct,
    Place: +(h.placePct - h.winPct).toFixed(1),
    Show:  +(h.showPct  - h.placePct).toFixed(1),
  }))

  return (
    <div>
      <SectionTitle>Monte Carlo Simulation</SectionTitle>
      <SectionDesc>
        10,000 simulated races using Phase 3 scores converted to win probabilities via temperature-scaled softmax. Tracks Win, Place, and Show finishes. EV column shows expected value on a $2 win bet at morning-line odds.
      </SectionDesc>
      <button onClick={run} disabled={running} style={{
        background: running ? C.border : C.gold, color: running ? C.muted : '#071510',
        border: 'none', borderRadius: 8, padding: '11px 28px',
        fontSize: 14, fontWeight: 'bold', cursor: running ? 'wait' : 'pointer', marginBottom: 24,
      }}>
        {running ? 'Simulating…' : results ? 'Re-Run 10,000 Simulations' : 'Run 10,000 Simulations'}
      </button>
      {results && (
        <>
          <div style={{ height: 300, marginBottom: 32 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 4, right: 16, bottom: 64, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
                <XAxis dataKey="name" tick={{ fill: C.muted, fontSize: 10 }} angle={-45} textAnchor="end" interval={0} />
                <YAxis tick={{ fill: C.muted, fontSize: 11 }} unit="%" />
                <Tooltip {...chartStyle} formatter={(v, n) => [`${v.toFixed(1)}%`, n]} />
                <Legend wrapperStyle={{ color: C.muted, fontSize: 12 }} />
                <Bar dataKey="Win"   stackId="a" fill={C.gold} />
                <Bar dataKey="Place" stackId="a" fill="#3a7050" />
                <Bar dataKey="Show"  stackId="a" fill="#234530" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <Th>Rank</Th><Th>#</Th><Th>Horse</Th><Th>ML</Th>
                  <Th>Win%</Th><Th>Place%</Th><Th>Show%</Th><Th>EV ($2 Win)</Th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((h, i) => (
                  <tr key={h.post} style={{ background: i % 2 === 0 ? C.row : C.rowAlt }}>
                    <Td><Rank i={i} /></Td>
                    <Td style={{ color: C.gold, fontWeight: 'bold' }}>{h.post}</Td>
                    <Td style={{ fontWeight: 'bold' }}>{h.name}</Td>
                    <Td>{h.odds}</Td>
                    <Td style={{ color: C.gold, fontWeight: 'bold' }}>{h.winPct}%</Td>
                    <Td style={{ color: '#7ab890' }}>{h.placePct}%</Td>
                    <Td style={{ color: C.muted }}>{h.showPct}%</Td>
                    <Td style={{ color: h.ev >= 0 ? '#5c8' : '#c55', fontWeight: 'bold' }}>
                      {h.ev >= 0 ? '+' : ''}{h.ev}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

// ── Tab: Bet Builder ──────────────────────────────────────────────────────────
const BET_TYPES  = ['Win', 'Place', 'Show', 'WPS', 'Exacta Box', 'Trifecta Box', 'Superfecta Box']
const MIN_H      = { Win: 1, Place: 1, Show: 1, WPS: 1, 'Exacta Box': 2, 'Trifecta Box': 3, 'Superfecta Box': 4 }
const COMBO_CALC = {
  Win: n => n, Place: n => n, Show: n => n, WPS: n => n * 3,
  'Exacta Box':    n => n * (n - 1),
  'Trifecta Box':  n => n * (n - 1) * (n - 2),
  'Superfecta Box':n => n * (n - 1) * (n - 2) * (n - 3),
}

function BetBuilderTab({ horses }) {
  const [selected, setSelected] = useState(new Set())
  const [betType,  setBetType]  = useState('Win')
  const [amount,   setAmount]   = useState(2)

  useEffect(() => { setSelected(new Set()) }, [horses])

  const toggle = post => setSelected(prev => {
    const s = new Set(prev); s.has(post) ? s.delete(post) : s.add(post); return s
  })

  const n         = selected.size
  const minH      = MIN_H[betType]
  const valid     = n >= minH
  const combos    = valid ? COMBO_CALC[betType](n) : 0
  const cost      = combos * amount
  const selHorses = horses.filter(h => selected.has(h.post))
  const winEst    = betType === 'Win' && n === 1 ? (selHorses[0].oddsNum * amount).toFixed(2) : null

  return (
    <div>
      <SectionTitle>Bet Builder</SectionTitle>
      <SectionDesc>Select horses, choose bet type, and set your base amount to calculate ticket cost.</SectionDesc>

      <div style={{ marginBottom: 18 }}>
        <FieldLabel>Bet Type</FieldLabel>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {BET_TYPES.map(t => <Pill key={t} active={betType === t} onClick={() => setBetType(t)}>{t}</Pill>)}
        </div>
      </div>

      <div style={{ marginBottom: 18 }}>
        <FieldLabel>Base Amount</FieldLabel>
        <div style={{ display: 'flex', gap: 8 }}>
          {[0.5, 1, 2, 5, 10].map(a => (
            <Pill key={a} active={amount === a} onClick={() => setAmount(a)}>${a}</Pill>
          ))}
        </div>
      </div>

      <div style={{ marginBottom: 28 }}>
        <FieldLabel>
          Select Horses
          {n > 0 && <span style={{ color: C.muted, fontWeight: 'normal' }}> — {n} selected (need {minH}+)</span>}
        </FieldLabel>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(155px, 1fr))', gap: 8 }}>
          {horses.map(h => {
            const sel = selected.has(h.post)
            return (
              <button key={h.post} onClick={() => toggle(h.post)} style={{
                background: sel ? C.gold + '22' : C.card,
                color: sel ? C.goldLt : C.text,
                border: `1px solid ${sel ? C.gold : C.border}`,
                borderRadius: 8, padding: '9px 12px',
                cursor: 'pointer', textAlign: 'left', transition: 'all 0.15s',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: C.gold, fontWeight: 'bold', fontSize: 15 }}>{h.post}</span>
                  <span style={{ color: sel ? C.goldLt : C.muted, fontSize: 12 }}>{h.odds}</span>
                </div>
                <div style={{ fontWeight: 'bold', fontSize: 12, marginTop: 2 }}>{h.name}</div>
              </button>
            )
          })}
        </div>
      </div>

      <div style={{
        background: C.card, border: `1px solid ${valid ? C.gold : C.border}`,
        borderRadius: 12, padding: 20, maxWidth: 420,
      }}>
        <div style={{ color: C.gold, fontSize: 15, fontWeight: 'bold', marginBottom: 14 }}>Ticket Summary</div>
        {!valid
          ? <p style={{ color: C.muted, fontSize: 13 }}>Select at least {minH} horse{minH > 1 ? 's' : ''} for a {betType} bet.</p>
          : (
            <>
              <SummaryRow label="Bet Type"     value={betType} />
              <SummaryRow label="Horses"       value={selHorses.map(h => `#${h.post} ${h.name}`).join(', ')} />
              <SummaryRow label="Combinations" value={combos} />
              <SummaryRow label="Base Amount"  value={`$${amount}`} />
              <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 12, marginTop: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ color: C.gold, fontWeight: 'bold' }}>Total Cost</span>
                <span style={{ color: C.goldLt, fontSize: 22, fontWeight: 'bold' }}>${cost.toFixed(2)}</span>
              </div>
              {winEst && (
                <div style={{ marginTop: 10, padding: '8px 12px', background: C.gold + '11', borderRadius: 6, border: `1px solid ${C.gold}33` }}>
                  <span style={{ color: C.muted, fontSize: 12 }}>Est. Win Return (ML): </span>
                  <span style={{ color: C.goldLt, fontWeight: 'bold' }}>${winEst}</span>
                </div>
              )}
            </>
          )}
      </div>
    </div>
  )
}

function FieldLabel({ children }) {
  return <div style={{ color: C.gold, fontSize: 11, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.07em', fontWeight: 'bold' }}>{children}</div>
}
function Pill({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      background: active ? C.gold : C.card, color: active ? '#071510' : C.text,
      border: `1px solid ${active ? C.gold : C.border}`,
      borderRadius: 6, padding: '7px 13px', fontSize: 12,
      fontWeight: active ? 'bold' : 'normal', cursor: 'pointer', transition: 'all 0.15s',
    }}>{children}</button>
  )
}
function SummaryRow({ label, value }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, gap: 12 }}>
      <span style={{ color: C.muted, fontSize: 12, flexShrink: 0 }}>{label}</span>
      <span style={{ color: C.text, fontSize: 12, textAlign: 'right', wordBreak: 'break-word' }}>{value}</span>
    </div>
  )
}

// ── App Shell ─────────────────────────────────────────────────────────────────
const TABS = ['Field Card', 'Phase 1', 'Phase 2', 'Phase 3', 'Monte Carlo', 'Bet Builder']

export default function App() {
  const [horses,   setHorses]    = useState(FALLBACK_HORSES)
  const [loading,  setLoading]   = useState(!!SHEET_CSV_URL)
  const [error,    setError]     = useState(null)
  const [usingLive, setUsingLive] = useState(false)
  const [tab,      setTab]       = useState(0)

  const fetchSheet = useCallback(() => {
    if (!SHEET_CSV_URL) return
    setLoading(true)
    setError(null)
    Papa.parse(SHEET_CSV_URL, {
      download:       true,
      header:         true,
      skipEmptyLines: true,
      complete: ({ data }) => {
        const parsed = data.map(parseRow).filter(h => h.post > 0 && h.name)
        if (parsed.length) {
          setHorses(parsed)
          setUsingLive(true)
        } else {
          setError('Sheet returned no valid rows — showing fallback data')
        }
        setLoading(false)
      },
      error: err => {
        setError(`Fetch failed: ${err.message} — showing fallback data`)
        setLoading(false)
      },
    })
  }, [])

  useEffect(() => { fetchSheet() }, [fetchSheet])

  const scored = useMemo(
    () => horses.map(h => ({ ...h, p1: calcP1(h), p2: calcP2(h), p3: calcP3(h) })),
    [horses],
  )

  const panels = [
    <FieldCard     horses={scored} />,
    <Phase1Tab     scored={scored} />,
    <Phase2Tab     scored={scored} />,
    <Phase3Tab     scored={scored} />,
    <MonteCarloTab scored={scored} />,
    <BetBuilderTab horses={horses} />,
  ]

  return (
    <div style={{ background: C.bg, minHeight: '100vh', color: C.text, fontFamily: 'Georgia, "Times New Roman", serif' }}>
      <style>{GLOBAL_CSS}</style>

      {/* Header */}
      <div style={{
        background: C.card, borderBottom: `3px solid ${C.gold}`,
        padding: '16px 24px', display: 'flex', alignItems: 'center',
        justifyContent: 'space-between', flexWrap: 'wrap', gap: 12,
      }}>
        <div>
          <div style={{ fontSize: 24, fontWeight: 'bold', color: C.gold, letterSpacing: '0.06em' }}>
            Kentucky Derby 2026
          </div>
          <div style={{ color: C.muted, fontSize: 11, marginTop: 2, letterSpacing: '0.12em', textTransform: 'uppercase' }}>
            Handicapping Dashboard &nbsp;&middot;&nbsp; Churchill Downs &nbsp;&middot;&nbsp; 1&frac14; Miles
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          {usingLive && !loading && (
            <span style={{ color: '#5ba', fontSize: 12, background: '#1a3a2a', border: `1px solid #3a6a4a`, borderRadius: 12, padding: '3px 10px' }}>
              Live Sheet
            </span>
          )}
          {!usingLive && !loading && (
            <span style={{ color: C.muted, fontSize: 12 }}>Fallback data</span>
          )}
          {error && (
            <span style={{ color: '#c66', fontSize: 11, maxWidth: 240 }}>{error}</span>
          )}
          {SHEET_CSV_URL && (
            <button onClick={fetchSheet} disabled={loading} style={{
              background: C.card, color: loading ? C.muted : C.gold,
              border: `1px solid ${loading ? C.border : C.gold}`,
              borderRadius: 6, padding: '7px 14px', fontSize: 12,
              fontWeight: 'bold', cursor: loading ? 'wait' : 'pointer',
              display: 'flex', alignItems: 'center', gap: 6,
            }}>
              {loading ? (
                <>
                  <span style={{
                    display: 'inline-block', width: 12, height: 12, borderRadius: '50%',
                    border: `2px solid ${C.border}`, borderTopColor: C.gold,
                    animation: 'derby-spin 0.7s linear infinite',
                  }} />
                  Refreshing…
                </>
              ) : '↻ Refresh'}
            </button>
          )}
        </div>
      </div>

      {/* Tab Bar */}
      <div style={{ background: C.card, borderBottom: `1px solid ${C.border}`, display: 'flex', overflowX: 'auto', padding: '0 8px' }}>
        {TABS.map((t, i) => (
          <button key={t} onClick={() => setTab(i)} style={{
            background: 'none', border: 'none',
            padding: '12px 18px', color: tab === i ? C.gold : C.muted,
            fontWeight: tab === i ? 'bold' : 'normal', cursor: 'pointer', fontSize: 13,
            borderBottom: `2px solid ${tab === i ? C.gold : 'transparent'}`,
            whiteSpace: 'nowrap', transition: 'color 0.15s',
          }}>{t}</button>
        ))}
      </div>

      {/* Content */}
      {loading
        ? <Spinner />
        : <div style={{ padding: '24px', maxWidth: 1200, margin: '0 auto' }}>{panels[tab]}</div>
      }
    </div>
  )
}
