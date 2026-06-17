const https = require("https");
const url   = require("url");

const { computeEdges } = require("./edges");

function fetchJson(reqUrl) {
  return new Promise((resolve, reject) => {
    const p = url.parse(reqUrl);
    const req = https.request({ hostname: p.hostname, path: p.path, method: "GET" }, (res) => {
      let raw = "";
      res.on("data", c => (raw += c));
      res.on("end", () => {
        try { resolve({ data: JSON.parse(raw), status: res.statusCode }); }
        catch (e) { reject(new Error(`JSON parse failed (${res.statusCode}): ${raw.slice(0, 200)}`)); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function toDecimal(american) {
  return american > 0 ? american / 100 + 1 : 100 / Math.abs(american) + 1;
}

// Converts a local ET date + whole hour to a UTC ISO timestamp for the
// historical odds API's ?date= param. Assumes EDT (UTC-4), which is correct
// for all currently active sports (MLB/NHL/MMA/World Cup, Mar–Nov).
function isoForDayET(dateStr, hourET) {
  const utcHour = (hourET + 4) % 24;
  return `${dateStr}T${String(utcHour).padStart(2, "0")}:00:00Z`;
}

async function fetchHistoricalSnapshot(sportKey, isoTimestamp, oddsKey) {
  const apiUrl =
    `https://api.the-odds-api.com/v4/historical/sports/${sportKey}/odds/` +
    `?apiKey=${oddsKey}&regions=us&markets=h2h,spreads,totals` +
    `&bookmakers=pinnacle,circa_sports,draftkings,fanduel,betmgm` +
    `&oddsFormat=american&dateFormat=iso&date=${encodeURIComponent(isoTimestamp)}`;

  // Historical endpoint returns { timestamp, previous_timestamp, next_timestamp, data: [...] }
  // rather than a raw array like the live /odds endpoint.
  const { data: wrapper } = await fetchJson(apiUrl);
  if (!Array.isArray(wrapper?.data)) return [];
  return wrapper.data;
}

// Look up the closing price for a specific edge in a close-snapshot game object.
function lookupClosePrice(edge, closeGame) {
  const marketKey = edge.market === "ml" ? "h2h" : edge.market === "spread" ? "spreads" : "totals";
  const bm = (closeGame.bookmakers || []).find(b => b.key === edge.book);
  if (!bm) return null;
  const m = (bm.markets || []).find(mm => mm.key === marketKey);
  if (!m) return null;

  if (edge.market === "total") {
    const o = m.outcomes.find(o => o.name === (edge.side === "over" ? "Over" : "Under"));
    return o?.price ?? null;
  }
  const name = edge.side === "home" ? closeGame.home_team : closeGame.away_team;
  const o = m.outcomes.find(o => o.name === name);
  return o?.price ?? null;
}

function aggStats(clvValues) {
  if (!clvValues.length) return { n: 0, avgCLV: "N/A", beatPct: "N/A" };
  const avg     = clvValues.reduce((a, b) => a + b, 0) / clvValues.length;
  const beatPct = (clvValues.filter(x => x > 0).length / clvValues.length) * 100;
  return { n: clvValues.length, avgCLV: avg.toFixed(2), beatPct: beatPct.toFixed(0) };
}

function aggregateResults(results, sport, days) {
  const byTag      = { CONSENSUS: [], SPLIT: [], CONFLUENCE: [], none: [] };
  const byMarket   = { ml: [], spread: [], total: [] };
  const byEVBucket = { "0-2%": [], "2-5%": [], "5%+": [] };
  const byTrueProb = { "<40%": [], "40-55%": [], "55%+": [] };
  const all        = [];

  for (const r of results) {
    all.push(r.clv);

    // An edge can be both CONSENSUS and CONFLUENCE — it counts in both groups.
    const tagged = r.consensus === true || r.consensus === false || !!r.confluence;
    if (r.consensus === true)  byTag.CONSENSUS.push(r.clv);
    if (r.consensus === false) byTag.SPLIT.push(r.clv);
    if (r.confluence)          byTag.CONFLUENCE.push(r.clv);
    if (!tagged)               byTag.none.push(r.clv);

    if (byMarket[r.market]) byMarket[r.market].push(r.clv);

    const evAbs = Math.abs(r.ev);
    if (evAbs < 2)      byEVBucket["0-2%"].push(r.clv);
    else if (evAbs < 5) byEVBucket["2-5%"].push(r.clv);
    else                byEVBucket["5%+"].push(r.clv);

    const tp = r.trueProb * 100;
    if (tp < 40)      byTrueProb["<40%"].push(r.clv);
    else if (tp < 55) byTrueProb["40-55%"].push(r.clv);
    else              byTrueProb["55%+"].push(r.clv);
  }

  return {
    sport,
    days,
    creditCost: days * 2 * 30,
    note: "byTag groups overlap — an edge tagged CONSENSUS+CONFLUENCE appears in both",
    overall:    aggStats(all),
    byTag:      Object.fromEntries(Object.entries(byTag).map(([k, v])      => [k, aggStats(v)])),
    byMarket:   Object.fromEntries(Object.entries(byMarket).map(([k, v])   => [k, aggStats(v)])),
    byEVBucket: Object.fromEntries(Object.entries(byEVBucket).map(([k, v]) => [k, aggStats(v)])),
    byTrueProb: Object.fromEntries(Object.entries(byTrueProb).map(([k, v]) => [k, aggStats(v)])),
  };
}

async function runBacktest({ oddsKey, sportKey, sport, days, pickHourET = 11, closeHourET = 18 }) {
  const allResults = [];
  const errs = [];

  for (let i = 1; i <= days; i++) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    const dateStr = d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });

    const pickISO  = isoForDayET(dateStr, pickHourET);
    const closeISO = isoForDayET(dateStr, closeHourET);
    const closeMs  = new Date(closeISO).getTime();

    try {
      const pickData = await fetchHistoricalSnapshot(sportKey, pickISO, oddsKey);
      if (!pickData.length) continue;

      const pickGames = computeEdges(pickData, sport, {
        today: dateStr,
        nowMs: new Date(pickISO).getTime(),
      });
      if (!pickGames.length) continue;

      const closeData = await fetchHistoricalSnapshot(sportKey, closeISO, oddsKey);
      const closeById = Object.fromEntries((closeData || []).map(g => [g.id, g]));

      for (const game of pickGames) {
        // Skip games that had already started by the close snapshot — their
        // "closing" price would be live/in-play, not a valid pregame line.
        if (new Date(game.time).getTime() <= closeMs) continue;

        const closeGame = closeById[game.id];
        if (!closeGame) continue;

        for (const edge of game.edges) {
          const closePrice = lookupClosePrice(edge, closeGame);
          if (closePrice === null) continue;

          const clv = (toDecimal(edge.price) / toDecimal(closePrice) - 1) * 100;
          allResults.push({
            clv,
            market:    edge.market,
            ev:        edge.ev,
            trueProb:  edge.trueProb,
            consensus: edge.consensus,
            confluence: edge.confluence,
          });
        }
      }
    } catch (e) {
      errs.push(`${dateStr}: ${e.message}`);
      console.warn(`[backtest] ${dateStr} failed:`, e.message);
    }
  }

  const report = aggregateResults(allResults, sport, days);
  if (errs.length) report.errors = errs;
  return report;
}

module.exports = { runBacktest };
