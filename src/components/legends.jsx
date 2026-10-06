import { useContext, useEffect, useState } from "react";
import { Glass } from "../ui/glass.jsx";
import { JMA_NOWCAST_SOURCE_PALETTE, NOWCAST_COLOR_SCHEMES, NowcastColorSchemeContext, formatNowcastFrameLabel, formatPrecipFrameLabel, nowcastNearestIndexToNow, nowcastValidtimeToMs } from "../weather/nowcast.js";
import { RISK_MODE_CONFIG, RIVER_LEVEL_STEPS } from "../weather/risk.js";
import { QUAKE_COLOR_SCHEMES, QuakeColorSchemeContext, ThemeContext, getIntensityStyleFromScheme } from "../settings/prefs.js";
import { TSUNAMI_GRADE_INFO, tsunamiGradeInfo, tsunamiHeightBandGrade } from "../api/p2p.js";
import { WARNING_LEVEL_COLOR, WARNING_LEVEL_PRIORITY } from "../api/warnings.js";

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
   NOWCAST LEGEND — 震度凡例・津波凡例と同じ見た目(Glassカード+隙間の
   詰まった横一列の色バー)にした、雨雲レーダーの降水強度凡例。
   選択中の配色スキーム(気象庁配色/Yahoo!天気配色)をそのまま反映する。
   ───────────────────────────────────────────────────── */
export function NowcastLegend() {
  const { tokens } = useContext(ThemeContext);
  const schemeId = useContext(NowcastColorSchemeContext);
  const scheme = NOWCAST_COLOR_SCHEMES[schemeId] || NOWCAST_COLOR_SCHEMES.jma;
  const colors = scheme.palette || JMA_NOWCAST_SOURCE_PALETTE;
  // colorsの各要素(弱い順)に対応する下限値(mm/h)。並びはJMA_NOWCAST_SOURCE_PALETTE
  // /YAHOO_WEATHER_NOWCAST_PALETTEの区分(0~1,1~5,5~10,10~20,20~30,30~50,50~80,80~)と対応。
  const NOWCAST_LEGEND_LOWER_BOUNDS = ["0", "1", "5", "10", "20", "30", "50", "80"];
  const SWATCH_WIDTH = 22; // 数値ラベルが収まるよう、震度凡例・津波凡例より少し幅広にしている

  return (
    <Glass
      radius={12}
      style={{ animation: "appear 0.35s cubic-bezier(.25,1,.5,1)" }}
    >
      <div style={{ display: "flex", flexDirection: "column", padding: "6px 8px 0" }}>
        {/* 単位ラベル。lineHeightを明示的に詰めて、フォントの行送り分の
            余白が上下に出ないようにする(指定しないと文字サイズの見た目以上に
            行の高さを取ってしまい、バーとの間に不自然な余白ができるため)。 */}
        <div style={{
          fontSize: 10, lineHeight: "11px", fontWeight: 700,
          color: `rgba(${tokens.ink},0.6)`, marginBottom: 3, whiteSpace: "nowrap",
        }}>
          mm/h
        </div>
        <div style={{ display: "flex", flexDirection: "row", alignItems: "center" }}>
          {colors.map((rgb, i) => (
            // 隙間なく連結した一続きのバーにし、両端だけ丸める
            <div
              key={i}
              style={{
                width: SWATCH_WIDTH, height: 9,
                borderRadius: i === 0 ? "2px 0 0 2px" : i === colors.length - 1 ? "0 2px 2px 0" : 0,
                background: `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`,
                flexShrink: 0,
              }}
            />
          ))}
        </div>
        <div style={{ display: "flex", flexDirection: "row", alignItems: "center" }}>
          {NOWCAST_LEGEND_LOWER_BOUNDS.map((label, i) => (
            // 各数値はその区分の下限値なので、ボックス中央でなく対応する
            // スウォッチの左端(色の境界線)に揃えて詰まって見えるようにする。
            // lineHeightを詰めて、フォントの行送り分の余白も削る。
            <div
              key={i}
              style={{
                width: SWATCH_WIDTH, flexShrink: 0, textAlign: "left", paddingLeft: 1,
                fontSize: 9, lineHeight: "9px", fontWeight: 600, color: `rgba(${tokens.ink},0.55)`,
              }}
            >
              {label}
            </div>
          ))}
        </div>
      </div>
    </Glass>
  );
}


/* ─────────────────────────────────────────────────────
   PRECIP LEGEND — NowcastLegendと全く同じ見た目・仕組み(Glassカード+隙間の
   詰まった横一列の色バー、配色は選択中のNowcastColorSchemeをそのまま反映)。
   1/3/24時間降水量はモードごとに目盛りの数値が異なる(気象庁の実際の凡例
   画像から採取した値)ため、モード名だけ外から渡してもらう。
   ・1時間: 雨雲レーダーと全く同じ区分(0,1,5,10,20,30,50,80 mm/h)
   ・3時間: 1,20,40,60,80,100,120,150 mm/3h
   ・24時間: 1,50,80,100,150,200,250,300 mm/24h
   ───────────────────────────────────────────────────── */
const PRECIP_LEGEND_LOWER_BOUNDS = {
  precip1h:  ["0", "1", "5", "10", "20", "30", "50", "80"],
  precip3h:  ["1", "20", "40", "60", "80", "100", "120", "150"],
  precip24h: ["1", "50", "80", "100", "150", "200", "250", "300"],
};

const PRECIP_LEGEND_UNIT = {
  precip1h: "mm/h",
  precip3h: "mm/3h",
  precip24h: "mm/24h",
};

export function PrecipLegend({ mode }) {
  const { tokens } = useContext(ThemeContext);
  const schemeId = useContext(NowcastColorSchemeContext);
  const scheme = NOWCAST_COLOR_SCHEMES[schemeId] || NOWCAST_COLOR_SCHEMES.jma;
  const colors = scheme.palette || JMA_NOWCAST_SOURCE_PALETTE;
  const bounds = PRECIP_LEGEND_LOWER_BOUNDS[mode] || PRECIP_LEGEND_LOWER_BOUNDS.precip1h;
  const unit = PRECIP_LEGEND_UNIT[mode] || "mm";
  const SWATCH_WIDTH = 22; // NowcastLegendと同じ幅

  return (
    <Glass
      radius={12}
      style={{ animation: "appear 0.35s cubic-bezier(.25,1,.5,1)" }}
    >
      <div style={{ display: "flex", flexDirection: "column", padding: "6px 8px 0" }}>
        {/* 単位ラベル。1/3/24時間のどのモードの凡例か分かるよう、雨雲レーダーの
            凡例(NowcastLegend)にはもともと無かった見出しを1行追加している。
            lineHeightを明示的に詰めて、フォントの行送り分の余白が上下に
            出ないようにする。 */}
        <div style={{
          fontSize: 10, lineHeight: "11px", fontWeight: 700,
          color: `rgba(${tokens.ink},0.6)`, marginBottom: 3, whiteSpace: "nowrap",
        }}>
          {unit}
        </div>
        <div style={{ display: "flex", flexDirection: "row", alignItems: "center" }}>
          {colors.map((rgb, i) => (
            <div
              key={i}
              style={{
                width: SWATCH_WIDTH, height: 9,
                borderRadius: i === 0 ? "2px 0 0 2px" : i === colors.length - 1 ? "0 2px 2px 0" : 0,
                background: `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`,
                flexShrink: 0,
              }}
            />
          ))}
        </div>
        <div style={{ display: "flex", flexDirection: "row", alignItems: "center" }}>
          {bounds.map((label, i) => (
            <div
              key={i}
              style={{
                width: SWATCH_WIDTH, flexShrink: 0, textAlign: "left", paddingLeft: 1,
                fontSize: 9, lineHeight: "9px", fontWeight: 600, color: `rgba(${tokens.ink},0.55)`,
              }}
            >
              {label}
            </div>
          ))}
        </div>
      </div>
    </Glass>
  );
}


/* ─────────────────────────────────────────────────────
   WDIST LEGEND — 天気分布予報の凡例。天気分布(晴れ/くもり/雨/雨または雪/雪の
   5分類)は連続的な数値スケールではないカテゴリなので、横一列のバーではなく
   「色見本+ラベル」を縦に並べる形にしている。気温分布は降水量と同じく
   連続的な数値なので、PrecipLegendと同じ横一列のバー形式にしている。
   ⚠️ どちらも色はJMAの実際のタイル配色を確認できていない暫定値。実機で
   確認できたら実際の配色に合わせて直す。
   ───────────────────────────────────────────────────── */
const WDIST_WEATHER_CATEGORIES = [
  { label: "晴れ", color: "#F5A623" },
  { label: "くもり", color: "#9AA0A6" },
  { label: "雨", color: "#4A90D9" },
  { label: "雨または雪", color: "#B48EAD" },
  { label: "雪", color: "#E8EEF5" },
];

// 気温分布用の配色・区分値(℃)。ユーザー提供のJMA凡例画像から採取した実際の
// スケール。画像は縦方向(下=寒い/薄紫〜上=暑い/濃い臙脂)なので、横一列の
// バーに直す際は「左=寒い、右=暑い」の向きにしている(雨雲レーダー・降水量の
// 凡例と同じ、弱い/低い方を左に置く向き)。
// 色は画像から目視で採取した近似値。
const WDIST_TEMP_LEGEND_COLORS = [
  [216, 214, 227], // 〜-25(パレット画像の一番下、パステル紫)
  [178, 175, 201], // -25〜-20
  [147, 143, 175], // -20〜-15
  [90, 86, 120],   // -15〜-10
  [20, 40, 110],   // -10〜-5
  [35, 70, 220],   // -5〜0
  [70, 130, 230],  // 0〜5
  [180, 220, 245], // 5〜10
  [255, 255, 230], // 10〜15
  [255, 255, 150], // 15〜20
  [255, 230, 20],  // 20〜25
  [245, 165, 60],  // 25〜30
  [235, 80, 40],   // 30〜35
  [180, 30, 100],  // 35〜40
  [75, 10, 35],    // 40〜(画像の一番上、濃い臙脂)
];

// 一番左(最も寒い)のバンドは画像でも下限値が示されていないため、先頭だけ
// 空文字にする(1時間降水量の凡例で先頭"0"を省いたのと同じ扱い)。
const WDIST_TEMP_LEGEND_BOUNDS = ["", "-25", "-20", "-15", "-10", "-5", "0", "5", "10", "15", "20", "25", "30", "35", "40"];


export function WdistLegend({ mode }) {
  const { tokens } = useContext(ThemeContext);

  if (mode === "temperature") {
    const SWATCH_WIDTH = 17; // 15段あるのでPrecipLegendより少し狭くして詰める
    const barWidth = WDIST_TEMP_LEGEND_COLORS.length * SWATCH_WIDTH;
    return (
      <Glass
        radius={12}
        style={{ animation: "appear 0.35s cubic-bezier(.25,1,.5,1)" }}
      >
        <div style={{ display: "flex", flexDirection: "column", padding: "6px 8px 0" }}>
          <div style={{
            fontSize: 10, lineHeight: "11px", fontWeight: 700,
            color: `rgba(${tokens.ink},0.6)`, marginBottom: 3, whiteSpace: "nowrap",
          }}>
            ℃
          </div>
          <div style={{ display: "flex", flexDirection: "row", alignItems: "center" }}>
            {WDIST_TEMP_LEGEND_COLORS.map((rgb, i) => (
              <div
                key={i}
                style={{
                  width: SWATCH_WIDTH, height: 9,
                  borderRadius: i === 0 ? "2px 0 0 2px" : i === WDIST_TEMP_LEGEND_COLORS.length - 1 ? "0 2px 2px 0" : 0,
                  background: `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`,
                  flexShrink: 0,
                }}
              />
            ))}
          </div>
          {/* 数字は各色の下ではなく、境界線(色と色の切れ目)のちょうど真上に
              来るよう、絶対配置で中央揃えにする。 */}
          <div style={{ position: "relative", width: barWidth, height: 10 }}>
            {WDIST_TEMP_LEGEND_BOUNDS.map((label, i) => (
              label ? (
                <div
                  key={i}
                  style={{
                    position: "absolute", left: i * SWATCH_WIDTH, top: 0,
                    transform: "translateX(-50%)",
                    fontSize: 8, lineHeight: "9px", fontWeight: 600, color: `rgba(${tokens.ink},0.55)`,
                    whiteSpace: "nowrap",
                  }}
                >
                  {label}
                </div>
              ) : null
            ))}
          </div>

        </div>
      </Glass>
    );
  }

  // mode === "weather"(デフォルト)
  return (
    <Glass
      radius={12}
      style={{ animation: "appear 0.35s cubic-bezier(.25,1,.5,1)" }}
    >
      <div style={{ display: "flex", flexDirection: "column", padding: "8px 10px", gap: 5 }}>
        <div style={{
          fontSize: 10, lineHeight: "11px", fontWeight: 700,
          color: `rgba(${tokens.ink},0.6)`, marginBottom: 1, whiteSpace: "nowrap",
        }}>
          天気
        </div>
        {WDIST_WEATHER_CATEGORIES.map(cat => (
          <div key={cat.label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{
              width: 12, height: 12, borderRadius: 3, flexShrink: 0,
              background: cat.color,
              boxShadow: `inset 0 0 0 0.5px rgba(${tokens.ink},0.15)`,
            }}/>
            <span style={{ fontSize: 11, fontWeight: 600, color: tokens.text, whiteSpace: "nowrap" }}>
              {cat.label}
            </span>
          </div>
        ))}
      </div>
    </Glass>
  );
}


/* ─────────────────────────────────────────────────────
   RISK LEGEND — 警報タブのキキクル(土砂/浸水)レイヤーの凡例。PrecipLegendと
   全く同じ見た目・仕組み(Glassカード+隙間の詰まった横一列の色バー)。
   区分値ではなく危険度レベル(5〜1)なので、目盛りは1〜5の数字にする。
   レベル1(無色)は背景に馴染んで見えなくなるので、薄い枠線を付ける。
   ───────────────────────────────────────────────────── */
const RISK_LEGEND_LEVELS = [
  { level: 1, color: "rgba(255,255,255,0.08)", border: true }, // 注意(無色)
  { level: 2, color: "#f2e700" }, // 警戒
  { level: 3, color: "#ff2800" }, // 非常に危険
  { level: 4, color: "#aa00aa" }, // 極めて危険
  { level: 5, color: "#0c000c" }, // 災害切迫
];

export function RiskLegend({ mode }) {
  const { tokens } = useContext(ThemeContext);
  const title = RISK_MODE_CONFIG[mode]?.label || "キキクル";
  const SWATCH_WIDTH = 22; // PrecipLegendと同じ幅

  return (
    <Glass
      radius={12}
      style={{ animation: "appear 0.35s cubic-bezier(.25,1,.5,1)" }}
    >
      <div style={{ display: "flex", flexDirection: "column", padding: "6px 8px 0" }}>
        <div style={{
          fontSize: 10, lineHeight: "11px", fontWeight: 700,
          color: `rgba(${tokens.ink},0.6)`, marginBottom: 3, whiteSpace: "nowrap",
        }}>
          {title}
        </div>
        <div style={{ display: "flex", flexDirection: "row", alignItems: "center" }}>
          {RISK_LEGEND_LEVELS.map((item, i) => (
            <div
              key={item.level}
              style={{
                width: SWATCH_WIDTH, height: 9, boxSizing: "border-box",
                borderRadius: i === 0 ? "2px 0 0 2px" : i === RISK_LEGEND_LEVELS.length - 1 ? "0 2px 2px 0" : 0,
                background: item.color,
                border: item.border ? `1px solid rgba(${tokens.ink},0.3)` : "none",
                flexShrink: 0,
              }}
            />
          ))}
        </div>
        <div style={{ display: "flex", flexDirection: "row", alignItems: "center", paddingBottom: 5 }}>
          {RISK_LEGEND_LEVELS.map((item) => (
            <div
              key={item.level}
              style={{
                width: SWATCH_WIDTH, flexShrink: 0, textAlign: "left", paddingLeft: 1,
                fontSize: 9, lineHeight: "9px", fontWeight: 600, color: `rgba(${tokens.ink},0.55)`,
              }}
            >
              {item.level}
            </div>
          ))}
        </div>
      </div>
    </Glass>
  );
}


/* ─────────────────────────────────────────────────────
   RIVER LEGEND — 警報タブの河川水位観測所レイヤーの凡例。RiskLegendと同じ
   Glassカードだが、区分値がレベル(5段階+通常)ではなく、色付きの丸+ラベルを
   縦に並べる形にする(河川水位は「通常」も含めて意味のある名前が付いているため、
   RiskLegendの数字だけの目盛りよりラベルを出した方が分かりやすい)。
   ───────────────────────────────────────────────────── */
export function RiverLegend() {
  const { tokens } = useContext(ThemeContext);
  return (
    <Glass
      radius={12}
      style={{ animation: "appear 0.35s cubic-bezier(.25,1,.5,1)" }}
    >
      <div style={{ display: "flex", flexDirection: "column", padding: "6px 8px 7px", gap: 3 }}>
        <div style={{
          fontSize: 10, lineHeight: "11px", fontWeight: 700,
          color: `rgba(${tokens.ink},0.6)`, marginBottom: 1, whiteSpace: "nowrap",
        }}>
          河川水位
        </div>
        {[...RIVER_LEVEL_STEPS].reverse().map((step) => (
          <div key={step.level} style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{
              width: 8, height: 8, borderRadius: 999, flexShrink: 0,
              background: step.color,
              border: step.level === 0 ? `1px solid rgba(${tokens.ink},0.3)` : "none",
            }}/>
            <span style={{ fontSize: 9.5, fontWeight: 600, color: `rgba(${tokens.ink},0.6)`, whiteSpace: "nowrap" }}>
              {step.label}
            </span>
          </div>
        ))}
      </div>
    </Glass>
  );
}



/* ─────────────────────────────────────────────────────
   WARNING LEGEND — 警報タブの気象警報・注意報レイヤーの凡例。
   TsunamiGradeLegend/QuakeIntensityLegendと全く同じ見た目(横一列の隙間の
   詰まった色バー)で、実際に発表されている中の最も低いレベルから最も高い
   レベルまでをラダー表示する(例: 注意報と警報が両方出ていれば2段、
   最高が警報だけなら「注意報→警報」の2段まで並べる)。
   ───────────────────────────────────────────────────── */
const WARNING_LEGEND_ORDER = ["chui", "keiho", "kiken", "tokubetsu"];


export function WarningLegend({ warningLevelMap }) {
  const { tokens } = useContext(ThemeContext);
  const levelsPresent = [...new Set(Object.values(warningLevelMap || {}).map(v => v.level))];
  if (levelsPresent.length === 0) return null;

  const maxWeight = Math.max(...levelsPresent.map(l => WARNING_LEVEL_PRIORITY[l]));
  const ladderLevels = WARNING_LEGEND_ORDER.filter(key => WARNING_LEVEL_PRIORITY[key] <= maxWeight);

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
        {ladderLevels.map(level => {
          const isMax = WARNING_LEVEL_PRIORITY[level] === maxWeight;
          return (
            <div
              key={level}
              style={{
                width: 7, height: 16, borderRadius: 2,
                background: WARNING_LEVEL_COLOR[level],
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
   NOWCAST TIME SLIDER — 雨雲レーダーがONで、展開メニュー(WeatherMenuFloating)が
   閉じている間だけ、ボタンバー(下部ナビ行)のすぐ上に浮かべる時刻スライダー。
   実況(過去)+予測(未来60分)を1本のタイムラインとしてドラッグで選べる。
   ───────────────────────────────────────────────────── */
export function NowcastTimeSlider({ frames, frameIndex, onChangeFrameIndex }) {
  const { tokens } = useContext(ThemeContext);
  const [isPlaying, setIsPlaying] = useState(false);

  // 自動再生。frames自体が変わった(=一覧が5分おきに取り直された)時や
  // コマが無くなった時は再生を止める。onChangeFrameIndexは実体が
  // useStateのsetterなので関数更新(prev => ...)を渡せる。
  useEffect(() => {
    if (!isPlaying || !frames || frames.length < 2) return;
    const id = setInterval(() => {
      onChangeFrameIndex(prev => ((prev ?? 0) + 1) % frames.length);
    }, 700);
    return () => clearInterval(id);
  }, [isPlaying, frames, onChangeFrameIndex]);

  useEffect(() => {
    if (!frames || frames.length === 0) setIsPlaying(false);
  }, [frames]);

  if (!frames || frames.length === 0) return null;
  const frame = frames[frameIndex] ?? frames[frames.length - 1];
  // 実況→予測の切り替わり(=「現在」)の位置。目盛りをここだけ目立たせる。
  // 「最初の予測コマ」ではなく「最後の実況コマ」を現在とする(予測コマは
  // 現在より先の時刻なので、最初の予測コマを現在扱いにすると実際より
  // 先のコマが「現在」として長く目立ってしまっていた)。
  const firstForecastIndex = frames.findIndex(f => f.kind === "forecast");
  const nowIndex = firstForecastIndex === -1 ? frames.length - 1 : Math.max(0, firstForecastIndex - 1);
  // 目盛りを長くする基準となる「現在時刻」。実況/予測の切り替わり位置の
  // validtimeを基準に、そこからプラマイ1時間ごと(60分刻み)のコマだけ
  // 長い目盛りにする(時計の正時ではなく、あくまで「現在」からの相対時間)。
  const nowFrame = nowIndex >= 0 ? frames[nowIndex] : frames[frames.length - 1];
  const nowMs = nowFrame ? nowcastValidtimeToMs(nowFrame.validtime) : null;

  return (
    <Glass
      radius={14}
      style={{ flex: 1, minWidth: 0, animation: "appear 0.3s cubic-bezier(.25,1,.5,1)" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px" }}>
        <button
          onClick={() => setIsPlaying(v => !v)}
          aria-label={isPlaying ? "自動再生を止める" : "自動再生する"}
          style={{
            flexShrink: 0, width: 26, height: 26, borderRadius: 999,
            display: "flex", alignItems: "center", justifyContent: "center",
            color: tokens.text, background: `rgba(${tokens.ink},0.08)`,
          }}
        >
          {isPlaying ? (
            <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
              <rect x="5" y="4" width="5" height="16" rx="1.2"/>
              <rect x="14" y="4" width="5" height="16" rx="1.2"/>
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor">
              <path d="M6 4.2c0-1 1.1-1.7 2-1.1l12 7.8c.8.5.8 1.7 0 2.2l-12 7.8c-.9.6-2-.1-2-1.1z"/>
            </svg>
          )}
        </button>
        {/* 数値ラベル。プロポーショナルフォントだと数字ごとにグリフ幅が違い
            (「1」は「8」より細い等)、コマが変わるたびにこのラベルの実測幅が
            微妙に変わってスライダー本体の長さがガタつく原因になっていたため、
            tabular-numsで数字幅を揃え、かつ幅を固定してレイアウトに影響しない
            ようにする。 */}
        <span style={{
          fontSize: 12.5, fontWeight: 700, color: tokens.text, flexShrink: 0,
          whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums",
          width: 74, textAlign: "left",
        }}>
          {formatNowcastFrameLabel(frame)}
        </span>
        <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
          {/* トラックとつまみのサイズをブラウザ既定に任せず固定している。
              目盛り側の内側マージン(left/right)もつまみの半幅(5px)に
              揃えることで、各目盛りの位置とスライダーのつまみが実際にその
              値になったときの中心位置が常に一致するようにしている
              (既定のつまみサイズはブラウザ・OSごとにまちまちで、決め打ちの
              マージンとズレることがあったため)。つまみは目盛り線と馴染む
              よう、丸ではなく角の取れた縦長の長方形にしている。 */}
          <style>{`
            .nowcast-range { -webkit-appearance: none; appearance: none; background: transparent; }
            .nowcast-range::-webkit-slider-runnable-track {
              height: 4px; border-radius: 2px; background: rgba(${tokens.ink},0.16);
            }
            .nowcast-range::-webkit-slider-thumb {
              -webkit-appearance: none; appearance: none;
              width: 10px; height: 26px; border-radius: 4px;
              background: #0A84FF; margin-top: -11px; cursor: pointer;
            }
            .nowcast-range::-moz-range-track {
              height: 4px; border-radius: 2px; background: rgba(${tokens.ink},0.16);
            }
            .nowcast-range::-moz-range-thumb {
              width: 10px; height: 26px; border-radius: 4px;
              background: #0A84FF; border: none; cursor: pointer;
            }
          `}</style>
          {/* 目盛り — トラックに重ねて表示する。つまみの半幅ぶん(左右5px)
              内側に収め、つまみの中心と目盛りの位置がずれないように
              している。1コマごとに薄い目盛りを、「現在」からプラマイ1時間
              ごとのコマは少し濃く長い目盛りにし、実況→予測の切り替わり
              (現在そのもの)だけ青く目立たせる。 */}
          <div style={{
            position: "absolute", left: 5, right: 5, top: "50%",
            transform: "translateY(-50%)",
            height: 22, pointerEvents: "none",
          }}>
            {frames.map((f, i) => {
              const pct = frames.length > 1 ? (i / (frames.length - 1)) * 100 : 0;
              const fMs = nowcastValidtimeToMs(f.validtime);
              const diffMin = nowMs != null && fMs != null ? Math.round((fMs - nowMs) / 60000) : null;
              const isHour = diffMin != null && diffMin % 60 === 0;
              const isNow = i === nowIndex;
              return (
                <div
                  key={i}
                  style={{
                    position: "absolute", left: `${pct}%`, top: 0,
                    transform: "translateX(-50%)",
                    width: isNow ? 2 : 1,
                    height: isNow ? 22 : isHour ? 18 : 11,
                    borderRadius: 1,
                    background: isNow ? "#0A84FF" : `rgba(${tokens.ink},${isHour ? 0.35 : 0.16})`,
                  }}
                />
              );
            })}
          </div>
          <input
            className="nowcast-range"
            type="range"
            min={0}
            max={frames.length - 1}
            step={1}
            value={frameIndex}
            onChange={(e) => onChangeFrameIndex(Number(e.target.value))}
            style={{ position: "relative", display: "block", width: "100%" }}
          />
        </div>
      </div>
    </Glass>
  );
}


// 1/3/24時間降水量用の時刻スライダー。NowcastTimeSliderとほぼ同じ見た目・
// 操作感だが、フレームに"kind"(実況/予測)の区別が無い(データ形式が未確認の
// ため)ので、「現在」の位置は現在時刻に一番近いコマ(nowcastNearestIndexToNow)
// から求める。
export function PrecipTimeSlider({ frames, frameIndex, onChangeFrameIndex, formatLabel = formatPrecipFrameLabel }) {
  const { tokens } = useContext(ThemeContext);
  const [isPlaying, setIsPlaying] = useState(false);

  useEffect(() => {
    if (!isPlaying || !frames || frames.length < 2) return;
    const id = setInterval(() => {
      onChangeFrameIndex(prev => ((prev ?? 0) + 1) % frames.length);
    }, 700);
    return () => clearInterval(id);
  }, [isPlaying, frames, onChangeFrameIndex]);

  useEffect(() => {
    if (!frames || frames.length === 0) setIsPlaying(false);
  }, [frames]);

  if (!frames || frames.length === 0) return null;
  const frame = frames[frameIndex] ?? frames[frames.length - 1];
  const nowIndex = nowcastNearestIndexToNow(frames) ?? frames.length - 1;
  const nowFrame = frames[nowIndex];
  const nowMs = nowFrame ? nowcastValidtimeToMs(nowFrame.validtime) : null;

  return (
    <Glass
      radius={14}
      style={{ flex: 1, minWidth: 0, animation: "appear 0.3s cubic-bezier(.25,1,.5,1)" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px" }}>
        <button
          onClick={() => setIsPlaying(v => !v)}
          aria-label={isPlaying ? "自動再生を止める" : "自動再生する"}
          style={{
            flexShrink: 0, width: 26, height: 26, borderRadius: 999,
            display: "flex", alignItems: "center", justifyContent: "center",
            color: tokens.text, background: `rgba(${tokens.ink},0.08)`,
          }}
        >
          {isPlaying ? (
            <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
              <rect x="5" y="4" width="5" height="16" rx="1.2"/>
              <rect x="14" y="4" width="5" height="16" rx="1.2"/>
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor">
              <path d="M6 4.2c0-1 1.1-1.7 2-1.1l12 7.8c.8.5.8 1.7 0 2.2l-12 7.8c-.9.6-2-.1-2-1.1z"/>
            </svg>
          )}
        </button>
        <span style={{
          fontSize: 12.5, fontWeight: 700, color: tokens.text, flexShrink: 0,
          whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums",
          width: 84, textAlign: "left",
        }}>
          {formatLabel(frame)}
        </span>
        <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
          <style>{`
            .precip-range { -webkit-appearance: none; appearance: none; background: transparent; }
            .precip-range::-webkit-slider-runnable-track {
              height: 4px; border-radius: 2px; background: rgba(${tokens.ink},0.16);
            }
            .precip-range::-webkit-slider-thumb {
              -webkit-appearance: none; appearance: none;
              width: 10px; height: 26px; border-radius: 4px;
              background: #0A84FF; margin-top: -11px; cursor: pointer;
            }
            .precip-range::-moz-range-track {
              height: 4px; border-radius: 2px; background: rgba(${tokens.ink},0.16);
            }
            .precip-range::-moz-range-thumb {
              width: 10px; height: 26px; border-radius: 4px;
              background: #0A84FF; border: none; cursor: pointer;
            }
          `}</style>
          <div style={{
            position: "absolute", left: 5, right: 5, top: "50%",
            transform: "translateY(-50%)",
            height: 22, pointerEvents: "none",
          }}>
            {frames.map((f, i) => {
              const pct = frames.length > 1 ? (i / (frames.length - 1)) * 100 : 0;
              const fMs = nowcastValidtimeToMs(f.validtime);
              const diffMin = nowMs != null && fMs != null ? Math.round((fMs - nowMs) / 60000) : null;
              const isHour = diffMin != null && diffMin % 60 === 0;
              const isNow = i === nowIndex;
              return (
                <div
                  key={i}
                  style={{
                    position: "absolute", left: `${pct}%`, top: 0,
                    transform: "translateX(-50%)",
                    width: isNow ? 2 : 1,
                    height: isNow ? 22 : isHour ? 18 : 11,
                    borderRadius: 1,
                    background: isNow ? "#0A84FF" : `rgba(${tokens.ink},${isHour ? 0.35 : 0.16})`,
                  }}
                />
              );
            })}
          </div>
          <input
            className="precip-range"
            type="range"
            min={0}
            max={frames.length - 1}
            step={1}
            value={frameIndex}
            onChange={(e) => onChangeFrameIndex(Number(e.target.value))}
            style={{ position: "relative", display: "block", width: "100%" }}
          />
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
