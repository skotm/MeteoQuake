


/* ─────────────────────────────────────────────────────
   発震機構解(CMT解) — 「この地震の詳細」用

   気象庁の発震機構解(精査後)ページ(data.jma.go.jp/eqev/data/mech/cmt/…)は
   正式なJSON APIではなく、月別の一覧HTMLページと、地震ごとの詳細HTMLページから
   なる。fetchでの取得(CORS)自体は実機で確認済み。
   
   1. 対象地震の発生月から一覧ページ(cmtYYYYMM.html)を取得し、時刻・位置が
      近い行を探す(=CMT解が求まっている地震かどうか、どれに対応するかを判別)。
   2. 一致した行の発生時刻から、詳細ページのURL(cmtYYYYMMDDHHMMSS.html)を
      組み立てて取得し、震源球画像・モーメントテンソル・P/T/N軸などの
      詳しい情報を得る。
   ───────────────────────────────────────────────────── */

// 「この地震の詳細」(発震機構解)ボタンを出すマグニチュードの下限。
// 気象庁のCMT解はおおむねM5.0以上だが、USGSのモーメントテンソル解はM4台前半からあるため、
// USGSも参照する今は下限を下げる(解が無ければ画面で「見つかりません」と案内する)。
export const CMT_BUTTON_MIN_MAGNITUDE = 4.0;

const CMT_LIST_BASE = "https://www.data.jma.go.jp/eqev/data/mech/cmt/";
const CMT_FIG_BASE = "https://www.data.jma.go.jp/eqev/data/mech/cmt/fig/";

// "33度17.8分N" のような度分表記を10進の度(符号付き)に変換する。
// S(南緯)・W(西経)の場合は負の値にする。
function cmtParseDegMin(str) {
  if (!str) return null;
  const m = String(str).match(/([\d.]+)度([\d.]+)分([NSEW])/);
  if (!m) return null;
  const deg = parseFloat(m[1]) + parseFloat(m[2]) / 60;
  return (m[3] === "S" || m[3] === "W") ? -deg : deg;
}

// "2026-07-09 21:58:58.8" のような気象庁側の時刻文字列(日本時間)を、
// 比較に使えるエポックミリ秒に変換する。
function cmtParseTimeToEpochMs(str) {
  if (!str) return null;
  const m = String(str).trim().match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss] = m.map(Number);
  // 気象庁のページはすべて日本時間(UTC+9)表記のため、UTCとして組み立ててから9時間引く。
  return Date.UTC(y, mo - 1, d, hh, mm, ss) - 9 * 3600 * 1000;
}

// アプリ内の地震オブジェクトが持つ time("YYYY/MM/DD HH:mm[:ss]"、日本時間)を
// 同じくエポックミリ秒に変換する。cmtParseTimeToEpochMsと単位を揃えるための対。
function quakeTimeToEpochMs(timeStr) {
  if (!timeStr) return null;
  const m = String(timeStr).trim().match(/(\d{4})\/(\d{2})\/(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const hh = Number(m[4]), mm = Number(m[5]), ss = m[6] ? Number(m[6]) : 0;
  return Date.UTC(y, mo - 1, d, hh, mm, ss) - 9 * 3600 * 1000;
}

// 発生時刻(気象庁ページの文字列)から、詳細ページのURLに使うタイムスタンプ
// (YYYYMMDDHHMMSS)を組み立てる。
function cmtTimeToUrlStamp(str) {
  const m = String(str).trim().match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return m[1] + m[2] + m[3] + m[4] + m[5] + m[6];
}

// 月別一覧ページ(cmtYYYYMM.html)を取得し、行ごとに構造化データへ変換する。
// 同じ月内で複数回この一覧が必要になることがあるため、簡単なメモ化キャッシュを持つ。
const cmtMonthCache = new Map(); // "YYYYMM" -> Promise<rows>

function fetchCmtMonthList(yyyymm) {
  if (cmtMonthCache.has(yyyymm)) return cmtMonthCache.get(yyyymm);

  const promise = (async () => {
    const res = await fetch(`${CMT_LIST_BASE}cmt${yyyymm}.html`);
    if (!res.ok) throw new Error(`CMT一覧の取得に失敗しました(status ${res.status})`);
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const rows = [...doc.querySelectorAll("table tr")];

    const out = [];
    for (const tr of rows) {
      const cells = [...tr.querySelectorAll("td")].map(td => td.textContent.trim());
      // データ行は14列(発生時刻,緯度,経度,深さ,M,震央地域名,Mw,走向1,傾斜1,すべり角1,走向2,傾斜2,すべり角2,詳細)。
      // ヘッダー行(列数が違う・数値が入っていない)はここで自然に弾かれる。
      if (cells.length < 13) continue;
      const timeMs = cmtParseTimeToEpochMs(cells[0]);
      if (timeMs == null) continue;
      const lat = cmtParseDegMin(cells[1]);
      const lon = cmtParseDegMin(cells[2]);
      const depthMatch = cells[3].match(/\d+/);
      out.push({
        timeStr: cells[0],
        timeMs,
        lat, lon,
        depth: depthMatch ? parseInt(depthMatch[0], 10) : null,
        magnitude: parseFloat(cells[4]) || null,
        place: cells[5] || "",
        mw: parseFloat(cells[6]) || null,
        plane1: { strike: cells[7], dip: cells[8], rake: cells[9] },
        plane2: { strike: cells[10], dip: cells[11], rake: cells[12] },
        detailUrlStamp: cmtTimeToUrlStamp(cells[0]),
      });
    }
    return out;
  })();

  cmtMonthCache.set(yyyymm, promise);
  // 失敗した月はキャッシュに残さない(一時的なネットワーク障害等で、以後ずっと
  // 失敗扱いのままになるのを防ぐ)。
  promise.catch(() => cmtMonthCache.delete(yyyymm));
  return promise;
}

// 対象の地震(time・緯度経度)に最も近いCMT解の行を探す。
// 発生時刻が近い(±3分以内)ことを必須とし、その中で最も時刻が近いものを採用する
// (連続発生時に別の地震を誤って拾わないよう、念のため緯度経度も大きく離れて
//  いないか確認する)。
const CMT_MATCH_TOLERANCE_MS = 3 * 60 * 1000;
const CMT_MATCH_MAX_DEGREES = 2.0;

export async function findCmtMatchForQuake(quake) {
  const quakeMs = quakeTimeToEpochMs(quake.time);
  if (quakeMs == null) return null;

  const d = new Date(quakeMs);
  // 発生時刻が月初め近くの場合、CMT解の一覧側は「発生時刻」(=同じ日本時間)なので
  // 基本的には地震自身と同じ月の一覧に載っているはずだが、念のため前月分も
  // 候補に含めておく(月境界をまたぐタイミングのずれ対策)。
  const yyyymmThis = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  const prevMonthDate = new Date(quakeMs - 24 * 3600 * 1000);
  const yyyymmPrev = `${prevMonthDate.getUTCFullYear()}${String(prevMonthDate.getUTCMonth() + 1).padStart(2, "0")}`;
  const monthKeys = yyyymmThis === yyyymmPrev ? [yyyymmThis] : [yyyymmThis, yyyymmPrev];

  let candidates = [];
  for (const key of monthKeys) {
    try {
      const rows = await fetchCmtMonthList(key);
      candidates = candidates.concat(rows);
    } catch {
      // その月の一覧が取れなくても、もう片方の月で見つかる可能性があるので続行する。
    }
  }

  let best = null, bestDiff = Infinity;
  for (const row of candidates) {
    const diff = Math.abs(row.timeMs - quakeMs);
    if (diff > CMT_MATCH_TOLERANCE_MS) continue;
    if (quake.latitude != null && quake.longitude != null && row.lat != null && row.lon != null) {
      const dist = Math.abs(row.lat - quake.latitude) + Math.abs(row.lon - quake.longitude);
      if (dist > CMT_MATCH_MAX_DEGREES) continue;
    }
    if (diff < bestDiff) { bestDiff = diff; best = row; }
  }
  return best;
}

// 地震ごとの詳細ページ(cmtYYYYMMDDHHMMSS.html)を取得し、震源球画像や
// モーメントテンソル・発震機構解(P/T/N軸込み)・観測点数などを取り出す。
export async function fetchCmtDetail(detailUrlStamp) {
  const url = `${CMT_FIG_BASE}cmt${detailUrlStamp}.html`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CMT詳細の取得に失敗しました(status ${res.status})`);
  const html = await res.text();
  const doc = new DOMParser().parseFromString(html, "text/html");

  // ページ内には複数の<table>があり、順番は固定(見出し文言で対応するテーブルを探す)。
  // h2見出しの直後の最初のtableを、その見出しのテーブルとみなす。
  function tableAfterHeading(keyword) {
    const heading = [...doc.querySelectorAll("h2")].find(h => h.textContent.includes(keyword));
    if (!heading) return null;
    let el = heading.nextElementSibling;
    while (el && el.tagName !== "TABLE") el = el.nextElementSibling;
    return el;
  }
  function rowCells(table, rowIndex) {
    if (!table) return [];
    const trs = table.querySelectorAll("tr");
    const tr = trs[rowIndex];
    if (!tr) return [];
    return [...tr.querySelectorAll("td,th")].map(c => c.textContent.trim());
  }

  const hypoTable = tableAfterHeading("地震発生時刻と震源位置");
  const hypo = rowCells(hypoTable, 1); // [発生時刻, 緯度, 経度, 深さ, M]

  const centroidTable = tableAfterHeading("セントロイド時刻");
  const centroid = rowCells(centroidTable, 1); // [セントロイド時刻, 緯度, 経度, 深さ, Mw]

  const mechTable = tableAfterHeading("発震機構解");
  const plane1Row = rowCells(mechTable, 1); // [断層面解1, 走向, 傾斜, すべり角, 方位, P軸方位, T軸方位, N軸方位]
  const plane2Row = rowCells(mechTable, 2); // [断層面解2, 走向, 傾斜, すべり角, 傾斜, P軸傾斜, T軸傾斜, N軸傾斜]

  const stationTable = tableAfterHeading("使用観測点数");
  const stationRow = rowCells(stationTable, 0);

  // 画像(震源球・周辺のCMT解)。<img>タグで直接読み込むだけなのでCORSの影響を受けない。
  // ページ内のsrc属性は相対パス("cmt....png"など)で書かれていることがあるため、
  // 文字列にパスが含まれているかで絞り込む前に、必ずURLを絶対パスへ解決してから
  // 判定する(でないと相対パスの画像を取りこぼす)。
  const images = [...doc.querySelectorAll("img")]
    .map(img => img.getAttribute("src"))
    .filter(Boolean)
    .map(src => new URL(src, url).href)
    .filter(src => !src.includes("jma.go.jp/jma/com/images/")); // 気象庁ロゴなど共通画像を除外
  const beachballImg = images.find(src => !/map/i.test(src)) || null;
  const surroundingMapImg = images.find(src => /map/i.test(src)) || null;

  return {
    sourceUrl: url,
    hypo: {
      time: hypo[0] || null, lat: hypo[1] || null, lon: hypo[2] || null,
      depth: hypo[3] || null, magnitude: hypo[4] || null,
    },
    centroid: {
      time: centroid[0] || null, lat: centroid[1] || null, lon: centroid[2] || null,
      depth: centroid[3] || null, mw: centroid[4] || null,
    },
    plane1: { strike: plane1Row[1] || null, dip: plane1Row[2] || null, rake: plane1Row[3] || null },
    plane2: { strike: plane2Row[1] || null, dip: plane2Row[2] || null, rake: plane2Row[3] || null },
    // P軸・T軸・N軸は「方位」の行(plane1Row)と「傾斜」の行(plane2Row)にそれぞれ
    // 3つずつ入っている(表が2行にまたがった構成のため)。
    axes: {
      p: { azimuth: plane1Row[5] || null, plunge: plane2Row[5] || null },
      t: { azimuth: plane1Row[6] || null, plunge: plane2Row[6] || null },
      n: { azimuth: plane1Row[7] || null, plunge: plane2Row[7] || null },
    },
    stationCount: stationRow[1] || null,
    varianceReduction: stationRow[3] || null,
    beachballImageUrl: beachballImg,
    surroundingMapImageUrl: surroundingMapImg,
  };
}

/* ─────────────────────────────────────────────────────
   USGSのモーメントテンソル解
   気象庁のCMT解は公開が遅いため、USGSのFDSN Event API(CORS対応)からも探す。
     1. 発生時刻の前後±5分・震源付近でmoment-tensorを持つイベントを検索
     2. 時刻・位置が最も近いイベントを採用(気象庁と同じ許容範囲)
     3. そのイベントの詳細(geojson)からmoment-tensorプロダクトを読み、
        気象庁のfetchCmtDetailと同じ形に正規化して返す
   ───────────────────────────────────────────────────── */
const USGS_QUERY_URL = "https://earthquake.usgs.gov/fdsnws/event/1/query";
// 気象庁とUSGSでは震源決定の時刻・位置が数十秒・1〜2度ずれることがあるため、
// 気象庁側より少し広めに許容する。
const USGS_SEARCH_WINDOW_MS = 10 * 60 * 1000;
const USGS_MATCH_TOLERANCE_MS = 5 * 60 * 1000;
const USGS_MATCH_MAX_DEGREES = 3.0;
const USGS_BBOX_DEGREES = 5;

const usgsNum = v => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

// エポックミリ秒 → 日本時間の"YYYY/MM/DD HH:mm:ss"。
function formatJstFromMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return null;
  const d = new Date(ms + 9 * 3600 * 1000);
  const p = n => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

const usgsLat = lat => (lat == null ? null : `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? "N" : "S"}`);
const usgsLon = lon => (lon == null ? null : `${Math.abs(lon).toFixed(2)}°${lon >= 0 ? "E" : "W"}`);
const usgsDepth = km => (km == null ? null : `${Math.round(km)} km`);
const usgsDeg = v => (usgsNum(v) == null ? null : String(Math.round(usgsNum(v))));

export async function findUsgsCmtForQuake(quake) {
  const quakeMs = quakeTimeToEpochMs(quake.time);
  if (quakeMs == null) return null;

  const iso = ms => new Date(ms).toISOString().slice(0, 19);
  const params = new URLSearchParams({
    format: "geojson",
    producttype: "moment-tensor",
    orderby: "time",
    starttime: iso(quakeMs - USGS_SEARCH_WINDOW_MS),
    endtime: iso(quakeMs + USGS_SEARCH_WINDOW_MS),
  });
  if (quake.latitude != null && quake.longitude != null) {
    params.set("minlatitude", String(quake.latitude - USGS_BBOX_DEGREES));
    params.set("maxlatitude", String(quake.latitude + USGS_BBOX_DEGREES));
    params.set("minlongitude", String(quake.longitude - USGS_BBOX_DEGREES));
    params.set("maxlongitude", String(quake.longitude + USGS_BBOX_DEGREES));
  }

  // 設定の「ログ」画面で原因を追えるよう、検索条件と結果を残す。
  const queryUrl = `${USGS_QUERY_URL}?${params.toString()}`;
  console.log("[usgs-cmt] 検索開始", { quakeTime: quake.time, place: quake.place, queryUrl });
  const res = await fetch(queryUrl);
  // 該当なしは204(本文なし)で返ることがある。
  if (res.status === 204) { console.log("[usgs-cmt] 該当イベントなし(204)"); return null; }
  if (!res.ok) throw new Error(`USGSの検索に失敗しました(status ${res.status})`);
  const json = await res.json();

  console.log("[usgs-cmt] 検索結果", {
    件数: (json.features || []).length,
    候補: (json.features || []).map(f => ({
      id: f.id, 時刻差秒: Math.round(((f.properties?.time ?? NaN) - quakeMs) / 1000),
      lat: f.geometry?.coordinates?.[1], lon: f.geometry?.coordinates?.[0], mag: f.properties?.mag,
    })),
  });
  let best = null, bestDiff = Infinity;
  for (const f of json.features || []) {
    const diff = Math.abs((f.properties?.time ?? Infinity) - quakeMs);
    if (diff > USGS_MATCH_TOLERANCE_MS) continue;
    const [lon, lat] = f.geometry?.coordinates || [];
    if (quake.latitude != null && quake.longitude != null && lat != null && lon != null) {
      if (Math.abs(lat - quake.latitude) + Math.abs(lon - quake.longitude) > USGS_MATCH_MAX_DEGREES) continue;
    }
    if (diff < bestDiff) { bestDiff = diff; best = f; }
  }
  if (!best || !best.properties?.detail) { console.log("[usgs-cmt] 許容範囲内の一致なし"); return null; }
  console.log("[usgs-cmt] 一致", { id: best.id, detail: best.properties.detail });

  const detailRes = await fetch(best.properties.detail);
  if (!detailRes.ok) throw new Error(`USGSの詳細取得に失敗しました(status ${detailRes.status})`);
  const detailJson = await detailRes.json();
  // プロダクトは優先度順に並ぶため、先頭が採用されている解。
  const mt = detailJson.properties?.products?.["moment-tensor"]?.[0];
  if (!mt) { console.log("[usgs-cmt] moment-tensorプロダクトなし", Object.keys(detailJson.properties?.products || {})); return null; }
  const p = mt.properties || {};

  // 震源球画像(beachball)。含まれていない場合は画像なしで数値だけ表示する。
  const contents = mt.contents || {};
  const bbKey = Object.keys(contents).find(k => /beachball.*\.(png|jpe?g|gif)$/i.test(k))
    || Object.keys(contents).find(k => /beachball.*\.svg$/i.test(k));
  const foundBeachballUrl = bbKey ? contents[bbKey].url || null : null;
  // 画像が無い・読み込めない場合に備え、断層面解1から震源球を描いたものを必ず用意する。
  const drawnBeachballUrl = renderBeachballDataUrl(
    p["nodal-plane-1-strike"], p["nodal-plane-1-dip"], p["nodal-plane-1-rake"]
  );
  console.log("[usgs-cmt] 震源球", { 画像キー: bbKey, 含まれるファイル: Object.keys(contents), 描画: !!drawnBeachballUrl });

  const [evLon, evLat, evDepth] = best.geometry?.coordinates || [];
  const magText = best.properties.mag != null
    ? `${Number(best.properties.mag).toFixed(1)}${best.properties.magType ? ` (${best.properties.magType})` : ""}`
    : null;
  const derivedMs = p["derived-eventtime"] ? Date.parse(p["derived-eventtime"]) : null;
  const derivedMag = usgsNum(p["derived-magnitude"]);
  const pdc = usgsNum(p["percent-double-couple"]);
  const stations = p["num-stations-used"] ?? p["num-stations"] ?? null;

  const metrics = [];
  if (pdc != null) metrics.push({ label: "ダブルカップル成分", value: `${Math.round(pdc <= 1 ? pdc * 100 : pdc)}%` });
  if (stations != null) metrics.push({ label: "使用観測点数", value: String(stations) });
  if (p["review-status"]) metrics.push({ label: "レビュー状況", value: String(p["review-status"]) });

  return {
    source: "usgs",
    sourceUrl: best.properties.url || null,
    hypo: {
      time: formatJstFromMs(best.properties.time),
      lat: usgsLat(evLat), lon: usgsLon(evLon),
      depth: usgsDepth(evDepth), magnitude: magText,
    },
    centroid: {
      time: formatJstFromMs(derivedMs),
      lat: usgsLat(usgsNum(p["derived-latitude"])), lon: usgsLon(usgsNum(p["derived-longitude"])),
      depth: usgsDepth(usgsNum(p["derived-depth"])),
      mw: derivedMag != null ? `${derivedMag.toFixed(1)}${p["derived-magnitude-type"] ? ` (${p["derived-magnitude-type"]})` : ""}` : null,
    },
    plane1: { strike: usgsDeg(p["nodal-plane-1-strike"]), dip: usgsDeg(p["nodal-plane-1-dip"]), rake: usgsDeg(p["nodal-plane-1-rake"]) },
    plane2: { strike: usgsDeg(p["nodal-plane-2-strike"]), dip: usgsDeg(p["nodal-plane-2-dip"]), rake: usgsDeg(p["nodal-plane-2-rake"]) },
    axes: {
      p: { azimuth: usgsDeg(p["p-axis-azimuth"]), plunge: usgsDeg(p["p-axis-plunge"]) },
      t: { azimuth: usgsDeg(p["t-axis-azimuth"]), plunge: usgsDeg(p["t-axis-plunge"]) },
      n: { azimuth: usgsDeg(p["n-axis-azimuth"]), plunge: usgsDeg(p["n-axis-plunge"]) },
    },
    metrics,
    beachballImageUrl: foundBeachballUrl || drawnBeachballUrl,
    beachballFallbackUrl: drawnBeachballUrl,
    surroundingMapImageUrl: null,
  };
}

/* ─────────────────────────────────────────────────────
   震源球(ビーチボール)の自前描画
   USGSのプロダクトには震源球画像が含まれない・名前が想定と違うことがあるため、
   断層面解(走向・傾斜・すべり角)から下半球等積投影の震源球を描いて、
   PNGのデータURLとして返す。
     - 各点の方位・射出角から、ダブルカップルの放射パターンの符号を求める
       (符号 = (n·r)(u·r)、n=断層面の法線、u=すべり方向、r=その方向の単位ベクトル)
     - 押し(P波初動が上向き)の領域を黒、引きの領域を白で塗る
   座標系は北(x)・東(y)・下(z)。
   ───────────────────────────────────────────────────── */
export function renderBeachballDataUrl(strikeDeg, dipDeg, rakeDeg, size = 360) {
  const strike = parseFloat(strikeDeg), dip = parseFloat(dipDeg), rake = parseFloat(rakeDeg);
  if (![strike, dip, rake].every(Number.isFinite)) return null;
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const rad = d => (d * Math.PI) / 180;
  const phi = rad(strike), del = rad(dip), lam = rad(rake);
  // 走向方向 s、傾斜方向(下向き) d、上盤側の法線 n、すべり方向 u
  const s = [Math.cos(phi), Math.sin(phi), 0];
  const d = [-Math.sin(phi) * Math.cos(del), Math.cos(phi) * Math.cos(del), Math.sin(del)];
  const n = [-Math.sin(phi) * Math.sin(del), Math.cos(phi) * Math.sin(del), -Math.cos(del)];
  const u = [
    Math.cos(lam) * s[0] - Math.sin(lam) * d[0],
    Math.cos(lam) * s[1] - Math.sin(lam) * d[1],
    Math.cos(lam) * s[2] - Math.sin(lam) * d[2],
  ];

  const img = ctx.createImageData(size, size);
  const c = size / 2, R = size / 2 - 3;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const x = (px + 0.5 - c) / R;  // 右が東
      const y = (c - (py + 0.5)) / R; // 上が北
      const rho = Math.hypot(x, y);
      const idx = (py * size + px) * 4;
      if (rho > 1) { img.data[idx + 3] = 0; continue; } // 円の外は透明
      // 等積投影: rho = √2·sin(i/2) (i = 鉛直下向きからの角度)
      const inc = 2 * Math.asin(Math.min(1, rho / Math.SQRT2));
      const az = Math.atan2(x, y); // 北から東回り
      const r = [Math.sin(inc) * Math.cos(az), Math.sin(inc) * Math.sin(az), Math.cos(inc)];
      const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      const compression = dot(n, r) * dot(u, r) > 0;
      const v = compression ? 20 : 255;
      img.data[idx] = v; img.data[idx + 1] = v; img.data[idx + 2] = v; img.data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  ctx.beginPath();
  ctx.arc(c, c, R, 0, Math.PI * 2);
  ctx.lineWidth = 3;
  ctx.strokeStyle = "#141414";
  ctx.stroke();
  return canvas.toDataURL("image/png");
}
