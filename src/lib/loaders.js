/* ─────────────────────────────────────────────────────
   MAPLIBRE LOADER
   CDNからmaplibre-gl本体とCSSを動的読み込みする
   （Reactアーティファクト環境にはnpmパッケージが無いため）
   ───────────────────────────────────────────────────── */
const MAPLIBRE_JS  = "https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/4.7.1/maplibre-gl.js";

const MAPLIBRE_CSS = "https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/4.7.1/maplibre-gl.css";


let maplibreLoadPromise = null;

export function loadMapLibre() {
  if (window.maplibregl) return Promise.resolve(window.maplibregl);
  if (maplibreLoadPromise) return maplibreLoadPromise;

  maplibreLoadPromise = new Promise((resolve, reject) => {
    if (!document.querySelector(`link[href="${MAPLIBRE_CSS}"]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = MAPLIBRE_CSS;
      document.head.appendChild(link);
    }
    const existing = document.querySelector(`script[src="${MAPLIBRE_JS}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve(window.maplibregl));
      return;
    }
    const script = document.createElement("script");
    script.src = MAPLIBRE_JS;
    script.async = true;
    script.onload = () => resolve(window.maplibregl);
    script.onerror = () => reject(new Error("MapLibre GL JS の読み込みに失敗しました"));
    document.head.appendChild(script);
  });

  return maplibreLoadPromise;
}


/* ─────────────────────────────────────────────────────
   TURF.JS LOADER
   CDNからturf.js本体を動的読み込みする(maplibre-glと同じ理由でnpm importできない)。
   台風レイヤーの幾何計算(暴風域の円・警戒領域ポリゴンの結合など)にのみ使うため、
   台風情報がONになった時点で初めて読み込む(使わない利用者には一切通信させない)。
   ───────────────────────────────────────────────────── */
const TURF_JS = "https://cdn.jsdelivr.net/npm/@turf/turf@6.5.0/turf.min.js";


let turfLoadPromise = null;

export function loadTurf() {
  if (window.turf) return Promise.resolve(window.turf);
  if (turfLoadPromise) return turfLoadPromise;

  turfLoadPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${TURF_JS}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve(window.turf));
      return;
    }
    const script = document.createElement("script");
    script.src = TURF_JS;
    script.async = true;
    script.onload = () => resolve(window.turf);
    script.onerror = () => reject(new Error("turf.js の読み込みに失敗しました"));
    document.head.appendChild(script);
  });

  return turfLoadPromise;
}


/* ─────────────────────────────────────────────────────
   GEO DATA LOADER
   /map/world.json (GeometryCollection・国境) と
   /map/prefectures.json (FeatureCollection・都道府県) を取得し、
   ブラウザの localStorage にキャッシュする。
   ファイル構成:
     public/
     └─ map/
        ├─ world.json
        └─ prefectures.json

   注意: localStorage は容量上限が一般的に 5〜10MB 程度(ブラウザ依存)。
   world.json は比較的大きいファイルのため、容量超過時は保存に失敗することがある。
   その場合は例外を握りつぶしてキャッシュなしで動作を継続する
   (=毎回ネットワークから取得するだけで、アプリ自体は問題なく動く)。

   localStorageではなく Cache API (caches.open) を使う理由:
   - localStorageは5〜10MB程度(ブラウザ依存)しか使えず、world.jsonや
     細分区域.json(いずれも10MB超)を保存しようとすると容量超過しやすい。
   - Cache APIはResponseをそのまま保存できるため文字列化(JSON.stringify/parse)の
     コストが無く、上限もブラウザの空きディスク容量に応じて大きく取れる。
   - Service Worker無し(ページのJSから直接)でも caches.open() だけで利用できる。
   ───────────────────────────────────────────────────── */
const GEO_CACHE_VERSION = "v1";
 // データ更新時はここを上げるとキャッシュを無効化できる
const GEO_CACHE_NAME = `bosai-geo-${GEO_CACHE_VERSION}`;


// Cache APIが使えない環境(プライベートブラウジング等で無効化されている場合や
// 古いブラウザ)でも、キャッシュを諦めるだけで動作は継続できるようにする。
function isCacheApiAvailable() {
  return typeof caches !== "undefined";
}


export async function cachedFetchJSON(url) {
  if (!isCacheApiAvailable()) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} の取得に失敗しました (${res.status})`);
    return res.json();
  }

  try {
    const cache = await caches.open(GEO_CACHE_NAME);
    const cached = await cache.match(url);
    if (cached) return cached.json();

    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} の取得に失敗しました (${res.status})`);
    // レスポンスはストリームなので、キャッシュ保存用と読み取り用で複製してから使う
    await cache.put(url, res.clone());
    return res.json();
  } catch (err) {
    // QuotaExceededError などでキャッシュの読み書きに失敗した場合は、
    // キャッシュを諦めて素のfetchにフォールバックする(アプリ自体は動作を継続)。
    console.warn(`地図データのキャッシュ(Cache API)に失敗しました(${url})。`, err);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} の取得に失敗しました (${res.status})`);
    return res.json();
  }
}


let geoDataPromise = null;

export function loadGeoData() {
  if (geoDataPromise) return geoDataPromise;
  geoDataPromise = Promise.all([
    cachedFetchJSON(`${import.meta.env.BASE_URL}map/world.json`),
    cachedFetchJSON(`${import.meta.env.BASE_URL}map/prefectures.json`),
    cachedFetchJSON(`${import.meta.env.BASE_URL}map/細分区域.json`),
  ]).then(([world, prefectures, areas]) => ({ world, prefectures, areas }));
  return geoDataPromise;
}


/* ─────────────────────────────────────────────────────
   断層(faults.geojson)・プレート境界(plate-boundaries.json)データ。
   いずれも数MB規模のファイルのため、world.json等とは違いアプリ起動時には
   読み込まず、設定でトグルが最初にONにされたタイミングで遅延読み込みする
   (loadGeoDataと同様、一度取得したPromiseはキャッシュして使い回す)。
   ファイル構成:
     public/
     └─ map/
        ├─ faults.geojson
        └─ plate-boundaries.json
   ───────────────────────────────────────────────────── */
let faultsDataPromise = null;

export function loadFaultsData() {
  if (faultsDataPromise) return faultsDataPromise;
  faultsDataPromise = cachedFetchJSON(`${import.meta.env.BASE_URL}map/faults.geojson`);
  return faultsDataPromise;
}


let plateBoundariesDataPromise = null;

export function loadPlateBoundariesData() {
  if (plateBoundariesDataPromise) return plateBoundariesDataPromise;
  plateBoundariesDataPromise = cachedFetchJSON(`${import.meta.env.BASE_URL}map/plate-boundaries.json`);
  return plateBoundariesDataPromise;
}


// 震央地名(気象庁の震央地名区域)データ。緊急地震速報テスト配信で「地図をタップして
// 震源を指定」した時に、タップ地点から震源地名を自動判定するためだけに使うので、
// 断層・プレート境界と同様、実験的機能が実際に使われた時だけ遅延読み込みする。
// ファイル: public/map/ep.json
// (以前は震央地名_geo.jsonという漢字入りファイル名だったが、環境によって
//  URLエンコード周りの問題を起こしうるためep.jsonに変更した)
let epicenterNamesDataPromise = null;

export function loadEpicenterNamesData() {
  if (epicenterNamesDataPromise) return epicenterNamesDataPromise;
  epicenterNamesDataPromise = cachedFetchJSON(`${import.meta.env.BASE_URL}map/ep.json`);
  return epicenterNamesDataPromise;
}


// 津波予報区(海岸線)データ。津波情報の詳細を開いた時だけ、対象の予報区を
// 塗り分けるために遅延読み込みする(断層・プレート境界と同じ理由・同じ方式)。
// ファイル: public/map/tsunami-areas.json
let tsunamiAreasDataPromise = null;

export function loadTsunamiAreasData() {
  if (tsunamiAreasDataPromise) return tsunamiAreasDataPromise;
  tsunamiAreasDataPromise = cachedFetchJSON(`${import.meta.env.BASE_URL}map/tsunami-areas.json`);
  return tsunamiAreasDataPromise;
}
