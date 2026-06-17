# Curly Locks — Picks Methodology

How the system finds bets, scores them, and delivers them each day.

---

## The Core Philosophy

The system is built on one idea: **if a public-facing sportsbook is offering a price that implies lower odds of winning than the sharpest books in the world think is true, that is a positive-expected-value (EV) bet — and positive EV is the only mathematically durable edge in sports betting.**

We don't predict games. We find prices that are wrong.

The sharpest books in the world (Pinnacle, Circa) lose money to sharp bettors long-term, so they set their lines to reflect the true probability of each outcome as accurately as possible. When DraftKings or FanDuel posts a price that diverges from Pinnacle's view of reality, we bet into that gap.

---

## Step 1: Fetching Live Odds

Every time picks are requested, the server calls The Odds API for each active sport:

```
GET /v4/sports/{sport}/odds/
  ?regions=us
  &markets=h2h,spreads,totals
  &bookmakers=pinnacle,circa_sports,draftkings,fanduel,betmgm
  &oddsFormat=american
```

**Books fetched:**
| Role | Books |
|------|-------|
| Sharp (price-setters) | Pinnacle, Circa Sports |
| Soft (target for bets) | DraftKings, FanDuel |

Only today's games are processed. Games that have already started are excluded — live in-play prices (e.g. a trailing team at +1400) would look like a massive mispricing but aren't pregame edges.

---

## Step 2: Stripping the Vig — Finding True Probability

Every book bakes a margin (vig) into their prices so both sides of a bet sum to more than 100% implied probability. Before we can compare prices fairly, we must remove the vig.

**Formula (for a binary market):**

```
implied_prob_home = 1 / decimal_odds_home
implied_prob_away = 1 / decimal_odds_away
total = implied_prob_home + implied_prob_away   // always > 1.0 due to vig

true_prob_home = implied_prob_home / total
true_prob_away = implied_prob_away / total
```

This is applied to each sharp book individually, then the per-book true probabilities are averaged (blended) across however many sharp books posted that market. If Pinnacle and Circa both posted a moneyline, we average their stripped probabilities — so one stale or slightly outlier sharp line doesn't skew the "true" number.

---

## Step 3: Calculating Expected Value

Once we have the true probability, EV tells us how much we expect to profit per $100 wagered at a soft book's price:

```
EV% = (true_prob × decimal_odds_at_soft_book - 1) × 100
```

**Example:**
- Pinnacle no-vig true probability for Team A to win: **55%**
- DraftKings is offering Team A at **-105** (decimal: 1.952)
- EV = (0.55 × 1.952 − 1) × 100 = **+7.4%**

That means: for every $100 bet on Team A at DraftKings, the expected profit is $7.40 — because DraftKings is underpricing the favourite relative to where the sharp market has settled.

We find the **best-priced soft book** for each side: if DraftKings offers -105 and FanDuel offers -108 for the same side, we record the DraftKings price (higher EV).

---

## Step 4: Signal Tags — What Type of Edge Is It?

Each edge is tagged with one or more signal labels computed from the data.

### CONSENSUS
Both Pinnacle AND Circa independently price this side as +EV. This is the strongest quality filter — it's not just the blended average showing value, it's that each sharp book on its own agrees. When there's only one sharp book available for a market, `consensus` is `null` (not false — just unknown).

### SPLIT
Pinnacle and Circa disagree on direction — one prices the side as +EV, the other as −EV. The blended number may still look positive, but it's being pulled toward +EV by one outlier book. Treat SPLIT edges with caution even if EV looks decent.

### CONFLUENCE
The moneyline AND spread for the same game both show a positive edge on the **same team**. Two independent markets agreeing a soft book is underpricing a team is a much stronger signal than either market alone — it suggests a systematic mispricing rather than a single-market quirk.

---

## Step 5: Liability Signals — What Is the Line Doing?

Beyond static EV, the system tracks line movement to identify **bookmaker liability** — the side the books need to lose so they break even on their exposure. Sharp bettors find the liability side.

The server polls odds every 2 hours across all sports and stores the first-seen Pinnacle spread + ML for every game in `line-history.json`. By game day, most games have 2–7 days of movement history.

Three signals are computed from this history:

### REVERSE LINE
The spread has moved **toward the underdog** from the opening line, despite (or because of) heavy public money on the favourite. This is the classic sharp-money tell: the book is adjusting to liability, not public action. When the line goes the wrong way from the public's perspective, the sharp money is on the dog.

*Trigger: spread moved ≥ 0.5 points toward the underdog from a game where the opening spread was at least 3 points.*

### FROZEN LINE
The game is within 5 hours of kickoff and Pinnacle has not moved the spread at all since we first saw it (3+ hours ago). The book is standing firm — they like their number and don't need to hedge. This is a secondary confirmation that the books aren't exposed on this side.

### SHARP/SOFT GAP
Pinnacle and DraftKings/FanDuel have **different spread numbers** at the same moment. The sharp book has already moved; the public book hasn't caught up yet. The side getting extra points at the soft book is getting a gift — bet them there while the number lasts.

**When all three appear together:** This is the highest-confidence scenario. The books need the underdog, sharp money is confirming it, and the public book is still offering the wrong number. These picks are flagged as 🎯 **OFFICIAL PLAYS** in the UI.

---

## Step 6: Claude's Role — Final Pick Selection

After the data pipeline runs, the server sends everything to Claude (claude-sonnet-4-6) in a single structured prompt. Claude does not make up information — it works entirely from the numbers it's given.

**What Claude receives:**
- Every today's game with all computed edges, their EV%, true probability, best soft-book price, and all signal tags
- Explicit instructions on how to weigh each signal type
- Liability explanations for games with line-movement signals
- Reference picks from the handicapper service (if submitted for today via Settings)

**What Claude decides:**
1. Which 0–3 edges represent a genuine, selective bet worth taking — not padding the card to reach 3 if only 1 or 2 are real
2. One pick per game maximum — never the same matchup twice in different markets
3. How to balance EV% vs. true win probability (see below)

**The probability correction:** American odds are mathematically convex — a +200 longshot showing +5% EV looks proportionally bigger than a -110 bet showing +3% EV, but the longshot loses 67% of the time. Raw EV% alone is biased toward plus-money underdogs. Claude is instructed to prefer sides with true probability ≥ 45% when they clear the EV bar, and to only take longshots (true prob < 40%) if EV is clearly exceptional (+5%+) AND they're tagged CONSENSUS or CONFLUENCE.

**The bar:** Positive EV vs the no-vig sharp line, ideally +2% or better. Edges that are barely positive, untagged, SPLIT, or are fragile longshots do not qualify.

---

## Step 7: Delivery — One Set of Picks Per Day

Picks are locked once per day and served from cache on every subsequent load. This is intentional:
- Line shopping is done at pick time — the price Claude cites is the actual price at that moment
- Picks that change throughout the day create confusion and tracking problems
- A consistent card can be tracked as a unit with a clean W/L/P result

If picks generation fails (no games, API error), the system waits 10 minutes before allowing a retry — preventing quota burn on rapid retries.

Picks can be force-refreshed with `?refresh=true` on `/api/picks` if you need a new set mid-day.

---

## Step 8: Closing Line Value (CLV) Tracking

CLV is how we validate the system over time — more reliable than W/L record in the short run.

If a pick was genuinely +EV at the time of pick, the closing line (final pregame price) should be **equal to or worse** than the price we got. Getting a better price than the close means the market agreed with our pick and moved toward us — we were early and right.

```
CLV% = (decimal_odds_at_pick / decimal_odds_at_close - 1) × 100
```

Positive CLV = we got a better number than the market ultimately settled on. Sharp bettors sustain positive CLV over time. Recreational bettors sustain negative CLV.

Closing lines are captured automatically ~10 minutes before each game starts. They appear in the 📊 SCORE → CLV tab, broken down by signal type so we can measure whether CONSENSUS edges beat the close at a higher rate than plain EV edges.

---

## Step 9: Handicapper Reference

A sharp handicapper service's daily plays are submitted via Settings → "TODAY'S REFERENCE PICKS" and stored in `capper-history.json`. These are fed to Claude as a `MARKET REFERENCE` block in the same prompt — Claude is explicitly told:
- Note when they corroborate the EV model (increases confidence)
- Note when they conflict (flag the discrepancy, do not override EV data to match)
- Do not pick a game solely because it appears in the reference — EV is still the primary filter

Over time this builds a data layer: do the handicapper's picks cluster around CONSENSUS edges? Do they consistently find value in certain park/weather conditions the EV model doesn't weight? That analysis compounds as the history grows.

---

## Data Flow Summary

```
The Odds API (live prices)
        │
        ▼
computeEdges() — strip vig, calc EV, tag CONSENSUS/SPLIT/CONFLUENCE
        │
        ▼
computeLiability() — compare current Pinnacle line to opening line
        │                 → REVERSE_LINE, FROZEN_LINE, SHARP_SOFT_GAP
        ▼
generatePicks() — format all edges + signals into structured prompt
        │         + inject today's handicapper reference picks
        ▼
Claude (claude-sonnet-4-6) — selects 0-3 picks, writes reasoning
        │
        ▼
Picks cached (picks-cache.json) + appended to history (picks-history.json)
        │
        ▼
Client — locked picks displayed, auto-tracked in record
        │
        ▼
CLV capture — closing line fetched ~10 min before each game
```

---

## What This System Does Not Do

- **Predict outcomes** — we don't model team stats, injuries, weather, or matchups. Claude's reasoning may reference these if they're contextually obvious from the game (e.g. a playoff spot on the line) but they are not inputs to the EV calculation.
- **Make money on every pick** — positive EV means profitable over a large sample, not on any individual bet. The house edge at -110 is 4.5%; +3% EV beats that, but you still lose 52%+ of bets.
- **Beat Pinnacle** — we're not betting at Pinnacle. We're using their price as a truth signal and betting at softer books that haven't fully adjusted to sharp money yet.
- **Guarantee closing line access** — if a game's line isn't posted at the soft book close to game time (game cancelled, line pulled), CLV won't be captured for that pick.
