// ─── EDGE DETECTION ───────────────────────────────────────────────────────────
// computeEdges() is the single source of truth for no-vig EV and tag logic.
// Both fetchTodaysGames() (live) and runBacktest() (historical) call it so
// the backtest validates the exact same heuristics used in production.

function toDecimal(american) {
  return american > 0 ? american / 100 + 1 : 100 / Math.abs(american) + 1;
}
function noVigProbs(d1, d2) {
  const p1 = 1 / d1, p2 = 1 / d2, t = p1 + p2;
  return [p1 / t, p2 / t];
}
function calcEV(trueProb, decimalOdds) {
  return ((trueProb * decimalOdds) - 1) * 100;
}

const SHARP_BOOKS = ["pinnacle", "circa_sports"];
const SOFT_BOOKS  = ["draftkings", "fanduel"];

// Average no-vig probabilities across whichever sharp books posted this
// market, so one stale/missing sharp line doesn't skew the "true" number.
function blendedTrueProbs(decA, decB) {
  const pairs = decA.map((a, i) => noVigProbs(a, decB[i]));
  const pa = pairs.reduce((s, [x]) => s + x, 0) / pairs.length;
  const pb = pairs.reduce((s, [, y]) => s + y, 0) / pairs.length;
  const t = pa + pb;
  return [pa / t, pb / t];
}

// True if every individual sharp book's own no-vig probability agrees in
// direction (positive vs. negative EV) with the blended consensus — i.e.
// this edge isn't just one stale/outlier sharp line dragging the average.
// Returns null when there's only one sharp book to check against.
function sharpAgreement(perBookProbs, sideIdx, price, blendedEv) {
  if (perBookProbs.length < 2) return null;
  const blendedPositive = blendedEv > 0;
  return perBookProbs.every(p => (calcEV(p[sideIdx], toDecimal(price)) > 0) === blendedPositive);
}

/**
 * Compute all edges for one sport's raw Odds API data array.
 *
 * @param {object[]} data   - raw array from live /odds or historical /odds .data
 * @param {string}   sport  - e.g. "MLB" — included verbatim in each returned game
 * @param {object}   opts
 * @param {string}   opts.today  - "YYYY-MM-DD" — skip games not on this date
 * @param {number}   opts.nowMs  - ms timestamp; games already started are skipped
 * @returns {object[]} games with { id, sport, home, away, time, edges }
 */
function computeEdges(data, sport, { today, nowMs }) {
  const games = [];

  for (const game of data) {
    if (game.commence_time.slice(0, 10) !== today) continue;

    // Once a game starts, /odds can return live in-play prices instead of
    // pregame lines — a team trailing big can show a wildly inflated ML
    // (e.g. +1400) that looks like a massive "mispricing" vs. a sharp
    // book's live line but is really just live variance, not a pregame
    // edge. Skip started games so picks are only built from pregame odds.
    if (new Date(game.commence_time).getTime() <= nowMs) continue;

    const h2h = {}, spreads = {}, totals = {};
    for (const bm of game.bookmakers || []) {
      for (const m of bm.markets || []) {
        if (m.key === "h2h") {
          // Skip 3-way moneylines (soccer's home/draw/away) — the no-vig
          // math below assumes a binary market, and folding in a draw
          // would inflate both true-probability numbers.
          if (m.outcomes.length !== 2) continue;
          const ho = m.outcomes.find(o => o.name === game.home_team);
          const ao = m.outcomes.find(o => o.name === game.away_team);
          if (ho && ao) h2h[bm.key] = { home: ho.price, away: ao.price };
        } else if (m.key === "spreads") {
          const ho = m.outcomes.find(o => o.name === game.home_team);
          const ao = m.outcomes.find(o => o.name === game.away_team);
          if (ho && ao) spreads[bm.key] = {
            home: { point: ho.point, price: ho.price },
            away: { point: ao.point, price: ao.price },
          };
        } else if (m.key === "totals") {
          const over  = m.outcomes.find(o => o.name === "Over");
          const under = m.outcomes.find(o => o.name === "Under");
          if (over && under) totals[bm.key] = {
            over:  { point: over.point,  price: over.price },
            under: { point: under.point, price: under.price },
          };
        }
      }
    }

    const sharpsFor = market => SHARP_BOOKS.filter(b => market[b]);
    const edges = [];

    // ── Moneyline ──
    let sharps = sharpsFor(h2h);
    if (sharps.length && (h2h.draftkings || h2h.fanduel)) {
      const perBook = sharps.map(b => noVigProbs(toDecimal(h2h[b].home), toDecimal(h2h[b].away)));
      const [tH, tA] = blendedTrueProbs(
        sharps.map(b => toDecimal(h2h[b].home)),
        sharps.map(b => toDecimal(h2h[b].away)),
      );
      for (const [side, trueProb, idx] of [["home", tH, 0], ["away", tA, 1]]) {
        let best = null;
        for (const book of SOFT_BOOKS) {
          const o = h2h[book]?.[side];
          if (o === undefined) continue;
          const ev = calcEV(trueProb, toDecimal(o));
          if (!best || ev > best.ev) best = { book, price: o, point: null, ev };
        }
        if (best) edges.push({ market: "ml", side, sharpSource: sharps.join("+"), consensus: sharpAgreement(perBook, idx, best.price, best.ev), trueProb, ...best });
      }
    }

    // ── Spread ──
    // Guard: a sharp book's true probability for "home at point X" is only
    // comparable to a soft book's price if the soft book is offering that
    // SAME point. Books occasionally disagree on which side is even the
    // favorite (e.g. a near-50/50 game) — Pinnacle might have the home team
    // -1.5 while a soft book has the away team -1.5. Matching by team name
    // alone in that case silently compares two different bets (e.g. "Cubs
    // +1.5" sharp probability applied to a "Cubs -1.5" soft price), producing
    // a huge fake EV. Require all sharp books to agree on both points, and
    // only accept a soft quote at the exact matching point.
    sharps = sharpsFor(spreads);
    if (sharps.length && (spreads.draftkings || spreads.fanduel)) {
      const sharpPoint = { home: spreads[sharps[0]].home.point, away: spreads[sharps[0]].away.point };
      const sharpsAgreeOnPoints = sharps.every(b => spreads[b].home.point === sharpPoint.home && spreads[b].away.point === sharpPoint.away);
      if (sharpsAgreeOnPoints) {
        const perBook = sharps.map(b => noVigProbs(toDecimal(spreads[b].home.price), toDecimal(spreads[b].away.price)));
        const [tH, tA] = blendedTrueProbs(
          sharps.map(b => toDecimal(spreads[b].home.price)),
          sharps.map(b => toDecimal(spreads[b].away.price)),
        );
        for (const [side, trueProb, idx] of [["home", tH, 0], ["away", tA, 1]]) {
          let best = null;
          for (const book of SOFT_BOOKS) {
            const o = spreads[book]?.[side];
            if (!o || o.point !== sharpPoint[side]) continue;
            const ev = calcEV(trueProb, toDecimal(o.price));
            if (!best || ev > best.ev) best = { book, price: o.price, point: o.point, ev };
          }
          if (best) edges.push({ market: "spread", side, sharpSource: sharps.join("+"), consensus: sharpAgreement(perBook, idx, best.price, best.ev), trueProb, ...best });
        }
      }
    }

    // ── Total ──
    // Same point-matching guard as spreads — a soft book's total line (e.g.
    // 8 vs 8.5) must match the sharp consensus's line before comparing.
    sharps = sharpsFor(totals);
    if (sharps.length && (totals.draftkings || totals.fanduel)) {
      const sharpPoint = { over: totals[sharps[0]].over.point, under: totals[sharps[0]].under.point };
      const sharpsAgreeOnPoints = sharps.every(b => totals[b].over.point === sharpPoint.over && totals[b].under.point === sharpPoint.under);
      if (sharpsAgreeOnPoints) {
        const perBook = sharps.map(b => noVigProbs(toDecimal(totals[b].over.price), toDecimal(totals[b].under.price)));
        const [tO, tU] = blendedTrueProbs(
          sharps.map(b => toDecimal(totals[b].over.price)),
          sharps.map(b => toDecimal(totals[b].under.price)),
        );
        for (const [side, trueProb, idx] of [["over", tO, 0], ["under", tU, 1]]) {
          let best = null;
          for (const book of SOFT_BOOKS) {
            const o = totals[book]?.[side];
            if (!o || o.point !== sharpPoint[side]) continue;
            const ev = calcEV(trueProb, toDecimal(o.price));
            if (!best || ev > best.ev) best = { book, price: o.price, point: o.point, ev };
          }
          if (best) edges.push({ market: "total", side, sharpSource: sharps.join("+"), consensus: sharpAgreement(perBook, idx, best.price, best.ev), trueProb, ...best });
        }
      }
    }

    if (!edges.length) continue;

    // Confluence: moneyline AND spread both show a real edge on the
    // same team — two independent markets agreeing the soft book is
    // underpricing them, which is a stronger signal than either alone.
    const mlEdge     = edges.find(e => e.market === "ml"     && e.ev > 0);
    const spreadEdge = edges.find(e => e.market === "spread" && e.ev > 0);
    if (mlEdge && spreadEdge && mlEdge.side === spreadEdge.side) {
      mlEdge.confluence = spreadEdge.confluence = true;
    }

    games.push({
      id:   game.id,
      sport,
      home: game.home_team,
      away: game.away_team,
      time: game.commence_time,
      edges,
    });
  }
  return games;
}

module.exports = { computeEdges };
