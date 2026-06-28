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
    `Pick ONLY bets that represent a real, sharp edge — positive EV vs the sharp no-vig line above, and REQUIRE +3% EV or better, UNLESS the pick instead qualifies via the CAPPER_ALIGNED path defined below (which has its own, looser bar). ` +
    `Moneyline, spread, and total bets are all fair game — pick whichever market shows the strongest genuine edge for a given game.\n` +
    `Return AT MOST 3 bets total, ONE PICK PER GAME — never return the same matchup twice, even at a different book or in a different market. ` +
    `RANKING — rank picks by true win probability and liability conviction FIRST, EV% size SECOND. EV is a qualifying gate (must clear +3%), not what determines which pick is best: a 58% true-probability pick with a liability signal ranks ABOVE a 51% true-probability pick with bigger EV%, even though the bigger-EV pick is "more profitable per dollar" in theory. The goal is winning the individual plays, not just being correct in expectation across many bets.\n` +
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
    `Your job is not just to find +EV, it's to pick winners: REQUIRE true probability of roughly 50% or higher — this is a hard floor, not a preference. ` +
    `Only take a longshot (true probability under 50%) if its EV is clearly exceptional (+6%+) AND it carries BOTH a CONSENSUS-or-CONFLUENCE tag AND a liability signal — all of that together, not just one. Otherwise skip it, regardless of how big the raw EV% looks. ` +
    `A card of modest favorites/near-coinflips that are genuinely +EV and likely to hit beats a card of technically-profitable longshots that lose most of the time. The target hit rate is 60%+ — 1-2 elite picks beat 3 mediocre ones every time, so when in doubt, return fewer.\n` +
    `HARD REQUIREMENT — every pick must carry at least one corroborating signal beyond raw EV: a CONSENSUS or CONFLUENCE tag, or a liability signal (REVERSE LINE / FROZEN LINE / SHARP/SOFT GAP). ` +
    `A "naked" edge with no tag and no liability signal does NOT qualify, no matter how large its EV% appears — raw EV alone is not sufficient confirmation, it must be corroborated by at least one independent signal. ` +
    `Liability signals are the STRONGER form of corroboration — they reflect actual money movement and book exposure, real independent evidence the side is likely to win, not just a price gap. CONSENSUS/CONFLUENCE are weaker — they're our own pricing model agreeing with itself across markets (moneyline and spread can both be off in the same direction for the same underlying reason), not truly independent confirmation. When choosing between two otherwise-qualifying picks, prefer the one with a liability signal even if its EV is smaller.\n` +
    `ALTERNATIVE QUALIFYING PATH — CAPPER_ALIGNED: if the MARKET REFERENCE section below (when present) contains a handicapper pick on the EXACT same side as one of the bets in the data above (same team/total and same direction — e.g. their "Pirates ML" matches a "Pittsburgh Pirates" moneyline line here), that bet can qualify WITHOUT needing +3% EV or a CONSENSUS/CONFLUENCE/liability tag, as long as: true probability is roughly 50% or higher (same hard floor as everywhere else), AND its EV is not worse than -5% (i.e. not a catastrophic price — it can be mildly negative by our no-vig math). ` +
    `This path exists because the handicapper is a real skilled outside predictor — their pick supplies the "who wins" judgment, and our math here is just a sanity check that the price isn't bad, not a requirement that the price itself be favorable. ` +
    `Tag any pick taken through this path with "signal":"CAPPER_ALIGNED" (not CONSENSUS/CONFLUENCE) so it can be tracked separately. Still respect ONE PICK PER GAME and the 3-bet maximum; a CAPPER_ALIGNED pick fills a slot like any other.\n` +
    `IMPORTANT — systematic-lag warning: if 2 or more of your top candidate picks share the same book AND the same market type (e.g. all run-line/spread edges on FanDuel, or all ML edges on DraftKings), that is a strong indicator of a systematic morning pricing lag at that book rather than independent real edges. ` +
    `In that scenario: select at most 1 pick from that book+market combination (the one with the strongest liability signals), actively look for a pick from a different market or book to ensure variety, and note the lag in your reasoning. ` +
    `Three picks all with identical structure (same book, same market, near-identical EV) is almost never legitimate — be suspicious.\n` +
    `Prioritise in this order: (1) true win probability and liability signals, (2) CONSENSUS/CONFLUENCE tags, (3) EV% size, with playoff/high-stakes spots as a tiebreaker. Be skeptical of SPLIT edges and of longshots with true probability under 50%.\n` +
    `Signal: EV (price value), CONSENSUS (sharp books independently agree), CONFLUENCE (moneyline+spread agree).\n\n` +
    `Some games show a [LIABILITY: ...] prefix with one or more of these signals computed directly from line-movement data:\n` +
    `REVERSE LINE — the spread moved toward the underdog since opening despite public money piling on the favourite. ` +
    `This is the classic sharp-money tell: the book is adjusting to liability, not public action. ` +
    `"Where's the liability? Who do the books need?" — when the line goes the wrong way, the answer is clear.\n` +
    `FROZEN LINE — the game is within 5 hours and Pinnacle has not moved the line at all. ` +
    `The book is standing firm. They like their side and don't need to hedge.\n` +
    `SHARP/SOFT GAP — Pinnacle and DraftKings/FanDuel have different spread numbers. ` +
    `The sharp book has already moved; the public book hasn't caught up. ` +
    `The side with the better number at the soft book is getting a gift — bet them there.\n` +
    `When REVERSE LINE + FROZEN LINE + SHARP/SOFT GAP all appear on the same game, that is the highest-confidence scenario — ` +
    `the books need the underdog, sharp money is confirming it, and the public book is still offering the wrong number. ` +
    `Set liability: true for those picks. A liability spot should rank ahead of a plain +EV pick of similar size.\n\n` +
    `For each bet set "betType" to "ml", "spread", or "total". Set "side" to "home"/"away" for ml and spread bets, or "over"/"under" for total bets. ` +
    `Set "line" to the spread/total number shown above (e.g. -4.5, 218.5), or null for ml. ` +
    `Set "bet" to a short human label matching the format above, e.g. "Lakers +4.5", "Over 218.5", "Celtics ML".\n` +
    `Set "liability" to true only when the game shows REVERSE LINE and/or FROZEN LINE signals — otherwise false.\n\n` +
    `Return ONLY valid JSON, no markdown, no comments. The "bets" array should contain only as many entries (0-3) as genuinely clear the bar — example shows the shape for 3, trim it down if fewer qualify:\n` +
    `{"date":"${today}","bets":[` +
    `{"rank":1,"sport":"NFL","matchup":"Team A @ Team B","betType":"spread","side":"away","line":6.5,"bet":"Team B +6.5","book":"DraftKings","odds":"+105","ev":"+3.2%","confidence":84,"reasoning":"REVERSE LINE + FROZEN LINE confirm sharp money on the dog. Book needs the favourite.","signal":"CONSENSUS","liability":true},` +
    `{"rank":2,"sport":"MLB","matchup":"Team C @ Team D","betType":"ml","side":"home","line":null,"bet":"Team D ML","book":"FanDuel","odds":"-130","ev":"-1.8%","confidence":68,"reasoning":"CAPPER_ALIGNED: handicapper has Team D ML, true probability 56% clears the floor, EV is mild (-1.8%) not catastrophic.","signal":"CAPPER_ALIGNED","liability":false},` +
    `{"rank":3,"sport":"NHL","matchup":"Team E @ Team F","betType":"total","side":"under","line":5.5,"bet":"Under 5.5","book":"DraftKings","odds":"-105","ev":"+3.1%","confidence":74,"reasoning":"Sharp reasoning.","signal":"CONFLUENCE","liability":false}]}`;

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
