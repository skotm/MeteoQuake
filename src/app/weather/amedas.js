// アメダス(地域気象観測システム)の観測値表示。
//
// 使うデータ(気象庁 bosai、時刻はすべてJST):
//   const/amedastable.json                  観測点一覧(緯度経度は[度, 分])
//   data/latest_time.txt                    最新の観測時刻(ISO8601, +09:00)
//   data/map/{YYYYMMDDHHmm00}.json          全観測点の10分値 { 観測点コード: { 要素: [値, 品質] } }
//   data/point/{code}/{YYYYMMDD}_{HH}.json  1観測点の時系列(3時間ブロック。キーは YYYYMMDDHHmm00)
// ⚠️ 形式は公開されている情報に基づく想定で、実データでの確認は未了。
//    想定と違う場合に壊れないよう、すべて「値が取れなければ欠測扱い」にしてある。
import { fetchBodyOrNull } from "./tileFetch.js";

export const AMEDAS_BASE = "https://www.jma.go.jp/bosai/amedas";
export const AMEDAS_STEP_MIN = 10;
export const AMEDAS_RANGE_MIN = 180; // さかのぼれる範囲(3時間)
export const AMEDAS_STEPS = AMEDAS_RANGE_MIN / AMEDAS_STEP_MIN; // 18
const STEP_MS = AMEDAS_STEP_MIN * 60 * 1000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/* ───────────── 時刻ユーティリティ ───────────── */
const p2 = (n) => String(n).padStart(2, "0");

// ms(UTC epoch) → JSTの各成分
function jstParts(ms) {
  const d = new Date(ms + JST_OFFSET_MS);
  return {
    y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(),
    h: d.getUTCHours(), mi: d.getUTCMinutes(),
  };
}

// "YYYYMMDDHHmm00"(JST)
export function amedasTimeKey(ms) {
  const t = jstParts(ms);
  return `${t.y}${p2(t.mo)}${p2(t.d)}${p2(t.h)}${p2(t.mi)}00`;
}

export function amedasTimeLabel(ms) {
  const t = jstParts(ms);
  return `${p2(t.h)}:${p2(t.mi)}`;
}

export function amedasDateTimeLabel(ms) {
  const t = jstParts(ms);
  return `${t.mo}/${t.d} ${p2(t.h)}:${p2(t.mi)}`;
}

// "YYYYMMDDHHmmss"(JST) → ms
export function amedasKeyToMs(key) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(String(key));
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - JST_OFFSET_MS;
}

// latest_time.txt の中身 → 10分に切り下げたms。解釈できなければ null。
export function parseAmedasLatestTime(text) {
  const ms = Date.parse(String(text ?? "").trim());
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / STEP_MS) * STEP_MS;
}

// 最新から古い順に並べたコマ(古い→新しい)。index 最後 = 最新。
export function buildAmedasFrames(latestMs) {
  if (latestMs == null) return [];
  const frames = [];
  for (let i = AMEDAS_STEPS; i >= 0; i--) {
    const timeMs = latestMs - i * STEP_MS;
    frames.push({ timeMs, validtime: amedasTimeKey(timeMs) });
  }
  return frames;
}


/* ───────────── 要素の定義 ───────────── */
// stops: [値, 色] の昇順。範囲外は端の色。
export const AMEDAS_ELEMENTS = {
  temp: {
    id: "temp", key: "temp", label: "気温", unit: "℃", decimals: 1,
    stops: [[-15, "#1a237e"], [-5, "#1976d2"], [0, "#4fc3f7"], [10, "#a5d6a7"], [20, "#fff59d"], [25, "#ffb74d"], [30, "#ff7043"], [35, "#d32f2f"], [40, "#6a1b9a"]],
    legend: [-10, 0, 10, 20, 30, 35],
    priority: (v) => -Math.abs(v - 15), // 極端な値を優先して表示
  },
  precip: {
    id: "precip", key: "precipitation1h", label: "降水量(1時間)", unit: "mm", decimals: 1,
    stops: [[0, "#eef2f6"], [1, "#a0d2ff"], [5, "#2196f3"], [10, "#ffeb3b"], [20, "#ff9800"], [30, "#f44336"], [50, "#9c27b0"], [80, "#6a0080"]],
    legend: [0, 1, 5, 10, 20, 30, 50],
    priority: (v) => v,
  },
  wind: {
    id: "wind", key: "wind", label: "風速", unit: "m/s", decimals: 1,
    stops: [[0, "#eef2f6"], [3, "#b3e5fc"], [6, "#4fc3f7"], [10, "#ffeb3b"], [15, "#ff9800"], [20, "#f44336"], [30, "#6a0080"]],
    legend: [0, 3, 6, 10, 15, 20],
    priority: (v) => v,
    hasDirection: true,
  },
  humidity: {
    id: "humidity", key: "humidity", label: "湿度", unit: "%", decimals: 0,
    stops: [[0, "#ffb74d"], [30, "#fff176"], [50, "#c5e1a5"], [70, "#81d4fa"], [100, "#1976d2"]],
    legend: [20, 40, 60, 80, 100],
    priority: (v) => -Math.abs(v - 60),
  },
  snow: {
    id: "snow", key: "snow", label: "積雪", unit: "cm", decimals: 0,
    stops: [[0, "#eef2f6"], [1, "#b3e5fc"], [10, "#4fc3f7"], [30, "#1976d2"], [100, "#6a1b9a"], [200, "#311b92"]],
    legend: [0, 10, 30, 100, 200],
    priority: (v) => v,
  },
  sun: {
    id: "sun", key: "sun1h", label: "日照(1時間)", unit: "h", decimals: 1,
    stops: [[0, "#cfd8dc"], [0.5, "#fff59d"], [1, "#ffb300"]],
    legend: [0, 0.5, 1],
    priority: (v) => v,
  },
};

export const AMEDAS_ELEMENT_IDS = Object.keys(AMEDAS_ELEMENTS);

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex([r, g, b]) {
  return `#${[r, g, b].map(v => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

export function amedasColor(stops, v) {
  if (v <= stops[0][0]) return stops[0][1];
  const last = stops[stops.length - 1];
  if (v >= last[0]) return last[1];
  for (let i = 1; i < stops.length; i++) {
    if (v <= stops[i][0]) {
      const [v0, c0] = stops[i - 1];
      const [v1, c1] = stops[i];
      const t = (v - v0) / (v1 - v0);
      const a = hexToRgb(c0), b = hexToRgb(c1);
      return rgbToHex(a.map((x, k) => x + (b[k] - x) * t));
    }
  }
  return last[1];
}

// 色を8段階ほどに丸めて、地図上のアイコン画像の種類が増えすぎないようにする
function quantizeHex(hex) {
  const q = (x) => Math.round(x / 16) * 16;
  return rgbToHex(hexToRgb(hex).map(q).map(x => Math.min(255, x)));
}

export function amedasTextColor(hex) {
  const [r, g, b] = hexToRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? "#111111" : "#ffffff";
}


/* ───────────── 値の取り出し ───────────── */
// 品質情報: 0(正常)・1 を表示対象、それ以外は欠測扱い(想定。実データで要確認)。
const QUALITY_OK_MAX = 1;

// [値, 品質] → 数値 | null。形式が違えば null。
export function amedasPick(entry, key) {
  const pair = entry?.[key];
  if (pair == null) return null;
  const v = Array.isArray(pair) ? pair[0] : pair;
  const q = Array.isArray(pair) ? pair[1] : 0;
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  if (q != null && q > QUALITY_OK_MAX) return null;
  return v;
}

// その観測点がこの要素を「観測している」か(キー自体があるか)。無ければ地図に出さない。
export function amedasObserves(entry, key) {
  return !!entry && Object.prototype.hasOwnProperty.call(entry, key);
}

export function formatAmedasValue(v, decimals = 1) {
  if (v == null) return "--";
  const s = v.toFixed(decimals);
  return s === "-0.0" ? "0.0" : s === "-0" ? "0" : s;
}

// 風向: 1=北北東 … 16=北(22.5度刻み、風が吹いてくる方位)、0=静穏
export const WIND_DIR_NAMES = ["静穏", "北北東", "北東", "東北東", "東", "東南東", "南東", "南南東", "南", "南南西", "南西", "西南西", "西", "西北西", "北西", "北北西", "北"];
export function windDirName(idx) {
  return Number.isInteger(idx) && idx >= 0 && idx <= 16 ? WIND_DIR_NAMES[idx] : null;
}
// 風が「吹いていく向き」の矢印の回転角(度、北向き=0・時計回り)。静穏/不明は null。
export function windArrowRotation(idx) {
  if (!Number.isInteger(idx) || idx < 1 || idx > 16) return null;
  return (idx * 22.5 + 180) % 360;
}


/* ───────────── 観測点一覧 ───────────── */
const degMin = (pair) => (Array.isArray(pair) && pair.length >= 2 ? Number(pair[0]) + Number(pair[1]) / 60 : null);

let tablePromise = null;
export function loadAmedasTable() {
  if (!tablePromise) {
    tablePromise = fetchBodyOrNull(`${AMEDAS_BASE}/const/amedastable.json`)
      .then(raw => {
        if (!raw) throw new Error("amedastable.json が見つかりません");
        const table = {};
        for (const [code, e] of Object.entries(raw)) {
          const lat = degMin(e.lat), lon = degMin(e.lon);
          if (lat == null || lon == null) continue;
          table[code] = { code, name: e.kjName || code, kana: e.knName || "", lat, lon, alt: e.alt ?? null };
        }
        return table;
      })
      .catch(err => { tablePromise = null; throw err; });
  }
  return tablePromise;
}


/* ───────────── GeoJSON化 ───────────── */
// table: loadAmedasTable()の結果 / frame: map/{時刻}.json / elementId: AMEDAS_ELEMENTSのキー
export function buildAmedasGeoJson(table, frame, elementId) {
  const el = AMEDAS_ELEMENTS[elementId];
  const features = [];
  if (!el || !table || !frame) return { type: "FeatureCollection", features };
  for (const [code, entry] of Object.entries(frame)) {
    const st = table[code];
    if (!st || !amedasObserves(entry, el.key)) continue;
    const v = amedasPick(entry, el.key);
    let label = "", color = "#9aa0a6", textColor = "#ffffff", sortKey = 1e6, rot = null;
    if (v != null) {
      const raw = amedasColor(el.stops, v);
      color = quantizeHex(raw);
      textColor = amedasTextColor(color);
      label = formatAmedasValue(v, el.decimals);
      sortKey = -el.priority(v);
      if (el.hasDirection) {
        const dir = amedasPick(entry, "windDirection");
        rot = windArrowRotation(dir);
      }
    }
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [st.lon, st.lat] },
      properties: { code, name: st.name, v, label, color, textColor, sortKey, rot: rot ?? -1 },
    });
  }
  return { type: "FeatureCollection", features };
}


/* ───────────── コマ(10分値)の取得 ───────────── */
const FRAME_CACHE_MAX = 6;
const frameCache = new Map(); // key -> Promise<object|null>

// 時刻ms の全観測点データ。無ければ null(404)。通信失敗は例外。
// 取得済みは直近6件まで保持する。新しい時刻(最新)は更新されうるので保持しない。
export function loadAmedasFrame(timeMs, { cacheable = true } = {}) {
  const key = amedasTimeKey(timeMs);
  if (cacheable && frameCache.has(key)) {
    const p = frameCache.get(key);
    frameCache.delete(key); frameCache.set(key, p); // LRU更新
    return p;
  }
  const p = fetchBodyOrNull(`${AMEDAS_BASE}/data/map/${key}.json`);
  if (cacheable) {
    frameCache.set(key, p);
    p.then(v => { if (v == null && frameCache.get(key) === p) frameCache.delete(key); },
           () => { if (frameCache.get(key) === p) frameCache.delete(key); });
    while (frameCache.size > FRAME_CACHE_MAX) frameCache.delete(frameCache.keys().next().value);
  }
  return p;
}

export function clearAmedasFrameCache() { frameCache.clear(); }

export async function loadAmedasLatestMs() {
  const text = await fetchBodyOrNull(`${AMEDAS_BASE}/data/latest_time.txt`, { text: true });
  return parseAmedasLatestTime(text);
}


/* ───────────── 1観測点の時系列(直近3時間) ───────────── */
// 3時間ブロックの開始(JSTの0,3,6,…21時)
function blockStartMs(ms) {
  const t = jstParts(ms);
  const hh = Math.floor(t.h / 3) * 3;
  return Date.UTC(t.y, t.mo - 1, t.d, hh, 0, 0) - JST_OFFSET_MS;
}
function pointUrl(code, blockMs) {
  const t = jstParts(blockMs);
  return `${AMEDAS_BASE}/data/point/${code}/${t.y}${p2(t.mo)}${p2(t.d)}_${p2(t.h)}.json`;
}

// 戻り値: [{ timeMs, temp, precip10m, wind, windDir }] 古い順(欠測は null)。取得不可は []。
export async function loadAmedasSeries(code, latestMs) {
  const from = latestMs - AMEDAS_RANGE_MIN * 60 * 1000;
  const blocks = [];
  for (let b = blockStartMs(from); b <= latestMs; b += 3 * 60 * 60 * 1000) blocks.push(b);
  const results = await Promise.allSettled(blocks.map(b => fetchBodyOrNull(pointUrl(code, b))));
  const rows = new Map();
  for (const r of results) {
    if (r.status !== "fulfilled" || !r.value || typeof r.value !== "object") continue;
    for (const [k, entry] of Object.entries(r.value)) {
      const timeMs = amedasKeyToMs(k);
      if (timeMs == null || timeMs < from || timeMs > latestMs) continue;
      rows.set(timeMs, {
        timeMs,
        temp: amedasPick(entry, "temp"),
        precip10m: amedasPick(entry, "precipitation10m"),
        wind: amedasPick(entry, "wind"),
        windDir: amedasPick(entry, "windDirection"),
      });
    }
  }
  return [...rows.values()].sort((a, b) => a.timeMs - b.timeMs);
}


/* ───────────── 詳細カードの行 ───────────── */
export function buildAmedasDetailRows(entry) {
  if (!entry) return [];
  const rows = [];
  const add = (label, key, unit, decimals) => {
    if (!amedasObserves(entry, key)) return;
    rows.push({ label, text: v2t(amedasPick(entry, key), unit, decimals) });
  };
  const v2t = (v, unit, d) => (v == null ? "--" : `${formatAmedasValue(v, d)}${unit}`);
  add("気温", "temp", "℃", 1);
  add("降水量(10分)", "precipitation10m", "mm", 1);
  add("降水量(1時間)", "precipitation1h", "mm", 1);
  add("降水量(3時間)", "precipitation3h", "mm", 1);
  add("降水量(24時間)", "precipitation24h", "mm", 1);
  if (amedasObserves(entry, "wind")) {
    const w = amedasPick(entry, "wind");
    const dir = windDirName(amedasPick(entry, "windDirection"));
    rows.push({ label: "風", text: w == null ? "--" : `${dir ? dir + " " : ""}${formatAmedasValue(w, 1)}m/s` });
  }
  if (amedasObserves(entry, "gust")) {
    const g = amedasPick(entry, "gust");
    const dir = windDirName(amedasPick(entry, "gustDirection"));
    rows.push({ label: "最大瞬間風速", text: g == null ? "--" : `${dir ? dir + " " : ""}${formatAmedasValue(g, 1)}m/s` });
  }
  add("湿度", "humidity", "%", 0);
  add("気圧", "pressure", "hPa", 1);
  add("日照(1時間)", "sun1h", "h", 1);
  add("積雪", "snow", "cm", 0);
  add("最高気温", "maxTemp", "℃", 1);
  add("最低気温", "minTemp", "℃", 1);
  return rows;
}
