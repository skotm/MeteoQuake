import { useContext, useEffect, useState } from "react";
import { Glass, PressableButton } from "./glass";
import { ThemeContext } from "./theme";
import {
  AMEDAS_ELEMENTS, amedasDateTimeLabel, amedasTimeLabel, buildAmedasDetailRows,
  formatAmedasValue, loadAmedasSeries,
} from "./weather/amedas";

/* ─────────────────────────────────────────────────────
   アメダスの時刻スライダー(直近3時間・10分刻み)。連続再生は付けない。
   frames: 古い→新しい(最後が最新)。frameIndex: 表示中のコマ。
   過去を見ている間は時刻を強調し、「現在に戻る」を出す。
   ───────────────────────────────────────────────────── */
export function AmedasTimeSlider({ frames, frameIndex, onChangeFrameIndex, onBackToLatest, loading = false, missing = false }) {
  const { tokens } = useContext(ThemeContext);
  if (!frames || frames.length === 0) return null;
  const last = frames.length - 1;
  const idx = Math.min(Math.max(frameIndex, 0), last);
  const isLatest = idx === last;
  const frame = frames[idx];
  return (
    <Glass radius={14} style={{ flex: 1, minWidth: 0, animation: "appear 0.3s cubic-bezier(.25,1,.5,1) backwards" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px" }}>
        <div style={{ flexShrink: 0, width: 78, lineHeight: 1.15 }}>
          <div style={{
            fontSize: 12.5, fontWeight: 700, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums",
            color: isLatest ? tokens.text : "#FF9F0A",
          }}>
            {amedasTimeLabel(frame.timeMs)}
          </div>
          <div style={{ fontSize: 9.5, color: `rgba(${tokens.ink},0.55)`, whiteSpace: "nowrap" }}>
            {missing ? "データなし" : loading ? "読み込み中…" : isLatest ? "最新" : `${(last - idx) * 10}分前`}
          </div>
        </div>
        <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
          <style>{`
            .amedas-range { -webkit-appearance: none; appearance: none; background: transparent; }
            .amedas-range::-webkit-slider-runnable-track { height: 4px; border-radius: 2px; background: rgba(${tokens.ink},0.16); }
            .amedas-range::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 10px; height: 26px; border-radius: 4px; background: #0A84FF; margin-top: -11px; cursor: pointer; }
            .amedas-range::-moz-range-track { height: 4px; border-radius: 2px; background: rgba(${tokens.ink},0.16); }
            .amedas-range::-moz-range-thumb { width: 10px; height: 26px; border-radius: 4px; background: #0A84FF; border: none; cursor: pointer; }
          `}</style>
          <div style={{ position: "absolute", left: 5, right: 5, top: "50%", transform: "translateY(-50%)", height: 22, pointerEvents: "none" }}>
            {frames.map((f, i) => {
              const pct = last > 0 ? (i / last) * 100 : 0;
              const hour = (last - i) % 6 === 0; // 1時間ごと
              return (
                <div key={f.validtime} style={{
                  position: "absolute", left: `${pct}%`, top: 0, transform: "translateX(-50%)",
                  width: i === last ? 2 : 1, height: i === last ? 22 : hour ? 18 : 11, borderRadius: 1,
                  background: i === last ? "#0A84FF" : `rgba(${tokens.ink},${hour ? 0.35 : 0.16})`,
                }}/>
              );
            })}
          </div>
          <input
            className="amedas-range" type="range" min={0} max={last} step={1} value={idx}
            onChange={(e) => onChangeFrameIndex(Number(e.target.value))}
            aria-label="アメダスの観測時刻"
            style={{ position: "relative", display: "block", width: "100%" }}
          />
        </div>
        {!isLatest && (
          <PressableButton
            onClick={onBackToLatest}
            style={{
              flexShrink: 0, padding: "5px 9px", borderRadius: 999, fontSize: 11, fontWeight: 700,
              color: tokens.text, background: `rgba(${tokens.ink},0.12)`, whiteSpace: "nowrap",
            }}
          >現在に戻る</PressableButton>
        )}
      </div>
    </Glass>
  );
}


/* ─────────────────────────────────────────────────────
   凡例(縦のカラーバー)。他の気象凡例と同じ右上に出す。
   ───────────────────────────────────────────────────── */
export function AmedasLegend({ elementId }) {
  const { tokens } = useContext(ThemeContext);
  const el = AMEDAS_ELEMENTS[elementId];
  if (!el) return null;
  const lo = el.stops[0][0], hi = el.stops[el.stops.length - 1][0];
  const gradient = `linear-gradient(to top, ${el.stops.map(([v, c]) => `${c} ${((v - lo) / (hi - lo)) * 100}%`).join(", ")})`;
  const BAR_H = 120;
  return (
    <Glass radius={12} style={{ width: "fit-content" }}>
      <div style={{ padding: "8px 10px", fontSize: 10.5, color: tokens.text }}>
        <div style={{ fontWeight: 700, marginBottom: 6, whiteSpace: "nowrap" }}>{el.label} <span style={{ opacity: 0.6, fontWeight: 600 }}>{el.unit}</span></div>
        <div style={{ display: "flex", gap: 6 }}>
          <div style={{ width: 10, height: BAR_H, borderRadius: 3, background: gradient, border: `0.5px solid rgba(${tokens.ink},0.3)` }}/>
          <div style={{ position: "relative", height: BAR_H, width: 28, fontVariantNumeric: "tabular-nums" }}>
            {el.legend.map(v => (
              <span key={v} style={{
                position: "absolute", left: 0, bottom: `${((v - lo) / (hi - lo)) * 100}%`,
                transform: "translateY(50%)", whiteSpace: "nowrap", lineHeight: 1,
              }}>{v}</span>
            ))}
          </div>
        </div>
      </div>
    </Glass>
  );
}


/* ─────────────────────────────────────────────────────
   観測点の詳細カード。最新値(表示中のコマ)は親から受け取り、
   直近3時間の推移(気温・降水量・風速)は観測点の時系列ファイルから取得する。
   ───────────────────────────────────────────────────── */
function MiniChart({ title, unit, rows, pick, kind, color, tokens }) {
  const pts = rows.map(r => ({ t: r.timeMs, v: pick(r) }));
  const vals = pts.map(p => p.v).filter(v => v != null);
  if (vals.length === 0) {
    return (
      <div style={{ fontSize: 10.5, color: `rgba(${tokens.ink},0.5)`, padding: "4px 0" }}>{title}: データなし</div>
    );
  }
  const W = 240, H = 46, PAD = 3;
  let min = Math.min(...vals), max = Math.max(...vals);
  if (kind === "bar") min = 0;
  if (max === min) { max = min + 1; }
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t || t0 + 1;
  const x = (t) => PAD + ((t - t0) / Math.max(1, t1 - t0)) * (W - PAD * 2);
  const y = (v) => H - PAD - ((v - min) / (max - min)) * (H - PAD * 2);
  const bw = Math.max(2, (W - PAD * 2) / Math.max(1, pts.length) - 1.5);
  let path = "";
  let pen = false; // 欠測をはさんだら線を切る
  pts.forEach(p => {
    if (p.v == null) { pen = false; return; }
    path += `${pen ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)} `;
    pen = true;
  });
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10.5, color: `rgba(${tokens.ink},0.6)`, marginBottom: 2 }}>
        <span style={{ fontWeight: 700, color: tokens.text }}>{title}</span>
        <span style={{ fontVariantNumeric: "tabular-nums" }}>{formatAmedasValue(min, 1)}〜{formatAmedasValue(max, 1)}{unit}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} style={{ display: "block", background: `rgba(${tokens.ink},0.05)`, borderRadius: 6 }}>
        {kind === "bar"
          ? pts.map((p, i) => p.v == null ? null : (
              <rect key={i} x={x(p.t) - bw / 2} y={y(p.v)} width={bw} height={Math.max(0, H - PAD - y(p.v))} fill={color} rx="1"/>
            ))
          : <path d={path} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"/>}
      </svg>
    </div>
  );
}

export function AmedasDetailCard({ station, entry, timeMs, latestMs, onClose }) {
  const { tokens } = useContext(ThemeContext);
  const [series, setSeries] = useState(null); // null=読み込み中, []=取得不可
  const code = station?.code;
  useEffect(() => {
    if (!code || latestMs == null) return undefined;
    let cancelled = false;
    setSeries(null);
    loadAmedasSeries(code, latestMs)
      .then(rows => { if (!cancelled) setSeries(rows); })
      .catch(() => { if (!cancelled) setSeries([]); });
    return () => { cancelled = true; };
  }, [code, latestMs]);

  if (!station) return null;
  const rows = buildAmedasDetailRows(entry);
  return (
    <Glass radius={14} style={{ width: 264, maxWidth: "100%", animation: "appear 0.25s cubic-bezier(.25,1,.5,1) backwards" }}>
      <div style={{ padding: "10px 12px", color: tokens.text, maxHeight: "52vh", overflowY: "auto" }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 800, lineHeight: 1.2 }}>{station.name}</div>
            <div style={{ fontSize: 10.5, color: `rgba(${tokens.ink},0.55)`, marginTop: 2 }}>
              アメダス {station.code} ・ {amedasDateTimeLabel(timeMs)} 観測
            </div>
          </div>
          <button onClick={onClose} aria-label="閉じる" style={{
            flexShrink: 0, width: 24, height: 24, borderRadius: 999, color: tokens.text,
            background: `rgba(${tokens.ink},0.1)`, fontSize: 14, lineHeight: 1,
          }}>×</button>
        </div>
        <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "auto 1fr", gap: "3px 10px", fontSize: 12 }}>
          {rows.length === 0 && <span style={{ gridColumn: "1 / -1", opacity: 0.6 }}>この時刻の観測値はありません</span>}
          {rows.map(r => (
            <span key={r.label} style={{ display: "contents" }}>
              <span style={{ color: `rgba(${tokens.ink},0.6)` }}>{r.label}</span>
              <span style={{ fontWeight: 700, fontVariantNumeric: "tabular-nums", textAlign: "right" }}>{r.text}</span>
            </span>
          ))}
        </div>
        <div style={{ marginTop: 10, fontSize: 10.5, fontWeight: 700, color: `rgba(${tokens.ink},0.55)` }}>直近3時間の推移</div>
        {series == null && <div style={{ fontSize: 11, opacity: 0.6, padding: "6px 0" }}>読み込み中…</div>}
        {series && series.length === 0 && <div style={{ fontSize: 11, opacity: 0.6, padding: "6px 0" }}>推移データを取得できませんでした</div>}
        {series && series.length > 0 && (
          <>
            <MiniChart title="気温" unit="℃" rows={series} pick={r => r.temp} kind="line" color="#ff7043" tokens={tokens}/>
            <MiniChart title="降水量(10分)" unit="mm" rows={series} pick={r => r.precip10m} kind="bar" color="#2196f3" tokens={tokens}/>
            <MiniChart title="風速" unit="m/s" rows={series} pick={r => r.wind} kind="line" color="#26a69a" tokens={tokens}/>
          </>
        )}
      </div>
    </Glass>
  );
}
