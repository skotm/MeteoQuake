import { createContext, useContext, useEffect, useState } from "react";
import { INTENSITY_LABEL } from "../quake/intensityScale.jsx";

/* ─────────────────────────────────────────────────────
   断層・プレート境界レイヤーの配色。
   ・縁取り(halo)はライト/ダーク共通の固定色にする(どちらのテーマでも
     海・陸に対して十分なコントラストが出る中間グレーを採用)。
   ・枠内の色(core)は設定画面でユーザーが選べるようにする。
   ───────────────────────────────────────────────────── */
const BOUNDARY_HALO_COLOR = "#86868c";


// 枠内の色が「グレー」の時だけ、縁取り(halo)を白にする。
// core・halo両方が似た中間グレーだと、二層構造(縁取り+芯)のコントラストが
// なくなって見分けにくくなるため、グレー選択時だけ縁取りを明るくして
// 芯とのコントラストを保つ。それ以外の色(オレンジ等)は、既に彩度差で
// haloとの区別がつくため、共通の固定グレーのままにする。
export function getBoundaryHaloColor(colorId) {
  return colorId === "gray" ? "#ffffff" : BOUNDARY_HALO_COLOR;
}


export const BOUNDARY_LINE_COLORS = {
  gray:   { label: "グレー",   color: "#9a9a9f" },
  white:  { label: "ホワイト", color: "#ffffff", checkColor: "#1c1c1e" }, // 白背景に白チェックだと見えないため、チェックだけ濃色にする
  orange: { label: "オレンジ", color: "#ff9500" },
  red:    { label: "レッド",   color: "#ff3b30" },
  blue:   { label: "ブルー",   color: "#0a84ff" },
  green:  { label: "グリーン", color: "#34c759" },
  purple: { label: "パープル", color: "#af52de" },
};


export const QUAKE_COLOR_SCHEMES = {
  // 過去のLeaflet版(getIntensityColor)と全く同じ、鮮やかなApple風パレット。
  legacy: {
    id: "legacy",
    label: "eqs viewer配色",
    colors: {
      "0":  { bg: "#8E8E93", fg: "#fff" },
      "1":  { bg: "#64D2FF", fg: "#0B0B0C" },
      "2":  { bg: "#0A84FF", fg: "#fff" },
      "3":  { bg: "#30D158", fg: "#0B0B0C" },
      "4":  { bg: "#FFD60A", fg: "#0B0B0C" },
      "5":  { bg: "#FF9F0A", fg: "#0B0B0C" }, // 1996年10月改定前の「弱/強」区分が無い震度5
      "5-": { bg: "#FF9F0A", fg: "#0B0B0C" },
      "5+": { bg: "#FF453A", fg: "#fff" },
      "6":  { bg: "#FF2D55", fg: "#fff" }, // 同上、震度6
      "6-": { bg: "#FF2D55", fg: "#fff" },
      "6+": { bg: "#BF5AF2", fg: "#fff" },
      "7":  { bg: "#5E5CE6", fg: "#fff" },
      "?":  { bg: "#8E8E93", fg: "rgba(255,255,255,0.5)" },
    },
  },
  // 気象庁「ホームページにおける気象情報の配色に関する設定指針」(表２－２ 震度)に
  // 定められた公式のRGB値をそのまま使用。
  // 震度7:(180,0,104) 6強:(165,0,33) 6弱:(255,40,0) 5強:(255,153,0) 5弱:(255,230,0)
  // 4:(250,230,150) 3:(0,65,255) 2:(0,170,255) 1:(242,242,255)
  jma: {
    id: "jma",
    label: "気象庁配色",
    colors: {
      "0":  { bg: "#E5E5EA", fg: "#0B0B0C" }, // 震度0は指針に規定が無いため、背景に馴染む薄いグレーにしている
      "1":  { bg: "#F2F2FF", fg: "#0B0B0C" },
      "2":  { bg: "#00AAFF", fg: "#0B0B0C" },
      "3":  { bg: "#0041FF", fg: "#fff" },
      "4":  { bg: "#FAE696", fg: "#0B0B0C" },
      "5":  { bg: "#FFE600", fg: "#0B0B0C" }, // 1996年10月改定前の「弱/強」区分が無い震度5
      "5-": { bg: "#FFE600", fg: "#0B0B0C" },
      "5+": { bg: "#FF9900", fg: "#0B0B0C" },
      "6":  { bg: "#FF2800", fg: "#fff" }, // 同上、震度6
      "6-": { bg: "#FF2800", fg: "#fff" },
      "6+": { bg: "#A50021", fg: "#fff" },
      "7":  { bg: "#B40068", fg: "#fff" },
      "?":  { bg: "#C7C7CC", fg: "rgba(11,11,12,0.5)" },
    },
  },
  // このアプリで震度分布の塗りつぶし・バッジに元々使っていた配色。
  fill: {
    id: "fill",
    label: "",
    colors: {
      "0":  { bg: "#3A3A3C", fg: "#fff" },
      "1":  { bg: "#2F6690", fg: "#fff" },
      "2":  { bg: "#3FA9E0", fg: "#0B0B0C" },
      "3":  { bg: "#4FBF67", fg: "#0B0B0C" },
      "4":  { bg: "#FFD60A", fg: "#0B0B0C" },
      "5":  { bg: "#FF9F0A", fg: "#0B0B0C" }, // 1996年10月改定前の「弱/強」区分が無い震度5
      "5-": { bg: "#FF9F0A", fg: "#0B0B0C" },
      "5+": { bg: "#FF7A1A", fg: "#0B0B0C" },
      "6":  { bg: "#E0342C", fg: "#fff" }, // 同上、震度6
      "6-": { bg: "#E0342C", fg: "#fff" },
      "6+": { bg: "#8A1518", fg: "#fff" },
      "7":  { bg: "#AF52DE", fg: "#fff" }, // 紫
      "?":  { bg: "#3A3A3C", fg: "rgba(255,255,255,0.5)" },
    },
  },
};


// 現在選択中の震度配色スキームID("legacy" | "jma" | "fill")を
// アプリ全体に配るコンテキスト。地図・バッジ・凡例など離れた場所からでも
// props バケツリレーせずに参照できるようにする。
export const QuakeColorSchemeContext = createContext("legacy");


// 震度配色スキームの選択はブラウザのlocalStorageに保存し、次回起動時も覚えておく。
// (プライベートブラウジング等でlocalStorageが使えない環境でも落ちないようtry/catchで囲む)
const QUAKE_COLOR_SCHEME_STORAGE_KEY = "quakeColorScheme";


export function loadStoredQuakeColorScheme() {
  try {
    const saved = localStorage.getItem(QUAKE_COLOR_SCHEME_STORAGE_KEY);
    if (saved && QUAKE_COLOR_SCHEMES[saved]) return saved;
  } catch (err) {
    console.warn("震度配色の設定を読み込めませんでした:", err);
  }
  return "legacy";
}


export function saveQuakeColorScheme(schemeId) {
  try {
    localStorage.setItem(QUAKE_COLOR_SCHEME_STORAGE_KEY, schemeId);
  } catch (err) {
    console.warn("震度配色の設定を保存できませんでした:", err);
  }
}


/* ─────────────────────────────────────────────────────
   ライト/ダークモード
   
   アプリ全体はもともとダーク基調(#121214背景+白文字)で作られているため、
   ライトモードは「別の配色を丸ごと用意し、UIのベースとなる色をcontext経由で
   出し分ける」形で追加する。地図の基本配色(海・陸のタイル色)や、震度色
   バッジのような意味を持つ色(震度配色スキームなど)まではこの対応範囲に
   含めない(それらは別途テーマ対応が必要)。まずは背景・カード・文字色
   など、UIチューム全体に効いてくる基礎トークンをテーマ切り替え対象にする。
   ───────────────────────────────────────────────────── */
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
    mapBg: "#121214",         // 海
    mapWorldFill: "#2c2c2e",  // 陸地(海外)
    mapWorldLine: "rgba(255,255,255,0.08)",
    mapPrefFill: "#3a3a3c",   // 都道府県(日本)
    mapPrefLine: "rgba(255,255,255,0.18)",
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
    mapBg: "#aecbe8",         // 海
    mapWorldFill: "#e4e2dc",  // 陸地(海外)
    mapWorldLine: "rgba(21,22,26,0.12)",
    mapPrefFill: "#f2f0ea",   // 都道府県(日本)
    mapPrefLine: "rgba(21,22,26,0.22)",
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



/* ─────────────────────────────────────────────────────
   推計震度分布(気象庁 estimated_intensity_map)の表示ON/OFF設定。
   震度配色と同様、ブラウザのlocalStorageに保存し次回起動時も覚えておく。
   デフォルトはON(防災アプリとして、初回起動時から見えている方が安全側)。
   ───────────────────────────────────────────────────── */
const EST_INTENSITY_ENABLED_STORAGE_KEY = "showEstimatedIntensity";


export function loadStoredEstIntensityEnabled() {
  try {
    const saved = localStorage.getItem(EST_INTENSITY_ENABLED_STORAGE_KEY);
    if (saved === "true") return true;
    if (saved === "false") return false;
  } catch (err) {
    console.warn("推計震度分布の表示設定を読み込めませんでした:", err);
  }
  return true;
}


export function saveEstIntensityEnabled(enabled) {
  try {
    localStorage.setItem(EST_INTENSITY_ENABLED_STORAGE_KEY, String(enabled));
  } catch (err) {
    console.warn("推計震度分布の表示設定を保存できませんでした:", err);
  }
}


/* ─────────────────────────────────────────────────────
   細分区域(気象庁の細分区域単位)を震度の色で塗りつぶすかどうかの設定。
   推計震度分布と同様、localStorageに保存し次回起動時も覚えておく。
   デフォルトはON(従来どおりの見た目を維持する)。
   ───────────────────────────────────────────────────── */
const AREA_FILL_ENABLED_STORAGE_KEY = "showAreaIntensityFill";


export function loadStoredAreaFillEnabled() {
  try {
    const saved = localStorage.getItem(AREA_FILL_ENABLED_STORAGE_KEY);
    if (saved === "true") return true;
    if (saved === "false") return false;
  } catch (err) {
    console.warn("細分区域塗りつぶしの表示設定を読み込めませんでした:", err);
  }
  return true;
}


export function saveAreaFillEnabled(enabled) {
  try {
    localStorage.setItem(AREA_FILL_ENABLED_STORAGE_KEY, String(enabled));
  } catch (err) {
    console.warn("細分区域塗りつぶしの表示設定を保存できませんでした:", err);
  }
}


/* ─────────────────────────────────────────────────────
   実験的・テスト機能のON/OFF設定。デフォルトはOFF
   (明示的にONにした場合のみ、設定画面にテスト配信UI等が現れる)。
   ───────────────────────────────────────────────────── */
const EXPERIMENTAL_FEATURES_STORAGE_KEY = "experimentalFeaturesEnabled";


export function loadStoredExperimentalFeaturesEnabled() {
  try {
    return localStorage.getItem(EXPERIMENTAL_FEATURES_STORAGE_KEY) === "true";
  } catch (err) {
    console.warn("実験的機能の設定を読み込めませんでした:", err);
  }
  return false;
}


export function saveExperimentalFeaturesEnabled(enabled) {
  try {
    localStorage.setItem(EXPERIMENTAL_FEATURES_STORAGE_KEY, String(enabled));
  } catch (err) {
    console.warn("実験的機能の設定を保存できませんでした:", err);
  }
}


/* ─────────────────────────────────────────────────────
   断層(faults.geojson)の表示ON/OFF設定。
   推計震度分布などと同様、localStorageに保存し次回起動時も覚えておく。
   ファイルサイズが大きい(数MB)ため、デフォルトはOFF
   (明示的にONにした場合のみデータを読み込む)。
   ───────────────────────────────────────────────────── */
const FAULTS_ENABLED_STORAGE_KEY = "showFaults";


export function loadStoredFaultsEnabled() {
  try {
    const saved = localStorage.getItem(FAULTS_ENABLED_STORAGE_KEY);
    if (saved === "true") return true;
    if (saved === "false") return false;
  } catch (err) {
    console.warn("断層表示の設定を読み込めませんでした:", err);
  }
  return false;
}


export function saveFaultsEnabled(enabled) {
  try {
    localStorage.setItem(FAULTS_ENABLED_STORAGE_KEY, String(enabled));
  } catch (err) {
    console.warn("断層表示の設定を保存できませんでした:", err);
  }
}


/* ─────────────────────────────────────────────────────
   プレート境界(plate-boundaries.json)の表示ON/OFF設定。
   断層と同様、ファイルサイズが大きいためデフォルトはOFF。
   ───────────────────────────────────────────────────── */
const PLATE_BOUNDARIES_ENABLED_STORAGE_KEY = "showPlateBoundaries";


export function loadStoredPlateBoundariesEnabled() {
  try {
    const saved = localStorage.getItem(PLATE_BOUNDARIES_ENABLED_STORAGE_KEY);
    if (saved === "true") return true;
    if (saved === "false") return false;
  } catch (err) {
    console.warn("プレート境界表示の設定を読み込めませんでした:", err);
  }
  return false;
}


export function savePlateBoundariesEnabled(enabled) {
  try {
    localStorage.setItem(PLATE_BOUNDARIES_ENABLED_STORAGE_KEY, String(enabled));
  } catch (err) {
    console.warn("プレート境界表示の設定を保存できませんでした:", err);
  }
}


/* ─────────────────────────────────────────────────────
   震央分布(地図上の丸)の表示ON/OFF設定。
   一覧を開くたびに丸が大量に出ると地図が見づらいという声があるため、
   デフォルトはOFFにしておき、必要な人だけ設定でONにしてもらう。
   ───────────────────────────────────────────────────── */
const EPICENTER_CIRCLES_ENABLED_STORAGE_KEY = "showEpicenterCircles";


export function loadStoredEpicenterCirclesEnabled() {
  try {
    const saved = localStorage.getItem(EPICENTER_CIRCLES_ENABLED_STORAGE_KEY);
    if (saved === "true") return true;
    if (saved === "false") return false;
  } catch (err) {
    console.warn("震央分布表示の設定を読み込めませんでした:", err);
  }
  return false;
}


export function saveEpicenterCirclesEnabled(enabled) {
  try {
    localStorage.setItem(EPICENTER_CIRCLES_ENABLED_STORAGE_KEY, String(enabled));
  } catch (err) {
    console.warn("震央分布表示の設定を保存できませんでした:", err);
  }
}


/* ─────────────────────────────────────────────────────
   利用規約・プライバシーポリシー・注意事項への同意まわり。

   public/配下の3つのMarkdownファイルの「内容」から非暗号学的ハッシュ(cyrb53)を
   計算し、前回同意した時点のハッシュとlocalStorage上で比較することで、
   文書が更新されたかどうかを自動判定する。開発者が手動でバージョン番号を
   上げ忘れても、ファイルの中身さえ変われば自動的に再同意を求められる。

   改ざん耐性等は不要(あくまで「差分があるかどうか」の検知が目的)なため、
   Web Crypto(非同期)は使わず、高速な同期関数で済ませている。
   ───────────────────────────────────────────────────── */
export function simpleHash(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}


const TERMS_AGREEMENT_STORAGE_KEY = "termsAgreementV1";


// { tou, privacy, notices: <各文書の同意時点でのハッシュ>, agreedAt } | null
export function loadStoredTermsAgreement() {
  try {
    const saved = localStorage.getItem(TERMS_AGREEMENT_STORAGE_KEY);
    if (!saved) return null;
    const parsed = JSON.parse(saved);
    if (parsed && typeof parsed === "object" && parsed.tou && parsed.privacy && parsed.notices) {
      return parsed;
    }
  } catch (err) {
    console.warn("利用規約等への同意状態を読み込めませんでした:", err);
  }
  return null;
}


export function saveStoredTermsAgreement(agreement) {
  try {
    localStorage.setItem(TERMS_AGREEMENT_STORAGE_KEY, JSON.stringify(agreement));
  } catch (err) {
    console.warn("利用規約等への同意状態を保存できませんでした:", err);
  }
}


/* ─────────────────────────────────────────────────────
   断層・プレート境界の「枠内の色」設定。
   縁取り(halo)はライト/ダーク共通の固定色だが、枠内の色はBOUNDARY_LINE_COLORSの
   中からユーザーが選べるようにし、localStorageに保存する。デフォルトは"gray"。
   ───────────────────────────────────────────────────── */
const BOUNDARY_LINE_COLOR_STORAGE_KEY = "boundaryLineColorId";


export function loadStoredBoundaryLineColorId() {
  try {
    const saved = localStorage.getItem(BOUNDARY_LINE_COLOR_STORAGE_KEY);
    if (saved && BOUNDARY_LINE_COLORS[saved]) return saved;
  } catch (err) {
    console.warn("断層・プレート境界の色設定を読み込めませんでした:", err);
  }
  return "gray";
}


export function saveBoundaryLineColorId(id) {
  try {
    localStorage.setItem(BOUNDARY_LINE_COLOR_STORAGE_KEY, id);
  } catch (err) {
    console.warn("断層・プレート境界の色設定を保存できませんでした:", err);
  }
}


/* ─────────────────────────────────────────────────────
   地震一覧の取得件数の設定。
   P2P地震情報APIの /history から一度に取得する件数(=一覧に表示する最大件数)。
   1〜1000件の範囲でユーザーが指定でき、localStorageに保存する。デフォルトは100件。
   ───────────────────────────────────────────────────── */
const QUAKE_FETCH_LIMIT_STORAGE_KEY = "quakeFetchLimit";

export const QUAKE_FETCH_LIMIT_MIN = 1;

export const QUAKE_FETCH_LIMIT_MAX = 1000;

export const QUAKE_FETCH_LIMIT_DEFAULT = 100;


export function clampQuakeFetchLimit(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return QUAKE_FETCH_LIMIT_DEFAULT;
  return Math.min(QUAKE_FETCH_LIMIT_MAX, Math.max(QUAKE_FETCH_LIMIT_MIN, n));
}


export function loadStoredQuakeFetchLimit() {
  try {
    const saved = localStorage.getItem(QUAKE_FETCH_LIMIT_STORAGE_KEY);
    if (saved != null) return clampQuakeFetchLimit(saved);
  } catch (err) {
    console.warn("地震の取得件数の設定を読み込めませんでした:", err);
  }
  return QUAKE_FETCH_LIMIT_DEFAULT;
}


export function saveQuakeFetchLimit(limit) {
  try {
    localStorage.setItem(QUAKE_FETCH_LIMIT_STORAGE_KEY, String(clampQuakeFetchLimit(limit)));
  } catch (err) {
    console.warn("地震の取得件数の設定を保存できませんでした:", err);
  }
}


/* ─────────────────────────────────────────────────────
   震度観測点リスト(StationPointsList)の表示方法。
   "grouped" = 震度階級ごとに階層表示(既定)、"list" = 従来のフラット一覧。
   震度配色などと同様、localStorageに保存し次回起動時も覚えておく。
   ───────────────────────────────────────────────────── */
export const STATION_LIST_DISPLAY_MODES = {
  grouped: { label: "階層表示" },
  list:    { label: "一覧表示" },
};

const STATION_LIST_DISPLAY_MODE_STORAGE_KEY = "stationListDisplayMode";


export function loadStoredStationListDisplayMode() {
  try {
    const saved = localStorage.getItem(STATION_LIST_DISPLAY_MODE_STORAGE_KEY);
    if (saved && STATION_LIST_DISPLAY_MODES[saved]) return saved;
  } catch (err) {
    console.warn("震度観測点リストの表示設定を読み込めませんでした:", err);
  }
  return "list"; // 既定は一覧表示
}


export function saveStationListDisplayMode(mode) {
  try {
    localStorage.setItem(STATION_LIST_DISPLAY_MODE_STORAGE_KEY, mode);
  } catch (err) {
    console.warn("震度観測点リストの表示設定を保存できませんでした:", err);
  }
}


// 指定したスキームオブジェクトについて、震度キーに対応する{ bg, fg, label }を返す。
// .map()のコールバック内などフックを呼べない場所からはこちらを直接使う
// (スキーム自体はコンポーネント側で useContext(QuakeColorSchemeContext) して渡す)。
export function getIntensityStyleFromScheme(scheme, intensityKey) {
  // "5u"(震度5弱以上未入電)は独自の色を持たず、5弱(5-)の配色を流用する。
  // 「少なくとも5弱相当」という情報として扱うため。
  const colorKey = intensityKey === "5u" ? "5-" : intensityKey;
  const c = scheme.colors[colorKey] || scheme.colors["0"];
  const label = INTENSITY_LABEL[intensityKey] || INTENSITY_LABEL["0"];
  return { bg: c.bg, fg: c.fg, label };
}


// 指定した震度キー("1"〜"7","5-"などINTENSITY_LABELのキー)について、
// 現在選択中のスキームに沿った{ bg, fg, label }を返す。
export function useIntensityStyle(intensityKey) {
  const schemeId = useContext(QuakeColorSchemeContext);
  const scheme = QUAKE_COLOR_SCHEMES[schemeId] || QUAKE_COLOR_SCHEMES.fill;
  return getIntensityStyleFromScheme(scheme, intensityKey);
}


// 表示用ラベルを「数字」と「弱/強」に分割する(バッジ内で2段組みにするため)
export function splitIntensityLabel(label) {
  const m = /^([0-7])(弱|強)?$/.exec(label);
  if (!m) return { num: label, suffix: null };
  return { num: m[1], suffix: m[2] || null };
}
