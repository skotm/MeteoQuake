import { createContext, useContext } from "react";
import { INTENSITY_LABEL } from "./stationIcons";


// リアルタイムタブ(強震モニタ/S-net)配信サーバーのベースURL。
// 実際にデプロイしたCloudflare Workersのドメインに置き換えること。
/* ─────────────────────────────────────────────────────
   リアルタイムタブ(強震モニタ/S-net)配信APIのアクセストークン。
   Collector側は簡易フィルタとしてトークン検証を行っている(本格的な
   認証ではない)。ユーザーが設定タブ「詳細設定」から入力し、
   localStorageに保存する。デフォルトは空文字(未設定)。
   ───────────────────────────────────────────────────── */
// 【廃止】APIトークンが未設定でも利用できるようになったため、トークン入力
// 機能を廃止した。将来また導入する可能性があるため削除はせずコメントアウト
// している(復元する場合はこのブロックと、下記の関連箇所を全てコメント解除
// すること)。
// const REALTIME_API_TOKEN_STORAGE_KEY = "realtimeApiToken";
//
// function loadStoredRealtimeApiToken() {
//   try {
//     return localStorage.getItem(REALTIME_API_TOKEN_STORAGE_KEY) ?? "";
//   } catch (err) {
//     console.warn("リアルタイムAPIトークンの設定を読み込めませんでした:", err);
//     return "";
//   }
// }
//
// function saveRealtimeApiToken(token) {
//   try {
//     localStorage.setItem(REALTIME_API_TOKEN_STORAGE_KEY, token);
//   } catch (err) {
//     console.warn("リアルタイムAPIトークンの設定を保存できませんでした:", err);
//   }
// }

export const REALTIME_API_BASE_URL = "https://meteoquake-realtime-collector.skotm.workers.dev";

// MapCanvasのrealtimeValuesデフォルト引数用。`= new Map()`を直接デフォルト値に
// 書くと毎レンダーで新しい参照が作られ、依存配列比較で無駄な再計算を招くため、
// モジュールスコープで1つだけ用意して使い回す。
export const EMPTY_REALTIME_VALUES = new Map();

// 計測震度(連続値)を、このアプリの震度階級キー("0"〜"7", 5-/5+/6-/6+)に変換する。
// 気象庁の計測震度→震度階級の標準的な換算表に基づく。
export function intensityValueToKey(value) {
  if (value == null || Number.isNaN(value)) return "?";
  if (value < 0.5) return "0";
  if (value < 1.5) return "1";
  if (value < 2.5) return "2";
  if (value < 3.5) return "3";
  if (value < 4.5) return "4";
  if (value < 5.0) return "5-";
  if (value < 5.5) return "5+";
  if (value < 6.0) return "6-";
  if (value < 6.5) return "6+";
  return "7";
}

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
// 【リプレイ再生時の震度階級表示】観測点の色を、強震モニタ本来の連続配色
// (shindoColorScale.ts)ではなく気象庁の震度階級に換算して表示する
// (replayJmaColorEnabled)場合の、震度0(計測震度0.5未満)の配色。
// 震度1以上は、地震情報の観測点マーカーと同じ仕組み(station-icon-*、
// registerStationIconsで選択中の配色スキームに追従して生成済みのアイコン
// 画像)で表示する(realtime-points-icon-layer参照)ため、この関数が使われる
// のは震度0の範囲のみになる。気象庁の指針では震度0は単一の薄いグレー
// (QUAKE_COLOR_SCHEMES.*.colors["0"])で一括りにされてしまい、平常時との差が
// 見えなくなるため、代わりに計測震度-1.0〜0.4の範囲だけは「透明→薄グレー→
// グレー」の3点グラデーションにして、震度0の中でも実際の揺れの強さの
// 違いがうっすら見えるようにする(0.4〜0.5未満はグレーのまま)。
const REPLAY_JMA_SUBTHRESHOLD_MIN = -1.0;
const REPLAY_JMA_SUBTHRESHOLD_MID = -0.3; // 透明→薄グレーと薄グレー→グレーの折り返し点
const REPLAY_JMA_SUBTHRESHOLD_MAX = 0.4;
const REPLAY_JMA_SUBTHRESHOLD_RGB = "142,142,147"; // iOSのsystemGray相当
const REPLAY_JMA_SUBTHRESHOLD_MID_ALPHA = 0.35; // 「薄グレー」時点の不透明度
const REPLAY_JMA_SUBTHRESHOLD_MAX_ALPHA = 0.75; // 「グレー」時点の不透明度

export function replayJmaSubthresholdColor(value) {
  const v = Math.min(Math.max(value ?? REPLAY_JMA_SUBTHRESHOLD_MIN, REPLAY_JMA_SUBTHRESHOLD_MIN), REPLAY_JMA_SUBTHRESHOLD_MAX);
  let alpha;
  if (v <= REPLAY_JMA_SUBTHRESHOLD_MID) {
    const t = (v - REPLAY_JMA_SUBTHRESHOLD_MIN) / (REPLAY_JMA_SUBTHRESHOLD_MID - REPLAY_JMA_SUBTHRESHOLD_MIN);
    alpha = t * REPLAY_JMA_SUBTHRESHOLD_MID_ALPHA;
  } else {
    const t = (v - REPLAY_JMA_SUBTHRESHOLD_MID) / (REPLAY_JMA_SUBTHRESHOLD_MAX - REPLAY_JMA_SUBTHRESHOLD_MID);
    alpha = REPLAY_JMA_SUBTHRESHOLD_MID_ALPHA + t * (REPLAY_JMA_SUBTHRESHOLD_MAX_ALPHA - REPLAY_JMA_SUBTHRESHOLD_MID_ALPHA);
  }
  return `rgba(${REPLAY_JMA_SUBTHRESHOLD_RGB},${alpha.toFixed(2)})`;
}

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
