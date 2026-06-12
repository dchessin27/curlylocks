require("dotenv").config();

const express = require("express");
const https   = require("https");
const path    = require("path");
const url     = require("url");

const app        = express();
const ODDS_KEY   = process.env.ODDS_API_KEY  || "";
const CLAUDE_KEY = process.env.CLAUDE_API_KEY || "";
const PORT       = parseInt(process.env.PORT  || "3747");

app.use(express.json());

// ─── SERVE REACT BUILD IN PRODUCTION ─────────────────────────────────────────
const clientBuild = path.join(__dirname, "../client/build");
app.use(express.static(clientBuild));

// ─── MATH ─────────────────────────────────────────────────────────────────────
function toDecimal(american) {
  return american > 0 ? american / 100 + 1 : 100 / Math.abs(american) + 1;
}
function toAmerican(decimal) {
  return decimal >= 2
    ? Math.round((decimal - 1) * 100)
    : Math.round(-100 / (decimal - 1));
}
function noVigProbs(d1, d2) {
  const p1 = 1 / d1, p2 = 1 / d2, t = p1 + p2;
  return [p1 / t, p2 / t];
}
function calcEV(trueProb, decimalOdds) {
  return ((trueProb * decimalOdds) - 1) * 100;
}

// ─── HTTP HELPER ──────────────────────────────────────────────────────────────
function fetchJson(reqUrl, opts = {}) {
  return new Promise((resolve, reject) => {
    const p      = url.parse(reqUrl);
    const body   = opts.body || null;
    const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
    if (body) headers["Content-Length"] = Buffer.byteLength(body);

    const req = https.request(
      { hostname: p.hostname, path: p.path, method: opts.method || "GET", headers },
      (res) => {
        let raw = "";
        res.on("data", c => (raw += c));
        res.on("end", () => {
          try { resolve({ data: JSON.parse(raw), status: res.statusCode }); }
          catch (e) { reject(new Error(`JSON parse failed (${res.statusCode}): ${raw.slice(0, 200)}`)); }
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// ─── FETCH LIVE ODDS ──────────────────────────────────────────────────────────
const SPORTS = {
  NBA: "basketball_nba",
  MLB: "baseball_mlb",
  NHL: "icehockey_nhl",
  NFL: "americanfootball_nfl",
};

async function fetchTodaysGames() {
  const today = new Date().toISOString().slice(0, 10);
  const games = [];

  for (const [sport, key] of Object.entries(SPORTS)) {
    try {
      const apiUrl =
        `https://api.the-odds-api.com/v4/sports/${key}/odds/` +
        `?apiKey=${ODDS_KEY}&regions=us&markets=h2h` +
        `&bookmakers=pinnacle,circa_sports,draftkings,fanduel,betmgm` +
        `&oddsFormat=decimal&dateFormat=iso`;

      const { data } = await fetchJson(apiUrl);
      if (!Array.isArray(data)) continue;

      for (const game of data) {
        if (game.commence_time.slice(0, 10) !== today) continue;

        const books = {};
        for (const bm of game.bookmakers || []) {
          const h2h = (bm.markets || []).find(m => m.key === "h2h");
          if (!h2h) continue;
          const ho = h2h.outcomes.find(o => o.name === game.home_team);
          const ao = h2h.outcomes.find(o => o.name === game.away_team);
          if (ho && ao) books[bm.key] = { hD: ho.price, aD: ao.price };
        }

        const sharp = books.pinnacle || books.circa_sports;
        if (!sharp || !books.draftkings || !books.fanduel) continue;

        const [tH, tA] = noVigProbs(sharp.hD, sharp.aD);
        const dk = books.draftkings;
        const fd = books.fanduel;

        games.push({
          sport,
          home: game.home_team,
          away: game.away_team,
          time: game.commence_time,
          sharpSource: books.pinnacle ? "Pinnacle" : "Circa",
          truePctHome: (tH * 100).toFixed(1),
          truePctAway: (tA * 100).toFixed(1),
          pinnacleHome: toAmerican(sharp.hD),
          pinnacleAway: toAmerican(sharp.aD),
          dk: {
            home: toAmerican(dk.hD), away: toAmerican(dk.aD),
            homeEV: calcEV(tH, dk.hD).toFixed(1),
            awayEV: calcEV(tA, dk.aD).toFixed(1),
          },
          fd: {
            home: toAmerican(fd.hD), away: toAmerican(fd.aD),
            homeEV: calcEV(tH, fd.hD).toFixed(1),
            awayEV: calcEV(tA, fd.aD).toFixed(1),
          },
        });
      }
    } catch (e) {
      console.warn(`[odds] ${sport} failed:`, e.message);
    }
  }
  return games;
}

// ─── FETCH CLOSING LINE FOR A SPECIFIC GAME ──────────────────────────────────
async function fetchGameOdds(sport, home, away) {
  const key = SPORTS[sport];
  if (!key) return null;

  const apiUrl =
    `https://api.the-odds-api.com/v4/sports/${key}/odds/` +
    `?apiKey=${ODDS_KEY}&regions=us&markets=h2h` +
    `&bookmakers=draftkings,fanduel&oddsFormat=american&dateFormat=iso`;

  const { data } = await fetchJson(apiUrl);
  if (!Array.isArray(data)) return null;

  const game = data.find(g => g.home_team === home && g.away_team === away);
  if (!game) return null;

  const books = {};
  for (const bm of game.bookmakers || []) {
    const h2h = (bm.markets || []).find(m => m.key === "h2h");
    if (!h2h) continue;
    const ho = h2h.outcomes.find(o => o.name === game.home_team);
    const ao = h2h.outcomes.find(o => o.name === game.away_team);
    books[bm.key] = { home: ho?.price, away: ao?.price };
  }
  return { home: game.home_team, away: game.away_team, books };
}

// ─── GENERATE PICKS WITH CLAUDE ───────────────────────────────────────────────
async function generatePicks(games) {
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
  });

  if (!games.length) throw new Error("No games with valid odds found for today");

  // Sort by best single-side EV
  games.sort((a, b) => {
    const bestA = Math.max(parseFloat(a.dk.homeEV), parseFloat(a.dk.awayEV), parseFloat(a.fd.homeEV), parseFloat(a.fd.awayEV));
    const bestB = Math.max(parseFloat(b.dk.homeEV), parseFloat(b.dk.awayEV), parseFloat(b.fd.homeEV), parseFloat(b.fd.awayEV));
    return bestB - bestA;
  });

  const gameLines = games.slice(0, 15).map(g => {
    const t = new Date(g.time).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZoneName: "short" });
    return (
      `${g.sport}: ${g.away} @ ${g.home} (${t})` +
      ` | True: Away ${g.truePctAway}% Home ${g.truePctHome}%` +
      ` | Pinnacle: Away ${g.pinnacleAway} Home ${g.pinnacleHome}` +
      ` | DK: Away ${g.dk.away}(EV${g.dk.awayEV}%) Home ${g.dk.home}(EV${g.dk.homeEV}%)` +
      ` | FD: Away ${g.fd.away}(EV${g.fd.awayEV}%) Home ${g.fd.home}(EV${g.fd.homeEV}%)`
    );
  }).join("\n");

  const prompt =
    `You are the sharpest sports bettor alive. Today is ${today}.\n\n` +
    `Here are today's real games with exact EV vs ${games[0]?.sharpSource || "Pinnacle"} no-vig:\n\n` +
    `${gameLines}\n\n` +
    `Pick the 3 best bets. Use ONLY the exact odds and EV numbers from the data above.\n` +
    `Prioritise: highest positive EV, playoff/high-stakes spots, RLM signals.\n` +
    `Signal: EV (price value), STEAM (sharp syndicate action), RLM (reverse line movement), ARB (both sides +EV).\n\n` +
    `Return ONLY valid JSON, no markdown:\n` +
    `{"date":"${today}","bets":[` +
    `{"rank":1,"sport":"MLB","matchup":"Team A @ Team B","bet":"Team A ML","book":"DraftKings","odds":"+115","ev":"+4.2%","confidence":82,"reasoning":"2 sentence sharp reasoning using the real numbers above.","signal":"EV"},` +
    `{"rank":2,"sport":"NBA","matchup":"Team C @ Team D","bet":"Team C ML","book":"FanDuel","odds":"-108","ev":"+2.9%","confidence":77,"reasoning":"Sharp reasoning.","signal":"RLM"},` +
    `{"rank":3,"sport":"MLB","matchup":"Team E @ Team F","bet":"Team E ML","book":"DraftKings","odds":"+108","ev":"+3.1%","confidence":74,"reasoning":"Sharp reasoning.","signal":"STEAM"}]}`;

  const { data } = await fetchJson("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": CLAUDE_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (data.error) throw new Error("Claude: " + data.error.message);
  const tb = (data.content || []).find(b => b.type === "text");
  if (!tb) throw new Error("No text in Claude response");

  const raw = tb.text.trim();
  const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
  if (s === -1 || e === -1) throw new Error("No JSON in response: " + raw.slice(0, 100));

  const parsed = JSON.parse(raw.slice(s, e + 1));
  if (!parsed.bets?.length) throw new Error("No bets in response");
  return parsed;
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    oddsKey: !!ODDS_KEY,
    claudeKey: !!CLAUDE_KEY,
    time: new Date().toISOString(),
  });
});

app.get("/api/picks", async (req, res) => {
  if (!ODDS_KEY)   return res.status(500).json({ error: "ODDS_API_KEY not set. Add it to .env or Railway environment variables." });
  if (!CLAUDE_KEY) return res.status(500).json({ error: "CLAUDE_API_KEY not set. Add it to .env or Railway environment variables." });

  try {
    console.log("[picks] Fetching live odds...");
    const games = await fetchTodaysGames();
    console.log(`[picks] ${games.length} games found`);
    if (!games.length) return res.status(404).json({ error: "No games with full odds today. Lines may not be posted yet — try again later." });
    const picks = await generatePicks(games);
    console.log("[picks] ✓ Done");
    res.json(picks);
  } catch (e) {
    console.error("[picks] Error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/closing-line", async (req, res) => {
  if (!ODDS_KEY) return res.status(500).json({ error: "ODDS_API_KEY not set." });

  const { sport, home, away } = req.query;
  if (!sport || !home || !away) return res.status(400).json({ error: "Missing sport, home, or away." });

  try {
    const result = await fetchGameOdds(sport, home, away);
    if (!result) return res.status(404).json({ error: "Game not found — it may not have posted odds yet, or has already finished." });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Catch-all — serve React app
app.get("*", (req, res) => {
  const index = path.join(clientBuild, "index.html");
  if (require("fs").existsSync(index)) {
    res.sendFile(index);
  } else {
    res.send(`<h2>Run <code>npm run build</code> first, or use <code>npm run dev</code> for local development.</h2>`);
  }
});

app.listen(PORT, () => {
  console.log("\n╔══════════════════════════════════════════╗");
  console.log("║      🔒  CURLY LOCKS                     ║");
  console.log("╠══════════════════════════════════════════╣");
  console.log(`║  http://localhost:${PORT}                    ║`);
  console.log(`║  Odds API : ${ODDS_KEY   ? "✓ connected" : "✗ missing (add to .env)"}          ║`);
  console.log(`║  Claude   : ${CLAUDE_KEY ? "✓ connected" : "✗ missing (add to .env)"}          ║`);
  console.log("╚══════════════════════════════════════════╝\n");
});
