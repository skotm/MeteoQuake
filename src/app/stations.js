import { cachedFetchJSON } from "./mapDataLoaders";
import { findAreaFeaturesByName, polygonRoughCentroid } from "./geo";
import { maxScaleToIntensityKey } from "./quakeCards";


/* ─────────────────────────────────────────────────────
   観測点マスタ (stations_with_amp_revised.json)
   気象庁 観測点コード・地点名・緯度経度のマスタデータ。
   ファイル構成:
     public/
     └─ map/
        └─ stations_with_amp_revised.json
   ───────────────────────────────────────────────────── */
let stationsPromise = null;
export function loadStations() {
  if (stationsPromise) return stationsPromise;
  stationsPromise = cachedFetchJSON(`${import.meta.env.BASE_URL}map/stations_with_amp_revised.json`);
  return stationsPromise;
}

/* ─────────────────────────────────────────────────────
   JMA2001走時表(震源推定、実験的機能)
   epicenterEstimation.tsのtravelTimeMs・computeSpTimePenaltyが使う、
   層構造を反映した理論走時テーブル。scripts/build-jma-travel-time.mjsで
   気象庁の配布データから生成する(詳細はそのスクリプトとjmaTravelTime.ts
   のコメント参照)。
   ファイル構成:
     public/
     └─ jma-travel-time.json  (無くてもアプリは動く。無い場合epicenter
                                Estimation.ts側が自動的に従来の定速モデルに
                                フォールバックする)
   ───────────────────────────────────────────────────── */
let jmaTravelTimeTablePromise = null;
export function loadJmaTravelTimeTable() {
  if (jmaTravelTimeTablePromise) return jmaTravelTimeTablePromise;
  jmaTravelTimeTablePromise = cachedFetchJSON(`${import.meta.env.BASE_URL}jma-travel-time.json`);
  return jmaTravelTimeTablePromise;
}

/* ─────────────────────────────────────────────────────
   観測点マッチング
   P2P地震情報APIの points[] (各要素は { pref, addr, scale, isArea }) を、
   観測点マスタ(stations)の地点と突き合わせて緯度経度を割り当てる。
   addr(地点名)とpref(都道府県名)の組み合わせだけが手がかりで、観測点コードが
   直接返ってこないため、以下の2段階でマッチングする(参考にした既存実装と同じ方針):
     1. 地点名が完全一致 かつ 都道府県名が一致
     2. 見つからなければ、都道府県名が一致するものの中から、
        地点名が部分一致(どちらかがどちらかを含む)するものを探す
   複数ヒットした場合は先頭の1件を採用する。
   ───────────────────────────────────────────────────── */
function matchStation(stations, point) {
  const exact = stations.find(s => s.name === point.addr && s.pref.name === point.pref);
  if (exact) return exact;

  const partial = stations.find(s =>
    s.pref.name === point.pref &&
    (s.name.includes(point.addr) || point.addr.includes(s.name) ||
     (s.city && s.city.name && point.addr.includes(s.city.name)))
  );
  return partial || null;
}

// points[]と観測点マスタを突き合わせ、地図・一覧で使える形(緯度経度+震度キー付き)に変換する。
// マスタに見つからなかった観測点は、地図には出せないが一覧には残すため latitude/longitude が null のまま返す。
// areaCodes(気象庁の細分区域コード。通常1件だが、同名区域が複数featureに分かれている場合は複数)
// も一緒に引いておき、区域単位の震度分布の塗り分けに使う。
//
// 震度速報(isArea:true)の点は、観測点マスタではなく「岩手県沿岸北部」のような
// 細分区域名そのものなので、matchStation(観測点名の突き合わせ)は使えない。
// 代わりにEEWで使っているfindAreaCodesByName(areasGeoJSON=細分区域.jsonを
// 地域名で引く)で区域コードを求め、個別のピンではなく区域の塗り分けだけで表示する
// (個々の観測点の緯度経度はそもそも震度速報には含まれないため、ピンは立てられない)。
export function resolveStationPoints(points, stations, areasGeoJSON) {
  return points.map(p => {
    if (p.isArea) {
      const features = findAreaFeaturesByName(areasGeoJSON, p.addr);
      if (features.length === 0) {
        // eslint-disable-next-line no-console
        console.warn(`[細分区域未一致] ${p.pref} ${p.addr} — 細分区域.jsonに無い地域名表記かもしれません(震度速報)`);
      }
      const areaCodes = features.map(f => f.properties?.code).filter(c => c != null);
      // 地図上にこの区域のアイコンを置くための代表点(区域ポリゴンの重心)。
      // 同じ区域名が複数のポリゴンに分かれている場合は、それぞれの重心を平均する。
      // 個々の観測点座標が無い震度速報でも、区域アイコンとして地図上に表示できるようにする。
      let latitude = null, longitude = null;
      const centroids = features.map(f => polygonRoughCentroid(f.geometry)).filter(Boolean);
      if (centroids.length > 0) {
        latitude = centroids.reduce((sum, c) => sum + c.lat, 0) / centroids.length;
        longitude = centroids.reduce((sum, c) => sum + c.lon, 0) / centroids.length;
      }
      return {
        pref: p.pref,
        addr: p.addr,
        city: null,
        intensityKey: maxScaleToIntensityKey(p.scale),
        latitude,
        longitude,
        areaCode: areaCodes[0] || null,
        areaCodes,
        isArea: true,
      };
    }

    const station = matchStation(stations, p);
    if (!station) {
      // eslint-disable-next-line no-console
      console.warn(`[観測点マスタ未一致] ${p.pref} ${p.addr} — stations_with_amp_revised.jsonに追加が必要かもしれません`);
    }
    return {
      pref: p.pref,
      addr: p.addr,
      city: station?.city?.name || null,
      intensityKey: maxScaleToIntensityKey(p.scale),
      latitude: station ? parseFloat(station.lat) : null,
      longitude: station ? parseFloat(station.lon) : null,
      areaCode: station?.area?.code || null,
      areaCodes: station?.area?.code ? [station.area.code] : [],
      isArea: false,
    };
  });
}

// 観測点(緯度経度+震度キー付き)の配列を、細分区域コードごとに集計する。
// 各区域には、その区域内の観測点で観測された「最大震度」を割り当てる
// (気象庁の震度分布図と同じ考え方: 区域内で一番揺れが大きかった地点の震度で塗る)。
// areaCodes(複数)があればそちらを使い、無ければ従来のareaCode(単数)にフォールバックする
// (buildEqdbQuakeCard等、areaCodesを持たない古い形式のresolvedPointsとの互換のため)。
export function aggregateByArea(resolvedPoints) {
  const INTENSITY_ORDER = ["0","1","2","3","4","5","5-","5u","5+","6","6-","6+","7"];
  const maxByArea = new Map(); // areaCode -> intensityKey

  for (const p of resolvedPoints) {
    const codes = (p.areaCodes && p.areaCodes.length > 0) ? p.areaCodes : (p.areaCode ? [p.areaCode] : []);
    for (const code of codes) {
      const current = maxByArea.get(code);
      if (!current || INTENSITY_ORDER.indexOf(p.intensityKey) > INTENSITY_ORDER.indexOf(current)) {
        maxByArea.set(code, p.intensityKey);
      }
    }
  }
  return maxByArea;
}
