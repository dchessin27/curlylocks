require("dotenv").config();

const express = require("express");
const https   = require("https");
const fs      = require("fs");
const path    = require("path");
const url     = require("url");

const { computeEdges } = require("./edges");
const { runBacktest  } = require("./backtest");

const app        = express();
const ODDS_KEY   = process.env.ODDS_API_KEY  || "";
const CLAUDE_KEY = process.env.CLAUDE_API_KEY || "";
const PORT       = parseInt(process.env.PORT  || "3747");
const TG_TOKEN   = process.env.TELEGRAM_BOT_TOKEN || "";
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID   || "";

// Set DATA_DIR to a mounted Railway volume (e.g. /data) for picks to
// survive redeploys. Defaults to a local folder for plain restarts.
const DATA_DIR   = process.env.DATA_DIR || path.join(__dirname, "data");
const PICKS_FILE = path.join(DATA_DIR, "picks-cache.json");

app.use(express.json());

// ─── SERVE REACT BUILD IN PRODUCTION ─────────────────────────────────────────
const clientBuild = path.join(__dirname, "../client/build");
app.use(express.static(clientBuild));

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
// Each sport here costs one Odds API request per picks attempt. Off-season
// leagues are commented out — re-add when their seasons start
// (NBA ~October, NFL/NCAAF ~August, NCAAB ~November).
// WORLDCUP covers the 2026 FIFA World Cup — remove after ~July 19.
// MMA (UFC etc.) runs year-round.
const SPORTS = {
  MLB:      "baseball_mlb",
  NHL:      "icehockey_nhl",
  MMA:      "mma_mixed_martial_arts",
  WORLDCUP: "soccer_fifa_world_cup",
  // NBA:   "basketball_nba",
};

async function fetchTodaysGames() {
  // Compare against the ET "betting day" (matches todayLabel()), not the UTC
  // date — otherwise evening US games (8pm ET+ = already the next UTC day)
  // get excluded from "today's" pool entirely.
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const games = [];

  for (const [sport, key] of Object.entries(SPORTS)) {
    try {
      const apiUrl =
        `https://api.the-odds-api.com/v4/sports/${key}/odds/` +
        `?apiKey=${ODDS_KEY}&regions=us&markets=h2h,spreads,totals` +
        `&bookmakers=pinnacle,circa_sports,draftkings,fanduel,betmgm` +
        `&oddsFormat=american&dateFormat=iso`;

      const { data } = await fetchJson(apiUrl);
      if (!Array.isArray(data)) continue;
      games.push(...computeEdges(data, sport, { today, nowMs: Date.now() }));
    } catch (e) {
      console.warn(`[odds] ${sport} failed:`, e.message);
    }
  }
  return games;
}

// ─── FETCH CLOSING LINE FOR A SPECIFIC GAME ──────────────────────────────────
async function fetchGameOdds(sport, home, away, betType) {
  const key = SPORTS[sport];
  if (!key) return null;

  const marketKey = betType === "spread" ? "spreads" : betType === "total" ? "totals" : "h2h";

  const apiUrl =
    `https://api.the-odds-api.com/v4/sports/${key}/odds/` +
    `?apiKey=${ODDS_KEY}&regions=us&markets=${marketKey}` +
    `&bookmakers=draftkings,fanduel&oddsFormat=american&dateFormat=iso`;

  const { data } = await fetchJson(apiUrl);
  if (!Array.isArray(data)) return null;

  const game = data.find(g => g.home_team === home && g.away_team === away);
  if (!game) return null;

  // Once a game has started, /odds can return live in-play prices instead
  // of the closing line — e.g. a trailing team's ML ballooning to +880.
  // That's not a meaningful comparison to a pregame bet, so treat it as
  // unavailable rather than recording a misleading CLV.
  if (new Date(game.commence_time).getTime() <= Date.now()) return null;

  const books = {};
  for (const bm of game.bookmakers || []) {
    const m = (bm.markets || []).find(mm => mm.key === marketKey);
    if (!m) continue;

    if (marketKey === "totals") {
      const over  = m.outcomes.find(o => o.name === "Over");
      const under = m.outcomes.find(o => o.name === "Under");
      books[bm.key] = { over: over?.price, under: under?.price, point: over?.point ?? null };
    } else {
      const ho = m.outcomes.find(o => o.name === game.home_team);
      const ao = m.outcomes.find(o => o.name === game.away_team);
      books[bm.key] = {
        home: ho?.price, away: ao?.price,
        homePoint: ho?.point ?? null, awayPoint: ao?.point ?? null,
      };
    }
  }
  return { home: game.home_team, away: game.away_team, market: marketKey, books };
}

// ─── FETCH COMPLETED SCORES FOR AUTO-SETTLING PICKS ──────────────────────────
async function fetchSportScores(sport) {
  const key = SPORTS[sport];
  if (!key) return [];

  const apiUrl =
    `https://api.the-odds-api.com/v4/sports/${key}/scores/` +
    `?apiKey=${ODDS_KEY}&daysFrom=3&dateFormat=iso`;

  const { data } = await fetchJson(apiUrl);
  if (!Array.isArray(data)) return [];

  return data
    .filter(g => g.completed && Array.isArray(g.scores))
    .map(g => {
      const hs = g.scores.find(s => s.name === g.home_team);
      const as = g.scores.find(s => s.name === g.away_team);
      return {
        home: g.home_team,
        away: g.away_team,
        homeScore: Number(hs?.score),
        awayScore: Number(as?.score),
      };
    })
    .filter(g => Number.isFinite(g.homeScore) && Number.isFinite(g.awayScore));
}

// ─── PICKS CACHE (SURVIVES RESTARTS) ─────────────────────────────────────────
function loadCachedPicks() {
  try {
    return JSON.parse(fs.readFileSync(PICKS_FILE, "utf8"));
  } catch {
    return null;
  }
}
function saveCachedPicks(picks) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(PICKS_FILE, JSON.stringify(picks));
  } catch (e) {
    console.warn("[cache] failed to save picks:", e.message);
  }
}

// ─── DATE HELPER ──────────────────────────────────────────────────────────────
// US sports books treat the "game day" as the Eastern-time calendar day. Pin
// the picks-lock boundary to that timezone regardless of where the server
// runs (Railway defaults to UTC, which would roll over to "tomorrow" at
// 8pm ET and trigger an early regeneration mid-evening for US users).
function todayLabel() {
  return new Date().toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
    timeZone: "America/New_York",
  });
}

// ─── GENERATE PICKS WITH CLAUDE ───────────────────────────────────────────────
async function generatePicks(games) {
  const today = todayLabel();

  if (!games.length) throw new Error("No games with valid odds found for today");

  // Sort by best edge found anywhere in the game (ML, spread, or total)
  games.sort((a, b) => {
    const bestA = Math.max(...a.edges.map(e => e.ev));
    const bestB = Math.max(...b.edges.map(e => e.ev));
    return bestB - bestA;
  });

  const sideName  = (g, e) => e.market === "total" ? (e.side === "over" ? "Over" : "Under") : (e.side === "home" ? g.home : g.away);
  const betLabel  = (g, e) => {
    const name = sideName(g, e);
    if (e.market === "ml")     return `${name} ML`;
    if (e.market === "spread") return `${name} ${e.point > 0 ? "+" : ""}${e.point}`;
    return `${name} ${e.point}`;
  };

  const gameLines = games.slice(0, 20).map(g => {
    const t = new Date(g.time).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZoneName: "short" });
    const edgeLines = g.edges
      .map(e => {
        const tags = [];
        if (e.consensus === true)  tags.push("CONSENSUS");
        if (e.consensus === false) tags.push("SPLIT");
        if (e.confluence)          tags.push("CONFLUENCE");
        const tagStr = tags.length ? `, ${tags.join("+")}` : "";
        return `${betLabel(g, e)} ${e.price > 0 ? "+" : ""}${e.price} (${e.book}, true ${(e.trueProb * 100).toFixed(0)}%, EV ${e.ev >= 0 ? "+" : ""}${e.ev.toFixed(1)}%, vs ${e.sharpSource}${tagStr})`;
      })
      .join(" | ");
    return `${g.sport}: ${g.away} @ ${g.home} (${t}) — ${edgeLines}`;
  }).join("\n");

  const prompt =
    `You are the sharpest sports bettor alive. Today is ${today}.\n\n` +
    `Here are today's real games across every tracked sport/league. For each game, the moneyline, spread, and total are listed ` +
    `with the best-priced book for each side and that side's exact EV vs the blended sharp no-vig line (Pinnacle and/or Circa):\n\n` +
    `${gameLines}\n\n` +
    `Pick ONLY bets that represent a real, sharp edge — positive EV vs the sharp no-vig line above, ideally +2% EV or better. ` +
    `Moneyline, spread, and total bets are all fair game — pick whichever market shows the strongest genuine edge for a given game.\n` +
    `Return AT MOST 3 bets total, ranked best first, ONE PICK PER GAME — never return the same matchup twice, even at a different book or in a different market. ` +
    `If only 1 or 2 games today clear the bar, return only those — do NOT pad the list with mediocre or break-even bets just to reach 3. ` +
    `If genuinely nothing clears the bar, return an empty "bets" array.\n` +
    `These picks are locked in for the entire day and tracked for real money, so be selective and consistent — ` +
    `use ONLY the exact odds, points, and EV numbers from the data above.\n` +
    `Some edges carry tags computed directly from the data, in parentheses after the EV: ` +
    `CONSENSUS means Pinnacle and Circa INDEPENDENTLY both price this side as +EV (not just on average) — weight these higher. ` +
    `SPLIT means the two sharp books disagree on direction — treat this EV with caution even if it looks positive. ` +
    `CONFLUENCE means the moneyline AND spread both favor the same team — two independent markets agreeing the soft book is underpricing them, a strong signal.\n` +
    `Each edge also shows "true X%" — the blended sharp probability that side actually wins/covers/hits. ` +
    `American odds are convex, so the SAME probability misestimate produces a much bigger EV% on a plus-money longshot than on a favorite — raw EV% alone is biased toward longshots. ` +
    `Your job is not just to find +EV, it's to pick winners: prefer sides with true probability of roughly 45% or higher when they clear the EV bar. ` +
    `Only take a longshot (true probability well under 40%) if its EV is clearly exceptional (+5%+) and ideally tagged CONSENSUS or CONFLUENCE — don't fill the card with plus-money underdogs just because their EV% looks biggest. ` +
    `A card of modest favorites/near-coinflips that are genuinely +EV and likely to hit beats a card of technically-profitable longshots that lose most of the time.\n` +
    `Prioritise: a balance of positive EV and true win probability, CONSENSUS and CONFLUENCE tags, playoff/high-stakes spots. Be skeptical of SPLIT edges and of longshots with true probability well under 40%.\n` +
    `Signal: EV (price value), CONSENSUS (sharp books independently agree), CONFLUENCE (moneyline+spread agree).\n\n` +
    `For each bet set "betType" to "ml", "spread", or "total". Set "side" to "home"/"away" for ml and spread bets, or "over"/"under" for total bets. ` +
    `Set "line" to the spread/total number shown above (e.g. -4.5, 218.5), or null for ml. ` +
    `Set "bet" to a short human label matching the format above, e.g. "Lakers +4.5", "Over 218.5", "Celtics ML".\n\n` +
    `Return ONLY valid JSON, no markdown, no comments. The "bets" array should contain only as many entries (0-3) as genuinely clear the bar — example shows the shape for 3, trim it down if fewer qualify:\n` +
    `{"date":"${today}","bets":[` +
    `{"rank":1,"sport":"NBA","matchup":"Team A @ Team B","betType":"spread","side":"away","line":4.5,"bet":"Team A +4.5","book":"DraftKings","odds":"+105","ev":"+3.2%","confidence":78,"reasoning":"2 sentence sharp reasoning using the real numbers above.","signal":"EV"},` +
    `{"rank":2,"sport":"MLB","matchup":"Team C @ Team D","betType":"ml","side":"home","line":null,"bet":"Team D ML","book":"FanDuel","odds":"-108","ev":"+2.9%","confidence":77,"reasoning":"Sharp reasoning.","signal":"CONSENSUS"},` +
    `{"rank":3,"sport":"NHL","matchup":"Team E @ Team F","betType":"total","side":"under","line":5.5,"bet":"Under 5.5","book":"DraftKings","odds":"-105","ev":"+3.1%","confidence":74,"reasoning":"Sharp reasoning.","signal":"CONFLUENCE"}]}`;

  const { data } = await fetchJson("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": CLAUDE_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      temperature: 0,
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
  if (!Array.isArray(parsed.bets)) throw new Error("No bets array in response");

  // Attach each game's real start time so we can schedule pre-game alerts
  for (const bet of parsed.bets) {
    const game = games.find(g => `${g.away} @ ${g.home}` === bet.matchup);
    if (game) bet.commenceTime = game.time;
  }
  return parsed;
}

// ─── TELEGRAM ALERTS ──────────────────────────────────────────────────────────
async function sendTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  try {
    await fetchJson(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: "Markdown" }),
    });
  } catch (e) {
    console.warn("[telegram] send failed:", e.message);
  }
}

let latestPicks = loadCachedPicks(); // most recently generated picks, with commenceTime per bet
const alertedBets = new Set();       // keys of bets we've already alerted on, "date|matchup|bet"

// While today's picks haven't been generated yet, avoid re-hitting the Odds
// API on every page load/"try again" click — retry at most once per cooldown window.
const PICKS_RETRY_COOLDOWN_MS = 10 * 60 * 1000;
let lastAttemptAt = 0;
let lastAttemptError = null;

// ─── AUTOMATIC CLOSING-LINE CAPTURE ───────────────────────────────────────────
function extractClosingPrice(bet, result) {
  const bk = result.books?.[(bet.book || "").toLowerCase()];
  if (!bk) return null;
  if (bet.betType === "total") return bet.side === "under" ? bk.under : bk.over;
  return bet.side === "home" ? bk.home : bk.away;
}

async function captureClosingLine(bet) {
  try {
    const [away, home] = (bet.matchup || "").split("@").map(s => s.trim());
    const result = await fetchGameOdds(bet.sport, home, away, bet.betType || "ml");
    if (!result) return;
    const price = extractClosingPrice(bet, result);
    if (price === undefined || price === null) return;
    bet.closingLine = price;
    saveCachedPicks(latestPicks);
  } catch (e) {
    console.warn("[clv] capture failed:", e.message);
  }
}

setInterval(() => {
  if (!latestPicks?.bets?.length) return;
  const now = Date.now();
  for (const bet of latestPicks.bets) {
    if (!bet.commenceTime) continue;
    const key = `${latestPicks.date}|${bet.matchup}|${bet.bet}`;
    if (alertedBets.has(key)) continue;

    const msUntil = new Date(bet.commenceTime).getTime() - now;
    if (msUntil <= 10 * 60 * 1000 && msUntil > 9 * 60 * 1000) {
      alertedBets.add(key);
      captureClosingLine(bet);
      sendTelegram(
        `⏰ *${bet.matchup}* starts in ~10 min\n` +
        `🔒 ${bet.bet} @ ${bet.book} ${bet.odds} (${bet.signal}, ${bet.ev} EV)\n` +
        `Closing line captured automatically for CLV tracking.`
      );
    }
  }
}, 60 * 1000);

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

  // Picks are locked in once per day — reloading should not produce new/different bets.
  if (req.query.refresh !== "true" && latestPicks?.date === todayLabel()) {
    return res.json(latestPicks);
  }

  // Today's picks aren't ready yet. If we just tried and failed, don't retry
  // (and re-spend Odds API quota) on every reload until the cooldown passes.
  const sinceLastAttempt = Date.now() - lastAttemptAt;
  if (req.query.refresh !== "true" && lastAttemptAt && sinceLastAttempt < PICKS_RETRY_COOLDOWN_MS) {
    const retryMin = Math.ceil((PICKS_RETRY_COOLDOWN_MS - sinceLastAttempt) / 60000);
    return res.status(503).json({ error: `${lastAttemptError} (next check in ~${retryMin} min)` });
  }

  lastAttemptAt = Date.now();
  try {
    console.log("[picks] Fetching live odds...");
    const games = await fetchTodaysGames();
    console.log(`[picks] ${games.length} games found`);
    if (!games.length) {
      lastAttemptError = "No games with full odds today. Lines may not be posted yet — try again later.";
      return res.status(404).json({ error: lastAttemptError });
    }
    const picks = await generatePicks(games);
    console.log("[picks] ✓ Done");
    latestPicks = picks;
    lastAttemptError = null;
    saveCachedPicks(picks);
    res.json(picks);
  } catch (e) {
    console.error("[picks] Error:", e.message);
    lastAttemptError = e.message;
    res.status(500).json({ error: e.message });
  }
});

// Wipe today's locked picks (cache + disk) so the next /api/picks call
// generates a fresh set. Used by the "reset" button in Settings.
app.post("/api/reset", (req, res) => {
  latestPicks = null;
  alertedBets.clear();
  lastAttemptAt = 0;
  lastAttemptError = null;
  try { fs.unlinkSync(PICKS_FILE); } catch {}
  res.json({ ok: true });
});

app.get("/api/closing-line", async (req, res) => {
  if (!ODDS_KEY) return res.status(500).json({ error: "ODDS_API_KEY not set." });

  const { sport, home, away, betType } = req.query;
  if (!sport || !home || !away) return res.status(400).json({ error: "Missing sport, home, or away." });

  try {
    const result = await fetchGameOdds(sport, home, away, betType);
    if (!result) return res.status(404).json({ error: "Closing line not available — odds may not be posted yet, or the game has already started/finished." });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/results", async (req, res) => {
  if (!ODDS_KEY) return res.status(500).json({ error: "ODDS_API_KEY not set." });

  const { sport } = req.query;
  if (!sport) return res.status(400).json({ error: "Missing sport." });

  try {
    const games = await fetchSportScores(sport);
    res.json({ games });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Run a CLV backtest against historical odds. Each run costs 2 snapshots ×
// 30 credits per sport (h2h+spreads+totals, us region). Default: 14 days
// ≈ 840 credits. Hard-capped at 30 days (~1,800 credits) per run.
// Example: /api/backtest?sport=MLB&days=14
app.get("/api/backtest", async (req, res) => {
  if (!ODDS_KEY) return res.status(500).json({ error: "ODDS_API_KEY not set." });

  const sport    = (req.query.sport || "").toUpperCase();
  const sportKey = SPORTS[sport];
  if (!sportKey) {
    return res.status(400).json({ error: `Unknown sport. Valid options: ${Object.keys(SPORTS).join(", ")}` });
  }

  const days = Math.min(Math.max(parseInt(req.query.days || "14") || 14, 1), 30);
  console.log(`[backtest] ${sport} × ${days} days (~${days * 2 * 30} credits)`);

  try {
    const report = await runBacktest({ oddsKey: ODDS_KEY, sportKey, sport, days });
    res.json(report);
  } catch (e) {
    console.error("[backtest] Error:", e.message);
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
