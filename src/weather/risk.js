import { parseNowcastValidTime } from "./nowcast.js";

/* ─────────────────────────────────────────────────────
   キキクル(危険度分布) — 土砂キキクル(land)・浸水キキクル(inund)。
   雨雲レーダー・降水量・天気分布予報と全く同じ考え方(独自プロトコルで
   奇数ズームを1段階粗い偶数ズームタイルの象限切り出しで代用)。JMAのPNGは
   既に危険度に応じて色分け済みなので、天気分布予報と同じく配色変換
   (remapImageDataColors)は行わない。
   ───────────────────────────────────────────────────── */
const RISK_DATA_BASE = "https://www.jma.go.jp/bosai/jmatile/data/risk";

export const RISK_MODE_CONFIG = {
  doshaKikkuru:    { element: "land",      middlePath: "none",   label: "土砂キキクル", targetTimesUrl: `${RISK_DATA_BASE}/targetTimes.json` },
  inundKikkuru:    { element: "inund",     middlePath: "none",   label: "浸水キキクル", targetTimesUrl: `${RISK_DATA_BASE}/targetTimes_N1.json` },
  // 2026年5月にJMAが浸水キキクル・洪水キキクルを「大雨キキクル」に統合。
  // URLパターンは土砂・浸水とほぼ同じだが、2番目のパス部分が"none"では
  // なく"immed0"、要素名が"rain_mesh"(実機のNetworkタブで確認済み)。
  // targetTimesのURLは未確認のため、まず専用と思われるURLを試し、
  // 失敗したら土砂と同じtargetTimes.jsonにフォールバックする。
  heavyrainKikkuru: { element: "rain_mesh", middlePath: "immed0", label: "大雨キキクル", targetTimesUrl: `${RISK_DATA_BASE}/targetTimes_immed0.json` },
};

function riskTileUrl(mode, basetime, validtime, z, x, y) {
  const config = RISK_MODE_CONFIG[mode] || RISK_MODE_CONFIG.doshaKikkuru;
  return `${RISK_DATA_BASE}/${basetime}/${config.middlePath}/${validtime}/surf/${config.element}/${z}/${x}/${y}.png`;
}

export function riskProtocolUrl(mode, basetime, validtime) {
  return `jmarisk://${mode}/${basetime}/${validtime}/{z}/{x}/{y}`;
}


// modeの時刻一覧を取得する。[{ basetime, validtime }, ...] を時系列昇順で返す。
// 浸水(inund)はtargetTimes_N1.jsonが本来のエンドポイントだが、無ければ
// targetTimes.json(土砂と同じ)にフォールバックする(旧ツールと同じ考え方)。
export async function loadRiskFrames(mode) {
  const config = RISK_MODE_CONFIG[mode] || RISK_MODE_CONFIG.doshaKikkuru;
  const label = config.label;
  let url = config.targetTimesUrl;
  let raw;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    raw = await res.json();
  } catch (err) {
    if (url !== RISK_MODE_CONFIG.doshaKikkuru.targetTimesUrl) {
      console.warn(`${label}: 時刻一覧の取得に失敗、targetTimes.jsonにフォールバックします url=${url}`, err);
      url = RISK_MODE_CONFIG.doshaKikkuru.targetTimesUrl;
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        raw = await res.json();
      } catch (err2) {
        console.warn(`${label}: フォールバック先の時刻一覧取得にも失敗 url=${url}`, err2);
        throw err2;
      }
    } else {
      console.warn(`${label}: 時刻一覧の取得に失敗 url=${url}`, err);
      throw err;
    }
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    console.warn(`${label}: 時刻一覧が空、または想定外の形式です url=${url}`, raw);
    return [];
  }
  return raw
    .filter(t => t && t.basetime && t.validtime)
    .sort((a, b) => String(a.validtime).localeCompare(String(b.validtime)))
    .map(t => ({ basetime: t.basetime, validtime: t.validtime }));
}


export function formatRiskFrameLabel(frame) {
  if (!frame) return "";
  const time = parseNowcastValidTime(frame.validtime);
  if (!time) return "";
  return `${time} 実況`;
}


// 404だったタイルURLの記録(キキクル用)。
const riskFailedTileUrls = new Set();


let riskProtocolRegistered = false;

export function registerRiskProtocol(maplibregl) {
  if (riskProtocolRegistered) return;
  riskProtocolRegistered = true;
  maplibregl.addProtocol("jmarisk", async (params, abortController) => {
    const m = params.url.match(/^jmarisk:\/\/([a-zA-Z]+)\/(\d+)\/(\d+)\/(-?\d+)\/(-?\d+)\/(-?\d+)$/);
    if (!m) return { data: null };
    const [, mode, basetime, validtime, zStr, xStr, yStr] = m;
    let z = Number(zStr), x = Number(xStr), y = Number(yStr);

    // 奇数ズームは1段階粗い偶数ズームのタイルを取得し、該当する象限だけを
    // 切り出して代用する(雨雲レーダー・降水量・天気分布予報と同じ方式)。
    let cropQuadrant = null;
    if (z % 2 !== 0) {
      cropQuadrant = { qx: x % 2, qy: y % 2 };
      z = z - 1;
      x = Math.floor(x / 2);
      y = Math.floor(y / 2);
    }
    const url = riskTileUrl(mode, basetime, validtime, z, x, y);
    if (riskFailedTileUrls.has(url)) return { data: null };

    let res;
    try {
      res = await fetch(url, { signal: abortController.signal });
    } catch (err) {
      if (err.name === "AbortError") throw err;
      return { data: null };
    }
    if (!res.ok) {
      if (res.status === 404) riskFailedTileUrls.add(url);
      return { data: null };
    }
    const blob = await res.blob();

    if (!cropQuadrant) return { data: await blob.arrayBuffer() };

    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(256, 256);
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(bitmap, cropQuadrant.qx * 128, cropQuadrant.qy * 128, 128, 128, 0, 0, 256, 256);
    const outBlob = await canvas.convertToBlob({ type: "image/png" });
    return { data: await outBlob.arrayBuffer() };
  });
}



/* ─────────────────────────────────────────────────────
   河川水位観測所(国管理・主要河川、stg)。国交省「川の防災情報」(kawabou)
   アプリ自身が使っている静的生成JSONを、Cloudflare Workersのプロキシ経由で
   取得する(www.river.go.jpは直接fetchするとCORSでブロックされるため、実機
   検証で判明済み)。プロキシはエッジキャッシュ(5分)を効かせており、複数端末
   からの同時アクセスでもriver.go.jp側への実リクエストは最小限に抑えている。
   実機検証の結果、概観・市区町村単位一覧は/kawabou/file/gjson配下だが、
   時系列(tmlist)だけ/kawabou/file/files配下だったため、ベースを分けている。
   ───────────────────────────────────────────────────── */
const RIVER_PROXY_BASE = "https://meteoquake-river-proxy.meteoquake-river.workers.dev";

const RIVER_GJSON_BASE = `${RIVER_PROXY_BASE}/kawabou/file/gjson`;

const RIVER_FILES_BASE = `${RIVER_PROXY_BASE}/kawabou/file/files`;


// 危険度レベル(stg_ovlvl、10刻み想定)→ ラベル・色。他の危険度分布(キキクル・
// 警報)と統一感を持たせつつ、6段階に対応させる。
export const RIVER_LEVEL_STEPS = [
  { level: 90, label: "氾濫発生",   color: "#140014" },
  { level: 80, label: "氾濫危険",   color: "#aa00aa" },
  { level: 40, label: "避難判断",   color: "#ff2800" },
  { level: 20, label: "氾濫注意",   color: "#f2e700" },
  { level: 10, label: "水防団待機", color: "#35a86b" },
  { level: 0,  label: "通常",       color: "#66ccff" },
];

export function riverLevelInfo(stgOvlvl) {
  if (stgOvlvl == null) return { label: "欠測", color: "#c8c8cb" };
  for (const step of RIVER_LEVEL_STEPS) {
    if (stgOvlvl >= step.level) return step;
  }
  return RIVER_LEVEL_STEPS[RIVER_LEVEL_STEPS.length - 1];
}


// kawabouのgetDatePath()と同じ考え方(YYYYMMDD/HHmm/)。10分刻みに切り捨てる。
// Date.getTime()は元々タイムゾーンに関係ない絶対時刻(UTC epoch ms)なので、
// ローカルタイムゾーン分の補正(getTimezoneOffset())は不要かつ有害
// (端末のタイムゾーンがJSTだと9時間分が二重に足されてしまうバグの元だった)。
// 単純に+9時間してUTC getterでJSTの日時として読み出せば良い。
function riverDatePath(date) {
  const d = new Date(date.getTime() + 9 * 60 * 60000); // JST化
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const roundedMin = Math.floor(d.getUTCMinutes() / 10) * 10;
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(roundedMin).padStart(2, "0");
  return { ymd: `${yyyy}${mm}${dd}`, hm: `${hh}${mi}` };
}


// 全国・基準超過(水防団待機水位以上)のみの概観一覧。生成が数分遅れることが
// あるため、現在時刻から10分刻みで最大6コマ(1時間分)遡って最初に成功した
// ものを使う。
export async function loadRiverOverview() {
  // 直近のコマはまだファイルが生成されていない(サイト側の生成タイミングに
  // ラグがある)可能性が高いため、最初から10分遅れのコマから試す。
  const now = new Date(Date.now() - 10 * 60000);
  for (let back = 0; back < 6; back++) {
    const t = new Date(now.getTime() - back * 10 * 60000);
    const { ymd, hm } = riverDatePath(t);
    const url = `${RIVER_GJSON_BASE}/overobs/stg/${ymd}/${hm}/over-obs-create.json`;
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) continue;
      const geojson = await res.json();
      if (geojson && Array.isArray(geojson.features)) return geojson;
    } catch (err) {
      if (back === 0) console.warn("河川水位(概観)の取得に失敗:", url, err);
    }
  }
  console.warn("河川水位(概観)の取得に失敗: 直近1時間分すべてダメでした");
  return { type: "FeatureCollection", features: [] };
}


// 市区町村単位・全件(通常水位の地点も含む)。twnCdは警報タブで既に持っている
// 市区町村コードをそのまま使う想定(桁数が違う場合は要調整、実機未確認)。
async function loadRiverStationsByTown(twnCd) {
  // 概観と同じく、最初から10分遅れのコマから試す。
  const now = new Date(Date.now() - 10 * 60000);
  for (let back = 0; back < 6; back++) {
    const t = new Date(now.getTime() - back * 10 * 60000);
    const { ymd, hm } = riverDatePath(t);
    const url = `${RIVER_GJSON_BASE}/obs/${ymd}/${hm}/stg/${twnCd}.json`;
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) continue;
      const geojson = await res.json();
      if (geojson && Array.isArray(geojson.features)) return geojson;
    } catch {
      // 次のコマにフォールバック
    }
  }
  return { type: "FeatureCollection", features: [] };
}



// 個別観測所の時系列(水位グラフ用)。実機検証で、ベースは/kawabou/file/files
// (gjsonではない)、引数はobs_fcd(13桁のフルコード)と判明済み。
export async function loadRiverStationSeries(obsFcd, obsCd) {
  const { ymd } = riverDatePath(new Date());
  const url = `${RIVER_FILES_BASE}/tmlist/past/stg/${ymd}/${obsFcd}.json`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (res.ok) return await res.json();
    console.warn("河川水位の時系列取得に失敗(HTTPエラー):", url, res.status);
  } catch (err) {
    console.warn("河川水位の時系列取得に失敗:", url, err);
  }
  return null;
}
