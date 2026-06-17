// ─── LIABILITY / LINE MOVEMENT TRACKER ────────────────────────────────────────
// Stores the first-seen Pinnacle spread + ML for every game in a persistent
// file.  On each subsequent fetch we compare the current line to the opening
// and emit structured signals that the picks prompt uses.
//
// Three signals:
//  REVERSE_LINE  — spread moved toward the underdog from a clear favourite
//                  (classic sharp-money tell; public hammers the fav but the
//                   line goes the other way)
//  FROZEN_LINE   — game ≤5h away, Pinnacle hasn't moved at all in 3+ hours
//                  (book is standing firm despite incoming action)
//  SHARP_SOFT_GAP — Pinnacle and DK/FanDuel have different spread numbers
//                  (sharp books have moved; soft books haven't caught up)

const fs   = require("fs");
const path = require("path");

function load(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch { return {}; }
}
function save(filePath, data) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data));
  } catch (e) { console.warn("[lines] save failed:", e.message); }
}

function extractLines(game) {
  const h2h = {}, spreads = {}, totals = {};
  for (const bm of game.bookmakers || []) {
    for (const m of bm.markets || []) {
      if (m.key === "h2h" && m.outcomes.length === 2) {
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
        const ov = m.outcomes.find(o => o.name === "Over");
        const un = m.outcomes.find(o => o.name === "Under");
        if (ov && un) totals[bm.key] = {
          over:  { point: ov.point, price: ov.price },
          under: { point: un.point, price: un.price },
        };
      }
    }
  }
  return { h2h, spreads, totals };
}

/**
 * Process a raw Odds API game array to:
 *   1. Store opening Pinnacle lines for new games.
 *   2. Compute liability signals for games seen before.
 *
 * Returns { [gameId]: Signal[] } for every game in liveData.
 * New games get an empty array (no opening to compare against yet).
 */
function computeLiability(filePath, liveData) {
  const history = load(filePath);
  const now     = Date.now();
  const result  = {};
  let   dirty   = false;

  for (const game of liveData) {
    const { h2h, spreads } = extractLines(game);

    const pinSpread  = spreads.pinnacle?.home?.point ?? null;
    const pinMLHome  = h2h.pinnacle?.home            ?? null;

    const softBook   = spreads.draftkings ? "draftkings" : spreads.fanduel ? "fanduel" : null;
    const softSpread = softBook ? spreads[softBook]?.home?.point ?? null : null;

    const hoursUntil      = (new Date(game.commence_time).getTime() - now) / 3600000;
    const rec             = history[game.id];

    if (!rec) {
      history[game.id] = {
        firstSeenAt: new Date().toISOString(),
        pinSpread,
        pinMLHome,
        softSpread,
        softBook,
      };
      result[game.id] = [];
      dirty = true;
      continue;
    }

    const signals = [];
    const openPinSpread = rec.pinSpread;

    // ── 1. Spread movement + reverse line ─────────────────────────────────────
    if (openPinSpread !== null && pinSpread !== null) {
      const moved = pinSpread - openPinSpread;
      if (Math.abs(moved) >= 0.5) {
        // "toward dog" = line moved away from the favourite's direction
        const towardDog =
          (openPinSpread < 0 && moved > 0) ||   // home was favourite, spread shrank
          (openPinSpread > 0 && moved < 0);      // away was favourite, spread shrank
        signals.push({ type: "SPREAD_MOVE", moved, towardDog });

        if (towardDog && Math.abs(openPinSpread) >= 3) {
          signals.push({ type: "REVERSE_LINE", moved });
        }
      }
    }

    // ── 2. Frozen line ────────────────────────────────────────────────────────
    const hoursSinceFirst = (now - new Date(rec.firstSeenAt).getTime()) / 3600000;
    const noMove          = !signals.some(s => s.type === "SPREAD_MOVE");
    if (hoursUntil > 0 && hoursUntil <= 5 && hoursSinceFirst >= 3 && noMove && openPinSpread !== null) {
      signals.push({ type: "FROZEN_LINE", hoursUntil: +hoursUntil.toFixed(1) });
    }

    // ── 3. Sharp/soft spread gap ──────────────────────────────────────────────
    if (pinSpread !== null && softSpread !== null) {
      const gap = pinSpread - softSpread;
      if (Math.abs(gap) >= 0.5) {
        // gap < 0: Pinnacle gives home FEWER points → underdog gets a better number at soft book
        // gap > 0: Pinnacle gives home MORE points  → favourite gets a better number at soft book
        signals.push({
          type:     "SHARP_SOFT_GAP",
          pin:      pinSpread,
          soft:     softSpread,
          softBook: softBook || "DK",
          gap,
          valueAt:  gap < 0 ? "underdog" : "favorite",
        });
      }
    }

    history[game.id].lastSeenAt = new Date().toISOString();
    dirty = true;
    result[game.id] = signals;
  }

  if (dirty) save(filePath, history);
  return result;
}

/**
 * Convert a signal array to a compact human-readable string for the Claude prompt.
 */
function liabilityStr(signals) {
  if (!signals || !signals.length) return "";
  const parts = [];
  for (const s of signals) {
    if (s.type === "REVERSE_LINE")
      parts.push(`REVERSE LINE (spread moved ${s.moved > 0 ? "+" : ""}${s.moved} since open)`);
    if (s.type === "FROZEN_LINE")
      parts.push(`FROZEN LINE (no movement, ${s.hoursUntil}h to tip)`);
    if (s.type === "SHARP_SOFT_GAP")
      parts.push(`SHARP/SOFT GAP (Pinnacle ${s.pin > 0 ? "+" : ""}${s.pin} vs ${s.softBook} ${s.soft > 0 ? "+" : ""}${s.soft} — ${s.valueAt} gets extra points at ${s.softBook})`);
  }
  return parts.length ? `[LIABILITY: ${parts.join(" · ")}] ` : "";
}

module.exports = { computeLiability, liabilityStr };
