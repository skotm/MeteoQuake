import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { MIN_INTENSITY as SHINDO_MIN_INTENSITY, MAX_INTENSITY as SHINDO_MAX_INTENSITY, intensityToShindoColor } from "../shindoColorScale";
import { ThemeContext } from "./theme";
import { QUAKE_COLOR_SCHEMES, QuakeColorSchemeContext, getIntensityStyleFromScheme } from "./colorSchemes";
import { Glass, PressableButton } from "./glass";
import { findEpicenterNameByPoint, findSingleEpicenterPlace } from "./geo";
import { loadEpicenterNamesData, loadGeoData } from "./mapDataLoaders";
import { TSUNAMI_GRADE_INFO, tsunamiGradeInfo, tsunamiHeightBandGrade } from "./tsunamiData";


/* ─────────────────────────────────────────────────────
   QUAKE INTENSITY LEGEND
   選択中の地震の「震度1〜最大震度」までを縦並びで表示する凡例。
   最大震度のバッジだけ枠線で強調する。画面左上に浮かべて使う想定。
   ───────────────────────────────────────────────────── */
const INTENSITY_LEGEND_ORDER = ["1", "2", "3", "4", "5-", "5+", "6-", "6+", "7"];

export function QuakeIntensityLegend({ maxIntensity, legacyIntensityScale }) {
  const { tokens } = useContext(ThemeContext);
  const schemeId = useContext(QuakeColorSchemeContext);
  const scheme = QUAKE_COLOR_SCHEMES[schemeId] || QUAKE_COLOR_SCHEMES.fill;

  // 旧震度階級(弱/強の区分が無い震度5・6)は、5弱/6弱と同じ色を使っているため、
  // 通常の並び順にそのまま追加すると「5」と「5弱」のように同じ色のバーが
  // 隣り合って重複しているように見えてしまう。そのため通常の並び順には含めず、
  // 震度4(または5強)までの並びに続けて、単独の「5」または「6」バーで
  // 打ち切る形にする。
  // 震度7の場合も、旧震度階級の期間の地震なら5弱/5強・6弱/6強の区別は
  // 存在しないはずなので、legacyIntensityScaleを見て同様に単純化する。
  let levels;
  if (maxIntensity === "5") {
    levels = ["1", "2", "3", "4", "5"];
  } else if (maxIntensity === "6") {
    levels = ["1", "2", "3", "4", "5", "6"];
  } else if (maxIntensity === "7" && legacyIntensityScale) {
    levels = ["1", "2", "3", "4", "5", "6", "7"];
  } else {
    const maxIdx = INTENSITY_LEGEND_ORDER.indexOf(maxIntensity);
    if (maxIdx < 0) return null; // 震度0や不明("?")の場合は凡例を出さない
    levels = INTENSITY_LEGEND_ORDER.slice(0, maxIdx + 1);
  }

  return (
    <Glass
      radius={12}
      style={{ animation: "appear 0.35s cubic-bezier(.25,1,.5,1)" }}
    >
      <div style={{
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        gap: 2,
        padding: "8px 9px",
      }}>
        {levels.map(key => {
          const style = getIntensityStyleFromScheme(scheme, key);
          const isMax = key === maxIntensity;
          return (
            // 設定の震度配色ピッカーのミニプレビューと同じ、隙間の詰まった横一列のバー
            <div
              key={key}
              style={{
                width: 7, height: 16, borderRadius: 2,
                background: style.bg,
                boxShadow: isMax ? `0 0 0 2px rgba(${tokens.ink},0.9)` : "none",
                flexShrink: 0,
              }}
            />
          );
        })}
      </div>
    </Glass>
  );
}

/* ─────────────────────────────────────────────────────
   TSUNAMI GRADE LEGEND — QuakeIntensityLegendと全く同じ見た目
   (横一列に並んだ隙間の詰まった色バー)にした版。
   「一番下(津波予報)〜一番上」までのラダー表示にする。一番上に来るグレードは、
   (a) 実際に発表されている予報区の中で一番高いグレード と
   (b) 観測された津波の最大波から相当するグレード
   のうち、高い方を採用する(例: 警報が出ていても、大津波警報相当の高さが
   観測されていれば、大津波警報の色まで表示する)。
   ───────────────────────────────────────────────────── */
export function TsunamiGradeLegend({ areas, tsunamiHeightByStation = {} }) {
  const { tokens } = useContext(ThemeContext);
  const gradesPresent = [...new Set((areas || []).map(a => a.grade))];
  if (gradesPresent.length === 0) return null;

  const declaredMaxWeight = Math.max(...gradesPresent.map(g => tsunamiGradeInfo(g).weight));

  // 観測された津波の最大波(全観測点の中で一番高いもの)から相当グレードを求める。
  const heights = Object.values(tsunamiHeightByStation).map(h => Math.abs(h));
  const maxObservedHeight = heights.length > 0 ? Math.max(...heights) : null;
  const observedGrade = tsunamiHeightBandGrade(maxObservedHeight);
  const observedWeight = observedGrade ? tsunamiGradeInfo(observedGrade).weight : 0;

  const maxWeight = Math.max(declaredMaxWeight, observedWeight);
  // 「津波予報」〜maxWeightまでを順番に並べる(ラダー)。ただし「津波予報」
  // (NonEffective)は、実際にどこかの予報区で発表されている時だけ含める
  // (観測やmaxWeightの都合だけで機械的に一番下へ足さない)。
  const ladderGrades = Object.entries(TSUNAMI_GRADE_INFO)
    .filter(([key, info]) => {
      if (key === "Unknown") return false;
      if (info.weight < 1 || info.weight > maxWeight) return false;
      if (key === "NonEffective" && !gradesPresent.includes("NonEffective")) return false;
      return true;
    })
    .sort((a, b) => a[1].weight - b[1].weight)
    .map(([key]) => key);
  if (ladderGrades.length === 0) return null;

  return (
    <Glass
      radius={12}
      style={{ animation: "appear 0.35s cubic-bezier(.25,1,.5,1)" }}
    >
      <div style={{
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        gap: 2,
        padding: "8px 9px",
      }}>
        {ladderGrades.map(grade => {
          const info = tsunamiGradeInfo(grade);
          const isMax = info.weight === maxWeight;
          return (
            // 震度凡例のミニバーと同じ、隙間の詰まった横一列のバー
            <div
              key={grade}
              style={{
                width: 7, height: 16, borderRadius: 2,
                background: info.color,
                boxShadow: isMax ? `0 0 0 2px rgba(${tokens.ink},0.9)` : "none",
                flexShrink: 0,
              }}
            />
          );
        })}
      </div>
    </Glass>
  );
}

/* ─────────────────────────────────────────────────────
   REALTIME INTENSITY THRESHOLD BAR
   強震モニタ/S-net本来の連続震度カラースケール(shindoColorScale.ts)を
   横長のグラデーションバーとして示す、震度凡例 兼 表示しきい値スライダー。
   三角マーカーをドラッグすると、地図上に表示する観測点の下限震度
   (App側のrealtimeIntensityThreshold・localStorage永続化)を変更できる。
   ───────────────────────────────────────────────────── */
const SHINDO_GRADIENT_CSS = (() => {
  const stops = [];
  for (let v = SHINDO_MIN_INTENSITY; v <= SHINDO_MAX_INTENSITY + 1e-9; v += 0.5) {
    const pct = ((v - SHINDO_MIN_INTENSITY) / (SHINDO_MAX_INTENSITY - SHINDO_MIN_INTENSITY)) * 100;
    stops.push(`${intensityToShindoColor(v)} ${pct.toFixed(2)}%`);
  }
  return `linear-gradient(to right, ${stops.join(", ")})`;
})();

const SHINDO_THRESHOLD_TICKS = (() => {
  const ticks = [];
  for (let v = Math.ceil(SHINDO_MIN_INTENSITY); v <= Math.floor(SHINDO_MAX_INTENSITY); v++) ticks.push(v);
  return ticks;
})();

export function RealtimeIntensityThresholdBar({ threshold, onChangeThreshold }) {
  const { tokens } = useContext(ThemeContext);
  const trackRef = useRef(null);
  const [dragging, setDragging] = useState(false);

  const clampedThreshold = Math.min(Math.max(threshold, SHINDO_MIN_INTENSITY), SHINDO_MAX_INTENSITY);
  const pct = ((clampedThreshold - SHINDO_MIN_INTENSITY) / (SHINDO_MAX_INTENSITY - SHINDO_MIN_INTENSITY)) * 100;

  // 配色そのままの0.1刻みにスナップする。
  const valueFromClientX = (clientX) => {
    const el = trackRef.current;
    if (!el) return clampedThreshold;
    const rect = el.getBoundingClientRect();
    const ratio = Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
    const raw = SHINDO_MIN_INTENSITY + ratio * (SHINDO_MAX_INTENSITY - SHINDO_MIN_INTENSITY);
    return Math.round(raw * 10) / 10;
  };

  const handlePointerDown = (e) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    onChangeThreshold(valueFromClientX(e.clientX));
  };
  const handlePointerMove = (e) => {
    if (!dragging) return;
    onChangeThreshold(valueFromClientX(e.clientX));
  };
  const handlePointerUp = (e) => {
    setDragging(false);
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
  };

  return (
    <Glass radius={14} style={{ animation: "appear 0.35s cubic-bezier(.25,1,.5,1)" }}>
      <div style={{ padding: "8px 12px", width: 224 }}>
        <div style={{ position: "relative" }}>
          {/* カラースケール本体(ドラッグでしきい値を変更) */}
          <div
            ref={trackRef}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            style={{
              position: "relative",
              height: 18,
              borderRadius: 6,
              background: SHINDO_GRADIENT_CSS,
              touchAction: "none",
              cursor: "pointer",
            }}
          >
            {SHINDO_THRESHOLD_TICKS.map(v => (
              <div key={v} style={{
                position: "absolute",
                left: `${((v - SHINDO_MIN_INTENSITY) / (SHINDO_MAX_INTENSITY - SHINDO_MIN_INTENSITY)) * 100}%`,
                top: 0,
                bottom: 0,
                width: 1,
                background: "rgba(0,0,0,0.25)",
                pointerEvents: "none",
              }}/>
            ))}

            {/* しきい値マーカー — 上下のキャップと縦棒を同じ太さの1枚のカプセル型
                (角丸を半径いっぱいにした縦長の丸角バー)にまとめる。1つの図形
                なので黒縁が上下左右つながって見える。 */}
            <div style={{
              position: "absolute",
              left: `${pct}%`,
              top: -4,
              bottom: -4,
              width: 4,
              transform: "translateX(-50%)",
              borderRadius: 999,
              background: "#fff",
              border: "1.5px solid #000",
              boxShadow: "0 1px 2px rgba(0,0,0,0.5)",
              pointerEvents: "none",
            }}/>
          </div>

          {/* 目盛りラベル */}
          <div style={{ position: "relative", height: 12, marginTop: 0 }}>
            {SHINDO_THRESHOLD_TICKS.map(v => (
              <span key={v} style={{
                position: "absolute",
                left: `${((v - SHINDO_MIN_INTENSITY) / (SHINDO_MAX_INTENSITY - SHINDO_MIN_INTENSITY)) * 100}%`,
                transform: v === SHINDO_MIN_INTENSITY
                  ? "translateX(0%)"
                  : v === SHINDO_MAX_INTENSITY ? "translateX(-100%)" : "translateX(-50%)",
                fontSize: 8,
                fontWeight: 700,
                fontVariantNumeric: "tabular-nums",
                color: `rgba(${tokens.ink},0.75)`,
                whiteSpace: "nowrap",
              }}>
                {v}
              </span>
            ))}
          </div>
        </div>
      </div>
    </Glass>
  );
}


/* ─────────────────────────────────────────────────────
   BACK TO LIST BUTTON
   地震を選択中に地図上へ浮かぶ丸い「戻る」ボタン。
   押すと選択を解除し、パネルを「中高」にして一覧表示へ戻る。
   ───────────────────────────────────────────────────── */
/* ─────────────────────────────────────────────────────
   STATION MARKER TOGGLE BUTTON — 地図上の観測点マーカーの表示/非表示を切り替える。
   表示中は点線の円、非表示中は実線の円のアイコンにする(BackToListButtonと
   同じ44×44の丸いGlassボタン)。
   ───────────────────────────────────────────────────── */
export function StationMarkerToggleButton({ visible, onClick }) {
  const { tokens } = useContext(ThemeContext);
  const [pressed, setPressed] = useState(false);

  return (
    <Glass
      radius={999}
      style={{
        width: 44, height: 44,
        transform: pressed ? "scale(1.16)" : "scale(1)",
        transformOrigin: "center",
        transition: "transform 0.18s cubic-bezier(.22,1,.36,1)",
      }}
    >
      <button
        onClick={onClick}
        onPointerDown={() => setPressed(true)}
        onPointerUp={() => setPressed(false)}
        onPointerCancel={() => setPressed(false)}
        onPointerLeave={() => setPressed(false)}
        aria-label={visible ? "観測点の表示を消す" : "観測点を表示する"}
        style={{
          position: "relative", zIndex: 1,
          width: "100%", height: "100%",
          display: "flex", alignItems: "center", justifyContent: "center",
          color: tokens.text,
        }}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none"
             stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="9.5" strokeDasharray={visible ? "3 3" : undefined}/>
        </svg>
      </button>
    </Glass>
  );
}

/* ─────────────────────────────────────────────────────
   REALTIME DATA TIME BADGE — リアルタイムタブで表示中の震度データの
   観測時刻を示す、横長のガラスピル。以前はフローティングパネル内部
   (左上)に素のテキストとして表示していたが、戻るボタン(BackToListButton)
   と同様にパネルの外側の兄弟要素として置き、フローティングの動き
   (パネルの高さ変化・ドラッグ)に追従させるようにした。
   ───────────────────────────────────────────────────── */
/* ─────────────────────────────────────────────────────
   SHAKE EVENT CARD — 揺れ検知エンジン(shakeDetection.ts)が検出したイベントを
   リアルタイムタブのフローティングに表示するカード。
   表示は「(場所)で(揺れの程度)を検出」+「観測点数 N」。1枚のGlassに、左へ場所+揺れの程度、右へ観測点数を並べる。色は枠だけに付け
   (揺れの程度で黄→橙→赤)、面は色を付けない。面ごと色付きの緊急地震速報カード
   (EewDetailFloatingCard)と並んだ時に紛らわしくならないようにするため。
   場所は、検知した観測点が属する震央地名の区域(ep.json)がただ1つならその区域名、
   複数にまたがる時は都道府県、それでも1つに絞れなければ地方名、と少しずつ広げる
   (geo.jsのfindSingleEpicenterPlace)。地方でも1つに絞れない時は、代表を選ぶと
   誤解を招くので地名を省いて「揺れを検出」だけにする。
   ───────────────────────────────────────────────────── */
const SHAKE_LEVEL_NOUNS = ["小さな揺れ", "揺れ", "やや強い揺れ", "強い揺れ", "非常に強い揺れ"];
// 揺れの程度(level 0〜4)ごとの枠の色。弱い揺れ=黄 → 強い揺れ=赤の3段階。
const SHAKE_LEVEL_ACCENTS = ["#FFC107", "#FFC107", "#FF9F0A", "#FF453A", "#FF453A"];

// 場所の判定に使うデータ(震央地名 ep.json 約670KB と 都道府県 prefectures.json)を、
// 揺れ検知カードが最初に出る時に1回だけ読み込み、以後は使い回す(prefectures.jsonは
// 地図が既に読み込んでおり、loadGeoDataのPromiseを共有するので追加の通信はない)。
// 観測点IDごとの判定結果もキャッシュする。
const gridCellSamplesCache = new Map();
// セル(緯度経度の矩形)を格子状にサンプリングして、各点が属する震央地名の区域を調べる。
// 結果 { points: [{id,lat,lon}], names: 区域名(重複なし) } はセルごとにキャッシュ。
// 区域の面積が小さすぎて格子の間に入る場合は拾えない。
function sampleCellRegions(epicenterNames, cell) {
  const cached = gridCellSamplesCache.get(cell.key);
  if (cached) return cached;
  const N = 8;
  const points = [];
  const names = [];
  for (let i = 0; i <= N; i++) {
    for (let j = 0; j <= N; j++) {
      const lat = cell.minLat + (cell.maxLat - cell.minLat) * ((i + 0.5) / (N + 1));
      const lon = cell.minLon + (cell.maxLon - cell.minLon) * ((j + 0.5) / (N + 1));
      points.push({ id: `${cell.key}:${i}_${j}`, lat, lon });
      const name = findEpicenterNameByPoint(epicenterNames, lat, lon);
      if (name && !names.includes(name)) names.push(name);
    }
  }
  const r = { points, names };
  gridCellSamplesCache.set(cell.key, r);
  return r;
}

// グリッド検知のイベントの場所。イベントに属するすべてのセルの震央地名をまとめ、
// 区域名が GRID_PLACE_MAX_NAMES(3)個以下ならすべて並べる。それより多ければ、通常の検知と同じく
// 区域 → 都道府県 → 地方と広げて、まとめた名前にする(findSingleEpicenterPlace)。
const GRID_PLACE_MAX_NAMES = 3;
function gridEventPlaceName(geo, cells) {
  if (!geo?.epicenterNames || !Array.isArray(cells) || cells.length === 0) return null;
  const names = [];
  const points = [];
  for (const cell of cells) {
    const r = sampleCellRegions(geo.epicenterNames, cell);
    for (const n of r.names) if (!names.includes(n)) names.push(n);
    points.push(...r.points);
  }
  if (names.length === 0) return null;
  if (names.length <= GRID_PLACE_MAX_NAMES) return names.join("・");
  return findSingleEpicenterPlace(geo, points, shakePlaceInfoCache)?.name ?? null;
}

let shakePlaceGeoCache = null;
const shakePlaceInfoCache = new Map();
function useShakeEventPlaceName(detections, gridCells = null) {
  const [geo, setGeo] = useState(shakePlaceGeoCache);
  useEffect(() => {
    if (geo) return undefined;
    let alive = true;
    Promise.all([
      loadEpicenterNamesData().catch((err) => { console.error("震央地名データの読み込みに失敗しました:", err); return null; }),
      loadGeoData().then((d) => d.prefectures).catch((err) => { console.error("都道府県データの読み込みに失敗しました:", err); return null; }),
    ]).then(([epicenterNames, prefectures]) => {
      shakePlaceGeoCache = { epicenterNames, prefectures };
      if (alive) setGeo(shakePlaceGeoCache);
    });
    return () => { alive = false; };
  }, [geo]);
  return useMemo(() => {
    if (gridCells) {
      const name = gridEventPlaceName(geo, gridCells);
      if (name) return name;
    }
    return findSingleEpicenterPlace(geo, detections, shakePlaceInfoCache)?.name ?? null;
  }, [geo, detections, gridCells]);
}

export function ShakeEventCard({ event }) {
  const { tokens } = useContext(ThemeContext);
  const isGrid = event.source === "grid";
  const place = useShakeEventPlaceName(event.detections, isGrid ? event.gridCells : null);
  const level = Math.min(Math.max(Number.isFinite(event.level) ? event.level : 0, 0), SHAKE_LEVEL_NOUNS.length - 1);
  const text = `${place ? `${place}で` : ""}${SHAKE_LEVEL_NOUNS[level]}を検出`;
  // 色は枠(border)だけに付ける。面は色を付けない通常のGlassにして、面ごと色付きの
  // 緊急地震速報カードと見分けがつくようにする(以前は面にも色を付けていて紛らわしかった)。
  // borderはGlassの外側のdivに付ける。Glassの内側のレイヤ(背景ぼかし・縁取り)は
  // padding box内(inset:0)に収まるので、枠は隠れずに残る。
  // Glassの中身は「コンテンツ層」のブロックdivに包まれるため、縦位置を確実に中央へ
  // 揃えるには、自前でheight:100%のflexラッパーを挟む必要がある
  // (ShakeTestRunningBadgeのコメント参照)。
  return (
    <Glass radius={14} style={{ margin: "6px 16px 8px", border: `2px solid ${SHAKE_LEVEL_ACCENTS[level]}` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, height: "100%", padding: "9px 14px" }}>
        <span style={{ flex: 1, minWidth: 0, fontSize: 15, fontWeight: 800, lineHeight: 1.3, color: tokens.text }}>{text}</span>
        {!isGrid && (
          <span style={{ flexShrink: 0, display: "flex", alignItems: "baseline", gap: 6, whiteSpace: "nowrap" }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: tokens.textSecondary }}>観測点数</span>
            <span style={{ fontSize: 15, fontWeight: 800, color: tokens.text, fontVariantNumeric: "tabular-nums" }}>{event.pointCount}</span>
          </span>
        )}
      </div>
    </Glass>
  );
}

// 地震検知テスト(実験的機能、shakeTestSimulation.ts)実行中であることを示す、
// RealtimeDataTimeBadgeのすぐ上に添える小さなインジケーター。
// 常時表示のRealtimeDataTimeBadgeより控えめに(フォントサイズ・パディングとも
// 一回り小さく)することで、あくまで補助的な表示であることを示す。
// 以前は画面上部中央に別のバナー(警告文+停止ボタン)を出していたが、
// この場所に統合し、停止ボタンもここへ移動した。
//
// 【文字の縦位置について】Glass自体はdisplay:inline-flexだが、Glassの中身
// (children)は実際には「コンテンツ層」というただのブロックdiv
// (position:relative,width:100%,height:100%)にラップされてから描画される
// ため、Glassのstyleに指定したalignItems:centerは、そのブロックdiv自体を
// (高さが100%指定のため実質意味を持たないまま)揃えるだけで、その中の
// テキスト・ボタンの縦位置には効かない。span+buttonをブロックdiv直下に
// そのまま置くと、フォントの行送り(line-height)や要素ごとのベースライン
// 位置の違いにより、見た目上わずかに中心からズレる。
// そのため、ここでは自前でheight:100%のflexラッパーを1つ挟み、
// alignItems:centerで確実に中央揃えする。
export function ShakeTestRunningBadge({ count = 1, onStop }) {
  return (
    <Glass
      radius={999}
      style={{
        padding: "0 6px 0 10px",
        height: 20,
      }}
    >
      <div
        style={{
          position: "relative",
          zIndex: 1,
          height: "100%",
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <span
          style={{
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: 0.2,
            lineHeight: 1,
            color: "#FF9F0A",
            whiteSpace: "nowrap",
            pointerEvents: "none",
          }}
        >
          検知テスト実行中{count > 1 ? `(${count}件)` : ""}
        </span>
        <PressableButton
          type="button"
          onClick={onStop}
          style={{
            flexShrink: 0, border: "none", cursor: "pointer",
            borderRadius: 999,
            padding: "0 8px",
            height: 14,
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            background: "rgba(255,159,10,0.22)",
            fontSize: 8, fontWeight: 700, lineHeight: 1,
            color: "#FF9F0A", whiteSpace: "nowrap",
          }}
        >
          {count > 1 ? "すべて停止" : "停止"}
        </PressableButton>
      </div>
    </Glass>
  );
}

export function RealtimeDataTimeBadge({ dataTime }) {
  const { tokens } = useContext(ThemeContext);
  return (
    <Glass
      radius={999}
      style={{
        padding: "0 14px",
        display: "inline-flex",
        alignItems: "center",
      }}
    >
      <span
        style={{
          position: "relative",
          zIndex: 1,
          fontSize: 11,
          fontWeight: 700,
          fontVariantNumeric: "tabular-nums",
          color: `rgba(${tokens.ink},0.85)`,
          whiteSpace: "nowrap",
          pointerEvents: "none",
        }}
      >
        {dataTime.toLocaleTimeString("ja-JP", { hour12: false })} 時点
      </span>
    </Glass>
  );
}

export function BackToListButton({ onClick, label = "地震一覧に戻る" }) {
  const { tokens } = useContext(ThemeContext);
  // ナビ行のガラスハイライトと同じ、"押し込むとガラスが少し膨らむ"演出。
  const [pressed, setPressed] = useState(false);

  return (
    <Glass
      radius={999}
      style={{
        width: 44, height: 44,
        transform: pressed ? "scale(1.16)" : "scale(1)",
        transformOrigin: "center",
        transition: "transform 0.18s cubic-bezier(.22,1,.36,1)",
      }}
    >
      <button
        onClick={onClick}
        onPointerDown={() => setPressed(true)}
        onPointerUp={() => setPressed(false)}
        onPointerCancel={() => setPressed(false)}
        onPointerLeave={() => setPressed(false)}
        aria-label={label}
        style={{
          position: "relative", zIndex: 1,
          width: "100%", height: "100%",
          display: "flex", alignItems: "center", justifyContent: "center",
          color: tokens.text,
        }}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none"
             stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="15 6 9 12 15 18"/>
        </svg>
      </button>
    </Glass>
  );
}

/* ─────────────────────────────────────────────────────
   LAYERS TOGGLE ICON
   ───────────────────────────────────────────────────── */
function LayersIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none"
         stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 2 7 12 12 22 7 12 2"/>
      <polyline points="2 17 12 22 22 17"/>
      <polyline points="2 12 12 17 22 12"/>
    </svg>
  );
}

/* ─────────────────────────────────────────────────────
   LIST VIEW ICON — 横長長方形が縦に3段積み上がったアイコン
   ───────────────────────────────────────────────────── */
export function ListViewIcon({ size = 18 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor">
      <rect x="3" y="4.5"  width="18" height="4" rx="1.6"/>
      <rect x="3" y="10.25" width="18" height="4" rx="1.6"/>
      <rect x="3" y="16"   width="18" height="4" rx="1.6"/>
    </svg>
  );
}

/* ─────────────────────────────────────────────────────
   REALTIME ICON — 地震タブのバー左端(リアルタイム)用の波形アイコン
   (旧リアルタイムタブのナビアイコンと同じ形)
   ───────────────────────────────────────────────────── */
export function RealtimeWaveIcon({ size = 18 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none"
         stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="2,12 7,12 9,5 13,19 15,12 22,12"/>
    </svg>
  );
}

/* ─────────────────────────────────────────────────────
   SEARCH ICON — 虫眼鏡アイコン
   ───────────────────────────────────────────────────── */
export function SearchGlassIcon({ size = 18 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none"
         stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="10.5" cy="10.5" r="6.5"/>
      <line x1="15.3" y1="15.3" x2="20.5" y2="20.5"/>
    </svg>
  );
}

/* ─────────────────────────────────────────────────────
   HISTORY ICON — 時計(履歴)アイコン。津波タブの「過去」モードで使う。
   ───────────────────────────────────────────────────── */
export function HistoryClockIcon({ size = 18 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none"
         stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12.5" r="8.5"/>
      <path d="M12 8v4.5l3 2"/>
      <path d="M9 2.5h6"/>
    </svg>
  );
}

/* ─────────────────────────────────────────────────────
   TIDE GAUGE ICON — 潮位計タブ用。目盛り付きの棒+波線で「水位計」を表す。
   ───────────────────────────────────────────────────── */
export function TideGaugeIcon({ size = 18 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none"
         stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 21V4.5"/>
      <path d="M6 7h2.5"/>
      <path d="M6 11h2.5"/>
      <path d="M6 15h2.5"/>
      <path d="M11 15c1.4-1.6 2.9-1.6 4.3 0s2.9 1.6 4.3 0"/>
    </svg>
  );
}

/* ─────────────────────────────────────────────────────
   PIN ICON — 気象タブ「地点」(登録地点)用の位置ピン
   ───────────────────────────────────────────────────── */
export function PinIcon({ size = 18 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none"
         stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 21.5c-4.3-4.4-6.5-8-6.5-11a6.5 6.5 0 0 1 13 0c0 3-2.2 6.6-6.5 11z"/>
      <circle cx="12" cy="10.5" r="2.4"/>
    </svg>
  );
}
