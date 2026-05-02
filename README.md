# Kentucky Derby 2026 Handicapping App

A React + Vite single-page handicapping dashboard for the 2026 Kentucky Derby.

## Features

- **Field Card** — Full 20-horse field with trainer, jockey, sire, running style, and tier
- **Phase 1** — Speed figure and class-tier analysis with ranked bar chart
- **Phase 2** — Pace aptitude and post-position multiplier breakdown
- **Phase 3** — Final composite ratings combining speed, pace, and post
- **Monte Carlo** — 10,000-race simulation with Win/Place/Show% and EV on $2 win bets
- **Bet Builder** — Build Win, Exacta, Trifecta, Superfecta box tickets with cost calculator

## Data Source

Horse data is fetched live from a published Google Sheet on every load. The sheet is configurable via `SHEET_CSV_URL` in `src/App.jsx`. Falls back to hardcoded data if the fetch fails.

### Sheet column headers (row 1)

```
post, name, odds, oddsNum, trainer, jockey, sire, tier, style, lastRace, figure, postMult
```

## Tech Stack

- React 19 + Vite
- Recharts (bar charts)
- Papa Parse (Google Sheets CSV fetch)

## Getting Started

```bash
npm install
npm run dev
```
