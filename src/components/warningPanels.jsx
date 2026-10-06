import { memo, useContext, useEffect, useMemo, useState } from "react";
import { PressableButton } from "../ui/glass.jsx";
import { loadRiverStationSeries, riverLevelInfo } from "../weather/risk.js";
import { PREF_ORDER, derivePrefFromEewAreaName } from "../eew/EewUi.jsx";
import { ThemeContext } from "../settings/prefs.js";
import { WARNING_LEVEL_COLOR, WARNING_LEVEL_LABEL, WARNING_LEVEL_PRIORITY } from "../api/warnings.js";
import { ChevronDownIcon } from "./quakeSearch.jsx";

/* ─────────────────────────────────────────────────────
   WARNING AREA LIST PANEL — 警報タブ、非選択時の中身。全国で発表中の
   警報・注意報を、市区町村単位でレベル順(特別警報→危険警報→警報→注意報)に
   ソートして一覧表示する。TyphoonListPanelと同じ構成(見出し+区切り線付き行)。
   ───────────────────────────────────────────────────── */
// BottomDockはドラッグ中のアニメーション等で頻繁に再レンダーされるため、
// memo化して警報一覧タブが開いていない時・propsが変わっていない時の
// 無駄な再レンダーを避ける(内部の重い組み立てはuseMemoで別途対策済み)。
export const WarningAreaListPanel = memo(function WarningAreaListPanel({ warningLevelMap = {}, warningAreaByRegioncode = {}, onSelectWarningArea }) {
  const { tokens } = useContext(ThemeContext);

  // 種類ごとの市区町村チップ一覧は、全国的な発表時にかなりの件数になり
  // 一覧が縦に伸びすぎるため、デフォルトは折りたたんでおき、行右端の
  // くの字ボタンを押した時だけ展開する。開閉状態はcode(種類)単位でSetに保持。
  const [expandedKinds, setExpandedKinds] = useState(() => new Set());
  function toggleKindExpanded(code) {
    setExpandedKinds(prev => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code); else next.add(code);
      return next;
    });
  }

  // 種類ごと(例: "大雨警報")に対象の市区町村をまとめる。市区町村1件ずつに
  // バッジ配列を組み立てていた以前の方式は、全国的な発表時に件数が膨らむと
  // 重くなっていたため、種類(最大でも警報種別の定義数、数十件程度)を軸に
  // まとめ直す。市区町村チップは種類の色で統一されるため、行ごとの色計算・
  // ソートも不要になる。warningLevelMap/warningAreaByRegioncodeが実際に
  // 変わった時だけuseMemoで再計算する。
  const groups = useMemo(() => {
    const byKind = new Map(); // key: "code" (種類のcode) → { code, name, level, areas: [{regioncode, name, pref}] }
    for (const [regioncode, entry] of Object.entries(warningLevelMap)) {
      const areaInfo = warningAreaByRegioncode[regioncode];
      const areaName = areaInfo?.name || regioncode;
      // regionnameから都道府県名を推定する(EEWの細分区域名と同じロジック)。
      // 判定不能な場合は「その他」小見出しにまとめる。
      const pref = derivePrefFromEewAreaName(areaInfo?.regionname) || "その他";
      for (const k of entry.kinds) {
        let g = byKind.get(k.code);
        if (!g) {
          g = { code: k.code, name: k.name, level: k.level, areas: [] };
          byKind.set(k.code, g);
        }
        g.areas.push({ regioncode, name: areaName, pref });
      }
    }
    const sortedGroups = [...byKind.values()].sort((a, b) => (WARNING_LEVEL_PRIORITY[b.level] ?? 0) - (WARNING_LEVEL_PRIORITY[a.level] ?? 0));
    // 各種類の中で、都道府県ごとの小グループにまとめる(北→南の固定順。
    // 判定できなかった「その他」は最後に置く)。
    for (const g of sortedGroups) {
      const byPref = new Map();
      for (const a of g.areas) {
        let list = byPref.get(a.pref);
        if (!list) { list = []; byPref.set(a.pref, list); }
        list.push(a);
      }
      g.prefGroups = [...byPref.entries()]
        .sort(([prefA], [prefB]) => {
          const ia = PREF_ORDER.indexOf(prefA), ib = PREF_ORDER.indexOf(prefB);
          return (ia === -1 ? PREF_ORDER.length : ia) - (ib === -1 ? PREF_ORDER.length : ib);
        })
        .map(([pref, areas]) => ({ pref, areas }));
    }
    return sortedGroups;
  }, [warningLevelMap, warningAreaByRegioncode]);

  return (
    <div>
      <div style={{
        display: "flex", alignItems: "center",
        padding: "8px 18px 11px",
        borderBottom: `0.5px solid rgba(${tokens.ink},0.15)`,
      }}>
        <span style={{ fontSize: 14, fontWeight: 600, flex: 1, color: `rgba(${tokens.ink},0.9)` }}>
          発表中の警報・注意報
        </span>
      </div>

      {groups.length === 0 ? (
        <div style={{ padding: "24px 18px", fontSize: 13, color: `rgba(${tokens.ink},0.5)`, textAlign: "center" }}>
          現在、発表中の警報・注意報はありません。
        </div>
      ) : (
        groups.map((g, i) => {
          const isOpen = expandedKinds.has(g.code);
          return (
            <div key={g.code} style={{ padding: "10px 18px", borderTop: i > 0 ? `0.5px solid rgba(${tokens.ink},0.1)` : "none" }}>
              <PressableButton
                onClick={() => toggleKindExpanded(g.code)}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  width: "100%",
                  marginBottom: isOpen ? 7 : 0,
                }}
              >
                <WarningKindBadge level={g.level} label={g.name}/>
                <span style={{ fontSize: 12, fontWeight: 600, color: `rgba(${tokens.ink},0.45)` }}>
                  {g.areas.length}市区町村
                </span>
                <span style={{ flex: 1 }}/>
                <ChevronDownIcon open={isOpen}/>
              </PressableButton>
              {isOpen && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {g.prefGroups.map(pg => (
                    <div key={pg.pref}>
                      <div style={{
                        fontSize: 11, fontWeight: 700, color: `rgba(${tokens.ink},0.4)`,
                        marginBottom: 4,
                      }}>
                        {pg.pref}
                      </div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                        {pg.areas.map(a => (
                          <PressableButton
                            key={a.regioncode}
                            onClick={() => onSelectWarningArea?.(a.regioncode)}
                            style={{
                              padding: "4px 9px",
                              borderRadius: 7,
                              background: `rgba(${tokens.ink},0.06)`,
                              fontSize: 12.5, fontWeight: 600, color: tokens.text,
                            }}
                          >
                            {a.name}
                          </PressableButton>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
});


/* ─────────────────────────────────────────────────────
   WARNING AREA DETAIL CARD — 警報タブ、選択中の中身。選んだ市区町村で
   発表中の警報・注意報の種別を、レベル順にバッジで一覧表示する。
   TyphoonDetailCardと対の構成。上部に「戻る」ボタンを置く(B要件)。
   ───────────────────────────────────────────────────── */
export function WarningAreaDetailCard({ regioncode, warningLevelMap = {}, warningAreaByRegioncode = {} }) {
  const { tokens } = useContext(ThemeContext);
  const area = warningAreaByRegioncode[regioncode];
  const entry = warningLevelMap[regioncode];
  const name = area?.name || regioncode;
  const kinds = [...(entry?.kinds || [])].sort((a, b) =>
    (WARNING_LEVEL_PRIORITY[b.level] ?? 0) - (WARNING_LEVEL_PRIORITY[a.level] ?? 0)
  );

  return (
    <div style={{ margin: "0 14px 2px" }}>
      {/* 戻るボタンは他タブ(地震・津波・設定)と同じく、BottomDock側でフローティング
          外部(右上/右下)に共通の枠で表示するため、ここでは持たない。 */}
      <div style={{ padding: "2px 4px 8px" }}>
        <div style={{
          fontSize: 17, fontWeight: 800, color: tokens.text, lineHeight: 1.15,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {name}
        </div>
      </div>

      {kinds.length === 0 ? (
        <div style={{ padding: "24px 4px", fontSize: 13, color: `rgba(${tokens.ink},0.5)`, textAlign: "center" }}>
          現在、このエリアで発表中の警報・注意報はありません。
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "4px 4px 12px" }}>
          {kinds.map(k => (
            <div
              key={k.code + k.name}
              style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "8px 10px",
                borderRadius: 10,
                background: `rgba(${tokens.ink},0.05)`,
              }}
            >
              <WarningKindBadge level={k.level} label={WARNING_LEVEL_LABEL[k.level]}/>
              <span style={{ fontSize: 13, fontWeight: 600, color: tokens.text }}>
                {k.name}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


// 警報・注意報のレベル別バッジ。旧ツールの.warn-badgeと同じ配色
// (特別警報=黒/危険警報=紫/警報=赤/注意報=黄、注意報のみ文字を黒にする)。
function WarningKindBadge({ level, label }) {
  return (
    <span style={{
      display: "inline-block",
      fontSize: 10, fontWeight: 700,
      padding: "2px 6px",
      borderRadius: 4,
      whiteSpace: "nowrap",
      background: WARNING_LEVEL_COLOR[level] || "#888",
      color: level === "chui" ? "#000" : "#fff",
      border: level === "tokubetsu" ? "1px solid rgba(255,255,255,0.4)" : "none",
    }}>
      {label}
    </span>
  );
}


/* ─────────────────────────────────────────────────────
   RIVER STATION DETAIL CARD — 警報タブで河川水位観測所のピンをタップした時の
   詳細カード。WarningAreaDetailCardと同じ枠を使い回す(戻るボタンはBottomDock
   側の共通フローティングで持つので、ここでは中身だけ)。
   observed_atはproperties(タップ時点のスナップショット)からそのまま出し、
   水位グラフだけ別途fetchする(タップのたびに取り直す)。
   ───────────────────────────────────────────────────── */
export function RiverStationDetailCard({ properties }) {
  const { tokens } = useContext(ThemeContext);
  const [series, setSeries] = useState(null); // null=読込中, {dspFlg, pastValues:[...]}=成功
  const [seriesError, setSeriesError] = useState(false);
  const [rangeDays, setRangeDays] = useState(1); // 1 | 3

  const obsFcd = properties?.obs_fcd;
  const obsCd = properties?.obs_cd;

  useEffect(() => {
    if (!obsFcd && obsCd == null) return;
    let cancelled = false;
    setSeries(null);
    setSeriesError(false);
    loadRiverStationSeries(obsFcd, obsCd)
      .then((data) => {
        if (cancelled) return;
        if (!data) { setSeriesError(true); return; }
        setSeries(data);
      })
      .catch(() => { if (!cancelled) setSeriesError(true); });
    return () => { cancelled = true; };
  }, [obsFcd, obsCd]);

  if (!properties) return null;
  const info = riverLevelInfo(properties.stg_ovlvl);
  const name = properties.obs_nm || "観測所";
  // 実機検証で判明した実際のスキーマ: { dspFlg, pastValues: [{ stg, obsTime, ... }] }。
  // ただしpastValuesは「確定済みの過去データ」のアーカイブのようで、当日分の
  // 最新の値が含まれていないことがある(前日24時までで止まる)。観測所ピンの
  // properties(タップ時点の最新値)を末尾に補完して、グラフが実際の「今」まで
  // 繋がるようにする。
  const points = useMemo(() => {
    const base = Array.isArray(series?.pastValues) ? series.pastValues.slice() : null;
    if (!base) return null;
    const latest = { stg: properties.stg_ovdeg, obsTime: properties.obs_time, stgOvlvl: properties.stg_ovlvl };
    const lastInBase = base[base.length - 1];
    const isNewer = !lastInBase?.obsTime || !latest.obsTime || latest.obsTime > lastInBase.obsTime;
    if (latest.stg != null && latest.obsTime && isNewer) base.push(latest);
    return base;
  }, [series, properties.stg_ovdeg, properties.obs_time, properties.stg_ovlvl]);
  const cutoffPoints = points
    ? points.filter(p => {
        if (!p?.obsTime) return true;
        const t = new Date(p.obsTime.replace(/\//g, "-"));
        return Date.now() - t.getTime() <= rangeDays * 24 * 60 * 60 * 1000;
      })
    : null;

  return (
    <div style={{ margin: "0 14px 2px" }}>
      <div style={{ padding: "2px 4px 6px" }}>
        <div style={{
          fontSize: 17, fontWeight: 800, color: tokens.text, lineHeight: 1.15,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {name}
        </div>
        {properties.rvr_cd != null && (
          <div style={{ fontSize: 12, color: `rgba(${tokens.ink},0.5)`, marginTop: 2 }}>
            河川コード {properties.rvr_cd}
            {properties.bnk_sct ? ` ・ ${properties.bnk_sct}` : ""}
            {properties.rvr_mouth_dst != null ? ` ・ 河口から${properties.rvr_mouth_dst}m` : ""}
          </div>
        )}
      </div>

      <div style={{
        display: "flex", alignItems: "center", gap: 10,
        padding: "8px 10px", margin: "4px 4px 10px",
        borderRadius: 10, background: `rgba(${tokens.ink},0.05)`,
      }}>
        <span style={{
          display: "inline-block", fontSize: 11, fontWeight: 700,
          padding: "3px 8px", borderRadius: 5, whiteSpace: "nowrap",
          background: info.color, color: info.color === "#f2e700" ? "#000" : "#fff",
        }}>
          {info.label}
        </span>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span style={{ fontSize: 20, fontWeight: 800, color: tokens.text, lineHeight: 1.1 }}>
            {properties.stg_ovdeg != null ? `${properties.stg_ovdeg} m` : "-- m"}
          </span>
          <span style={{ fontSize: 11, color: `rgba(${tokens.ink},0.5)` }}>
            {properties.obs_time || ""} 観測
          </span>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "0 4px 4px" }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: `rgba(${tokens.ink},0.55)` }}>水位の推移</span>
        <div style={{ display: "flex", gap: 4 }}>
          {[{ id: 1, label: "1日" }, { id: 3, label: "3日" }].map(opt => (
            <PressableButton
              key={opt.id}
              onClick={() => setRangeDays(opt.id)}
              style={{
                fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 999,
                background: rangeDays === opt.id ? "#0A84FF" : `rgba(${tokens.ink},0.06)`,
                color: rangeDays === opt.id ? "#fff" : tokens.text,
              }}
            >
              {opt.label}
            </PressableButton>
          ))}
        </div>
      </div>

      <div style={{ margin: "0 4px 16px", padding: "10px 10px 4px", borderRadius: 10, background: `rgba(${tokens.ink},0.05)` }}>
        {seriesError ? (
          <div style={{ padding: "16px 4px", fontSize: 12, color: `rgba(${tokens.ink},0.5)`, textAlign: "center" }}>
            水位の推移データを取得できませんでした。
          </div>
        ) : !cutoffPoints ? (
          <div style={{ padding: "16px 4px", fontSize: 12, color: `rgba(${tokens.ink},0.5)`, textAlign: "center" }}>
            読み込み中...
          </div>
        ) : cutoffPoints.length < 2 ? (
          <div style={{ padding: "16px 4px", fontSize: 12, color: `rgba(${tokens.ink},0.5)`, textAlign: "center" }}>
            表示できるデータがありません。
          </div>
        ) : (
          <RiverLevelSparkline points={cutoffPoints}/>
        )}
      </div>
    </div>
  );
}


// 水位の推移を表す簡易SVGグラフ。旧タブの潮位計チャートと同じく、外部chart
// ライブラリを使わない自前SVG。日付軸ラベル・面グラフ塗り・現在値ドットを
// 加えて、値だけのシンプルな折れ線より状況が掴みやすいようにしている。
// pastValuesの各要素は { stg: 水位(m), obsTime: "YYYY/MM/DD HH:mm", ... }。
function RiverLevelSparkline({ points }) {
  const { tokens } = useContext(ThemeContext);
  const W = 280, H = 150;
  const PAD_L = 34, PAD_R = 8, PAD_TOP = 10, PAD_BOTTOM = 30;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_TOP - PAD_BOTTOM;

  const parsed = points
    .map(p => ({ v: Number(p.stg), t: new Date(p.obsTime.replace(/\//g, "-")), lvl: p.stgOvlvl }))
    .filter(p => !Number.isNaN(p.v) && !Number.isNaN(p.t.getTime()));
  if (parsed.length < 2) return null;

  const values = parsed.map(p => p.v);
  const minV = Math.min(...values);
  const maxV = Math.max(...values);
  // 値の範囲が全く無い(水位が一定)場合でも線がつぶれないよう、上下に余白を持たせる。
  const range = (maxV - minV) || Math.max(0.1, maxV * 0.05);
  const padV = range * 0.15;
  const yMin = minV - padV, yMax = maxV + padV;

  const stepX = plotW / (parsed.length - 1);
  const toX = (i) => PAD_L + i * stepX;
  const toY = (v) => PAD_TOP + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  const linePath = parsed
    .map((p, i) => `${i === 0 ? "M" : "L"} ${toX(i).toFixed(1)} ${toY(p.v).toFixed(1)}`)
    .join(" ");
  const areaPath =
    `M ${toX(0).toFixed(1)} ${(PAD_TOP + plotH).toFixed(1)} ` +
    parsed.map((p, i) => `L ${toX(i).toFixed(1)} ${toY(p.v).toFixed(1)}`).join(" ") +
    ` L ${toX(parsed.length - 1).toFixed(1)} ${(PAD_TOP + plotH).toFixed(1)} Z`;

  // 横軸のラベルは、データ範囲を3等分した位置(始点・中間・終点)に日付+時刻を出す。
  const tickIdxs = [0, Math.floor((parsed.length - 1) / 2), parsed.length - 1];
  const formatTickDate = (d) => `${d.getMonth() + 1}/${d.getDate()}`;
  const formatTickTime = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

  const last = parsed[parsed.length - 1];
  const lastColor = riverLevelInfo(last.lvl).color;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H}>
      {/* 横方向のグリッド線(最大・最小の目安) */}
      <line x1={PAD_L} y1={PAD_TOP} x2={W - PAD_R} y2={PAD_TOP} stroke={`rgba(${tokens.ink},0.1)`} strokeWidth="1"/>
      <line x1={PAD_L} y1={PAD_TOP + plotH} x2={W - PAD_R} y2={PAD_TOP + plotH} stroke={`rgba(${tokens.ink},0.1)`} strokeWidth="1"/>

      <defs>
        <linearGradient id="riverSparklineFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#0A84FF" stopOpacity="0.28"/>
          <stop offset="100%" stopColor="#0A84FF" stopOpacity="0"/>
        </linearGradient>
      </defs>
      <path d={areaPath} fill="url(#riverSparklineFill)" stroke="none"/>

      <path d={linePath} fill="none" stroke="#0A84FF" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"/>

      {/* 現在値(最新点)を強調するドット */}
      <circle cx={toX(parsed.length - 1)} cy={toY(last.v)} r="4" fill={lastColor} stroke="#fff" strokeWidth="1.5"/>

      {/* 縦軸(最大値・最小値) */}
      <text x={PAD_L - 4} y={PAD_TOP + 4} fontSize="9.5" textAnchor="end" fill={`rgba(${tokens.ink},0.5)`}>{maxV.toFixed(2)}</text>
      <text x={PAD_L - 4} y={PAD_TOP + plotH + 3} fontSize="9.5" textAnchor="end" fill={`rgba(${tokens.ink},0.5)`}>{minV.toFixed(2)}</text>

      {/* 横軸(日付+時刻の2行) */}
      {tickIdxs.map((i, k) => {
        const anchor = k === 0 ? "start" : k === tickIdxs.length - 1 ? "end" : "middle";
        return (
          <g key={i}>
            <text x={toX(i)} y={H - 17} fontSize="9.5" textAnchor={anchor} fill={`rgba(${tokens.ink},0.5)`}>
              {formatTickDate(parsed[i].t)}
            </text>
            <text x={toX(i)} y={H - 5} fontSize="9.5" textAnchor={anchor} fill={`rgba(${tokens.ink},0.5)`}>
              {formatTickTime(parsed[i].t)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
