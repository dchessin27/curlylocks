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
const SC  = { NFL:"#c8a84b", NBA:"#e85d3a", MLB:"#4aade8", NHL:"#7ecfcf" };
const SI  = { NFL:"🏈", NBA:"🏀", MLB:"⚾", NHL:"🏒" };
const SGC = { EV:"#c8a84b", STEAM:"#ff8866", RLM:"#aa88ff", ARB:"#22ff99" };
const RM  = [
  { label:"LOCK #1", emoji:"🥇", border:"#c8a84b", glow:"#c8a84b33" },
  { label:"LOCK #2", emoji:"🥈", border:"#888",    glow:"#88888822" },
  { label:"LOCK #3", emoji:"🥉", border:"#7c4d1a", glow:"#7c4d1a22" },
];

const btn = (active, color="#c8a84b") => ({
  flex:1, background: active ? color+"22":"none",
  border:`1px solid ${active ? color+"44":"transparent"}`,
  color: active ? color:"#445566",
  borderRadius:6, padding:"7px 0", cursor:"pointer", fontSize:10, letterSpacing:0.5,
  fontFamily:"'DM Mono',monospace",
});

// ─── STAT PILL ────────────────────────────────────────────────────────────────
function StatPill({ label, value, color }) {
  return (
    <div style={{ background:"#0a0a14", border:`1px solid ${color}33`, borderRadius:6, padding:"8px 10px", textAlign:"center", minWidth:64 }}>
      <div style={{ fontSize:8, color:"#445566", letterSpacing:1, marginBottom:4 }}>{label}</div>
      <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:18, fontWeight:800, color }}>{value ?? "—"}</div>
    </div>
  );
}

// ─── SCORE ROW ────────────────────────────────────────────────────────────────
function ScoreRow({ label, picks, color, bankroll, unitPct=1 }) {
  const s = calcStats(picks);
  if (!s) return null;
  const rc = s.roi === null ? "#445566" : parseFloat(s.roi) >= 0 ? "#22ff99" : "#ff5544";
  const hc = s.hitRate === null ? "#445566" : parseFloat(s.hitRate) >= 55 ? "#22ff99" : parseFloat(s.hitRate) >= 48 ? "#c8a84b" : "#ff5544";
  return (
    <div style={{ background:"#0c0c18", border:`1px solid ${color}33`, borderRadius:8, padding:"12px 14px" }}>
      <div style={{ display:"flex", justifyContent:"space-between", marginBottom:10 }}>
        <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:15, fontWeight:700, color, letterSpacing:1 }}>{label}</div>
        <div style={{ fontSize:9, color:"#334455" }}>{s.settled}/{s.total}</div>
      </div>
      <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
        <StatPill label="HIT RATE" value={s.hitRate ? s.hitRate+"%" : "—"} color={hc} />
        <StatPill label="ROI"      value={s.roi     ? s.roi    +"%" : "—"} color={rc} />
        <StatPill label="RECORD"   value={`${s.wins}-${s.losses}`}          color={color} />
        <StatPill label="P&L ($)"  value={s.pl !== undefined ? fmtDollars(unitsToDollars(parseFloat(s.pl), bankroll, unitPct)) : "—"} color={rc} />
      </div>
      {s.hitRate && <div style={{ marginTop:10, height:3, background:"#1a1a2e", borderRadius:2, overflow:"hidden" }}><div style={{ height:"100%", width:`${Math.min(100,parseFloat(s.hitRate))}%`, background:`linear-gradient(90deg,${color},${color}66)`, borderRadius:2 }} /></div>}
    </div>
  );
}

// ─── RECORD TAB ───────────────────────────────────────────────────────────────
function CLVBadge({ pick }) {
  const clv = calcCLV(pick);
  if (clv === null) return <span style={{ fontSize:9, color:"#334455" }}>CL pending</span>;
  return (
    <span style={{ fontSize:9, fontWeight:700, color: clv>=0 ? "#22ff99":"#ff5544" }}>
      Close {fmtOdds(pick.closingLine)} · {clv>=0?"+":""}{clv.toFixed(1)}% CLV
    </span>
  );
}

function RecordTab({ record, bankroll, unitPct, onSettle, onDelete, onSyncClosingLines, syncingCLV }) {
  const [view, setView] = useState("overview");
  const overall  = calcStats(record);
  const bySport  = groupBy(record, "sport");
  const bySignal = groupBy(record, "signal");
  const pending  = record.filter(p => p.result === "pending");
  const settled  = [...record].filter(p => p.result !== "pending").reverse();
  const rc = !overall || overall.roi===null ? "#c8a84b" : parseFloat(overall.roi)>=0 ? "#22ff99" : "#ff5544";
  const clvStats = calcCLVStats(record);
  const clvc = clvStats && parseFloat(clvStats.avgCLV)>=0 ? "#22ff99" : "#ff5544";

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
      <div style={{ display:"flex", background:"#0a0a14", border:"1px solid #1a1a2e", borderRadius:8, padding:3 }}>
        {[["overview","📊 Overview"],["sport","🏆 Sport"],["signal","⚡ Signal"],["history","📋 History"]].map(([k,l]) => (
          <button key={k} onClick={() => setView(k)} style={{ ...btn(view===k), padding:"5px 0", fontSize:9 }}>{l}</button>
        ))}
      </div>

      {view === "overview" && (
        <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
          {!overall || overall.total === 0
            ? <div style={{ textAlign:"center", padding:"50px 0", color:"#334455", fontSize:10 }}>No picks logged yet.<br/>Go to BETS and hit + LOG.</div>
            : <>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
                <div style={{ background:"#0c0c18", border:"1px solid #1a1a2e", borderRadius:8, padding:"14px 16px" }}>
                  <div style={{ fontSize:9, color:"#445566", letterSpacing:1, marginBottom:6 }}>OVERALL RECORD</div>
                  <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:30, fontWeight:800, color:"#e0e0f8" }}>
                    {overall.wins}<span style={{ color:"#334455", fontSize:20 }}>-</span>{overall.losses}
                    {overall.pushes > 0 && <span style={{ color:"#445566", fontSize:16 }}>-{overall.pushes}</span>}
                  </div>
                  <div style={{ fontSize:9, color:"#445566", marginTop:3 }}>{overall.total} picks total</div>
                </div>
                <div style={{ background:"#0c0c18", border:`1px solid ${rc}33`, borderRadius:8, padding:"14px 16px" }}>
                  <div style={{ fontSize:9, color:"#445566", letterSpacing:1, marginBottom:6 }}>ALL-TIME ROI</div>
                  <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:30, fontWeight:800, color:rc }}>
                    {overall.roi !== null ? (parseFloat(overall.roi)>=0?"+":"")+overall.roi+"%" : "—"}
                  </div>
                  <div style={{ fontSize:9, color:"#445566", marginTop:3 }}>{overall.hitRate ? overall.hitRate+"% hit rate" : "pending"}</div>
                </div>
              </div>

              {overall.settled > 0 && (
                <div style={{ background:"#0c0c18", border:`1px solid ${rc}33`, borderRadius:8, padding:"12px 16px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                  <div>
                    <div style={{ fontSize:9, color:"#445566", letterSpacing:1, marginBottom:4 }}>TOTAL P&L</div>
                    <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:26, fontWeight:800, color:rc }}>{fmtDollars(unitsToDollars(parseFloat(overall.pl), bankroll, unitPct))}</div>
                  </div>
                  <div style={{ textAlign:"right" }}>
                    <div style={{ fontSize:9, color:"#445566", marginBottom:4 }}>UNITS</div>
                    <div style={{ fontSize:14, color:rc, fontWeight:700 }}>{parseFloat(overall.pl)>=0?"+":""}{overall.pl}u</div>
                    <div style={{ fontSize:8, color:"#334455", marginTop:2 }}>1u = ${(bankroll*unitPct/100).toFixed(0)}</div>
                  </div>
                </div>
              )}

              <div style={{ background:"#0c0c18", border:`1px solid ${clvStats?clvc+"33":"#1a1a2e"}`, borderRadius:8, padding:"12px 16px" }}>
                {clvStats ? (
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
                    <div>
                      <div style={{ fontSize:9, color:"#445566", letterSpacing:1, marginBottom:4 }}>AVG CLOSING LINE VALUE</div>
                      <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:26, fontWeight:800, color:clvc }}>{parseFloat(clvStats.avgCLV)>=0?"+":""}{clvStats.avgCLV}%</div>
                    </div>
                    <div style={{ textAlign:"right" }}>
                      <div style={{ fontSize:9, color:"#445566", marginBottom:4 }}>BEAT CLOSE</div>
                      <div style={{ fontSize:14, color:clvc, fontWeight:700 }}>{clvStats.beatPct}%</div>
                      <div style={{ fontSize:8, color:"#334455", marginTop:2 }}>{clvStats.count} picks tracked</div>
                    </div>
                  </div>
                ) : (
                  <div style={{ fontSize:9, color:"#445566", marginBottom:10 }}>No closing lines synced yet — works best once a game has tipped off or the line has set.</div>
                )}
                <button onClick={onSyncClosingLines} disabled={syncingCLV} style={{ width:"100%", background:"#c8a84b14", border:"1px solid #c8a84b44", color:"#c8a84b", borderRadius:6, padding:"7px 0", cursor:syncingCLV?"default":"pointer", fontSize:9, fontFamily:"'DM Mono',monospace", letterSpacing:1 }}>
                  {syncingCLV ? "SYNCING..." : "🔄 SYNC CLOSING LINES"}
                </button>
              </div>

              {overall.hitRate && (
                <div style={{ background:"#0c0c18", border:"1px solid #1a1a2e", borderRadius:8, padding:"12px 14px" }}>
                  <div style={{ display:"flex", justifyContent:"space-between", fontSize:9, color:"#445566", marginBottom:8 }}>
                    <span>Win Rate</span>
                    <span style={{ color: parseFloat(overall.hitRate)>=52.4 ? "#22ff99":"#ff5544", fontWeight:700 }}>
                      {parseFloat(overall.hitRate)>=52.4 ? "✓ PROFITABLE" : "✗ BELOW BREAKEVEN"}
                    </span>
                  </div>
                  <div style={{ height:6, background:"#1a1a2e", borderRadius:3, overflow:"hidden", position:"relative" }}>
                    <div style={{ height:"100%", width:`${Math.min(100,parseFloat(overall.hitRate))}%`, background:"linear-gradient(90deg,#ff5544,#c8a84b,#22ff99)", borderRadius:3 }} />
                    <div style={{ position:"absolute", top:0, left:"52.4%", width:2, height:"100%", background:"#ffffff55" }} />
                  </div>
                  <div style={{ display:"flex", justifyContent:"space-between", fontSize:8, color:"#334455", marginTop:4 }}>
                    <span>0%</span><span style={{ color:"#778899" }}>52.4% breakeven</span><span>100%</span>
                  </div>
                </div>
              )}

              {pending.length > 0 && (
                <div>
                  <div style={{ fontSize:9, color:"#c8a84b", letterSpacing:1, marginBottom:8 }}>PENDING ({pending.length})</div>
                  {pending.map(p => (
                    <div key={p.id} style={{ background:"#0c0c18", border:"1px solid #1a1a2e", borderRadius:7, padding:"10px 12px", marginBottom:6, display:"flex", justifyContent:"space-between", alignItems:"center", gap:10 }}>
                      <div style={{ minWidth:0 }}>
                        <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:14, fontWeight:700, color:"#e0e0f8" }}>{p.bet}</div>
                        <div style={{ fontSize:9, color:"#445566", marginTop:2 }}>{p.book} {fmtOdds(p.odds)} · {p.sport} · {p.date}</div>
                        <div style={{ marginTop:5 }}><CLVBadge pick={p} /></div>
                      </div>
                      <div style={{ display:"flex", gap:5, flexShrink:0 }}>
                        {["win","loss","push"].map(r => (
                          <button key={r} onClick={() => onSettle(p.id, r)} style={{ background:r==="win"?"#22ff9920":r==="loss"?"#ff554420":"#44444420", border:`1px solid ${r==="win"?"#22ff9944":r==="loss"?"#ff554444":"#44444444"}`, color:r==="win"?"#22ff99":r==="loss"?"#ff5544":"#888", borderRadius:3, padding:"4px 9px", cursor:"pointer", fontSize:9 }}>{r.toUpperCase()}</button>
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

      {view === "sport" && (
        <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
          {Object.keys(SC).map(sport => {
            const picks = bySport[sport] || [];
            if (!picks.length) return (
              <div key={sport} style={{ background:"#0c0c18", border:"1px solid #1a1a2e", borderRadius:8, padding:"10px 14px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                <div style={{ display:"flex", gap:8, alignItems:"center" }}><span>{SI[sport]}</span><span style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:14, fontWeight:700, color:SC[sport] }}>{sport}</span></div>
                <span style={{ fontSize:9, color:"#334455" }}>No picks yet</span>
              </div>
            );
            return (
              <div key={sport}>
                <ScoreRow label={`${SI[sport]} ${sport}`} picks={picks} color={SC[sport]} bankroll={bankroll} unitPct={unitPct} />
                {Object.entries(groupBy(picks,"signal")).map(([sig,sp]) => {
                  const ss = calcStats(sp);
                  if (!ss || !ss.settled) return null;
                  return <div key={sig} style={{ marginTop:4, background:"#09090f", border:`1px solid ${SGC[sig]||"#c8a84b"}22`, borderRadius:5, padding:"7px 12px", display:"flex", justifyContent:"space-between" }}><span style={{ fontSize:9, color:SGC[sig]||"#c8a84b" }}>↳ {sig}</span><div style={{ display:"flex", gap:14 }}><span style={{ fontSize:10, color:"#778899" }}>{ss.wins}W-{ss.losses}L</span>{ss.hitRate && <span style={{ fontSize:10, fontWeight:700, color:parseFloat(ss.hitRate)>=55?"#22ff99":"#ff5544" }}>{ss.hitRate}%</span>}</div></div>;
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
            if (!picks.length) return <div key={sig} style={{ background:"#0c0c18", border:"1px solid #1a1a2e", borderRadius:8, padding:"10px 14px", display:"flex", justifyContent:"space-between", alignItems:"center" }}><span style={{ fontSize:12, color, fontWeight:700, letterSpacing:1 }}>{sig}</span><span style={{ fontSize:9, color:"#334455" }}>No picks yet</span></div>;
            return <ScoreRow key={sig} label={sig} picks={picks} color={color} bankroll={bankroll} unitPct={unitPct} />;
          })}
        </div>
      )}

      {view === "history" && (
        <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
          {settled.length === 0 && <div style={{ textAlign:"center", padding:"40px 0", color:"#334455", fontSize:10 }}>No settled picks yet.</div>}
          {settled.map(p => {
            const isWin = p.result==="win", isLoss = p.result==="loss";
            const pl = pickPL(p);
            return (
              <div key={p.id} style={{ background:"#0c0c18", border:`1px solid ${isWin?"#22ff9933":isLoss?"#ff554433":"#1a1a2e"}`, borderLeft:`3px solid ${isWin?"#22ff99":isLoss?"#ff5544":"#445566"}`, borderRadius:7, padding:"10px 13px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:14, fontWeight:700, color:isWin?"#22ff99":isLoss?"#ff7766":"#888" }}>{p.bet}</div>
                  <div style={{ fontSize:9, color:"#445566", marginTop:2 }}>{SI[p.sport]} {p.sport} · {p.signal} · {p.book} {fmtOdds(p.odds)} · {p.date}</div>
                  <div style={{ marginTop:5 }}><CLVBadge pick={p} /></div>
                </div>
                <div style={{ display:"flex", alignItems:"center", gap:6, flexShrink:0, marginLeft:10 }}>
                  <div style={{ textAlign:"right" }}>
                    <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:16, fontWeight:700, color:isWin?"#22ff99":isLoss?"#ff5544":"#888" }}>{fmtDollars(unitsToDollars(pl, bankroll, unitPct))}</div>
                    <div style={{ fontSize:8, color:"#334455", marginTop:1 }}>{isWin?"+":isLoss?"-":""}{Math.abs(pl).toFixed(0)}u</div>
                  </div>
                  <button onClick={() => onSettle(p.id,"pending")} style={{ background:"#c8a84b14", border:"1px solid #c8a84b33", color:"#c8a84b", borderRadius:3, padding:"3px 7px", cursor:"pointer", fontSize:10 }}>↩</button>
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
function SettingsPanel({ bankroll, unitPct, onSave }) {
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
      <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:18, fontWeight:800, color:"#e0e0f8", letterSpacing:1 }}>⚙️ BANKROLL SETTINGS</div>

      <div style={{ background:"#0c0c18", border:"1px solid #1a1a2e", borderRadius:10, padding:"16px 18px" }}>
        <div style={{ fontSize:9, color:"#c8a84b", letterSpacing:1, marginBottom:12 }}>YOUR BANKROLL</div>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <span style={{ fontSize:20, color:"#445566" }}>$</span>
          <input type="number" value={br} onChange={e => setBr(e.target.value)} style={{ flex:1, background:"#0a0a14", border:"1px solid #2a2a3e", borderRadius:6, color:"#e0e0f8", padding:"10px 14px", fontSize:18, fontFamily:"'Barlow Condensed',sans-serif", fontWeight:700, outline:"none" }} />
        </div>
        <div style={{ fontSize:9, color:"#334455", marginTop:8 }}>Total funds dedicated to sports betting</div>
      </div>

      <div style={{ background:"#0c0c18", border:"1px solid #1a1a2e", borderRadius:10, padding:"16px 18px" }}>
        <div style={{ fontSize:9, color:"#c8a84b", letterSpacing:1, marginBottom:12 }}>UNIT SIZE (% OF BANKROLL)</div>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <input type="number" value={up} min="0.5" max="5" step="0.5" onChange={e => setUp(e.target.value)} style={{ flex:1, background:"#0a0a14", border:"1px solid #2a2a3e", borderRadius:6, color:"#e0e0f8", padding:"10px 14px", fontSize:18, fontFamily:"'Barlow Condensed',sans-serif", fontWeight:700, outline:"none" }} />
          <span style={{ fontSize:20, color:"#445566" }}>%</span>
        </div>
        <div style={{ display:"flex", gap:6, marginTop:10 }}>
          {[["0.5","Conservative"],["1","Standard"],["2","Aggressive"],["3","Max"]].map(([v,l]) => (
            <button key={v} onClick={() => setUp(v)} style={{ flex:1, background:up===v?"#c8a84b22":"#0a0a14", border:`1px solid ${up===v?"#c8a84b55":"#1a1a2e"}`, color:up===v?"#c8a84b":"#445566", borderRadius:5, padding:"5px 0", cursor:"pointer", fontSize:8, fontFamily:"'DM Mono',monospace" }}>{v}%<br/><span style={{ fontSize:7, color:"#334455" }}>{l}</span></button>
          ))}
        </div>
      </div>

      <div style={{ background:"#0c0c18", border:"1px solid #c8a84b33", borderRadius:10, padding:"16px 18px" }}>
        <div style={{ fontSize:9, color:"#c8a84b", letterSpacing:1, marginBottom:14 }}>LIVE PREVIEW</div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:10 }}>
          {[{l:"BANKROLL",v:brV>=1000?"$"+(brV/1000).toFixed(0)+"k":"$"+brV,c:"#e0e0f8"},{l:"1 UNIT =",v:"$"+unitAmt.toFixed(0),c:"#c8a84b"},{l:"BET SIZE",v:"$"+unitAmt.toFixed(0),c:"#22ff99"}].map(s => (
            <div key={s.l} style={{ background:"#0a0a14", border:`1px solid ${s.c}22`, borderRadius:6, padding:"10px 0", textAlign:"center" }}>
              <div style={{ fontSize:8, color:"#445566", letterSpacing:1, marginBottom:5 }}>{s.l}</div>
              <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:20, fontWeight:800, color:s.c }}>{s.v}</div>
            </div>
          ))}
        </div>
        <div style={{ marginTop:14 }}>
          <div style={{ fontSize:9, color:"#445566", letterSpacing:1, marginBottom:8 }}>EXAMPLE OUTCOMES</div>
          {[{l:"Win at -110",pl:+(unitAmt*100/110),c:"#22ff99"},{l:"Win at +115",pl:+(unitAmt*1.15),c:"#22ff99"},{l:"Loss",pl:-unitAmt,c:"#ff5544"},{l:"3-0 week",pl:+(unitAmt*100/110)*3,c:"#c8a84b"},{l:"2-1 week",pl:+(unitAmt*100/110)*2-unitAmt,c:"#c8a84b"}].map(row => (
            <div key={row.l} style={{ display:"flex", justifyContent:"space-between", padding:"5px 10px", background:"#07070f", borderRadius:5, marginBottom:4 }}>
              <span style={{ fontSize:10, color:"#667" }}>{row.l}</span>
              <span style={{ fontSize:11, fontWeight:700, color:row.c, fontFamily:"'Barlow Condensed',sans-serif" }}>{row.pl>=0?"+":""}${Math.abs(row.pl).toFixed(0)}</span>
            </div>
          ))}
        </div>
      </div>

      <button onClick={handleSave} style={{ width:"100%", background:saved?"#22ff9922":"#c8a84b", color:saved?"#22ff99":"#07070f", border:`1px solid ${saved?"#22ff9955":"transparent"}`, borderRadius:8, padding:"14px 0", fontSize:12, fontFamily:"'Barlow Condensed',sans-serif", fontWeight:700, letterSpacing:1, cursor:"pointer" }}>{saved ? "✓ SAVED" : "SAVE SETTINGS"}</button>
      <div style={{ fontSize:9, color:"#223", textAlign:"center", lineHeight:1.8 }}>Settings saved locally · Sharp sizing = 1-2% per bet<br/>Not financial advice · Bet responsibly</div>
    </div>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [tab,      setTab]      = useState("bets");
  const [status,   setStatus]   = useState("loading");
  const [data,     setData]     = useState(null);
  const [error,    setError]    = useState(null);
  const [record,   setRecord]   = useState(() => loadRecord());
  const [syncingCLV, setSyncingCLV] = useState(false);
  const [settings, setSettings] = useState(() => loadSettings());
  const { bankroll, unitPct } = settings;

  useEffect(() => { load(); }, []);

  async function load() {
    setStatus("loading"); setError(null);
    try {
      const res  = await fetch("/api/picks");
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Server error " + res.status);
      if (!body.bets?.length) throw new Error("No picks returned");
      setData(body);
    } catch(e) {
      setError(e.message);
    }
    setStatus("done");
  }

  function addToRecord(bet, date) {
    // matchup format from Claude is "Away @ Home"
    const [away, home] = (bet.matchup || "").split("@").map(s => s.trim());
    const entry = { id: Date.now()+Math.random(), date, bet:bet.bet, sport:bet.sport, signal:bet.signal, book:bet.book, odds:parseOdds(bet.odds), ev:bet.ev, confidence:bet.confidence, matchup:bet.matchup, home, away, result:"pending", closingLine:null };
    const u = [entry, ...record]; setRecord(u); saveRecord(u);
  }
  function settle(id, result)  { const u = record.map(p => p.id===id ? {...p,result} : p); setRecord(u); saveRecord(u); }
  function deletePick(id)      { const u = record.filter(p => p.id!==id); setRecord(u); saveRecord(u); }
  function removeFromRecord(bet, date) {
    const u = record.filter(p => !(p.bet===bet.bet && p.date===date)); setRecord(u); saveRecord(u);
  }

  async function syncClosingLines() {
    const targets = record.filter(p => (p.closingLine===null || p.closingLine===undefined) && p.home && p.away);
    if (!targets.length) return;
    setSyncingCLV(true);
    const updates = {};
    for (const p of targets) {
      try {
        const r = await fetch(`/api/closing-line?sport=${encodeURIComponent(p.sport)}&home=${encodeURIComponent(p.home)}&away=${encodeURIComponent(p.away)}`);
        const body = await r.json();
        if (!r.ok) continue;
        const bk = body.books?.[p.book.toLowerCase()];
        if (!bk) continue;
        const isHome = p.bet.includes(body.home);
        const price = isHome ? bk.home : bk.away;
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
    <div style={{ minHeight:"100vh", background:"#07070f", color:"#c0c0e0", display:"flex", flexDirection:"column", alignItems:"center", fontFamily:"'DM Mono',monospace" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;700;800&family=DM+Mono:wght@400;500&display=swap'); *{box-sizing:border-box;margin:0;padding:0} @keyframes spin{to{transform:rotate(360deg)}} @keyframes fadeUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}} button:hover{opacity:0.85}`}</style>

      {/* HEADER */}
      <div style={{ width:"100%", maxWidth:540, padding:"24px 20px 0" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:4 }}>
          <div>
            <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:36, fontWeight:800, letterSpacing:2, lineHeight:1 }}>
              <span style={{ color:"#c8a84b" }}>CURLY</span><span style={{ color:"#e0e0f8" }}> LOCKS</span>
            </div>
            <div style={{ fontSize:9, color:"#445566", marginTop:4, letterSpacing:1 }}>3 BEST BETS TODAY · LIVE ODDS</div>
          </div>
          <div style={{ display:"flex", flexDirection:"column", alignItems:"flex-end", gap:6 }}>
            {overall?.hitRate && <div style={{ background:parseFloat(overall.roi||0)>=0?"#22ff9914":"#ff554414", border:`1px solid ${parseFloat(overall.roi||0)>=0?"#22ff9933":"#ff554433"}`, borderRadius:5, padding:"3px 10px", fontSize:9, textAlign:"right", lineHeight:1.8, color:parseFloat(overall.roi||0)>=0?"#22ff99":"#ff5544" }}>
              {overall.wins}W-{overall.losses}L · {parseFloat(overall.roi||0)>=0?"+":""}{overall.roi}% ROI<br/>
              <span style={{ fontSize:8, color:"#556677" }}>P&L {fmtDollars(unitsToDollars(parseFloat(overall.pl||0), bankroll, unitPct))}</span>
            </div>}
            <button onClick={load} disabled={status==="loading"} style={{ background:"none", border:"1px solid #1a1a2e", color:"#445566", borderRadius:6, padding:"4px 12px", cursor:status==="loading"?"not-allowed":"pointer", fontSize:10, opacity:status==="loading"?0.4:1, fontFamily:"'DM Mono',monospace" }}>{status==="loading"?"…":"⟳ refresh"}</button>
          </div>
        </div>

        <div style={{ display:"flex", marginTop:16, background:"#0a0a14", border:"1px solid #1a1a2e", borderRadius:8, padding:3 }}>
          <button onClick={() => setTab("bets")}     style={btn(tab==="bets")}>🔒 BETS</button>
          <button onClick={() => setTab("record")}   style={{ ...btn(tab==="record"), position:"relative" }}>
            📊 SCORE {pendingCount>0 && <span style={{ position:"absolute", top:4, right:6, background:"#ff8866", color:"#07070f", borderRadius:10, fontSize:8, padding:"1px 5px", fontWeight:700 }}>{pendingCount}</span>}
          </button>
          <button onClick={() => setTab("settings")} style={btn(tab==="settings")}>⚙️ SETTINGS</button>
        </div>
        {data && tab==="bets" && <div style={{ fontSize:9, color:"#334455", marginTop:8 }}>{data.date}</div>}
      </div>

      {/* BODY */}
      <div style={{ width:"100%", maxWidth:540, padding:"14px 20px 44px", display:"flex", flexDirection:"column", gap:14 }}>

        {status==="loading" && <div style={{ display:"flex", flexDirection:"column", alignItems:"center", padding:"70px 0", gap:14, color:"#445566" }}>
          <div style={{ fontSize:30, animation:"spin 1s linear infinite" }}>⟳</div>
          <div style={{ fontSize:11, letterSpacing:1 }}>PULLING LIVE ODDS</div>
          <div style={{ fontSize:9, color:"#334455" }}>Odds API → EV calc → Claude picks</div>
        </div>}

        {error && status==="done" && <div style={{ background:"#ff444414", border:"1px solid #ff444433", borderRadius:8, padding:16, textAlign:"center" }}>
          <div style={{ fontSize:12, color:"#ff8866", marginBottom:8 }}>Could not load picks</div>
          <div style={{ fontSize:10, color:"#cc5533", marginBottom:12, wordBreak:"break-word" }}>{error}</div>
          <button onClick={load} style={{ background:"#c8a84b", color:"#07070f", border:"none", borderRadius:6, padding:"8px 20px", fontSize:11, fontWeight:700, letterSpacing:1, cursor:"pointer", fontFamily:"'DM Mono',monospace" }}>⟳ TRY AGAIN</button>
        </div>}

        {status==="done" && tab==="bets" && data?.bets?.map((bet, i) => {
          const rm = RM[i]||RM[2], sc = SC[bet.sport]||"#c8a84b", sgc = SGC[bet.signal]||"#c8a84b";
          const conf = bet.confidence||80;
          const logged = record.some(p => p.bet===bet.bet && p.date===data.date);
          return (
            <div key={i} style={{ background:"#0c0c18", border:`1px solid ${rm.border}`, borderRadius:12, padding:"18px 18px 16px", animation:`fadeUp 0.3s ease ${i*0.1}s both`, boxShadow:`0 0 24px ${rm.glow}` }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:12 }}>
                <div style={{ display:"flex", alignItems:"center", gap:9 }}>
                  <span style={{ fontSize:20 }}>{rm.emoji}</span>
                  <div>
                    <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:11, fontWeight:700, color:rm.border, letterSpacing:2 }}>{rm.label}</div>
                    <div style={{ fontSize:9, color:"#334455", marginTop:1 }}>{bet.sport} · {bet.matchup}</div>
                  </div>
                </div>
                <div style={{ display:"flex", gap:6, alignItems:"center" }}>
                  <span style={{ background:sgc+"20", color:sgc, border:`1px solid ${sgc}44`, borderRadius:4, padding:"2px 7px", fontSize:9, fontWeight:700, letterSpacing:1 }}>{bet.signal}</span>
                  <button onClick={() => logged ? removeFromRecord(bet, data.date) : addToRecord(bet, data.date)} style={{ background:logged?"#22ff9914":"#c8a84b14", border:`1px solid ${logged?"#22ff9944":"#c8a84b44"}`, color:logged?"#22ff99":"#c8a84b", borderRadius:4, padding:"2px 8px", cursor:"pointer", fontSize:9, fontFamily:"'DM Mono',monospace" }}>{logged?"✓ logged":"+ log"}</button>
                </div>
              </div>
              <div style={{ background:rm.border+"10", border:`1px solid ${rm.border}33`, borderRadius:8, padding:"11px 13px", marginBottom:12 }}>
                <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:22, fontWeight:800, color:"#e8e8ff", marginBottom:8 }}>🔒 {bet.bet}</div>
                <div style={{ display:"flex", gap:18, flexWrap:"wrap" }}>
                  {[{l:"BOOK",v:bet.book,c:bet.book==="DraftKings"?"#c8a84b":"#4a9fff"},{l:"ODDS",v:fmtOdds(bet.odds),c:"#e0e0f8"},{l:"EDGE",v:bet.ev,c:"#22ff99"},{l:"CONFIDENCE",v:conf+"%",c:sc}].map(s => (
                    <div key={s.l}><div style={{ fontSize:8, color:"#445566", marginBottom:3, letterSpacing:1 }}>{s.l}</div><div style={{ fontSize:13, fontWeight:700, color:s.c }}>{s.v}</div></div>
                  ))}
                </div>
              </div>
              <div style={{ height:3, background:"#1a1a2e", borderRadius:2, overflow:"hidden", marginBottom:10 }}><div style={{ height:"100%", width:conf+"%", background:`linear-gradient(90deg,${rm.border},${rm.border}66)`, borderRadius:2 }} /></div>
              <div style={{ fontSize:11, color:"#778899", lineHeight:1.8 }}>{bet.reasoning}</div>
            </div>
          );
        })}

        {status==="done" && tab==="record"   && <RecordTab record={record} bankroll={bankroll} unitPct={unitPct} onSettle={settle} onDelete={deletePick} onSyncClosingLines={syncClosingLines} syncingCLV={syncingCLV} />}
        {                   tab==="settings" && <SettingsPanel bankroll={bankroll} unitPct={unitPct} onSave={saveSettingsHandler} />}

        {status==="done" && <div style={{ textAlign:"center", fontSize:9, color:"#1a1a2e", lineHeight:1.9, marginTop:4 }}>
          Curly Locks · Real odds via The Odds API · EV vs Pinnacle no-vig · Claude AI<br/>Not financial advice · Bet responsibly
        </div>}
      </div>
    </div>
  );
}
