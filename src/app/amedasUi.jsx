import { useContext, useEffect, useRef, useState } from "react";
import { Glass, PressableButton } from "./glass";
import { ThemeContext } from "./theme";
import {
  AMEDAS_ELEMENTS, amedasColor, amedasDateTimeLabel, amedasTextColor, amedasTimeLabel, buildAmedasDetailModel,
  AMEDAS_SERIES_HOURS, formatAmedasValue, hourTicks, loadAmedasSeries, niceTicks,
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
const CHART_W = 300, CHART_H = 132;
const PAD_L = 32, PAD_R = 10, PAD_T = 12, PAD_B = 22;

// 縦軸の目盛り・横軸(正時)の目盛り・格子線つきの小さなグラフ。なぞった位置の値は
// 吹き出しで出す(3つのグラフで位置を共有)。
function MiniChart({ title, unit, decimals = 1, rows, pick, kind, color, tokens, hoverIdx, onHover }) {
  const svgRef = useRef(null);
  const gradId = useRef(`amedasGrad-${Math.random().toString(36).slice(2, 8)}`).current;
  const pts = rows.map(r => ({ t: r.timeMs, v: pick(r) }));
  const vals = pts.map(p => p.v).filter(v => v != null);
  if (vals.length === 0) {
    return <div style={{ fontSize: 11, color: `rgba(${tokens.ink},0.5)`, padding: "8px 0" }}>{title}: データなし</div>;
  }
  const rawMin = kind === "bar" ? 0 : Math.min(...vals);
  const rawMax = Math.max(...vals);
  const allZeroBar = kind === "bar" && rawMax === 0;
  // 降水量は0〜1mmの目盛りを最低限確保(0.1mmの降水で棒が極端に伸びないように)
  const axis = niceTicks(rawMin, kind === "bar" ? Math.max(rawMax, 1) : rawMax, 3);
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t > t0 ? pts[pts.length - 1].t : t0 + 1;
  const plotW = CHART_W - PAD_L - PAD_R, plotH = CHART_H - PAD_T - PAD_B;
  const x = (t) => PAD_L + ((t - t0) / (t1 - t0)) * plotW;
  const y = (v) => PAD_T + plotH - ((v - axis.min) / (axis.max - axis.min)) * plotH;
  const bw = Math.max(1.5, (plotW / Math.max(1, pts.length)) * (pts.length > 40 ? 0.8 : 0.7));
  const xTicks = hourTicks(t0, t1);

  let path = "", area = "";
  let pen = false, segStart = null, lastX = null;
  pts.forEach(p => {
    if (p.v == null) {
      if (pen && lastX != null) area += `L${lastX.toFixed(1)},${(PAD_T + plotH).toFixed(1)} Z `;
      pen = false; return;
    }
    const px = x(p.t).toFixed(1), py = y(p.v).toFixed(1);
    path += `${pen ? "L" : "M"}${px},${py} `;
    if (!pen) { area += `M${px},${(PAD_T + plotH).toFixed(1)} L${px},${py} `; segStart = px; }
    else area += `L${px},${py} `;
    pen = true; lastX = x(p.t);
  });
  if (pen && lastX != null) area += `L${lastX.toFixed(1)},${(PAD_T + plotH).toFixed(1)} Z`;

  const hp = hoverIdx != null ? pts[hoverIdx] : null;
  const lastPt = [...pts].reverse().find(p => p.v != null);

  const pickIdx = (e) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return null;
    const px = ((e.clientX - rect.left) / rect.width) * CHART_W;
    let best = 0, bestD = Infinity;
    pts.forEach((p, i) => { const d = Math.abs(x(p.t) - px); if (d < bestD) { bestD = d; best = i; } });
    return best;
  };
  const handle = (e) => { const i = pickIdx(e); if (i != null) onHover(i); };

  // 吹き出し(時刻+値)。点の上に出し、左右・上にはみ出さないよう寄せる。
  let tip = null;
  if (hp && hp.v != null) {
    const label = `${amedasTimeLabel(hp.t)}  ${formatAmedasValue(hp.v, decimals)}${unit}`;
    const w = label.length * 5.6 + 14, h = 18;
    const cx = x(hp.t);
    const tx = Math.min(Math.max(cx - w / 2, PAD_L), CHART_W - PAD_R - w);
    const ty = Math.max(1, y(hp.v) - h - 8);
    tip = { label, w, h, tx, ty };
  }

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", fontSize: 11.5, marginBottom: 3 }}>
        <span style={{ fontWeight: 700, color: tokens.text }}>{title} <span style={{ fontWeight: 500, color: `rgba(${tokens.ink},0.5)` }}>{unit}</span></span>
        <span style={{ fontVariantNumeric: "tabular-nums", color: `rgba(${tokens.ink},0.6)` }}>
          {allZeroBar ? "降水なし" : `最小 ${formatAmedasValue(Math.min(...vals), decimals)} / 最大 ${formatAmedasValue(Math.max(...vals), decimals)}`}
        </span>
      </div>
      <div style={{ background: `rgba(${tokens.ink},0.05)`, borderRadius: 10, padding: "2px 0" }}>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${CHART_W} ${CHART_H}`} width="100%" style={{ display: "block", touchAction: "pan-y", cursor: "crosshair" }}
          onPointerDown={(e) => { e.stopPropagation(); handle(e); }}
          onPointerMove={handle}
        >
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.30"/>
              <stop offset="100%" stopColor={color} stopOpacity="0"/>
            </linearGradient>
          </defs>
          {/* 縦軸: 格子線と目盛りの数値 */}
          {axis.ticks.map(v => (
            <g key={v}>
              <line x1={PAD_L} x2={CHART_W - PAD_R} y1={y(v)} y2={y(v)} stroke={`rgba(${tokens.ink},${v === axis.min ? 0.28 : 0.1})`} strokeWidth="1"/>
              <text x={PAD_L - 5} y={y(v) + 3} fontSize="9.5" textAnchor="end" fill={`rgba(${tokens.ink},0.55)`}>{formatAmedasValue(v, axis.decimals)}</text>
            </g>
          ))}
          {/* 横軸: 正時の縦の格子線と時刻 */}
          {xTicks.map(t => (
            <g key={t}>
              <line x1={x(t)} x2={x(t)} y1={PAD_T} y2={PAD_T + plotH} stroke={`rgba(${tokens.ink},0.08)`} strokeWidth="1"/>
              <line x1={x(t)} x2={x(t)} y1={PAD_T + plotH} y2={PAD_T + plotH + 3} stroke={`rgba(${tokens.ink},0.35)`} strokeWidth="1"/>
              <text x={x(t)} y={CHART_H - 6} fontSize="9.5" textAnchor="middle" fill={`rgba(${tokens.ink},0.55)`}>{amedasTimeLabel(t)}</text>
            </g>
          ))}
          {kind === "bar"
            ? pts.map((p, i) => p.v == null || p.v <= 0 ? null : (
                <rect key={i} x={x(p.t) - bw / 2} y={y(p.v)} width={bw} height={Math.max(1, PAD_T + plotH - y(p.v))} fill={color} opacity={hoverIdx == null || hoverIdx === i ? 1 : 0.5} rx="1.5"/>
              ))
            : (
              <>
                <path d={area} fill={`url(#${gradId})`} stroke="none"/>
                <path d={path} fill="none" stroke={color} strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round"/>
                {!hp && lastPt && <circle cx={x(lastPt.t)} cy={y(lastPt.v)} r="3.6" fill={color} stroke="#fff" strokeWidth="1.5"/>}
              </>
            )}
          {hp && (
            <>
              <line x1={x(hp.t)} x2={x(hp.t)} y1={PAD_T} y2={PAD_T + plotH} stroke={`rgba(${tokens.ink},0.5)`} strokeWidth="1" strokeDasharray="3 3"/>
              {hp.v != null && kind !== "bar" && <circle cx={x(hp.t)} cy={y(hp.v)} r="4.2" fill={color} stroke="#fff" strokeWidth="1.6"/>}
            </>
          )}
          {tip && (
            <g pointerEvents="none">
              <rect x={tip.tx} y={tip.ty} width={tip.w} height={tip.h} rx="7" fill="rgba(20,20,24,0.86)"/>
              <text x={tip.tx + tip.w / 2} y={tip.ty + 12.4} fontSize="10.5" fontWeight="700" textAnchor="middle" fill="#fff">{tip.label}</text>
            </g>
          )}
          {hp && hp.v == null && (
            <text x={x(hp.t)} y={PAD_T + 10} fontSize="10" textAnchor="middle" fill={`rgba(${tokens.ink},0.6)`}>{amedasTimeLabel(hp.t)} 欠測</text>
          )}
        </svg>
      </div>
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
function StatRow({ stats, tokens, loose = false }) {
  if (stats.length === 0) return null;
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${stats.length}, 1fr)`, columnGap: 6, marginTop: loose ? 10 : 5 }}>
      {stats.map((s, i) => (
        <div key={s.label} style={{
          textAlign: "center", minWidth: 0,
          borderLeft: i > 0 ? `0.5px solid rgba(${tokens.ink},0.12)` : "none",
          paddingLeft: i > 0 ? 6 : 0,
        }}>
          <div style={{ fontSize: 9.5, fontWeight: 700, color: `rgba(${tokens.ink},0.55)`, whiteSpace: "nowrap" }}>{s.label}</div>
          <div className="mono" style={{ fontSize: 16, fontWeight: 700, color: tokens.text, whiteSpace: "nowrap" }}>{s.text}</div>
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
  const [rangeHours, setRangeHours] = useState(6);
  const code = station?.code;
  useEffect(() => {
    if (!code || latestMs == null) return undefined;
    let cancelled = false;
    setSeries(null);
    setHoverIdx(null);
    loadAmedasSeries(code, latestMs, rangeHours)
      .then(rows => { if (!cancelled) setSeries(rows); })
      .catch(() => { if (!cancelled) setSeries([]); });
    return () => { cancelled = true; };
  }, [code, latestMs, rangeHours]);

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
  // 気温の色(地図の丸と同じスケール)は、小さな色ドットで示す
  const tempV = m?.temp?.v ?? null;
  const heroColor = tempV != null ? amedasColor(AMEDAS_ELEMENTS.temp.stops, tempV) : null;
  const tempText = tempV != null ? formatAmedasValue(tempV, 1) : "--";
  const hair = `0.5px solid rgba(${tokens.ink},0.12)`;
  return (
    <div style={{ margin: "0 14px 2px", color: tokens.text, textAlign: "left" }}>
      {/* 見出し: カードで囲まず、紙面のように素直に並べる */}
      <div style={{ padding: "0 4px 8px" }}>
        <div style={{ fontSize: 22, fontWeight: 800, lineHeight: 1.15, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{station.name}</div>
        <div style={{ fontSize: 12, color: `rgba(${tokens.ink},0.5)`, marginTop: 3 }}>
          アメダス {station.code} ・ {amedasDateTimeLabel(timeMs)} 観測
        </div>
      </div>

      {/* 主役: 気温(左)と風(右)。大きな数字だけで見せる */}
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 12, padding: "6px 4px 12px", borderBottom: hair }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 700, color: `rgba(${tokens.ink},0.6)` }}>
            {heroColor && <span style={{ width: 8, height: 8, borderRadius: 4, background: heroColor, boxShadow: `0 0 0 1px rgba(${tokens.ink},0.15)` }}/>}
            気温
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 3 }}>
            <span className="mono" style={{ fontSize: 44, fontWeight: 800, lineHeight: 1.05 }}>{tempText}</span>
            <span style={{ fontSize: 16, fontWeight: 700, color: `rgba(${tokens.ink},0.6)` }}>℃</span>
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: `rgba(${tokens.ink},0.6)` }}>風{m?.wind?.dirName ? `(${m.wind.dirName})` : ""}</div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 5 }}>
            {m?.wind && <WindMark rot={m.wind.rot} color="#26a69a"/>}
            <span className="mono" style={{ fontSize: 30, fontWeight: 800, lineHeight: 1.1 }}>{m?.wind ? m.wind.speedText : "--"}</span>
          </div>
        </div>
      </div>

      {!m && <div style={{ padding: "8px 0", fontSize: 12, opacity: 0.6, textAlign: "center" }}>この時刻の観測値はありません</div>}
      {secondaryRows.length > 0 && (
        <Glass radius={16} style={{ margin: "12px 0 0", padding: "6px 12px 8px" }}>
          {secondaryRows.map((row, i) => <StatRow key={i} stats={row} tokens={tokens}/>)}
        </Glass>
      )}

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 4px 4px" }}>
        <span style={{ fontSize: 11.5, fontWeight: 600, color: `rgba(${tokens.ink},0.55)` }}>
          直近{rangeHours}時間の推移 <span style={{ fontWeight: 500, opacity: 0.8 }}>なぞると値を確認</span>
        </span>
        <div style={{ display: "flex", gap: 4 }}>
          {AMEDAS_SERIES_HOURS.map(h => (
            <PressableButton
              key={h}
              onClick={() => setRangeHours(h)}
              style={{
                fontSize: 11, fontWeight: 700, padding: "3px 9px", borderRadius: 999,
                background: rangeHours === h ? "#0A84FF" : `rgba(${tokens.ink},0.06)`,
                color: rangeHours === h ? "#fff" : tokens.text,
              }}
            >
              {h}h
            </PressableButton>
          ))}
        </div>
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
