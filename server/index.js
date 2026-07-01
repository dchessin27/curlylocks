require("dotenv").config();

const express = require("express");
const https   = require("https");
const fs      = require("fs");
const path    = require("path");
const url     = require("url");

const { computeEdges }                = require("./edges");
const { runBacktest  }                = require("./backtest");
const { computeLiability, liabilityStr } = require("./lines");

const app        = express();
const ODDS_KEY   = process.env.ODDS_API_KEY  || "";
const CLAUDE_KEY = process.env.CLAUDE_API_KEY || "";
const PORT       = parseInt(process.env.PORT  || "3747");
const TG_TOKEN   = process.env.TELEGRAM_BOT_TOKEN || "";
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID   || "";

// Set DATA_DIR to a mounted Railway volume (e.g. /data) for picks to
// survive redeploys. Defaults to a local folder for plain restarts.
const DATA_DIR   = process.env.DATA_DIR || path.join(__dirname, "data");
const PICKS_FILE   = path.join(DATA_DIR, "picks-cache.json");
const HISTORY_FILE = path.join(DATA_DIR, "picks-history.json");
const LINES_FILE   = path.join(DATA_DIR, "line-history.json");
const CAPPER_FILE  = path.join(DATA_DIR, "capper-history.json");

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
  const today   = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const games   = [];
  const rawAll  = []; // collect raw API data for liability computation

  for (const [sport, key] of Object.entries(SPORTS)) {
    try {
      const apiUrl =
        `https://api.the-odds-api.com/v4/sports/${key}/odds/` +
        `?apiKey=${ODDS_KEY}&regions=us&markets=h2h,spreads,totals` +
        `&bookmakers=pinnacle,circa_sports,draftkings,fanduel,betmgm` +
        `&oddsFormat=american&dateFormat=iso`;

      const { data } = await fetchJson(apiUrl);
      if (!Array.isArray(data)) continue;
      rawAll.push(...data);
      games.push(...computeEdges(data, sport, { today, nowMs: Date.now() }));
    } catch (e) {
      console.warn(`[odds] ${sport} failed:`, e.message);
    }
  }

  // Track lines for ALL upcoming games across every sport — not just today's.
  // This means a Sunday NFL game picked up on Tuesday already has 5 days of
  // movement history by game day, making frozen/reverse signals much stronger.
  const liabilityMap = computeLiability(LINES_FILE, rawAll);
  for (const g of games) {
    const sigs = liabilityMap[g.id];
    if (sigs && sigs.length) g.liability = sigs;
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

function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8")); }
  catch { return []; }
}

function appendToHistory(picks) {
  try {
    const history    = loadHistory();
    const existingIdx = history.findIndex(h => h.date === picks.date);
    const prevBets   = existingIdx >= 0 ? history[existingIdx].bets : [];
    const entry = {
      date:        picks.date,
      generatedAt: new Date().toISOString(),
      bets: (picks.bets || []).map(b => {
        const [away, home] = (b.matchup || "").split("@").map(s => s.trim());
        const prev = prevBets.find(e => e.bet === b.bet);
        return {
          sport:        b.sport,
          matchup:      b.matchup,
          bet:          b.bet,
          book:         b.book,
          odds:         b.odds,
          ev:           b.ev,
          confidence:   b.confidence   ?? null,
          signal:       b.signal,
          betType:      b.betType      ?? "ml",
          side:         b.side         ?? null,
          line:         b.line         ?? null,
          home:         home           ?? null,
          away:         away           ?? null,
          commenceTime: b.commenceTime ?? null,
          closingLine:  prev?.closingLine ?? b.closingLine ?? null,
          result:       prev?.result      ?? "pending",
        };
      }),
    };
    if (existingIdx >= 0) history[existingIdx] = entry;
    else history.push(entry);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history));
  } catch (e) { console.warn("[history] append failed:", e.message); }
}

function updateHistoryClosingLine(date, betLabel, closingLine) {
  try {
    const history = loadHistory();
    const day = history.find(h => h.date === date);
    if (!day) return;
    const bet = day.bets.find(b => b.bet === betLabel);
    if (!bet || bet.closingLine !== null) return;
    bet.closingLine = closingLine;
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history));
  } catch (e) { console.warn("[history] update closing line failed:", e.message); }
}

// ─── HANDICAPPER REFERENCE PICKS ──────────────────────────────────────────────
// Stores raw daily picks text submitted by the user via /api/capper POST.
// These are fed to Claude as market context (not tracked for W/L).
function loadCapperHistory() {
  try { return JSON.parse(fs.readFileSync(CAPPER_FILE, "utf8")); }
  catch { return []; }
}
function saveCapperHistory(history) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CAPPER_FILE, JSON.stringify(history));
  } catch (e) { console.warn("[capper] save failed:", e.message); }
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
    const liab = liabilityStr(g.liability);
    return `${g.sport}: ${g.away} @ ${g.home} (${t}) — ${liab}${edgeLines}`;
  }).join("\n");

  const prompt =
    `You are the sharpest sports bettor alive. Today is ${today}.\n\n` +
    `Here are today's real games across every tracked sport/league. For each game, the moneyline, spread, and total are listed ` +
    `with the best-priced book for each side and that side's exact EV vs the blended sharp no-vig line (Pinnacle and/or Circa):\n\n` +
    `${gameLines}\n\n` +
    `YOUR JOB: Return the 3 BEST plays from today's card. Always return exactly 3 bets — ONE PICK PER GAME, never the same matchup twice. ` +
    `Only return fewer than 3 if today literally has fewer than 3 unstarted games with valid odds. Do NOT return an empty array. Every day has a card.\n` +
    `Moneyline, spread, and total bets are all in play — pick whichever market gives the strongest case for each game.\n\n` +
    `HARD FLOORS (the ONLY non-negotiable rules — everything else is ranking preference):\n` +
    `1. True probability must be 50% or higher — never pick a side the sharp books think is the underdog.\n` +
    `2. EV must be no worse than -5% — do not take a clearly bad price.\n\n` +
    `RANKING ORDER — use these to choose WHICH 3 picks to make and in what order (these are preferences, not gates):\n` +
    `Tier 1 — CAPPER_ALIGNED: handicapper reference matches a line here (see CAPPER_ALIGNED path below) + 50%+ true prob + EV ≥ -5%. These are first priority.\n` +
    `Tier 2 — Liability + positive EV: game shows a REVERSE LINE, FROZEN LINE, or SHARP/SOFT GAP signal AND the edge is positive EV vs the sharp line. Strongest mathematical + money-flow confirmation.\n` +
    `Tier 3 — CONSENSUS or CONFLUENCE + positive EV: both sharp books agree (+EV on its own), or ML and spread both favor same team at a soft book.\n` +
    `Tier 4 — Best available: pick the remaining games with the highest true probability and least-negative EV to complete the card. SPLIT edges or mildly negative EV (down to -5%) are acceptable here if nothing better is available — the goal is a full card every day.\n` +
    `Within each tier, rank by true probability first, then EV size.\n\n` +
    `SIGNAL DEFINITIONS:\n` +
    `CONSENSUS — Pinnacle and Circa INDEPENDENTLY both price this side as +EV (not just on average) — stronger than blended average alone. ` +
    `SPLIT — the two sharp books disagree on direction — treat EV with caution. ` +
    `CONFLUENCE — moneyline AND spread both favor the same team — two independent markets agreeing, strong signal.\n\n` +
    `LIABILITY SIGNALS (appear as [LIABILITY: ...] prefix on each game):\n` +
    `REVERSE LINE — spread moved toward the underdog since opening despite public money on the favourite. Classic sharp-money tell: books adjusting to liability, not public action.\n` +
    `FROZEN LINE — game is within 5 hours, Pinnacle has not moved the line at all. Book stands firm — they like their number.\n` +
    `SHARP/SOFT GAP — Pinnacle and DraftKings/FanDuel have different spread numbers right now. Sharp book moved; public book hasn't caught up — bet the side getting extra points at the soft book.\n` +
    `When REVERSE LINE + FROZEN LINE + SHARP/SOFT GAP all appear: highest-confidence scenario — set liability:true.\n\n` +
    `CAPPER_ALIGNED path: if the MARKET REFERENCE section below contains a handicapper pick matching an exact line in the data above (same team/total, same direction), that pick is Tier 1 priority as long as true probability ≥ 50% AND EV ≥ -5%. ` +
    `The handicapper supplies the "who wins" judgment; our math is just a price sanity check. Tag these picks "signal":"CAPPER_ALIGNED".\n\n` +
    `SYSTEMATIC-LAG WARNING: if 2+ top picks share the same book AND same market type (e.g. all run-line edges on FanDuel), that likely indicates a morning pricing lag, not independent edges. Pick at most 1 from that book+market combo and find variety elsewhere.\n\n` +
    `Use ONLY the exact odds, points, and EV numbers from the data above.\n` +
    `Set "betType" to "ml", "spread", or "total". Set "side" to "home"/"away" for ml/spread, or "over"/"under" for totals. ` +
    `Set "line" to the spread/total number (e.g. -1.5, 8.5), or null for ml. ` +
    `Set "bet" to a short human label, e.g. "Cubs ML", "Under 8.5", "Padres +1.5". ` +
    `Set "signal" to: CONSENSUS, CONFLUENCE, SPLIT, EV, CAPPER_ALIGNED, or LIABILITY (use the strongest tag present). ` +
    `Set "liability" to true only when REVERSE LINE and/or FROZEN LINE signals are present.\n\n` +
    `Return ONLY valid JSON, no markdown, no comments:\n` +
    `{"date":"${today}","bets":[` +
    `{"rank":1,"sport":"NFL","matchup":"Team A @ Team B","betType":"spread","side":"away","line":6.5,"bet":"Team B +6.5","book":"DraftKings","odds":"+105","ev":"+3.2%","confidence":84,"reasoning":"REVERSE LINE + FROZEN LINE confirm sharp money on the dog. Book needs the favourite.","signal":"LIABILITY","liability":true},` +
    `{"rank":2,"sport":"MLB","matchup":"Team C @ Team D","betType":"ml","side":"home","line":null,"bet":"Team D ML","book":"FanDuel","odds":"-130","ev":"-1.8%","confidence":68,"reasoning":"CAPPER_ALIGNED: handicapper has Team D ML, true probability 56% clears the floor, EV is mild (-1.8%) not catastrophic.","signal":"CAPPER_ALIGNED","liability":false},` +
    `{"rank":3,"sport":"NHL","matchup":"Team E @ Team F","betType":"total","side":"under","line":5.5,"bet":"Under 5.5","book":"DraftKings","odds":"-105","ev":"+3.1%","confidence":74,"reasoning":"Best available: CONFLUENCE tag with positive EV, 55% true probability.","signal":"CONFLUENCE","liability":false}]}`;

  // Include today's handicapper reference picks as market context if available.
  const capperHistory = loadCapperHistory();
  const todayCapper   = capperHistory.find(h => h.date === today);
  let fullPrompt = prompt;
  if (todayCapper) {
    fullPrompt +=
      `\n\nMARKET REFERENCE — A sharp handicapper service has issued these plays for today. ` +
      `Use them as additional market intelligence: they represent another experienced view of today's value. ` +
      `When they align with a pick already justified by the EV data above, that corroboration strengthens the signal — note it in your reasoning. ` +
      `These reference picks are also eligible for the CAPPER_ALIGNED qualifying path defined earlier: match each reference pick to its exact line in the game data above (same team/total, same direction), then check it against that path's requirements (true probability >= 50%, EV no worse than -5%). ` +
      `If a reference pick conflicts with your EV analysis or fails those requirements, note the discrepancy and do NOT include it — only take it if it actually clears the CAPPER_ALIGNED bar, do not pick a game solely because it appears here otherwise.\n` +
      `Reference picks:\n${todayCapper.picks}`;
  }

  const { data } = await fetchJson("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": CLAUDE_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      temperature: 0,
      messages: [{ role: "user", content: fullPrompt }],
    }),
  });

  if (data.error) throw new Error("Claude: " + data.error.message);
  if (data.stop_reason === "max_tokens") throw new Error("Claude response was truncated (hit max_tokens) — raise the limit in generatePicks().");
  const tb = (data.content || []).find(b => b.type === "text");
  if (!tb) throw new Error("No text in Claude response");

  const raw = tb.text.trim();
  const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
  if (s === -1 || e === -1) throw new Error("No JSON in response: " + raw.slice(0, 100));

  let parsed;
  try {
    parsed = JSON.parse(raw.slice(s, e + 1));
  } catch (err) {
    throw new Error(`Malformed JSON from Claude (possibly truncated): ${err.message}`);
  }
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
    if (latestPicks?.date) updateHistoryClosingLine(latestPicks.date, bet.bet, price);
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
app.get("/health", async (req, res) => {
  const result = {
    status: "ok",
    oddsKey: !!ODDS_KEY,
    claudeKey: !!CLAUDE_KEY,
    time: new Date().toISOString(),
  };

  // When ?verify=1, make a live call to the Odds API sports list to confirm
  // the key is valid and show the plan's remaining credits.
  if (req.query.verify === "1" && ODDS_KEY) {
    try {
      const { data, status } = await fetchJson(
        `https://api.the-odds-api.com/v4/sports/?apiKey=${ODDS_KEY}`
      );
      if (Array.isArray(data)) {
        result.oddsKeyValid = true;
        result.oddsApiSportsCount = data.length;
      } else {
        result.oddsKeyValid = false;
        result.oddsApiError = data;
      }
    } catch (e) {
      result.oddsKeyValid = false;
      result.oddsApiError = e.message;
    }
  }

  res.json(result);
});

app.get("/api/picks", async (req, res) => {
  if (!ODDS_KEY)   return res.status(500).json({ error: "ODDS_API_KEY not set. Add it to .env or Railway environment variables." });
  if (!CLAUDE_KEY) return res.status(500).json({ error: "CLAUDE_API_KEY not set. Add it to .env or Railway environment variables." });

  // Picks are locked in once per day — reloading should not produce new/different bets.
  if (req.query.refresh !== "true" && latestPicks?.date === todayLabel()) {
    appendToHistory(latestPicks); // ensure picks are in the server record even on cache hits
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
    appendToHistory(picks);
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

// Returns the full picks history (all days with closing lines for CLV analysis).
app.get("/api/history", (req, res) => {
  res.json(loadHistory());
});

// Bet label alone isn't always unique within a day (e.g. two different
// games can both produce an "Under 8" pick) — disambiguate with matchup
// when there's more than one candidate and a matchup was provided.
function findPick(day, bet, matchup) {
  const candidates = day.bets.filter(b => b.bet === bet);
  if (candidates.length <= 1) return candidates[0];
  return (matchup && candidates.find(b => b.matchup === matchup)) || candidates[0];
}

// Update a pick's result or closing line in the server-side record.
app.patch("/api/record", (req, res) => {
  const { date, bet, matchup, result, closingLine } = req.body;
  if (!date || !bet) return res.status(400).json({ error: "date and bet required" });
  if (result !== undefined && !["win","loss","push","pending"].includes(result))
    return res.status(400).json({ error: "invalid result value" });
  try {
    const history = loadHistory();
    const day  = history.find(h => h.date === date);
    if (!day)  return res.status(404).json({ error: "Date not found" });
    const pick = findPick(day, bet, matchup);
    if (!pick) return res.status(404).json({ error: "Pick not found" });
    if (result      !== undefined) pick.result      = result;
    if (closingLine !== undefined) pick.closingLine = closingLine;
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Remove a pick from the server-side record.
app.delete("/api/record", (req, res) => {
  const { date, bet, matchup } = req.query;
  if (!date || !bet) return res.status(400).json({ error: "date and bet required" });
  try {
    const history = loadHistory();
    const day = history.find(h => h.date === date);
    if (!day) return res.status(404).json({ error: "Date not found" });
    const pick = findPick(day, bet, matchup);
    if (!pick) return res.status(404).json({ error: "Pick not found" });
    day.bets = day.bets.filter(b => b !== pick);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Single historical snapshot probe — fast, just 1 API call (~30 credits).
// Returns the raw snapshot so you can verify bookmaker availability.
// Example: /api/backtest-probe?sport=MLB&date=2026-06-15
app.get("/api/backtest-probe", async (req, res) => {
  if (!ODDS_KEY) return res.status(500).json({ error: "ODDS_API_KEY not set." });

  const sport    = (req.query.sport || "MLB").toUpperCase();
  const sportKey = SPORTS[sport];
  if (!sportKey) return res.status(400).json({ error: `Unknown sport. Options: ${Object.keys(SPORTS).join(", ")}` });

  const dateStr = req.query.date || (() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  })();

  const hourET = parseInt(req.query.hour || "11");
  const utcHour = (hourET + 4) % 24;
  const isoTimestamp = `${dateStr}T${String(utcHour).padStart(2, "0")}:00:00Z`;

  const apiUrl =
    `https://api.the-odds-api.com/v4/historical/sports/${sportKey}/odds/` +
    `?apiKey=${ODDS_KEY}&regions=us&markets=h2h,spreads,totals` +
    `&bookmakers=pinnacle,circa_sports,draftkings,fanduel,betmgm` +
    `&oddsFormat=american&dateFormat=iso&date=${encodeURIComponent(isoTimestamp)}`;

  try {
    const { data: wrapper, status } = await fetchJson(apiUrl);
    if (!Array.isArray(wrapper?.data)) {
      return res.json({ error: `API HTTP ${status}`, raw: wrapper });
    }
    const games = wrapper.data;
    const summary = games.map(g => ({
      id: g.id,
      home: g.home_team,
      away: g.away_team,
      commence_time: g.commence_time,
      books: (g.bookmakers || []).map(b => b.key),
    }));
    res.json({
      sport, dateStr, isoTimestamp,
      snapshotTimestamp: wrapper.timestamp,
      gameCount: games.length,
      games: summary,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Store / retrieve handicapper reference picks.
// POST { picks: "ROCKIES CUBS OVER 10\nCARDINALS ML..." } — saved as today's entry.
// GET returns the full history array for optional inspection.
app.post("/api/capper", (req, res) => {
  const picks = (req.body?.picks || "").trim();
  if (!picks) return res.status(400).json({ error: "No picks provided" });

  const today   = todayLabel();
  const history = loadCapperHistory();
  const idx     = history.findIndex(h => h.date === today);
  const entry   = { date: today, picks, submittedAt: new Date().toISOString() };
  if (idx >= 0) history[idx] = entry;
  else history.push(entry);
  saveCapperHistory(history);

  console.log(`[capper] ${history.length > 1 && idx >= 0 ? "updated" : "saved"} ${today} (${picks.split("\n").length} picks)`);
  res.json({ ok: true, date: today, count: picks.split("\n").filter(Boolean).length });
});

app.get("/api/capper", (req, res) => {
  res.json(loadCapperHistory());
});

// Debug: shows exactly what the Odds API returns per sport and why games fail.
// Hit this to diagnose "no games" errors: /api/debug
app.get("/api/debug", async (req, res) => {
  if (!ODDS_KEY) return res.status(500).json({ error: "ODDS_API_KEY not set" });

  const today  = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const nowMs  = Date.now();
  const report = { today, nowUtc: new Date().toISOString(), sports: {} };

  for (const [sport, key] of Object.entries(SPORTS)) {
    try {
      const apiUrl =
        `https://api.the-odds-api.com/v4/sports/${key}/odds/` +
        `?apiKey=${ODDS_KEY}&regions=us&markets=h2h,spreads,totals` +
        `&bookmakers=pinnacle,circa_sports,draftkings,fanduel&oddsFormat=american&dateFormat=iso`;
      const { data } = await fetchJson(apiUrl);
      if (!Array.isArray(data)) { report.sports[sport] = { error: "non-array response", raw: data }; continue; }

      const games = data.map(g => {
        const started   = new Date(g.commence_time).getTime() <= nowMs;
        const wrongDay  = g.commence_time.slice(0, 10) !== today;
        const books     = (g.bookmakers || []).map(b => b.key);
        const hasSharp  = books.some(b => ["pinnacle","circa_sports"].includes(b));
        const hasSoft   = books.some(b => ["draftkings","fanduel"].includes(b));
        const edges     = computeEdges([g], sport, { today, nowMs });
        const spreadsByBook = {};
        for (const bm of g.bookmakers || []) {
          const m = (bm.markets || []).find(mm => mm.key === "spreads");
          if (!m) continue;
          const ho = m.outcomes.find(o => o.name === g.home_team);
          const ao = m.outcomes.find(o => o.name === g.away_team);
          spreadsByBook[bm.key] = { home: { point: ho?.point, price: ho?.price }, away: { point: ao?.point, price: ao?.price } };
        }
        return {
          matchup: `${g.away_team} @ ${g.home_team}`,
          time: g.commence_time,
          started, wrongDay,
          books,
          hasSharp, hasSoft,
          edgesFound: edges.length > 0 ? edges[0].edges.length : 0,
          edgeDetails: edges.length > 0 ? edges[0].edges.map(e => ({
            market: e.market, side: e.side, book: e.book, price: e.price, point: e.point,
            trueProb: +(e.trueProb * 100).toFixed(1), ev: +e.ev.toFixed(2),
            consensus: e.consensus, confluence: !!e.confluence,
          })) : [],
          skip: started ? "started" : wrongDay ? "wrong-day" : !hasSharp ? "no-sharp-book" : !hasSoft ? "no-soft-book" : null,
          spreadsByBook,
        };
      });

      report.sports[sport] = {
        total: games.length,
        eligible: games.filter(g => !g.skip && g.edgesFound > 0).length,
        games,
      };
    } catch (e) {
      report.sports[sport] = { error: e.message };
    }
  }

  res.json(report);
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

// ─── BACKGROUND LINE POLLER ───────────────────────────────────────────────────
// Polls every sport every 2 hours — h2h + spreads only (lighter call) — purely
// to keep line-history.json current so reverse/frozen/gap signals have a full
// day of movement history by the time picks are generated.
// Cost: ~2 markets × N sports = ~8 credits/poll, ~2,880 credits/month.
async function pollAllLines() {
  if (!ODDS_KEY) return;
  const rawAll = [];
  for (const [sport, key] of Object.entries(SPORTS)) {
    try {
      const { data } = await fetchJson(
        `https://api.the-odds-api.com/v4/sports/${key}/odds/` +
        `?apiKey=${ODDS_KEY}&regions=us&markets=h2h,spreads` +
        `&bookmakers=pinnacle,draftkings,fanduel&oddsFormat=american&dateFormat=iso`
      );
      if (Array.isArray(data)) rawAll.push(...data);
    } catch (e) {
      console.warn(`[lines] poll ${sport} failed:`, e.message);
    }
  }
  if (rawAll.length) {
    computeLiability(LINES_FILE, rawAll);
    console.log(`[lines] polled ${rawAll.length} games across ${Object.keys(SPORTS).length} sports`);
  }
}

app.listen(PORT, () => {
  console.log("\n╔══════════════════════════════════════════╗");
  console.log("║      🔒  CURLY LOCKS                     ║");
  console.log("╠══════════════════════════════════════════╣");
  console.log(`║  http://localhost:${PORT}                    ║`);
  console.log(`║  Odds API : ${ODDS_KEY   ? "✓ connected" : "✗ missing (add to .env)"}          ║`);
  console.log(`║  Claude   : ${CLAUDE_KEY ? "✓ connected" : "✗ missing (add to .env)"}          ║`);
  console.log("╚══════════════════════════════════════════╝\n");

  // Warm up line history immediately, then refresh every 8 hours (3x/day).
  // 2-hour polling was burning through Odds API credits too fast (~12 polls/day
  // × 4 sports ≈ 600+ credits/day). 8-hour interval still captures opening,
  // midday, and pre-game line snapshots for liability signals.
  pollAllLines();
  setInterval(pollAllLines, 8 * 60 * 60 * 1000);
});
