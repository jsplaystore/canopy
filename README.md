# 🌳 Canopy — Chicago Urban Tree Dispatch

Canopy turns Chicago's live 311 tree-service data into a prioritized dispatch tool for arborist crews. It ranks all 77 community areas by a **Canopy Stress Index (CSI)**, maps where the most vulnerable communities are, and generates an AI field briefing for any neighborhood.

**Live:** https://canopy-five-alpha.vercel.app

## What it does

- **Live dispatch queue** — every Chicago community area ranked by urgency, neglect, or trend.
- **Canopy Stress Index (0–100)** — one priority score blending six signals:
  `42% service pressure · 18% community vulnerability · 15% neglect (time since last service) · 13% complaint trend · 8% unresolved rate · 4% drought`
- **Two map views** — 🌳 *Service pressure* and ⚖ *Social vulnerability* (Chicago Hardship Index), so crews aren't just sent to the loudest neighborhoods but to the most under-served ones.
- **AI field briefings** — per-zone arborist dispatch brief (Groq / Llama 3.3), factoring in drought and canopy-equity need.
- **Live canopy intelligence** — mapped trees, estimated tree age (from trunk circumference), and plant-species diversity per neighborhood.
- **Urban heat-island** comparison and 30-day drought stress.

## Data sources

All free / public — no paid APIs.

| Source | Provider | Use |
|---|---|---|
| 311 Tree Service Requests (`v6vf-nfxy`) | Chicago Open Data | Core demand signal |
| Community Area Boundaries (`igwz-8jzy`) | Chicago Open Data | Map shapes |
| Tree Trim / Debris History (`uxic-zsuj`, `mab8-y9h3`) | Chicago Open Data | Service gap, canopy-age proxy |
| Hardship Index (`kn9c-c2s2`) | Chicago Open Data (ACS) | Social-vulnerability view + CSI |
| Precipitation & Temperature | Open-Meteo | Drought + heat island |
| Mapped trees / species / age | OpenStreetMap Overpass | Live canopy intelligence |
| Plant species diversity | iNaturalist | Live canopy intelligence |
| AI briefings | Groq (`llama-3.3-70b-versatile`) | Field dispatch brief |
| Basemap | CARTO / OpenStreetMap | Map tiles |

## Run locally

```bash
# 1. Set your Groq API key (never commit this file)
echo "GROQ_API_KEY=your_key_here" > .env.local

# 2. Start the dev server (serves public/ + /api/dispatch)
node server.mjs
# → http://localhost:3002
```

## Stack

Vanilla HTML/CSS/JS + Leaflet. No build step. AI briefings run as a Vercel serverless function (`api/dispatch.js`); `server.mjs` mirrors it for local dev.

## Deploy

Deployed on Vercel. `GROQ_API_KEY` is configured as a Vercel environment variable — it is **never** committed (`.env.local` is gitignored).
