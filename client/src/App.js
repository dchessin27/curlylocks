import React, { useState, useEffect } from "react";

// ─── STORAGE ─────────────────────────────────────────────────────────────────
const RECORD_KEY   = "cl_record_v3";
const SETTINGS_KEY = "cl_settings_v1";

const loadRecord   = () => { try { return JSON.parse(localStorage.getItem(RECORD_KEY)   || "[]");                       } catch { return []; } };
const saveRecord   = r  => localStorage.setItem(RECORD_KEY,   JSON.stringify(r));
const loadSettings = () => { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{"bankroll":10000,"unitPct":1}'); } catch { return { bankroll: 10000, unitPct: 1 }; } };
const saveSettings = s  => localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));

// ─── MATH ─────────────────────────────────────────────────────────────────────
const parseOdds = v => { const n = parseInt(String(v).replace(/[−–—]/g, "-").replace(/[^0-9\-+]/g, ""), 10); return isNaN(n) ? 0 : n; };
const fmtOdds = v => { const n = parseOdds(v); return n > 0 ? `+${n}` : `${n}`; };
const oddsToDecimal = o => { const n = parseOdds(o); return n > 0 ? n / 100 + 1 : 100 / Math.abs(n) + 1; };
const pickPL = p => p.result === "win" ? (oddsToDecimal(p.odds) - 1) * 100 : p.result === "loss" ? -100 : 0;
const unitsToDollars = (u, b, p = 1) => (u * p / 100) * b;
const fmtDollars = a => { const abs = Math.abs(a), sign = a >= 0 ? "+" : "-"; return abs >= 1000 ? `${sign}$${(abs/1000).toFixed(1)}k` : `${sign}$${abs.toFixed(0)}`; };

function betToEntry(bet, date) {
  // matchup format from Claude is "Away @ Home"
  const [away, home] = (bet.matchup || "").split("@").map(s => s.trim());
  return { id: Date.now()+Math.random(), date, bet:bet.bet, sport:bet.sport, signal:bet.signal, book:bet.book, odds:parseOdds(bet.odds), ev:bet.ev, confidence:bet.confidence, matchup:bet.matchup, home, away, betType:bet.betType || "ml", side:bet.side || null, line:bet.line ?? null, result:"pending", closingLine:bet.closingLine ?? null };
}

function calcStats(picks) {
  if (!picks.length) return null;
  const s = picks.filter(p => p.result !== "pending");
  if (!s.length) return { total: picks.length, settled: 0, wins: 0, losses: 0, pushes: 0, hitRate: null, roi: null, pl: 0 };
  const wins = s.filter(p => p.result === "win").length;
  const losses = s.filter(p => p.result === "loss").length;
  const pushes = s.filter(p => p.result === "push").length;
  const pl = s.reduce((acc, p) => acc + pickPL(p), 0);
  const w = (wins + losses) * 100;
  return { total: picks.length, settled: s.length, wins, losses, pushes,
    hitRate: w > 0 ? ((wins / (wins + losses)) * 100).toFixed(1) : null,
    roi:     w > 0 ? ((pl / w) * 100).toFixed(1) : null,
    pl:      pl.toFixed(1) };
}
const groupBy = (picks, key) => picks.reduce((acc, p) => { const k = p[key]||"?"; if (!acc[k]) acc[k]=[]; acc[k].push(p); return acc; }, {});

// CLV = how much better our price was vs. the closing line, in %.
// Positive = we beat the close (got a better number before the market moved).
const calcCLV = p => {
  if (p.closingLine === null || p.closingLine === undefined || p.closingLine === "") return null;
  return ((oddsToDecimal(p.odds) / oddsToDecimal(p.closingLine)) - 1) * 100;
};
function calcCLVStats(picks) {
  const withClose = picks.map(p => ({ p, clv: calcCLV(p) })).filter(x => x.clv !== null);
  if (!withClose.length) return null;
  const avg = withClose.reduce((acc, x) => acc + x.clv, 0) / withClose.length;
  const beat = withClose.filter(x => x.clv > 0).length;
  return { count: withClose.length, avgCLV: avg.toFixed(2), beatPct: ((beat / withClose.length) * 100).toFixed(0) };
}

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const SC  = { NFL:"#cef17b", NBA:"#e85d3a", MLB:"#4aade8", NHL:"#7ecfcf", MMA:"#ff5e62", WORLDCUP:"#e8c84a" };
const SI  = { NFL:"🏈", NBA:"🏀", MLB:"⚾", NHL:"🏒", MMA:"🥊", WORLDCUP:"⚽" };
const SGC = { EV:"#cef17b", CONSENSUS:"#22ff99", CONFLUENCE:"#4a9fff", LIABILITY:"#ff8c00" };
const SLOT_SYMBOLS = ["🔒","7️⃣","🍒","💰","⭐","🍀"];
const RM  = [
  { label:"LOCK #1", emoji:"🥇", border:"#cef17b", glow:"#cef17b33" },
  { label:"LOCK #2", emoji:"🥈", border:"#7a9488",    glow:"#7a948822" },
  { label:"LOCK #3", emoji:"🥉", border:"#5d7a2e", glow:"#5d7a2e22" },
];

const btn = (active, color="#cef17b") => ({
  flex:1, background: active ? color+"22":"none",
  border:`1px solid ${active ? color+"44":"transparent"}`,
  color: active ? color:"#3f6b58",
  borderRadius:6, padding:"7px 0", cursor:"pointer", fontSize:10, letterSpacing:0.5,
  fontFamily:"'DM Mono',monospace",
});

// ─── STAT PILL ────────────────────────────────────────────────────────────────
function StatPill({ label, value, color }) {
  return (
    <div style={{ background:"#071210", border:`1px solid ${color}33`, borderRadius:6, padding:"8px 10px", textAlign:"center", minWidth:64 }}>
      <div style={{ fontSize:8, color:"#3f6b58", letterSpacing:1, marginBottom:4 }}>{label}</div>
      <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:18, fontWeight:800, color }}>{value ?? "—"}</div>
    </div>
  );
}

// ─── SCORE ROW ────────────────────────────────────────────────────────────────
function ScoreRow({ label, picks, color, bankroll, unitPct=1 }) {
  const s = calcStats(picks);
  if (!s) return null;
  const rc = s.roi === null ? "#3f6b58" : parseFloat(s.roi) >= 0 ? "#22ff99" : "#ff5544";
  const hc = s.hitRate === null ? "#3f6b58" : parseFloat(s.hitRate) >= 55 ? "#22ff99" : parseFloat(s.hitRate) >= 48 ? "#cef17b" : "#ff5544";
  return (
    <div style={{ background:"#08140f", border:`1px solid ${color}33`, borderRadius:8, padding:"12px 14px" }}>
      <div style={{ display:"flex", justifyContent:"space-between", marginBottom:10 }}>
        <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:15, fontWeight:700, color, letterSpacing:1 }}>{label}</div>
        <div style={{ fontSize:9, color:"#2c5443" }}>{s.settled}/{s.total}</div>
      </div>
      <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
        <StatPill label="HIT RATE" value={s.hitRate ? s.hitRate+"%" : "—"} color={hc} />
        <StatPill label="ROI"      value={s.roi     ? s.roi    +"%" : "—"} color={rc} />
        <StatPill label="RECORD"   value={`${s.wins}-${s.losses}`}          color={color} />
        <StatPill label="P&L ($)"  value={s.pl !== undefined ? fmtDollars(unitsToDollars(parseFloat(s.pl), bankroll, unitPct)) : "—"} color={rc} />
      </div>
      {s.hitRate && <div style={{ marginTop:10, height:3, background:"#0f2e22", borderRadius:2, overflow:"hidden" }}><div style={{ height:"100%", width:`${Math.min(100,parseFloat(s.hitRate))}%`, background:`linear-gradient(90deg,${color},${color}66)`, borderRadius:2 }} /></div>}
    </div>
  );
}

// ─── CLV HISTORY HELPERS ─────────────────────────────────────────────────────
function histCLV(b) {
  if (b.closingLine === null || b.closingLine === undefined) return null;
  return (oddsToDecimal(parseOdds(b.odds)) / oddsToDecimal(b.closingLine) - 1) * 100;
}

function calcHistoryStats(history) {
  const betsWithClose = history.flatMap(d => d.bets).filter(b => histCLV(b) !== null);
  if (!betsWithClose.length) return null;
  const values = betsWithClose.map(histCLV);
  const avg = values.reduce((s, v) => s + v, 0) / values.length;
  const beat = values.filter(v => v > 0).length;

  const bySig = {};
  for (const b of betsWithClose) {
    const sig = b.signal || "EV";
    if (!bySig[sig]) bySig[sig] = [];
    bySig[sig].push(histCLV(b));
  }
  const sigStats = Object.fromEntries(
    Object.entries(bySig).map(([sig, vals]) => {
      const a = vals.reduce((s, v) => s + v, 0) / vals.length;
      const bp = (vals.filter(v => v > 0).length / vals.length) * 100;
      return [sig, { n: vals.length, avgCLV: a, beatPct: bp }];
    })
  );

  const dailyCLV = history.map(day => {
    const vals = day.bets.map(histCLV).filter(v => v !== null);
    if (!vals.length) return null;
    return { date: day.date, avg: vals.reduce((s, v) => s + v, 0) / vals.length, n: vals.length };
  }).filter(Boolean);

  return { n: betsWithClose.length, avg, beat, total: values.length, sigStats, dailyCLV };
}

function CLVSparkline({ dailyCLV }) {
  if (!dailyCLV.length) return null;
  const W = 320, H = 56, padX = 4;
  const maxAbs = Math.max(...dailyCLV.map(d => Math.abs(d.avg)), 0.5);
  const barW = Math.max(6, Math.floor((W - padX * 2) / dailyCLV.length) - 2);
  const zeroY = H / 2;
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display:"block", overflow:"visible" }}>
      <line x1={padX} y1={zeroY} x2={W - padX} y2={zeroY} stroke="#1a3329" strokeWidth={1} />
      {dailyCLV.map((d, i) => {
        const x = padX + i * (barW + 2);
        const barH = Math.max((Math.abs(d.avg) / maxAbs) * (zeroY - 6), 2);
        const pos = d.avg >= 0;
        return (
          <rect key={i} x={x} y={pos ? zeroY - barH : zeroY} width={barW}
            height={barH} fill={pos ? "#22ff99" : "#ff5544"} opacity={0.75} rx={1} />
        );
      })}
    </svg>
  );
}

// ─── RECORD TAB ───────────────────────────────────────────────────────────────
function CLVBadge({ pick }) {
  const clv = calcCLV(pick);
  if (clv === null) return <span style={{ fontSize:9, color:"#2c5443" }}>CL pending</span>;
  return (
    <span style={{ fontSize:9, fontWeight:700, color: clv>=0 ? "#22ff99":"#ff5544" }}>
      Close {fmtOdds(pick.closingLine)} · {clv>=0?"+":""}{clv.toFixed(1)}% CLV
    </span>
  );
}

function RecordTab({ record, bankroll, unitPct, onSettle, onDelete, onSyncClosingLines, syncingCLV, history }) {
  const [view, setView] = useState("overview");
  const overall  = calcStats(record);
  const bySport  = groupBy(record, "sport");
  const bySignal = groupBy(record, "signal");
  const pending  = record.filter(p => p.result === "pending");
  const settled  = [...record].filter(p => p.result !== "pending").reverse();
  const rc = !overall || overall.roi===null ? "#cef17b" : parseFloat(overall.roi)>=0 ? "#22ff99" : "#ff5544";
  const clvStats = calcCLVStats(record);
  const clvc = clvStats && parseFloat(clvStats.avgCLV)>=0 ? "#22ff99" : "#ff5544";

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
      <div style={{ display:"flex", background:"#071210", border:"1px solid #0f2e22", borderRadius:8, padding:3 }}>
        {[["overview","📊 Overview"],["clv","📈 CLV"],["sport","🏆 Sport"],["signal","⚡ Signal"],["history","📋 History"]].map(([k,l]) => (
          <button key={k} onClick={() => setView(k)} style={{ ...btn(view===k), padding:"5px 0", fontSize:9 }}>{l}</button>
        ))}
      </div>

      {view === "overview" && (
        <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
          {!overall || overall.total === 0
            ? <div style={{ textAlign:"center", padding:"50px 0", color:"#2c5443", fontSize:10 }}>No picks tracked yet.<br/>Check the BETS tab — today's locks are tracked automatically.</div>
            : <>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
                <div style={{ background:"#08140f", border:"1px solid #0f2e22", borderRadius:8, padding:"14px 16px" }}>
                  <div style={{ fontSize:9, color:"#3f6b58", letterSpacing:1, marginBottom:6 }}>OVERALL RECORD</div>
                  <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:30, fontWeight:800, color:"#cdedb3" }}>
                    {overall.wins}<span style={{ color:"#2c5443", fontSize:20 }}>-</span>{overall.losses}
                    {overall.pushes > 0 && <span style={{ color:"#3f6b58", fontSize:16 }}>-{overall.pushes}</span>}
                  </div>
                  <div style={{ fontSize:9, color:"#3f6b58", marginTop:3 }}>{overall.total} picks total</div>
                </div>
                <div style={{ background:"#08140f", border:`1px solid ${rc}33`, borderRadius:8, padding:"14px 16px" }}>
                  <div style={{ fontSize:9, color:"#3f6b58", letterSpacing:1, marginBottom:6 }}>ALL-TIME ROI</div>
                  <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:30, fontWeight:800, color:rc }}>
                    {overall.roi !== null ? (parseFloat(overall.roi)>=0?"+":"")+overall.roi+"%" : "—"}
                  </div>
                  <div style={{ fontSize:9, color:"#3f6b58", marginTop:3 }}>{overall.hitRate ? overall.hitRate+"% hit rate" : "pending"}</div>
                </div>
              </div>

              {overall.settled > 0 && (
                <div style={{ background:"#08140f", border:`1px solid ${rc}33`, borderRadius:8, padding:"12px 16px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                  <div>
                    <div style={{ fontSize:9, color:"#3f6b58", letterSpacing:1, marginBottom:4 }}>TOTAL P&L</div>
                    <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:26, fontWeight:800, color:rc }}>{fmtDollars(unitsToDollars(parseFloat(overall.pl), bankroll, unitPct))}</div>
                  </div>
                  <div style={{ textAlign:"right" }}>
                    <div style={{ fontSize:9, color:"#3f6b58", marginBottom:4 }}>UNITS</div>
                    <div style={{ fontSize:14, color:rc, fontWeight:700 }}>{parseFloat(overall.pl)>=0?"+":""}{overall.pl}u</div>
                    <div style={{ fontSize:8, color:"#2c5443", marginTop:2 }}>1u = ${(bankroll*unitPct/100).toFixed(0)}</div>
                  </div>
                </div>
              )}

              <div style={{ background:"#08140f", border:`1px solid ${clvStats?clvc+"33":"#0f2e22"}`, borderRadius:8, padding:"12px 16px" }}>
                {clvStats ? (
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
                    <div>
                      <div style={{ fontSize:9, color:"#3f6b58", letterSpacing:1, marginBottom:4 }}>AVG CLOSING LINE VALUE</div>
                      <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:26, fontWeight:800, color:clvc }}>{parseFloat(clvStats.avgCLV)>=0?"+":""}{clvStats.avgCLV}%</div>
                    </div>
                    <div style={{ textAlign:"right" }}>
                      <div style={{ fontSize:9, color:"#3f6b58", marginBottom:4 }}>BEAT CLOSE</div>
                      <div style={{ fontSize:14, color:clvc, fontWeight:700 }}>{clvStats.beatPct}%</div>
                      <div style={{ fontSize:8, color:"#2c5443", marginTop:2 }}>{clvStats.count} picks tracked</div>
                    </div>
                  </div>
                ) : (
                  <div style={{ fontSize:9, color:"#3f6b58", marginBottom:10 }}>No closing lines synced yet — works best once a game has tipped off or the line has set.</div>
                )}
                <button onClick={onSyncClosingLines} disabled={syncingCLV} style={{ width:"100%", background:"#cef17b14", border:"1px solid #cef17b44", color:"#cef17b", borderRadius:6, padding:"7px 0", cursor:syncingCLV?"default":"pointer", fontSize:9, fontFamily:"'DM Mono',monospace", letterSpacing:1 }}>
                  {syncingCLV ? "SYNCING..." : "🔄 SYNC CLOSING LINES"}
                </button>
              </div>

              {overall.hitRate && (
                <div style={{ background:"#08140f", border:"1px solid #0f2e22", borderRadius:8, padding:"12px 14px" }}>
                  <div style={{ display:"flex", justifyContent:"space-between", fontSize:9, color:"#3f6b58", marginBottom:8 }}>
                    <span>Win Rate</span>
                    <span style={{ color: parseFloat(overall.hitRate)>=52.4 ? "#22ff99":"#ff5544", fontWeight:700 }}>
                      {parseFloat(overall.hitRate)>=52.4 ? "✓ PROFITABLE" : "✗ BELOW BREAKEVEN"}
                    </span>
                  </div>
                  <div style={{ height:6, background:"#0f2e22", borderRadius:3, overflow:"hidden", position:"relative" }}>
                    <div style={{ height:"100%", width:`${Math.min(100,parseFloat(overall.hitRate))}%`, background:"linear-gradient(90deg,#ff5544,#cef17b,#22ff99)", borderRadius:3 }} />
                    <div style={{ position:"absolute", top:0, left:"52.4%", width:2, height:"100%", background:"#ffffff55" }} />
                  </div>
                  <div style={{ display:"flex", justifyContent:"space-between", fontSize:8, color:"#2c5443", marginTop:4 }}>
                    <span>0%</span><span style={{ color:"#7a9488" }}>52.4% breakeven</span><span>100%</span>
                  </div>
                </div>
              )}

              {pending.length > 0 && (
                <div>
                  <div style={{ fontSize:9, color:"#cef17b", letterSpacing:1, marginBottom:2 }}>PENDING ({pending.length})</div>
                  <div style={{ fontSize:8, color:"#2c5443", marginBottom:8 }}>Results auto-check against final scores each time the app loads.</div>
                  {pending.map(p => (
                    <div key={p.id} style={{ background:"#08140f", border:"1px solid #0f2e22", borderRadius:7, padding:"10px 12px", marginBottom:6, display:"flex", justifyContent:"space-between", alignItems:"center", gap:10 }}>
                      <div style={{ minWidth:0 }}>
                        <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:14, fontWeight:700, color:"#cdedb3" }}>{p.bet}</div>
                        <div style={{ fontSize:9, color:"#3f6b58", marginTop:2 }}>{p.book} {fmtOdds(p.odds)} · {p.sport} · {p.date}</div>
                        <div style={{ marginTop:5 }}><CLVBadge pick={p} /></div>
                      </div>
                      <div style={{ display:"flex", gap:5, flexShrink:0 }}>
                        {["win","loss","push"].map(r => (
                          <button key={r} onClick={() => onSettle(p.id, r)} style={{ background:r==="win"?"#22ff9920":r==="loss"?"#ff554420":"#3a4f4420", border:`1px solid ${r==="win"?"#22ff9944":r==="loss"?"#ff554444":"#3a4f4444"}`, color:r==="win"?"#22ff99":r==="loss"?"#ff5544":"#7a9488", borderRadius:3, padding:"4px 9px", cursor:"pointer", fontSize:9 }}>{r.toUpperCase()}</button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          }
        </div>
      )}

      {view === "clv" && (() => {
        const hs = calcHistoryStats(history || []);
        const clvc = hs && hs.avg >= 0 ? "#22ff99" : "#ff5544";
        return (
          <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
            {!hs ? (
              <div style={{ textAlign:"center", padding:"50px 0", color:"#2c5443", fontSize:10, lineHeight:2 }}>
                No CLV data yet.<br/>
                Closing lines are captured automatically ~10 min before each game.<br/>
                Check back after tonight's games tip off.
              </div>
            ) : (
              <>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
                  <div style={{ background:"#08140f", border:`1px solid ${clvc}33`, borderRadius:8, padding:"14px 16px" }}>
                    <div style={{ fontSize:9, color:"#3f6b58", letterSpacing:1, marginBottom:6 }}>AVG CLV</div>
                    <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:30, fontWeight:800, color:clvc }}>
                      {hs.avg >= 0 ? "+" : ""}{hs.avg.toFixed(2)}%
                    </div>
                    <div style={{ fontSize:9, color:"#3f6b58", marginTop:3 }}>{hs.n} picks with close</div>
                  </div>
                  <div style={{ background:"#08140f", border:`1px solid ${clvc}33`, borderRadius:8, padding:"14px 16px" }}>
                    <div style={{ fontSize:9, color:"#3f6b58", letterSpacing:1, marginBottom:6 }}>BEAT CLOSE</div>
                    <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:30, fontWeight:800, color:clvc }}>
                      {((hs.beat / hs.n) * 100).toFixed(0)}%
                    </div>
                    <div style={{ fontSize:9, color:"#3f6b58", marginTop:3 }}>{hs.beat}/{hs.n} picks</div>
                  </div>
                </div>

                {hs.dailyCLV.length > 1 && (
                  <div style={{ background:"#08140f", border:"1px solid #0f2e22", borderRadius:8, padding:"12px 14px" }}>
                    <div style={{ fontSize:9, color:"#3f6b58", letterSpacing:1, marginBottom:10 }}>DAILY CLV TREND</div>
                    <CLVSparkline dailyCLV={hs.dailyCLV} />
                    <div style={{ display:"flex", justifyContent:"space-between", fontSize:8, color:"#2c5443", marginTop:6 }}>
                      <span>{hs.dailyCLV[0].date.split(",")[1]?.trim()}</span>
                      <span>{hs.dailyCLV[hs.dailyCLV.length - 1].date.split(",")[1]?.trim()}</span>
                    </div>
                  </div>
                )}

                <div style={{ background:"#08140f", border:"1px solid #0f2e22", borderRadius:8, padding:"12px 14px" }}>
                  <div style={{ fontSize:9, color:"#3f6b58", letterSpacing:1, marginBottom:10 }}>CLV BY SIGNAL</div>
                  {Object.entries(hs.sigStats).sort((a, b) => b[1].avgCLV - a[1].avgCLV).map(([sig, s]) => {
                    const sc = SGC[sig] || "#cef17b";
                    const pos = s.avgCLV >= 0;
                    return (
                      <div key={sig} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"8px 0", borderBottom:"1px solid #0a1f18" }}>
                        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                          <span style={{ background:sc+"20", color:sc, border:`1px solid ${sc}44`, borderRadius:4, padding:"2px 7px", fontSize:9, fontWeight:700, letterSpacing:1 }}>{sig}</span>
                          <span style={{ fontSize:9, color:"#3f6b58" }}>{s.n} picks</span>
                        </div>
                        <div style={{ textAlign:"right" }}>
                          <div style={{ fontSize:13, fontWeight:700, fontFamily:"'Barlow Condensed',sans-serif", color:pos?"#22ff99":"#ff5544" }}>
                            {pos?"+":""}{s.avgCLV.toFixed(2)}%
                          </div>
                          <div style={{ fontSize:9, color:"#3f6b58" }}>{s.beatPct.toFixed(0)}% beat close</div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div style={{ fontSize:9, color:"#2c5443", textAlign:"center", lineHeight:1.8 }}>
                  Positive CLV = we got a better price than the market closed at.<br/>
                  Sharp bettors target +CLV over time — it's the leading indicator of long-run profit.
                </div>
              </>
            )}
          </div>
        );
      })()}

      {view === "sport" && (
        <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
          {Object.keys(SC).map(sport => {
            const picks = bySport[sport] || [];
            if (!picks.length) return (
              <div key={sport} style={{ background:"#08140f", border:"1px solid #0f2e22", borderRadius:8, padding:"10px 14px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                <div style={{ display:"flex", gap:8, alignItems:"center" }}><span>{SI[sport]}</span><span style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:14, fontWeight:700, color:SC[sport] }}>{sport}</span></div>
                <span style={{ fontSize:9, color:"#2c5443" }}>No picks yet</span>
              </div>
            );
            return (
              <div key={sport}>
                <ScoreRow label={`${SI[sport]} ${sport}`} picks={picks} color={SC[sport]} bankroll={bankroll} unitPct={unitPct} />
                {Object.entries(groupBy(picks,"signal")).map(([sig,sp]) => {
                  const ss = calcStats(sp);
                  if (!ss || !ss.settled) return null;
                  return <div key={sig} style={{ marginTop:4, background:"#060f0c", border:`1px solid ${SGC[sig]||"#cef17b"}22`, borderRadius:5, padding:"7px 12px", display:"flex", justifyContent:"space-between" }}><span style={{ fontSize:9, color:SGC[sig]||"#cef17b" }}>↳ {sig}</span><div style={{ display:"flex", gap:14 }}><span style={{ fontSize:10, color:"#7a9488" }}>{ss.wins}W-{ss.losses}L</span>{ss.hitRate && <span style={{ fontSize:10, fontWeight:700, color:parseFloat(ss.hitRate)>=55?"#22ff99":"#ff5544" }}>{ss.hitRate}%</span>}</div></div>;
                })}
              </div>
            );
          })}
        </div>
      )}

      {view === "signal" && (
        <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
          {Object.entries(SGC).map(([sig, color]) => {
            const picks = bySignal[sig] || [];
            if (!picks.length) return <div key={sig} style={{ background:"#08140f", border:"1px solid #0f2e22", borderRadius:8, padding:"10px 14px", display:"flex", justifyContent:"space-between", alignItems:"center" }}><span style={{ fontSize:12, color, fontWeight:700, letterSpacing:1 }}>{sig}</span><span style={{ fontSize:9, color:"#2c5443" }}>No picks yet</span></div>;
            return <ScoreRow key={sig} label={sig} picks={picks} color={color} bankroll={bankroll} unitPct={unitPct} />;
          })}
        </div>
      )}

      {view === "history" && (
        <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
          {settled.length === 0 && <div style={{ textAlign:"center", padding:"40px 0", color:"#2c5443", fontSize:10 }}>No settled picks yet.</div>}
          {settled.map(p => {
            const isWin = p.result==="win", isLoss = p.result==="loss";
            const pl = pickPL(p);
            return (
              <div key={p.id} style={{ background:"#08140f", border:`1px solid ${isWin?"#22ff9933":isLoss?"#ff554433":"#0f2e22"}`, borderLeft:`3px solid ${isWin?"#22ff99":isLoss?"#ff5544":"#3f6b58"}`, borderRadius:7, padding:"10px 13px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:14, fontWeight:700, color:isWin?"#22ff99":isLoss?"#ff7766":"#7a9488" }}>{p.bet}</div>
                  <div style={{ fontSize:9, color:"#3f6b58", marginTop:2 }}>{SI[p.sport]} {p.sport} · {p.signal} · {p.book} {fmtOdds(p.odds)} · {p.date}</div>
                  <div style={{ marginTop:5 }}><CLVBadge pick={p} /></div>
                </div>
                <div style={{ display:"flex", alignItems:"center", gap:6, flexShrink:0, marginLeft:10 }}>
                  <div style={{ textAlign:"right" }}>
                    <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:16, fontWeight:700, color:isWin?"#22ff99":isLoss?"#ff5544":"#7a9488" }}>{fmtDollars(unitsToDollars(pl, bankroll, unitPct))}</div>
                    <div style={{ fontSize:8, color:"#2c5443", marginTop:1 }}>{isWin?"+":isLoss?"-":""}{Math.abs(pl).toFixed(0)}u</div>
                  </div>
                  <button onClick={() => onSettle(p.id,"pending")} style={{ background:"#cef17b14", border:"1px solid #cef17b33", color:"#cef17b", borderRadius:3, padding:"3px 7px", cursor:"pointer", fontSize:10 }}>↩</button>
                  <button onClick={() => onDelete(p.id)}           style={{ background:"none", border:"1px solid #2a1a1a", color:"#553333", borderRadius:3, padding:"3px 7px", cursor:"pointer", fontSize:10 }}>✕</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── SETTINGS ─────────────────────────────────────────────────────────────────
function SettingsPanel({ bankroll, unitPct, onSave, onResetAll }) {
  const [br, setBr]   = useState(String(bankroll));
  const [up, setUp]   = useState(String(unitPct));
  const [saved, setSaved] = useState(false);
  const brV = parseFloat(br) || bankroll;
  const upV = parseFloat(up) || unitPct;
  const unitAmt = brV * upV / 100;

  function handleSave() {
    if (parseFloat(br) > 0 && parseFloat(up) > 0) onSave(parseFloat(br), parseFloat(up));
    setSaved(true); setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
      <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:18, fontWeight:800, color:"#cdedb3", letterSpacing:1 }}>⚙️ BANKROLL SETTINGS</div>

      <div style={{ background:"#08140f", border:"1px solid #0f2e22", borderRadius:10, padding:"16px 18px" }}>
        <div style={{ fontSize:9, color:"#cef17b", letterSpacing:1, marginBottom:12 }}>YOUR BANKROLL</div>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <span style={{ fontSize:20, color:"#3f6b58" }}>$</span>
          <input type="number" value={br} onChange={e => setBr(e.target.value)} style={{ flex:1, background:"#071210", border:"1px solid #194232", borderRadius:6, color:"#cdedb3", padding:"10px 14px", fontSize:18, fontFamily:"'Barlow Condensed',sans-serif", fontWeight:700, outline:"none" }} />
        </div>
        <div style={{ fontSize:9, color:"#2c5443", marginTop:8 }}>Total funds dedicated to sports betting</div>
      </div>

      <div style={{ background:"#08140f", border:"1px solid #0f2e22", borderRadius:10, padding:"16px 18px" }}>
        <div style={{ fontSize:9, color:"#cef17b", letterSpacing:1, marginBottom:12 }}>UNIT SIZE (% OF BANKROLL)</div>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <input type="number" value={up} min="0.5" max="5" step="0.5" onChange={e => setUp(e.target.value)} style={{ flex:1, background:"#071210", border:"1px solid #194232", borderRadius:6, color:"#cdedb3", padding:"10px 14px", fontSize:18, fontFamily:"'Barlow Condensed',sans-serif", fontWeight:700, outline:"none" }} />
          <span style={{ fontSize:20, color:"#3f6b58" }}>%</span>
        </div>
        <div style={{ display:"flex", gap:6, marginTop:10 }}>
          {[["0.5","Conservative"],["1","Standard"],["2","Aggressive"],["3","Max"]].map(([v,l]) => (
            <button key={v} onClick={() => setUp(v)} style={{ flex:1, background:up===v?"#cef17b22":"#071210", border:`1px solid ${up===v?"#cef17b55":"#0f2e22"}`, color:up===v?"#cef17b":"#3f6b58", borderRadius:5, padding:"5px 0", cursor:"pointer", fontSize:8, fontFamily:"'DM Mono',monospace" }}>{v}%<br/><span style={{ fontSize:7, color:"#2c5443" }}>{l}</span></button>
          ))}
        </div>
      </div>

      <div style={{ background:"#08140f", border:"1px solid #cef17b33", borderRadius:10, padding:"16px 18px" }}>
        <div style={{ fontSize:9, color:"#cef17b", letterSpacing:1, marginBottom:14 }}>LIVE PREVIEW</div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:10 }}>
          {[{l:"BANKROLL",v:brV>=1000?"$"+(brV/1000).toFixed(0)+"k":"$"+brV,c:"#cdedb3"},{l:"1 UNIT =",v:"$"+unitAmt.toFixed(0),c:"#cef17b"},{l:"BET SIZE",v:"$"+unitAmt.toFixed(0),c:"#22ff99"}].map(s => (
            <div key={s.l} style={{ background:"#071210", border:`1px solid ${s.c}22`, borderRadius:6, padding:"10px 0", textAlign:"center" }}>
              <div style={{ fontSize:8, color:"#3f6b58", letterSpacing:1, marginBottom:5 }}>{s.l}</div>
              <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:20, fontWeight:800, color:s.c }}>{s.v}</div>
            </div>
          ))}
        </div>
        <div style={{ marginTop:14 }}>
          <div style={{ fontSize:9, color:"#3f6b58", letterSpacing:1, marginBottom:8 }}>EXAMPLE OUTCOMES</div>
          {[{l:"Win at -110",pl:+(unitAmt*100/110),c:"#22ff99"},{l:"Win at +115",pl:+(unitAmt*1.15),c:"#22ff99"},{l:"Loss",pl:-unitAmt,c:"#ff5544"},{l:"3-0 week",pl:+(unitAmt*100/110)*3,c:"#cef17b"},{l:"2-1 week",pl:+(unitAmt*100/110)*2-unitAmt,c:"#cef17b"}].map(row => (
            <div key={row.l} style={{ display:"flex", justifyContent:"space-between", padding:"5px 10px", background:"#050d0a", borderRadius:5, marginBottom:4 }}>
              <span style={{ fontSize:10, color:"#7a9488" }}>{row.l}</span>
              <span style={{ fontSize:11, fontWeight:700, color:row.c, fontFamily:"'Barlow Condensed',sans-serif" }}>{row.pl>=0?"+":""}${Math.abs(row.pl).toFixed(0)}</span>
            </div>
          ))}
        </div>
      </div>

      <button onClick={handleSave} style={{ width:"100%", background:saved?"#22ff9922":"#cef17b", color:saved?"#22ff99":"#050d0a", border:`1px solid ${saved?"#22ff9955":"transparent"}`, borderRadius:8, padding:"14px 0", fontSize:12, fontFamily:"'Barlow Condensed',sans-serif", fontWeight:700, letterSpacing:1, cursor:"pointer" }}>{saved ? "✓ SAVED" : "SAVE SETTINGS"}</button>
      <div style={{ fontSize:9, color:"#0f2e22", textAlign:"center", lineHeight:1.8 }}>Settings saved locally · Sharp sizing = 1-2% per bet<br/>Not financial advice · Bet responsibly</div>

      <div style={{ background:"#1a0c0c", border:"1px solid #ff554433", borderRadius:10, padding:"16px 18px", marginTop:8 }}>
        <div style={{ fontSize:9, color:"#ff5544", letterSpacing:1, marginBottom:10 }}>DANGER ZONE</div>
        <button onClick={onResetAll} style={{ width:"100%", background:"transparent", color:"#ff5544", border:"1px solid #ff554455", borderRadius:8, padding:"12px 0", fontSize:11, fontFamily:"'Barlow Condensed',sans-serif", fontWeight:700, letterSpacing:1, cursor:"pointer" }}>🗑 CLEAR TODAY'S PICKS &amp; HISTORY</button>
        <div style={{ fontSize:9, color:"#3f6b58", marginTop:8 }}>Wipes today's locked picks and your tracked record, then generates a fresh set of 3 picks on next load.</div>
      </div>
    </div>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [tab,      setTab]      = useState("bets");
  const [status,   setStatus]   = useState("loading");
  const [landed,   setLanded]   = useState([0, 0, 0]);
  const [data,     setData]     = useState(null);
  const [error,    setError]    = useState(null);
  const [record,   setRecord]   = useState(() => loadRecord());
  const [syncingCLV, setSyncingCLV] = useState(false);
  const [settings, setSettings] = useState(() => loadSettings());
  const [history,  setHistory]  = useState([]);
  const { bankroll, unitPct } = settings;

  useEffect(() => { load(); autoSettleRecord(); fetchHistory(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function fetchHistory() {
    try {
      const r = await fetch("/api/history");
      const h = await r.json();
      if (Array.isArray(h)) setHistory(h);
    } catch {}
  }

  // Automatically track every pick the moment it's loaded — no manual "log" needed.
  // Also backfill closingLine onto already-tracked picks once the server has
  // captured it (auto-captured ~10 min before kickoff).
  useEffect(() => {
    if (!data?.bets?.length) return;
    setRecord(prev => {
      let changed = false;
      const withCLV = prev.map(p => {
        if (p.date !== data.date || p.closingLine != null) return p;
        const bet = data.bets.find(b => b.bet === p.bet);
        if (!bet || bet.closingLine == null) return p;
        changed = true;
        return { ...p, closingLine: bet.closingLine };
      });
      const fresh = data.bets.filter(bet => !withCLV.some(p => p.bet===bet.bet && p.date===data.date));
      if (!fresh.length && !changed) return prev;
      const updated = fresh.length ? [...fresh.map(bet => betToEntry(bet, data.date)), ...withCLV] : withCLV;
      saveRecord(updated);
      return updated;
    });
  }, [data]);

  async function load() {
    setStatus("loading"); setError(null);
    try {
      const res  = await fetch("/api/picks");
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Server error " + res.status);
      if (!Array.isArray(body.bets)) throw new Error("No picks returned");
      setData(body);
    } catch(e) {
      setError(e.message);
    }
    setLanded([0, 1, 2].map(i => {
      const reelSymbols = [...SLOT_SYMBOLS.slice(i * 2), ...SLOT_SYMBOLS.slice(0, i * 2)];
      return reelSymbols.indexOf(SLOT_SYMBOLS[1]);
    }));
    setStatus("stopping");
    setTimeout(() => setStatus("done"), 2000);
  }

  async function resetAll() {
    if (!window.confirm("Clear today's locked picks and your tracked history? The next load will generate a fresh set of picks for today. This can't be undone.")) return;
    setRecord([]); saveRecord([]);
    try { await fetch("/api/reset", { method: "POST" }); } catch {}
    setData(null);
    load();
  }

  function settle(id, result)  { const u = record.map(p => p.id===id ? {...p,result} : p); setRecord(u); saveRecord(u); }
  function deletePick(id)      { const u = record.filter(p => p.id!==id); setRecord(u); saveRecord(u); }

  function gradeBet(p, game) {
    const betType = p.betType || "ml";
    const side = p.side || (p.bet.includes(p.home) ? "home" : "away");

    if (betType === "total") {
      if (p.line === null || p.line === undefined) return null;
      const total = game.homeScore + game.awayScore;
      if (total === p.line) return "push";
      const overHit = total > p.line;
      return (side === "over") === overHit ? "win" : "loss";
    }

    if (betType === "spread") {
      if (p.line === null || p.line === undefined) return null;
      const margin = side === "home" ? (game.homeScore - game.awayScore) : (game.awayScore - game.homeScore);
      const adjusted = margin + p.line;
      if (adjusted === 0) return "push";
      return adjusted > 0 ? "win" : "loss";
    }

    if (game.homeScore === game.awayScore) return "push";
    const winner = game.homeScore > game.awayScore ? "home" : "away";
    return side === winner ? "win" : "loss";
  }

  async function autoSettleRecord() {
    const pending = record.filter(p => p.result === "pending" && p.home && p.away && p.sport);
    if (!pending.length) return;

    const sports = [...new Set(pending.map(p => p.sport))];
    const scoresBySport = {};
    for (const sport of sports) {
      try {
        const r = await fetch(`/api/results?sport=${encodeURIComponent(sport)}`);
        const body = await r.json();
        if (r.ok) scoresBySport[sport] = body.games || [];
      } catch {}
    }

    let updated = record, changed = false;
    for (const p of pending) {
      const game = (scoresBySport[p.sport] || []).find(g => g.home === p.home && g.away === p.away);
      if (!game) continue;

      const result = gradeBet(p, game);
      if (!result) continue;
      updated = updated.map(x => x.id === p.id ? { ...x, result } : x);
      changed = true;
    }
    if (changed) { setRecord(updated); saveRecord(updated); }
  }

  async function syncClosingLines() {
    const targets = record.filter(p => (p.closingLine===null || p.closingLine===undefined) && p.home && p.away);
    if (!targets.length) return;
    setSyncingCLV(true);
    const updates = {};
    for (const p of targets) {
      try {
        const betType = p.betType || "ml";
        const r = await fetch(`/api/closing-line?sport=${encodeURIComponent(p.sport)}&home=${encodeURIComponent(p.home)}&away=${encodeURIComponent(p.away)}&betType=${encodeURIComponent(betType)}`);
        const body = await r.json();
        if (!r.ok) continue;
        const bk = body.books?.[p.book.toLowerCase()];
        if (!bk) continue;

        let price;
        if (betType === "total") {
          price = p.side === "under" ? bk.under : bk.over;
        } else {
          const side = p.side || (p.bet.includes(body.home) ? "home" : "away");
          price = side === "home" ? bk.home : bk.away;
        }
        if (price !== undefined && price !== null) updates[p.id] = price;
      } catch {}
    }
    if (Object.keys(updates).length) {
      const u = record.map(p => updates[p.id]!==undefined ? {...p, closingLine:updates[p.id]} : p);
      setRecord(u); saveRecord(u);
    }
    setSyncingCLV(false);
  }
  function saveSettingsHandler(br, up) { const s={bankroll:br,unitPct:up}; setSettings(s); saveSettings(s); }

  const pendingCount = record.filter(p => p.result==="pending").length;
  const overall = calcStats(record);

  return (
    <div style={{ minHeight:"100vh", background:"#050d0a", color:"#cdedb3", display:"flex", flexDirection:"column", alignItems:"center", fontFamily:"'DM Mono',monospace" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;700;800&family=DM+Mono:wght@400;500&display=swap'); *{box-sizing:border-box;margin:0;padding:0} @keyframes spin{to{transform:rotate(360deg)}} @keyframes slotSpin{from{transform:translateY(0)}to{transform:translateY(-50%)}} @keyframes fadeUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}} button:hover{opacity:0.85}`}</style>

      {/* HEADER */}
      <div style={{ width:"100%", maxWidth:540, padding:"24px 20px 0" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:4 }}>
          <div>
            <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:36, fontWeight:800, letterSpacing:2, lineHeight:1 }}>
              <span style={{ color:"#cef17b" }}>CURLY</span><span style={{ color:"#cdedb3" }}> LOCKS</span>
            </div>
            <div style={{ fontSize:9, color:"#3f6b58", marginTop:4, letterSpacing:1 }}>3 BEST BETS TODAY · LIVE ODDS</div>
          </div>
          <div style={{ display:"flex", flexDirection:"column", alignItems:"flex-end", gap:6 }}>
            {overall?.hitRate && <div style={{ background:parseFloat(overall.roi||0)>=0?"#22ff9914":"#ff554414", border:`1px solid ${parseFloat(overall.roi||0)>=0?"#22ff9933":"#ff554433"}`, borderRadius:5, padding:"3px 10px", fontSize:9, textAlign:"right", lineHeight:1.8, color:parseFloat(overall.roi||0)>=0?"#22ff99":"#ff5544" }}>
              {overall.wins}W-{overall.losses}L · {parseFloat(overall.roi||0)>=0?"+":""}{overall.roi}% ROI<br/>
              <span style={{ fontSize:8, color:"#3f6b58" }}>P&L {fmtDollars(unitsToDollars(parseFloat(overall.pl||0), bankroll, unitPct))}</span>
            </div>}
            <button onClick={load} disabled={status!=="done"} style={{ background:"none", border:"1px solid #0f2e22", color:"#3f6b58", borderRadius:6, padding:"4px 12px", cursor:status!=="done"?"not-allowed":"pointer", fontSize:10, opacity:status!=="done"?0.4:1, fontFamily:"'DM Mono',monospace" }}>{status!=="done"?"…":"⟳ refresh"}</button>
          </div>
        </div>

        <div style={{ display:"flex", marginTop:16, background:"#071210", border:"1px solid #0f2e22", borderRadius:8, padding:3 }}>
          <button onClick={() => setTab("bets")}     style={btn(tab==="bets")}>🔒 BETS</button>
          <button onClick={() => setTab("record")}   style={{ ...btn(tab==="record"), position:"relative" }}>
            📊 SCORE {pendingCount>0 && <span style={{ position:"absolute", top:4, right:6, background:"#ff8866", color:"#050d0a", borderRadius:10, fontSize:8, padding:"1px 5px", fontWeight:700 }}>{pendingCount}</span>}
          </button>
          <button onClick={() => setTab("settings")} style={btn(tab==="settings")}>⚙️ SETTINGS</button>
        </div>
        {data && tab==="bets" && <div style={{ fontSize:9, color:"#2c5443", marginTop:8 }}>{data.date}</div>}
      </div>

      {/* BODY */}
      <div style={{ width:"100%", maxWidth:540, padding:"14px 20px 44px", display:"flex", flexDirection:"column", gap:14 }}>

        {(status==="loading" || status==="stopping") && <div style={{ display:"flex", flexDirection:"column", alignItems:"center", padding:"70px 0", gap:14, color:"#3f6b58" }}>
          <div style={{ display:"flex", gap:6, background:"#08140f", border:"1px solid #cef17b44", borderRadius:8, padding:"8px 10px", boxShadow:"0 0 18px #cef17b22" }}>
            {[0.37, 0.53, 0.71].map((dur, i) => {
              const reelSymbols = [...SLOT_SYMBOLS.slice(i * 2), ...SLOT_SYMBOLS.slice(0, i * 2)];
              const stopping = status === "stopping";
              return (
                <div key={i} style={{ width:42, height:52, overflow:"hidden", borderRadius:5, background:"#050d0a", border:"1px solid #194232" }}>
                  <div style={{
                    display:"flex", flexDirection:"column",
                    animation: stopping ? "none" : `slotSpin ${dur}s linear infinite`,
                    animationDelay: stopping ? undefined : `-${(i * 0.17).toFixed(2)}s`,
                    transform: stopping ? `translateY(-${landed[i] * 52}px)` : undefined,
                    transition: stopping ? `transform 0.7s cubic-bezier(0.15,0.8,0.25,1) ${i * 0.6}s` : undefined,
                  }}>
                    {[...reelSymbols, ...reelSymbols].map((sym, j) => (
                      <div key={j} style={{ height:52, display:"flex", alignItems:"center", justifyContent:"center", fontSize:26 }}>{sym}</div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ fontSize:11, letterSpacing:1 }}>{status==="stopping" ? "LOCKING IN PICKS" : "PULLING LIVE ODDS"}</div>
          <div style={{ fontSize:9, color:"#2c5443" }}>Odds API → EV calc → Claude picks</div>
        </div>}

        {error && status==="done" && <div style={{ background:"#ff444414", border:"1px solid #ff444433", borderRadius:8, padding:16, textAlign:"center" }}>
          <div style={{ fontSize:12, color:"#ff8866", marginBottom:8 }}>Could not load picks</div>
          <div style={{ fontSize:10, color:"#cc5533", marginBottom:12, wordBreak:"break-word" }}>{error}</div>
          <button onClick={load} style={{ background:"#cef17b", color:"#050d0a", border:"none", borderRadius:6, padding:"8px 20px", fontSize:11, fontWeight:700, letterSpacing:1, cursor:"pointer", fontFamily:"'DM Mono',monospace" }}>⟳ TRY AGAIN</button>
        </div>}

        {!error && status==="done" && tab==="bets" && data?.bets?.length===0 && <div style={{ background:"#08140f", border:"1px solid #0f2e22", borderRadius:8, padding:24, textAlign:"center" }}>
          <div style={{ fontSize:12, color:"#7a9488", marginBottom:6 }}>No locks today</div>
          <div style={{ fontSize:10, color:"#3f6b58" }}>Nothing on the board cleared the bar for a sharp edge. Check back tomorrow.</div>
        </div>}

        {status==="done" && tab==="bets" && data?.bets?.map((bet, i) => {
          const rm = RM[i]||RM[2], sc = SC[bet.sport]||"#cef17b", sgc = SGC[bet.signal]||"#cef17b";
          const conf = bet.confidence||80;
          return (
            <div key={i} style={{ background:"#08140f", border:`1px solid ${rm.border}`, borderRadius:12, padding:"18px 18px 16px", animation:`fadeUp 0.3s ease ${i*0.1}s both`, boxShadow:`0 0 24px ${rm.glow}` }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:12 }}>
                <div style={{ display:"flex", alignItems:"center", gap:9 }}>
                  <span style={{ fontSize:20 }}>{rm.emoji}</span>
                  <div>
                    <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:11, fontWeight:700, color:rm.border, letterSpacing:2 }}>{rm.label}</div>
                    <div style={{ fontSize:9, color:"#2c5443", marginTop:1 }}>{bet.sport} · {bet.matchup}</div>
                  </div>
                </div>
                <div style={{ display:"flex", gap:6, alignItems:"center" }}>
                  <span style={{ background:sgc+"20", color:sgc, border:`1px solid ${sgc}44`, borderRadius:4, padding:"2px 7px", fontSize:9, fontWeight:700, letterSpacing:1 }}>{bet.signal}</span>
                  <span style={{ background:"#22ff9914", border:"1px solid #22ff9944", color:"#22ff99", borderRadius:4, padding:"2px 8px", fontSize:9, fontFamily:"'DM Mono',monospace" }}>✓ tracked</span>
                </div>
              </div>
              <div style={{ background:rm.border+"10", border:`1px solid ${rm.border}33`, borderRadius:8, padding:"11px 13px", marginBottom:12 }}>
                <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:22, fontWeight:800, color:"#cdedb3", marginBottom:8 }}>🔒 {bet.bet}</div>
                <div style={{ display:"flex", gap:18, flexWrap:"wrap" }}>
                  {[{l:"BOOK",v:bet.book,c:bet.book==="DraftKings"?"#cef17b":"#4a9fff"},{l:"ODDS",v:fmtOdds(bet.odds),c:"#cdedb3"},{l:"EDGE",v:bet.ev,c:"#22ff99"},{l:"CONFIDENCE",v:conf+"%",c:sc}].map(s => (
                    <div key={s.l}><div style={{ fontSize:8, color:"#3f6b58", marginBottom:3, letterSpacing:1 }}>{s.l}</div><div style={{ fontSize:13, fontWeight:700, color:s.c }}>{s.v}</div></div>
                  ))}
                </div>
              </div>
              <div style={{ height:3, background:"#0f2e22", borderRadius:2, overflow:"hidden", marginBottom:10 }}><div style={{ height:"100%", width:conf+"%", background:`linear-gradient(90deg,${rm.border},${rm.border}66)`, borderRadius:2 }} /></div>
              {bet.liability && (
                <div style={{ background:"#ff8c0018", border:"1px solid #ff8c0055", borderRadius:6, padding:"7px 12px", marginBottom:10, display:"flex", alignItems:"center", gap:8 }}>
                  <span style={{ fontSize:14 }}>🎯</span>
                  <div>
                    <div style={{ fontSize:10, fontWeight:700, color:"#ff8c00", letterSpacing:1 }}>OFFICIAL PLAY</div>
                    <div style={{ fontSize:9, color:"#a05a00", marginTop:1 }}>Reverse line + frozen line confirm books need the other side</div>
                  </div>
                </div>
              )}
              <div style={{ fontSize:11, color:"#7a9488", lineHeight:1.8 }}>{bet.reasoning}</div>
            </div>
          );
        })}

        {status==="done" && tab==="record"   && <RecordTab record={record} bankroll={bankroll} unitPct={unitPct} onSettle={settle} onDelete={deletePick} onSyncClosingLines={syncClosingLines} syncingCLV={syncingCLV} history={history} />}
        {                   tab==="settings" && <SettingsPanel bankroll={bankroll} unitPct={unitPct} onSave={saveSettingsHandler} onResetAll={resetAll} />}

        {status==="done" && <div style={{ textAlign:"center", fontSize:9, color:"#0f2e22", lineHeight:1.9, marginTop:4 }}>
          Curly Locks · Real odds via The Odds API · EV vs Pinnacle no-vig · Claude AI<br/>Not financial advice · Bet responsibly
        </div>}
      </div>
    </div>
  );
}
