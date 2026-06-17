# Curly Locks — Claude Code Instructions

Daily sharp sports betting picks using real odds from The Odds API + Claude AI analysis.

## Project Structure

```
curly-locks/
├── server/
│   ├── index.js         # Express server — routes, picks cache, alerts, line poller
│   ├── edges.js         # EV engine — vig stripping, true prob, CONSENSUS/CONFLUENCE tags
│   ├── lines.js         # Liability tracker — REVERSE_LINE, FROZEN_LINE, SHARP_SOFT_GAP
│   └── backtest.js      # CLV backtest against historical snapshots
├── client/
│   ├── src/
│   │   ├── App.js       # Full React app — bets, record tracker, CLV, settings
│   │   └── index.js     # Entry point
│   ├── public/
│   │   └── index.html
│   └── package.json
├── PICKS_METHODOLOGY.md  # Full picks pipeline documentation — read before editing picks logic
├── package.json          # Root — runs server, builds client
├── railway.json          # Deploy config
└── .env.example          # API key template
```

## Local Development

```bash
# Terminal 1 — start server (serves /api/picks)
npm install
cp .env.example .env
# edit .env with your API keys
npm run dev

# Terminal 2 — start React dev server with hot reload
cd client
npm install
npm start
# opens http://localhost:3000 (proxies /api to :3747)
```

## Environment Variables

| Key | Where to get it |
|-----|-----------------|
| `ODDS_API_KEY` | https://the-odds-api.com (free tier = 500 req/month) |
| `CLAUDE_API_KEY` | https://console.anthropic.com |

## Deploy to Railway

1. Push this folder to a GitHub repo
2. Go to railway.app → New Project → Deploy from GitHub
3. Select the repo
4. Go to Variables → add `ODDS_API_KEY` and `CLAUDE_API_KEY`
5. Railway auto-deploys — gives you a public URL

## How the picks work

Full methodology: see `PICKS_METHODOLOGY.md` in the project root — read this before making any changes to the picks pipeline.

Short version:
1. `server/index.js` calls The Odds API for today's MLB/NHL/MMA/WORLDCUP games
2. `server/edges.js` strips vig from Pinnacle+Circa to find true probability, computes EV% vs DraftKings/FanDuel
3. `server/lines.js` compares current Pinnacle lines to opening lines → REVERSE_LINE, FROZEN_LINE, SHARP_SOFT_GAP signals
4. Today's handicapper reference picks (from Settings) are injected as context
5. Claude (claude-sonnet-4-6) selects 0–3 bets from the pre-computed EV data — it never invents odds

## Key files to edit

- **Add a sport**: `SPORTS` object in `server/index.js`
- **Change Claude model**: `model:` field in `generatePicks()` 
- **Tweak the prompt**: `prompt` string in `generatePicks()`
- **UI changes**: `client/src/App.js`
- **Add CLV tracking**: add `closingLine` field to record entries in `addToRecord()`

## Common tasks for Claude Code

- "Add closing line value tracking to the record"
- "Add a props tab for player props from The Odds API"  
- "Make the app a PWA so it installs on mobile"
- "Add email alerts when picks are generated"
- "Add a chart showing ROI over time in the model score tab"
