import { MIN_INTENSITY as SHINDO_MIN_INTENSITY, MAX_INTENSITY as SHINDO_MAX_INTENSITY } from "../shindoColorScale";
import { BOUNDARY_LINE_COLORS } from "./stationIcons";



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
   リアルタイム震度(強震モニタ/S-net)の表示しきい値。震度しきい値バー
   (RealtimeIntensityThresholdBar)で設定した「これ未満の観測点は地図に
   出さない」値を、推計震度分布と同様にlocalStorageへ永続化する。
   デフォルトは配色スケールの下限(=しきい値なし、全観測点を表示)。
   ───────────────────────────────────────────────────── */
const REALTIME_INTENSITY_THRESHOLD_STORAGE_KEY = "realtimeIntensityThreshold";

export function loadStoredRealtimeIntensityThreshold() {
  try {
    const saved = localStorage.getItem(REALTIME_INTENSITY_THRESHOLD_STORAGE_KEY);
    if (saved != null) {
      const n = Number(saved);
      if (Number.isFinite(n)) return Math.min(Math.max(n, SHINDO_MIN_INTENSITY), SHINDO_MAX_INTENSITY);
    }
  } catch (err) {
    console.warn("震度しきい値の設定を読み込めませんでした:", err);
  }
  return SHINDO_MIN_INTENSITY;
}

export function saveRealtimeIntensityThreshold(threshold) {
  try {
    localStorage.setItem(REALTIME_INTENSITY_THRESHOLD_STORAGE_KEY, String(threshold));
  } catch (err) {
    console.warn("震度しきい値の設定を保存できませんでした:", err);
  }
}

/* ─────────────────────────────────────────────────────
   震度上昇中レイヤー。強震モニタ/S-netの観測点のうち、前回の更新時点より
   震度が上昇した観測点を黄色、それ以外を震度-3相当の青色で表示する設定の
   ON/OFF(観測点自体の色を上書きする方式。以前のリング表示から変更)。
   推計震度分布と同様、localStorageに保存し次回起動時も覚えておく。
   デフォルトはOFF。
   ───────────────────────────────────────────────────── */
const REALTIME_RISING_ENABLED_STORAGE_KEY = "showRealtimeRisingIntensity";

export function loadStoredRealtimeRisingEnabled() {
  try {
    const saved = localStorage.getItem(REALTIME_RISING_ENABLED_STORAGE_KEY);
    if (saved === "true") return true;
    if (saved === "false") return false;
  } catch (err) {
    console.warn("震度上昇中レイヤーの表示設定を読み込めませんでした:", err);
  }
  return false;
}

export function saveRealtimeRisingEnabled(enabled) {
  try {
    localStorage.setItem(REALTIME_RISING_ENABLED_STORAGE_KEY, String(enabled));
  } catch (err) {
    console.warn("震度上昇中レイヤーの表示設定を保存できませんでした:", err);
  }
}

/* ─────────────────────────────────────────────────────
   リプレイ再生中のみ選択できる、観測点の色を気象庁震度階級に換算して
   表示する設定のON/OFF。デフォルトOFF(=強震モニタ本来の連続配色)。
   リプレイ再生中でなければこの設定自体が意味を持たない(App側で
   replayPlayer.loadedとのANDを取ってMapCanvasへ渡す)が、設定値自体は
   トグルの状態としてlocalStorageに保存し、次回リプレイ再生時にも
   覚えておく。
   ───────────────────────────────────────────────────── */
const REPLAY_JMA_COLOR_ENABLED_STORAGE_KEY = "replayJmaColorEnabled";

export function loadStoredReplayJmaColorEnabled() {
  try {
    const saved = localStorage.getItem(REPLAY_JMA_COLOR_ENABLED_STORAGE_KEY);
    if (saved === "true") return true;
    if (saved === "false") return false;
  } catch (err) {
    console.warn("リプレイの震度階級表示設定を読み込めませんでした:", err);
  }
  return false;
}

export function saveReplayJmaColorEnabled(enabled) {
  try {
    localStorage.setItem(REPLAY_JMA_COLOR_ENABLED_STORAGE_KEY, String(enabled));
  } catch (err) {
    console.warn("リプレイの震度階級表示設定を保存できませんでした:", err);
  }
}

/* ─────────────────────────────────────────────────────
   揺れ検知エンジン(shakeDetection.ts)自体のON/OFF。推計震度分布・
   震度上昇中と同様にlocalStorageに永続化する。デフォルトはON。
   ───────────────────────────────────────────────────── */
const SHAKE_DETECTION_ENABLED_STORAGE_KEY = "shakeDetectionEnabled";

export function loadStoredShakeDetectionEnabled() {
  try {
    const saved = localStorage.getItem(SHAKE_DETECTION_ENABLED_STORAGE_KEY);
    if (saved === "true") return true;
    if (saved === "false") return false;
  } catch (err) {
    console.warn("地震検知の設定を読み込めませんでした:", err);
  }
  return true;
}

export function saveShakeDetectionEnabled(enabled) {
  try {
    localStorage.setItem(SHAKE_DETECTION_ENABLED_STORAGE_KEY, String(enabled));
  } catch (err) {
    console.warn("地震検知の設定を保存できませんでした:", err);
  }
}

/* ─────────────────────────────────────────────────────
   震源推定(epicenterEstimation.ts)自体のON/OFF。実験的機能のため、
   揺れ検知(shakeDetectionEnabled)とは別にlocalStorageに永続化する。
   デフォルトはOFF(検証が浅い機能のため、明示的にONにした人だけ使う)。
   ───────────────────────────────────────────────────── */
const EPICENTER_ESTIMATION_ENABLED_STORAGE_KEY = "epicenterEstimationEnabled";

export function loadStoredEpicenterEstimationEnabled() {
  try {
    const saved = localStorage.getItem(EPICENTER_ESTIMATION_ENABLED_STORAGE_KEY);
    if (saved === "true") return true;
    if (saved === "false") return false;
  } catch (err) {
    console.warn("震源推定の設定を読み込めませんでした:", err);
  }
  return false;
}

export function saveEpicenterEstimationEnabled(enabled) {
  try {
    localStorage.setItem(EPICENTER_ESTIMATION_ENABLED_STORAGE_KEY, String(enabled));
  } catch (err) {
    console.warn("震源推定の設定を保存できませんでした:", err);
  }
}

/* ─────────────────────────────────────────────────────
   微弱な揺れの検知(配列型。shakeDetection.tsのステップ3c)を使うか。
   リアルタイムタブの設定。デフォルトはON。実機で誤検知が出た場合に、切れるようにしてある。
   ───────────────────────────────────────────────────── */
const WEAK_ARRAY_DETECTION_STORAGE_KEY = "weakArrayDetectionEnabled";

export function loadStoredWeakArrayDetectionEnabled() {
  try {
    return localStorage.getItem(WEAK_ARRAY_DETECTION_STORAGE_KEY) !== "false";
  } catch (err) {
    console.warn("微弱検知の設定を読み込めませんでした:", err);
  }
  return true;
}

export function saveWeakArrayDetectionEnabled(enabled) {
  try {
    localStorage.setItem(WEAK_ARRAY_DETECTION_STORAGE_KEY, String(enabled));
  } catch (err) {
    console.warn("微弱検知の設定を保存できませんでした:", err);
  }
}

/* ─────────────────────────────────────────────────────
   信頼度が下限未満の震源推定も表示するか。リアルタイムタブの設定。
   デフォルトはOFF(信頼度が低い推定は表示しない)。
   ───────────────────────────────────────────────────── */
const SHOW_LOW_CONFIDENCE_ESTIMATES_STORAGE_KEY = "showLowConfidenceEstimates";

export function loadStoredShowLowConfidenceEstimates() {
  try {
    return localStorage.getItem(SHOW_LOW_CONFIDENCE_ESTIMATES_STORAGE_KEY) === "true";
  } catch (err) {
    console.warn("信頼度の低い推定の表示設定を読み込めませんでした:", err);
  }
  return false;
}

export function saveShowLowConfidenceEstimates(enabled) {
  try {
    localStorage.setItem(SHOW_LOW_CONFIDENCE_ESTIMATES_STORAGE_KEY, String(enabled));
  } catch (err) {
    console.warn("信頼度の低い推定の表示設定を保存できませんでした:", err);
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

/* ─────────────────────────────────────────────────────
   カメラの動き(詳細設定 > カメラの動き)。localStorageにJSONで永続化する。初期設定はすべてオン。
     eewFocus    : 緊急地震速報の第一報で、震源が画面に収まるよう地図を動かす
     shakeFollow : 揺れ検知で、検知した観測点が画面に収まるよう地図を動かし、はみ出しそうなら調整する
     autoResume  : 地図を自分で動かしても、2秒間操作がなければ、揺れ検知の自動調整を再開する
   ───────────────────────────────────────────────────── */
const CAMERA_SETTINGS_STORAGE_KEY = "cameraSettings";
export const DEFAULT_CAMERA_SETTINGS = Object.freeze({ eewFocus: true, shakeFollow: true, autoResume: true });

export function loadStoredCameraSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(CAMERA_SETTINGS_STORAGE_KEY) || "null");
    if (saved && typeof saved === "object") {
      const out = { ...DEFAULT_CAMERA_SETTINGS };
      for (const key of Object.keys(DEFAULT_CAMERA_SETTINGS)) if (typeof saved[key] === "boolean") out[key] = saved[key];
      return out;
    }
  } catch (err) {
    console.warn("カメラの動きの設定を読み込めませんでした:", err);
  }
  return { ...DEFAULT_CAMERA_SETTINGS };
}

export function saveCameraSettings(settings) {
  try {
    localStorage.setItem(CAMERA_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch (err) {
    console.warn("カメラの動きの設定を保存できませんでした:", err);
  }
}

/* ─────────────────────────────────────────────────────
   グリッド(セル)方式の揺れ検知(gridDetection.ts)のON/OFFと、セル枠の表示のON/OFF。
   既存の揺れ検知(shakeDetectionEnabled)とは独立に、併用して比較できる。
   検知はデフォルトOFF、セル枠の表示はデフォルトON(検知をONにした人が、すぐ見られるように)。
   ───────────────────────────────────────────────────── */
const GRID_DETECTION_ENABLED_STORAGE_KEY = "gridDetectionEnabled";
const GRID_CELLS_VISIBLE_STORAGE_KEY = "gridCellsVisible";

function loadStoredBool(key, fallback, label) {
  try {
    const saved = localStorage.getItem(key);
    if (saved === "true") return true;
    if (saved === "false") return false;
  } catch (err) {
    console.warn(`${label}の設定を読み込めませんでした:`, err);
  }
  return fallback;
}

function saveStoredBool(key, value, label) {
  try {
    localStorage.setItem(key, String(value));
  } catch (err) {
    console.warn(`${label}の設定を保存できませんでした:`, err);
  }
}

export function loadStoredGridDetectionEnabled() {
  return loadStoredBool(GRID_DETECTION_ENABLED_STORAGE_KEY, false, "グリッド検知");
}

export function saveGridDetectionEnabled(enabled) {
  saveStoredBool(GRID_DETECTION_ENABLED_STORAGE_KEY, enabled, "グリッド検知");
}

export function loadStoredGridCellsVisible() {
  return loadStoredBool(GRID_CELLS_VISIBLE_STORAGE_KEY, true, "グリッド枠の表示");
}

export function saveGridCellsVisible(visible) {
  saveStoredBool(GRID_CELLS_VISIBLE_STORAGE_KEY, visible, "グリッド枠の表示");
}
