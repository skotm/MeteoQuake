import { useContext, useEffect, useRef, useState } from "react";
import { Glass } from "./glass";
import { ThemeContext } from "./theme";
import {
  AMEDAS_ELEMENTS, amedasDateTimeLabel, amedasTimeLabel, buildAmedasDetailModel,
  formatAmedasValue, loadAmedasSeries,
} from "./weather/amedas";

/* ─────────────────────────────────────────────────────
   アメダスの時刻スライダー(直近3時間・10分刻み)。連続再生は付けない。
   frames: 古い→新しい(最後が最新)。frameIndex: 表示中のコマ。
   過去を見ている間は時刻をオレンジにする(最新へはスライダーを右端へ)。
   ───────────────────────────────────────────────────── */
export function AmedasTimeSlider({ frames, frameIndex, onChangeFrameIndex, hourly = false, loading = false, missing = false }) {
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
            {missing ? "データなし" : loading ? "読み込み中…" : isLatest ? (hourly ? "最新(毎正時)" : "最新") : `${Math.round((frames[last].timeMs - frame.timeMs) / 60000)}分前`}
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
              const hour = f.timeMs % 3600000 === 0; // 正時
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
      </div>
    </Glass>
  );
}


/* ─────────────────────────────────────────────────────
   凡例(縦のカラーバー)。他の気象凡例と同じ右上に出す。
   ───────────────────────────────────────────────────── */
// 要素によらず同じ横幅(題名は短い名前+単位の2行にして、長い題名で幅が変わらないようにする)。
export const AMEDAS_LEGEND_WIDTH = 48;
export function AmedasLegend({ elementId }) {
  const { tokens } = useContext(ThemeContext);
  const el = AMEDAS_ELEMENTS[elementId];
  if (!el) return null;
  // 色の区切り(stops)を等間隔に並べる。値で線形に配置すると、0〜10のように
  // 小さい値が固まる要素(降水量・積雪)で目盛りの文字が重なるため。
  const n = el.stops.length;
  const pos = (i) => (i / (n - 1)) * 100;
  const gradient = `linear-gradient(to top, ${el.stops.map(([, c], i) => `${c} ${pos(i)}%`).join(", ")})`;
  const BAR_H = Math.max(110, (n - 1) * 20);
  return (
    <Glass radius={12} style={{ width: AMEDAS_LEGEND_WIDTH, flexShrink: 0 }}>
      <div style={{ padding: "7px 6px", boxSizing: "border-box", width: AMEDAS_LEGEND_WIDTH, fontSize: 9.5, color: tokens.text }}>
        <div style={{ fontWeight: 800, lineHeight: 1.15, whiteSpace: "nowrap" }}>{el.legendTitle || el.label}</div>
        <div style={{ fontSize: 8.5, fontWeight: 600, lineHeight: 1.2, opacity: 0.6, marginBottom: 4, whiteSpace: "nowrap" }}>{el.unit}</div>
        <div style={{ display: "flex", gap: 4, padding: "5px 0" }}>
          <div style={{ width: 8, height: BAR_H, flexShrink: 0, borderRadius: 3, background: gradient, border: `0.5px solid rgba(${tokens.ink},0.3)` }}/>
          <div style={{ position: "relative", height: BAR_H, flex: 1, minWidth: 0, fontVariantNumeric: "tabular-nums" }}>
            {el.stops.map(([v], i) => (
              <span key={i} style={{
                position: "absolute", left: 0, bottom: `${pos(i)}%`,
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
   観測点の詳細(下のフローティングパネルの中身)。最新値(表示中のコマ)は親から受け取り、
   直近3時間の推移(気温・降水量・風速)は観測点の時系列ファイルから取得する。
   グラフは、タッチ/カーソルで動かした位置の時刻と値を読み取れる。3つのグラフで
   位置を共有する(同じ時刻の気温・降水量・風速を同時に見られる)。
   ───────────────────────────────────────────────────── */
const CHART_W = 300, CHART_H = 58, CHART_PAD = 6, AXIS_H = 12;

function MiniChart({ title, unit, decimals = 1, rows, pick, kind, color, tokens, hoverIdx, onHover }) {
  const svgRef = useRef(null);
  const pts = rows.map(r => ({ t: r.timeMs, v: pick(r) }));
  const vals = pts.map(p => p.v).filter(v => v != null);
  if (vals.length === 0) {
    return (
      <div style={{ fontSize: 11, color: `rgba(${tokens.ink},0.5)`, padding: "6px 0" }}>{title}: データなし</div>
    );
  }
  let min = Math.min(...vals), max = Math.max(...vals);
  if (kind === "bar") min = 0;
  const allZeroBar = kind === "bar" && max === 0;
  if (max === min) max = min + 1;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t > t0 ? pts[pts.length - 1].t : t0 + 1;
  const x = (t) => CHART_PAD + ((t - t0) / (t1 - t0)) * (CHART_W - CHART_PAD * 2);
  const y = (v) => CHART_H - CHART_PAD - ((v - min) / (max - min)) * (CHART_H - CHART_PAD * 2);
  const TOTAL_H = CHART_H + AXIS_H;
  const bw = Math.max(3, (CHART_W - CHART_PAD * 2) / Math.max(1, pts.length) - 2);
  let path = "";
  let pen = false; // 欠測をはさんだら線を切る
  pts.forEach(p => {
    if (p.v == null) { pen = false; return; }
    path += `${pen ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)} `;
    pen = true;
  });
  const hp = hoverIdx != null ? pts[hoverIdx] : null;

  // 指/カーソルのx位置 → いちばん近い時刻のコマ
  const pickIdx = (e) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return null;
    const px = ((e.clientX - rect.left) / rect.width) * CHART_W;
    let best = 0, bestD = Infinity;
    pts.forEach((p, i) => { const d = Math.abs(x(p.t) - px); if (d < bestD) { bestD = d; best = i; } });
    return best;
  };
  const handle = (e) => { const i = pickIdx(e); if (i != null) onHover(i); };

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", fontSize: 11, marginBottom: 3 }}>
        <span style={{ fontWeight: 700, color: tokens.text }}>{title}</span>
        <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: hp ? 800 : 500, color: hp ? tokens.text : `rgba(${tokens.ink},0.6)` }}>
          {hp
            ? `${amedasTimeLabel(hp.t)}  ${hp.v == null ? "--" : formatAmedasValue(hp.v, decimals)}${hp.v == null ? "" : unit}`
            : allZeroBar ? "降水なし" : `${formatAmedasValue(min, decimals)}〜${formatAmedasValue(max, decimals)}${unit}`}
        </span>
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${CHART_W} ${TOTAL_H}`} width="100%" style={{ display: "block", background: `rgba(${tokens.ink},0.05)`, borderRadius: 8, touchAction: "pan-y", cursor: "crosshair" }}
        onPointerDown={(e) => { e.stopPropagation(); handle(e); }}
        onPointerMove={handle}
      >
        {kind === "bar"
          ? pts.map((p, i) => p.v == null ? null : (
              <rect key={i} x={x(p.t) - bw / 2} y={y(p.v)} width={bw} height={Math.max(0, CHART_H - CHART_PAD - y(p.v))} fill={color} opacity={hoverIdx == null || hoverIdx === i ? 1 : 0.55} rx="1.5"/>
            ))
          : <path d={path} fill="none" stroke={color} strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round"/>}
        <text x={CHART_PAD} y={TOTAL_H - 2} fontSize="8.5" fill={`rgba(${tokens.ink},0.5)`}>{amedasTimeLabel(t0)}</text>
        <text x={CHART_W - CHART_PAD} y={TOTAL_H - 2} fontSize="8.5" textAnchor="end" fill={`rgba(${tokens.ink},0.5)`}>{amedasTimeLabel(t1)}</text>
        {hp && (
          <>
            <line x1={x(hp.t)} x2={x(hp.t)} y1={0} y2={CHART_H} stroke={`rgba(${tokens.ink},0.45)`} strokeWidth="1" strokeDasharray="3 3"/>
            {hp.v != null && kind !== "bar" && <circle cx={x(hp.t)} cy={y(hp.v)} r="4" fill={color} stroke="#fff" strokeWidth="1.6"/>}
          </>
        )}
      </svg>
    </div>
  );
}

function WindMark({ rot, color }) {
  // 風が吹いていく向きの矢印(静穏/不明は丸)
  return (
    <svg width="20" height="20" viewBox="-11 -11 22 22" aria-hidden="true" style={{ flexShrink: 0 }}>
      {rot == null
        ? <circle r="3.5" fill="none" stroke={color} strokeWidth="1.6"/>
        : <path transform={`rotate(${rot})`} d="M0,-9 L5.5,6 L0,3 L-5.5,6 Z" fill={color}/>}
    </svg>
  );
}

// 台風カードと同じ作り: 項目を最大4列の1行にし、隣同士を縦の細線で区切る。
function StatRow({ stats, tokens }) {
  if (stats.length === 0) return null;
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${stats.length}, 1fr)`, columnGap: 6, marginTop: 5 }}>
      {stats.map((s, i) => (
        <div key={s.label} style={{
          textAlign: "center", minWidth: 0,
          borderLeft: i > 0 ? `0.5px solid rgba(${tokens.ink},0.12)` : "none",
          paddingLeft: i > 0 ? 6 : 0,
        }}>
          <div style={{ fontSize: 9.5, fontWeight: 700, color: `rgba(${tokens.ink},0.55)`, whiteSpace: "nowrap" }}>{s.label}</div>
          <div className="mono" style={{ fontSize: 14, fontWeight: 700, color: tokens.text, whiteSpace: "nowrap" }}>{s.text}</div>
        </div>
      ))}
    </div>
  );
}

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

export function AmedasDetailPanel({ station, entry, timeMs, latestMs }) {
  const { tokens } = useContext(ThemeContext);
  const [series, setSeries] = useState(null); // null=読み込み中, []=取得不可
  const [hoverIdx, setHoverIdx] = useState(null);
  const code = station?.code;
  useEffect(() => {
    if (!code || latestMs == null) return undefined;
    let cancelled = false;
    setSeries(null);
    setHoverIdx(null);
    loadAmedasSeries(code, latestMs)
      .then(rows => { if (!cancelled) setSeries(rows); })
      .catch(() => { if (!cancelled) setSeries([]); });
    return () => { cancelled = true; };
  }, [code, latestMs]);

  if (!station) return null;
  const m = buildAmedasDetailModel(entry);
  const chartProps = { rows: series || [], tokens, hoverIdx, onHover: setHoverIdx };
  // 降水(10分〜24時間)→ その他、の順に4列ずつ並べる
  const precipStats = (m?.precip || []).map(r => ({ label: `降水${r.label}`, text: r.text }));
  const otherStats = [
    ...(m?.gust ? [{ label: "最大瞬間", text: m.gust.text }] : []),
    ...(m?.others || []).map(r => ({ label: r.label.replace("(1時間)", "1h"), text: r.text })),
  ];
  const secondaryRows = [...chunk(precipStats, 4), ...chunk(otherStats, 4)];
  return (
    <div style={{ margin: "0 14px 2px", color: tokens.text, textAlign: "left" }}>
      {/* 見出し: 名称の下に「観測点番号(左)+観測時刻(右)」を1行にまとめる(台風カードと同じ) */}
      <div style={{ padding: "0 4px 4px" }}>
        <div style={{ fontSize: 17, fontWeight: 800, color: tokens.text, lineHeight: 1.15, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {station.name}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 4 }}>
          <span style={{ fontSize: 12, color: `rgba(${tokens.ink},0.5)` }}>アメダス {station.code}</span>
          <span style={{ flex: 1, minWidth: 4 }}/>
          <span style={{ fontSize: 11, fontWeight: 500, color: `rgba(${tokens.ink},0.5)`, whiteSpace: "nowrap" }}>{amedasDateTimeLabel(timeMs)} 観測</span>
        </div>
      </div>

      <Glass radius={16} style={{ padding: "6px 12px 6px" }}>
        {!m && <div style={{ padding: "10px 0", fontSize: 12, opacity: 0.6, textAlign: "center" }}>この時刻の観測値はありません</div>}
        {m && (m.temp || m.wind) && (
          <div style={{
            display: "grid", gridTemplateColumns: m.temp && m.wind ? "1fr 1fr" : "1fr", columnGap: 8,
            paddingBottom: 4, borderBottom: secondaryRows.length ? `0.5px solid rgba(${tokens.ink},0.12)` : "none",
          }}>
            {m.temp && (
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: `rgba(${tokens.ink},0.6)` }}>気温</div>
                <span className="mono" style={{ fontSize: 28, fontWeight: 800, lineHeight: 1.15 }}>{m.temp.text}</span>
              </div>
            )}
            {m.wind && (
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: `rgba(${tokens.ink},0.6)` }}>風{m.wind.dirName ? `(${m.wind.dirName})` : ""}</div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 4 }}>
                  <WindMark rot={m.wind.rot} color="#26a69a"/>
                  <span className="mono" style={{ fontSize: 28, fontWeight: 800, lineHeight: 1.15 }}>{m.wind.speedText}</span>
                </div>
              </div>
            )}
          </div>
        )}
        {secondaryRows.map((row, i) => <StatRow key={i} stats={row} tokens={tokens}/>)}
      </Glass>

      <div style={{ padding: "8px 4px 4px", fontSize: 11.5, fontWeight: 600, color: `rgba(${tokens.ink},0.55)` }}>
        直近3時間の推移 <span style={{ fontWeight: 500, opacity: 0.8 }}>なぞると値を確認</span>
      </div>
      <Glass radius={16} style={{ padding: "4px 12px 12px" }}>
        {series == null && <div style={{ fontSize: 12, color: `rgba(${tokens.ink},0.5)`, padding: "16px 4px", textAlign: "center" }}>読み込み中...</div>}
        {series && series.length === 0 && <div style={{ fontSize: 12, color: `rgba(${tokens.ink},0.5)`, padding: "16px 4px", textAlign: "center" }}>推移データを取得できませんでした。</div>}
        {series && series.length > 0 && (
          <>
            <MiniChart {...chartProps} title="気温" unit="℃" pick={r => r.temp} kind="line" color="#ff7043"/>
            <MiniChart {...chartProps} title="降水量(10分)" unit="mm" pick={r => r.precip10m} kind="bar" color="#2196f3"/>
            <MiniChart {...chartProps} title="風速" unit="m/s" pick={r => r.wind} kind="line" color="#26a69a"/>
          </>
        )}
      </Glass>
    </div>
  );
}
