import { createContext, useState, useEffect } from "react";


/* ─────────────────────────────────────────────────────
   ライト/ダークモード
   
   アプリ全体はもともとダーク基調(#121214背景+白文字)で作られているため、
   ライトモードは「別の配色を丸ごと用意し、UIのベースとなる色をcontext経由で
   出し分ける」形で追加する。地図の基本配色(海・陸のタイル色)や、震度色
   バッジのような意味を持つ色(震度配色スキームなど)まではこの対応範囲に
   含めない(それらは別途テーマ対応が必要)。まずは背景・カード・文字色
   など、UIチューム全体に効いてくる基礎トークンをテーマ切り替え対象にする。
   ───────────────────────────────────────────────────── */
/* ─────────────────────────────────────────────────────
   地図の基本配色(海・陸・境界線)の既定値と、ユーザーによる上書き
   ライト/ダークで別々に持つ。線(境界線)は半透明なので、色と不透明度の組で扱う。
   THEME_TOKENSの地図用トークンはここの既定値から作り、ユーザーが色を変えた場合だけ
   applyMapColorOverridesで上書きする(UI用の色には影響しない)。
   ───────────────────────────────────────────────────── */
export const MAP_COLOR_ITEMS = [
  { key: "mapBg",        label: "海",               type: "fill" },
  { key: "mapPrefFill",  label: "陸(日本)",         type: "fill" },
  { key: "mapWorldFill", label: "陸(海外)",         type: "fill" },
  { key: "mapPrefLine",  label: "都道府県の境界線", type: "line" },
  { key: "mapWorldLine", label: "国境線",           type: "line" },
];

export const MAP_COLOR_DEFAULTS = {
  dark: {
    mapBg: "#121214", mapPrefFill: "#3a3a3c", mapWorldFill: "#2c2c2e",
    mapPrefLine: { color: "#ffffff", opacity: 0.18 },
    mapWorldLine: { color: "#ffffff", opacity: 0.08 },
  },
  light: {
    mapBg: "#aecbe8", mapPrefFill: "#f2f0ea", mapWorldFill: "#e4e2dc",
    mapPrefLine: { color: "#15161a", opacity: 0.22 },
    mapWorldLine: { color: "#15161a", opacity: 0.12 },
  },
};

// {color:"#rrggbb", opacity:0〜1} → "rgba(r,g,b,a)"(MapLibreのline-colorにそのまま渡せる形)
export function mapLineToCss({ color, opacity }) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color || "");
  if (!m) return "rgba(0,0,0,0)";
  const [r, g, b] = [m[1], m[2], m[3]].map(h => parseInt(h, 16));
  return `rgba(${r},${g},${b},${opacity})`;
}

// モード別のユーザー設定(overrides = { light: {...}, dark: {...} })を、地図用トークンに反映する。
export function applyMapColorOverrides(tokens, mode, overrides) {
  const o = overrides && overrides[mode];
  if (!o) return tokens;
  let next = null;
  for (const item of MAP_COLOR_ITEMS) {
    const v = o[item.key];
    if (v == null) continue;
    next = next || { ...tokens };
    next[item.key] = item.type === "line" ? mapLineToCss(v) : v;
  }
  return next || tokens;
}

export const THEME_TOKENS = {
  dark: {
    pageBg: "#121214",
    text: "#ffffff",
    textSecondary: "rgba(255,255,255,0.55)",
    textTertiary: "rgba(255,255,255,0.35)",
    cardBg: "rgba(255,255,255,0.04)",
    cardBorder: "rgba(255,255,255,0.08)",
    divider: "rgba(255,255,255,0.08)",
    glassTint: "rgba(255,255,255,0.02)",
    glassOpaqueBg: "rgba(32,32,36,0.92)",
    rimLight: "rgba(255,255,255,0.45)",
    rimHighlight: "rgba(255,255,255,0.55)",
    // ナビ行(SideNavRail/BottomDockの下部タブ)の選択中ピル。
    // ダークはこれまで通りガラスの縁取り(rim)入りの見た目を維持する。
    navPillBg: "rgba(255,255,255,0.13)",
    navPillShadow: "inset 0 0 0 0.5px rgba(255,255,255,0.45), inset 0 1px 0 rgba(255,255,255,0.55)",
    // 文字・線用のRGBチャンネル値(不透明度だけ変えたrgba(${tokens.ink},X)の形で
    // 各所から使う。ダークは白、ライトはほぼ黒)。
    ink: "255,255,255",
    // 検索ボタンなどのアクセント文字色。ダークは明るい水色の方が背景に映えるが、
    // ライトの明るい背景だと同じ色ではコントラストが足りず読みにくくなるため、
    // ライトモードではやや濃い標準的なシステムブルーにする。
    accentText: "#64D2FF",
    // 地図の基本配色(海・陸・都道府県境界線)
    mapBg: MAP_COLOR_DEFAULTS.dark.mapBg,                       // 海
    mapWorldFill: MAP_COLOR_DEFAULTS.dark.mapWorldFill,         // 陸地(海外)
    mapWorldLine: mapLineToCss(MAP_COLOR_DEFAULTS.dark.mapWorldLine),
    mapPrefFill: MAP_COLOR_DEFAULTS.dark.mapPrefFill,           // 都道府県(日本)
    mapPrefLine: mapLineToCss(MAP_COLOR_DEFAULTS.dark.mapPrefLine),
  },
  light: {
    pageBg: "#eef0f3",
    text: "#15161a",
    textSecondary: "rgba(21,22,26,0.6)",
    textTertiary: "rgba(21,22,26,0.4)",
    cardBg: "rgba(21,22,26,0.045)",
    cardBorder: "rgba(21,22,26,0.10)",
    divider: "rgba(21,22,26,0.10)",
    glassTint: "rgba(255,255,255,0.55)",
    glassOpaqueBg: "rgba(244,245,248,0.94)",
    rimLight: "rgba(21,22,26,0.16)",
    rimHighlight: "rgba(255,255,255,0.8)",
    // ナビ行の選択中ピル。参考画像のような、縁取りのないフラットな
    // 淡いグレーのピルにする(ダークのようなガラスの縁取りは入れない)。
    navPillBg: "rgba(21,22,26,0.07)",
    navPillShadow: "none",
    ink: "21,22,26",
    accentText: "#0A84FF",
    // 地図の基本配色(海・陸・都道府県境界線)
    mapBg: MAP_COLOR_DEFAULTS.light.mapBg,                      // 海
    mapWorldFill: MAP_COLOR_DEFAULTS.light.mapWorldFill,        // 陸地(海外)
    mapWorldLine: mapLineToCss(MAP_COLOR_DEFAULTS.light.mapWorldLine),
    mapPrefFill: MAP_COLOR_DEFAULTS.light.mapPrefFill,          // 都道府県(日本)
    mapPrefLine: mapLineToCss(MAP_COLOR_DEFAULTS.light.mapPrefLine),
  },
};

// UIのベースになる配色トークンを、モード("dark"|"light")込みでアプリ全体に配るcontext。
// mode: 実際に適用中のライト/ダーク("dark"|"light"、"system"選択時はデバイス設定から解決した結果)。
// modePref: ユーザーが選んだ設定そのもの("system"|"light"|"dark"、初期設定は"system")。
// setModePref: modePrefを変更する関数。
export const ThemeContext = createContext({
  mode: "dark",
  tokens: THEME_TOKENS.dark,
  modePref: "system",
  setModePref: () => {},
});

// デバイスの配色設定(prefers-color-scheme)をライブで監視するフック。
// "デバイスの設定に合わせる"がONの間、この値をそのままthemeMode解決に使う。
// 端末側でライト/ダークが切り替わった場合もリアルタイムに追従する。
export function useSystemThemeMode() {
  const [systemMode, setSystemMode] = useState(() => {
    try {
      return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    } catch (err) {
      return "dark";
    }
  });

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const handleChange = (e) => setSystemMode(e.matches ? "light" : "dark");
    if (mq.addEventListener) mq.addEventListener("change", handleChange);
    else if (mq.addListener) mq.addListener(handleChange); // 古いSafari向けフォールバック
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", handleChange);
      else if (mq.removeListener) mq.removeListener(handleChange);
    };
  }, []);

  return systemMode;
}

// ナビ等のハイライトピルを指で押している間だけ本物のガラス(backdrop-filter)に
// する際のぼかし量。ライトモードは背景の色情報が少なく、ダークと同じ強さでは
// 「ガラス感」が弱く見えるため、ぼかし・彩度ともライトの方を強めにしている。
export function touchGlassBackdropFilter(mode) {
  return mode === "light"
    ? "blur(22px) saturate(220%)"
    : "blur(16px) saturate(160%)";
}

// テーマの選択はlocalStorageに保存し、次回起動時も覚えておく。
// 値は"system"(デバイスの設定に合わせる。初期設定) | "light" | "dark"。
const THEME_MODE_STORAGE_KEY = "themeMode";

export function loadStoredThemeModePref() {
  try {
    const saved = localStorage.getItem(THEME_MODE_STORAGE_KEY);
    if (saved === "light" || saved === "dark" || saved === "system") return saved;
  } catch (err) {
    console.warn("テーマ設定を読み込めませんでした:", err);
  }
  return "system";
}

export function saveThemeModePref(modePref) {
  try {
    localStorage.setItem(THEME_MODE_STORAGE_KEY, modePref);
  } catch (err) {
    console.warn("テーマ設定を保存できませんでした:", err);
  }
}
