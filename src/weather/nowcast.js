import { createContext } from "react";

/* ─────────────────────────────────────────────────────
   雨雲レーダー(高解像度降水ナウキャスト) — 気象庁のPNGタイルをMapLibreで表示する。
   ・提供されているズームレベルは偶数のみ(奇数ズームにはタイルが存在しない)。
     MapLibreの独自プロトコル(addProtocol)でタイル要求をフックし、奇数ズームは
     1段階粗い偶数ズームのタイルの該当象限(128×128)を切り出して256×256に
     拡大することで代用する(=通常のオーバーズーム表示と同じ見た目になる)。
   ・全国のデータが存在するのはおおよそ東経118°〜150°・北緯20°〜48°の範囲のみ。
     この範囲外でタイルをリクエストしないよう、raster sourceにbounds(範囲)を
     設定して無駄な通信を避ける(MapLibreは画面に映っている範囲のタイルしか
     要求しないため、無駄になるのは主に日本から離れた場所を見ている時)。
   ・それでも境界付近では404になり得るため、一度404だったタイルのURLを
     覚えておき、同じURLを再度リクエストしない(パンで同じ境界付近を
     行き来した時の無駄打ちを防ぐ)。
   ───────────────────────────────────────────────────── */
export const NOWCAST_BOUNDS = [118, 20, 150, 48];
 // [west, south, east, north] のおおよその提供範囲
// コマ切り替え(自動再生・手動スライダー操作とも)で一瞬レーダーが消えないよう、
// 前後何コマぶんタイルを先読みしておくか。
const NOWCAST_PRELOAD_RADIUS = 3;

const NOWCAST_TARGET_TIMES_URLS = {
  obs: "https://www.jma.go.jp/bosai/jmatile/data/nowc/targetTimes_N1.json",       // 実況(過去)
  forecast: "https://www.jma.go.jp/bosai/jmatile/data/nowc/targetTimes_N2.json",  // 予測(60分先まで)
};

export function nowcastTileUrl(basetime, validtime, z, x, y) {
  return `https://www.jma.go.jp/bosai/jmatile/data/nowc/${basetime}/none/${validtime}/surf/hrpns/${z}/${x}/${y}.png`;
}

// MapLibreのraster sourceに渡す独自プロトコルURL(実タイルURLの組み立てや
// 偶数ズームへの丸め・配色変換は下のregisterNowcastProtocol内で行う)。
// schemeIdをURLに含めることで、配色設定を切り替えた時にMapLibreが
// 「別のタイル」として再取得してくれる(実際のJMAタイル自体はブラウザの
// HTTPキャッシュに乗っているので、追加の通信は発生しない)。
export function nowcastProtocolUrl(schemeId, basetime, validtime) {
  return `jmanowc://${schemeId}/${basetime}/${validtime}/{z}/{x}/{y}`;
}


/* ─────────────────────────────────────────────────────
   雨雲レーダーの配色スキーム。「震度配色」の設定と全く同じ考え方で、
   {id, label, palette} の一覧をここに増やしていけば選択肢を追加できる。
   ・palette: null の場合は気象庁配色そのまま(変換なし・最速)。
   ・palette がある場合は、JMA_NOWCAST_SOURCE_PALETTE の各色を、
     配列の対応するインデックスの色に1対1で置き換える(近似一致)。
   ───────────────────────────────────────────────────── */
// 気象庁「ホームページにおける気象情報の配色に関する設定指針」表２－１に定められた、
// レーダー・ナウキャストの降水強度(mm/h)ごとの正式なRGB値(弱い順)。
export const JMA_NOWCAST_SOURCE_PALETTE = [
  [242, 242, 255], // 0~1   ほぼ白
  [160, 210, 255], // 1~5   薄い水色
  [33, 140, 255],  // 5~10  やや薄い青
  [0, 65, 255],    // 10~20 青
  [250, 245, 0],   // 20~30 黄
  [255, 153, 0],   // 30~50 橙
  [255, 40, 0],    // 50~80 赤
  [180, 0, 104],   // 80~   赤紫
];

// Yahoo!天気の降水強度カラーバー(スクリーンショットより近似抽出)。
// 上と同じ並び(弱い順)で対応させる。
const YAHOO_WEATHER_NOWCAST_PALETTE = [
  [216, 246, 246], // 0~1   ごく薄い水色
  [130, 210, 235], // 1~5   薄い水色
  [70, 150, 225],  // 5~10  青
  [90, 200, 90],   // 10~20 緑
  [225, 225, 60],  // 20~30 黄
  [235, 165, 60],  // 30~50 橙
  [230, 70, 40],   // 50~80 赤
  [204, 0, 0],     // 80~   濃い赤
];

export const NOWCAST_COLOR_SCHEMES = {
  jma: {
    id: "jma",
    label: "気象庁配色(オリジナル)",
    palette: null,
  },
  yahoo: {
    id: "yahoo",
    label: "Yahoo!天気配色",
    palette: YAHOO_WEATHER_NOWCAST_PALETTE,
  },
};


// 現在選択中の雨雲レーダー配色スキームID("jma" | "yahoo")をアプリ全体に配る
// コンテキスト(震度配色と同じ仕組み)。
export const NowcastColorSchemeContext = createContext("jma");

const NOWCAST_COLOR_SCHEME_STORAGE_KEY = "nowcastColorScheme";

export function loadStoredNowcastColorScheme() {
  try {
    const saved = localStorage.getItem(NOWCAST_COLOR_SCHEME_STORAGE_KEY);
    if (saved && NOWCAST_COLOR_SCHEMES[saved]) return saved;
  } catch (err) {
    console.warn("雨雲レーダー配色の設定を読み込めませんでした:", err);
  }
  return "jma";
}

export function saveNowcastColorScheme(schemeId) {
  try {
    localStorage.setItem(NOWCAST_COLOR_SCHEME_STORAGE_KEY, schemeId);
  } catch (err) {
    console.warn("雨雲レーダー配色の設定を保存できませんでした:", err);
  }
}


// 台風予報円の表示間隔(時間)。台風接近時は気象庁の予報が3時間おきに増えるため、
// 「現在から○時間ごと」の予報円だけを間引いて表示する設定。初期値は12時間ごと。
const TYPHOON_FORECAST_INTERVAL_STORAGE_KEY = "typhoonForecastIntervalHours";

const TYPHOON_FORECAST_INTERVAL_VALID_HOURS = new Set([3, 6, 12, 24]);

export function loadStoredTyphoonForecastInterval() {
  try {
    const saved = Number(localStorage.getItem(TYPHOON_FORECAST_INTERVAL_STORAGE_KEY));
    if (TYPHOON_FORECAST_INTERVAL_VALID_HOURS.has(saved)) return saved;
  } catch (err) {
    console.warn("台風予報円の表示間隔の設定を読み込めませんでした:", err);
  }
  return 12;
}

export function saveTyphoonForecastInterval(hours) {
  try {
    localStorage.setItem(TYPHOON_FORECAST_INTERVAL_STORAGE_KEY, String(hours));
  } catch (err) {
    console.warn("台風予報円の表示間隔の設定を保存できませんでした:", err);
  }
}


// ピクセルの色を、最も近いJMA元パレットの色に対応する変換先の色へ置き換える
// (透明度はそのまま維持する)。JMAのタイルは基本的に固定色のパレット画像なので、
// 単純なユークリッド距離での最近傍マッチングで十分な精度になる。
export function remapImageDataColors(imageData, palette) {
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a === 0) continue; // 完全透明はそのまま(無駄な距離計算を省く)
    const r = data[i], g = data[i + 1], b = data[i + 2];
    let bestIdx = -1, bestDist = Infinity;
    for (let p = 0; p < JMA_NOWCAST_SOURCE_PALETTE.length; p++) {
      const [pr, pg, pb] = JMA_NOWCAST_SOURCE_PALETTE[p];
      const dr = r - pr, dg = g - pg, db = b - pb;
      const dist = dr * dr + dg * dg + db * db;
      if (dist < bestDist) { bestDist = dist; bestIdx = p; }
    }
    // 元パレットからかけ離れた色(誤差大きすぎ)は、地図の下地等が透けている
    // 縁のアンチエイリアシングとみなし、変換せずそのまま残す。
    if (bestDist > 60 * 60 * 3) continue;
    const [nr, ng, nb] = palette[bestIdx];
    data[i] = nr; data[i + 1] = ng; data[i + 2] = nb;
  }
  return imageData;
}


// 実況(N1)+予測(N2)を時刻昇順の1本のタイムラインにまとめて返す。
// [{ basetime, validtime, kind: "obs"|"forecast" }, ...]
export async function loadNowcastFrames() {
  const [obsRes, fcRes] = await Promise.all([
    fetch(NOWCAST_TARGET_TIMES_URLS.obs),
    fetch(NOWCAST_TARGET_TIMES_URLS.forecast),
  ]);
  if (!obsRes.ok) throw new Error(`雨雲レーダーの時刻一覧(実況)の取得に失敗(HTTP ${obsRes.status})`);
  if (!fcRes.ok) throw new Error(`雨雲レーダーの時刻一覧(予測)の取得に失敗(HTTP ${fcRes.status})`);
  const [obsList, fcList] = await Promise.all([obsRes.json(), fcRes.json()]);
  // N1・N2とも新しい順(降順)で来るので、時系列順(昇順)に直してから連結する。
  const obsFrames = [...obsList].reverse().map(t => ({ basetime: t.basetime, validtime: t.validtime, kind: "obs" }));
  const fcFramesRaw = [...fcList].reverse().map(t => ({ basetime: t.basetime, validtime: t.validtime, kind: "forecast" }));
  // N1(実況)の最新コマとN2(予測)の先頭コマは、境目の「現在時刻」を指す
  // validtimeが一致することがある(予測は現在時刻を起点に60分先までを
  // 含むため)。そのまま連結すると、スライダー上に同じ時刻の目盛りが
  // 「実況」「予測」として2つ並んでしまう。実況側を正としてそちらを残し、
  // 予測側にある重複コマは取り除く。
  const obsValidtimes = new Set(obsFrames.map(f => f.validtime));
  const fcFrames = fcFramesRaw.filter(f => !obsValidtimes.has(f.validtime));
  return [...obsFrames, ...fcFrames];
}


// targetTimes_N1/N2.jsonのvalidtimeは"YYYYMMDDHHMMSS"形式の14桁文字列で、実際には
// UTCで返ってくる(コメントでJSTと誤解していたのが「実際は7:20なのに22:20と表示
// される」不具合の原因だった)。日付をまたぐ差し引きも正しく扱えるよう、一度UTCの
// タイムスタンプ(ms)として組み立ててから使う。
export function nowcastValidtimeToMs(validtime) {
  if (!validtime || validtime.length < 12) return null;
  const y = Number(validtime.slice(0, 4));
  const mo = Number(validtime.slice(4, 6)) - 1;
  const d = Number(validtime.slice(6, 8));
  const h = Number(validtime.slice(8, 10));
  const mi = Number(validtime.slice(10, 12));
  const s = validtime.length >= 14 ? Number(validtime.slice(12, 14)) : 0;
  const ms = Date.UTC(y, mo, d, h, mi, s);
  return Number.isNaN(ms) ? null : ms;
}

// スライダー上に出す「16:40」のような短い時刻表示に変換する(UTC→JSTは+9時間)。
export function parseNowcastValidTime(validtime) {
  const utcMs = nowcastValidtimeToMs(validtime);
  if (utcMs == null) return null;
  const jst = new Date(utcMs + 9 * 60 * 60 * 1000);
  const hh = String(jst.getUTCHours()).padStart(2, "0");
  const mm = String(jst.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function formatNowcastFrameLabel(frame) {
  if (!frame) return "";
  const time = parseNowcastValidTime(frame.validtime);
  if (!time) return frame.kind === "obs" ? "実況" : "予測";
  return frame.kind === "obs" ? `${time} 実況` : `${time} 予測`;
}


// フレーム一覧の中から、現在時刻(Date.now())に一番近いものを探す。
// 雨雲レーダーのN1/N2のように「実況/予測」がファイルで分かれておらず、
// 1本のtargetTimes.jsonに実況・予報が混ざっている(と思われる)降水量では、
// これを「現在」の代わりに使う(一覧の再取得時に選択を維持するかどうかの
// 判定にも使う)。
export function nowcastNearestIndexToNow(frames) {
  if (!frames || frames.length === 0) return null;
  const now = Date.now();
  let bestIdx = 0, bestDist = Infinity;
  frames.forEach((f, i) => {
    const ms = nowcastValidtimeToMs(f.validtime);
    if (ms == null) return;
    const dist = Math.abs(ms - now);
    if (dist < bestDist) { bestDist = dist; bestIdx = i; }
  });
  return bestIdx;
}


/* ─────────────────────────────────────────────────────
   1時間・3時間・24時間降水量(気象庁「今後の雨」降水短時間予報)。
   配色は雨雲レーダーと共通(NOWCAST_COLOR_SCHEMES/remapImageDataColors を
   そのまま使う)。

   実際にtargetTimes.jsonを取得して確認済み(2026-08-08時点):
   - 要素名は"rasrf"(1時間)/"rasrf03h"(3時間)/"rasrf24h"(24時間)で正しかった。
   - 同じjsonの中に、この降水量とは無関係な要素(sjfcstmap・slmcs等)を含む
     エントリも大量に混ざっているため、目的のelementを含むエントリだけを
     拾う必要がある。
   - 各エントリにmemberフィールド("none"だったり"immed"だったりする)があり、
     タイルURL中の"none"の部分は固定ではなく、このmemberをそのまま使う必要が
     ある(直近の即時値・予報コマはmember="immed"になっており、"none"固定
     だとそこだけ404していた)。
   ───────────────────────────────────────────────────── */
const PRECIP_DATA_BASE = "https://www.jma.go.jp/bosai/jmatile/data/rasrf";

const PRECIP_MODE_CONFIG = {
  precip1h:  { element: "rasrf",     label: "1時間降水量" },
  precip3h:  { element: "rasrf03h",  label: "3時間降水量" },
  precip24h: { element: "rasrf24h",  label: "24時間降水量" },
};

export function precipTileUrl(mode, member, basetime, validtime, z, x, y) {
  const element = PRECIP_MODE_CONFIG[mode]?.element || "rasrf";
  return `${PRECIP_DATA_BASE}/${basetime}/${member}/${validtime}/surf/${element}/${z}/${x}/${y}.png`;
}

export function precipProtocolUrl(mode, schemeId, member, basetime, validtime) {
  return `jmaprecip://${mode}/${schemeId}/${member}/${basetime}/${validtime}/{z}/{x}/{y}`;
}


// modeの時刻一覧を取得する。[{ basetime, validtime, member }, ...] を時系列昇順で返す。
export async function loadPrecipFrames(mode) {
  const label = PRECIP_MODE_CONFIG[mode]?.label || mode;
  const element = PRECIP_MODE_CONFIG[mode]?.element || "rasrf";
  const url = `${PRECIP_DATA_BASE}/targetTimes.json`;
  let raw;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    raw = await res.json();
  } catch (err) {
    console.warn(`降水量[${label}]: 時刻一覧の取得に失敗 url=${url}`, err);
    throw err;
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    console.warn(`降水量[${label}]: 時刻一覧が空、または想定外の形式です url=${url}`, raw);
    return [];
  }
  // このjsonには降水量以外の要素(sjfcstmap・slmcs等)のエントリも混ざっているため、
  // elementsに目的の要素名を含むものだけを拾う。validtimeの文字列比較で昇順に
  // 整列する(YYYYMMDDHHMMSS形式なので文字列比較=時系列比較になる)。
  return raw
    .filter(t => t && t.basetime && t.validtime && Array.isArray(t.elements) && t.elements.includes(element))
    .sort((a, b) => String(a.validtime).localeCompare(String(b.validtime)))
    .map(t => ({ basetime: t.basetime, validtime: t.validtime, member: t.member || "none" }));
}


export function formatPrecipFrameLabel(frame) {
  if (!frame) return "";
  const time = parseNowcastValidTime(frame.validtime);
  if (!time) return "";
  const ms = nowcastValidtimeToMs(frame.validtime);
  const isForecast = ms != null && ms > Date.now();
  return isForecast ? `${time} 予報` : `${time} 実況`;
}


/* ─────────────────────────────────────────────────────
   天気分布予報。「天気分布」(晴れ/くもり/雨/雨または雪/雪の5分類)と
   「気温分布」の2種類を実装する(降水量・降雪量・最高最低気温は対象外)。
   5kmメッシュで、3時間ごと・翌日24時まで予報するデータ(毎日5時・11時・
   17時発表)。

   ⚠️ 天気分布のタイルURL構造は実機で確認済み(2026年8月時点で正常に表示)。
   気温分布(要素名"temp")は、ページのURLハッシュ(elements:temp)から
   類推した未検証の値。実機で404や想定外のデータが出た場合はconsole.warnに
   実際のURL・レスポンスを出すようにしてあるので、そこから正しい値を
   特定して直す想定。
   ───────────────────────────────────────────────────── */
const WDIST_DATA_BASE = "https://www.jma.go.jp/bosai/jmatile/data/wdist";

export const WDIST_MODE_CONFIG = {
  weather:     { element: "wm",   label: "天気分布" },
  temperature: { element: "temp", label: "気温分布" }, // 要検証
};

export function wdistTileUrl(mode, member, basetime, validtime, z, x, y) {
  const element = WDIST_MODE_CONFIG[mode]?.element || "wm";
  return `${WDIST_DATA_BASE}/${basetime}/${member}/${validtime}/surf/${element}/${z}/${x}/${y}.png`;
}

export function wdistProtocolUrl(mode, member, basetime, validtime) {
  return `jmawdist://${mode}/${member}/${basetime}/${validtime}/{z}/{x}/{y}`;
}


// modeの時刻一覧を取得する。[{ basetime, validtime, member }, ...] を時系列昇順で返す。
export async function loadWdistFrames(mode) {
  const label = WDIST_MODE_CONFIG[mode]?.label || mode;
  const element = WDIST_MODE_CONFIG[mode]?.element || "wm";
  const url = `${WDIST_DATA_BASE}/targetTimes.json`;
  let raw;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    raw = await res.json();
  } catch (err) {
    console.warn(`${label}: 時刻一覧の取得に失敗 url=${url}`, err);
    throw err;
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    console.warn(`${label}: 時刻一覧が空、または想定外の形式です url=${url}`, raw);
    return [];
  }
  // このjsonには天気分布予報以外の要素のエントリが混ざっている可能性がある
  // ため、elementsに目的の要素名を含むものだけを拾う。含まれていなかった
  // 場合(=elements自体が無い形式だった場合)に備えて、elementsが無ければ
  // 素通しするフォールバックも用意しておく。
  const filtered = raw.filter(t => t && t.basetime && t.validtime);
  const withElement = filtered.filter(t => Array.isArray(t.elements) && t.elements.includes(element));
  if (filtered.length > 0 && withElement.length === 0) {
    console.warn(
      `${label}: elements="${element}"を含むエントリが1件も無かった。` +
      `要素名の推測が外れている可能性があります。実際のエントリ例:`,
      filtered[0]
    );
  }
  const result = withElement.length > 0 ? withElement : filtered;
  return result
    .sort((a, b) => String(a.validtime).localeCompare(String(b.validtime)))
    .map(t => ({ basetime: t.basetime, validtime: t.validtime, member: t.member || "none" }));
}


// 天気分布予報のスライダー用ラベル。翌日24時まで予報があるため、雨雲レーダー・
// 降水量のような「HH:MM」だけだと今日なのか明日なのか分からなくなる。
// 「10日15時」のように日付+時をそのまま出す。
export function formatWdistFrameLabel(frame) {
  if (!frame) return "";
  const ms = nowcastValidtimeToMs(frame.validtime);
  if (ms == null) return "";
  const jst = new Date(ms + 9 * 60 * 60 * 1000);
  const day = jst.getUTCDate();
  const hour = jst.getUTCHours();
  return `${day}日${hour}時`;
}
