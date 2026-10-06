import { cachedFetchJSON } from "../lib/loaders.js";
import { hasKnownHypocenter, maxScaleToIntensityKey } from "./p2p.js";
import { findAreaFeaturesByName } from "../weather/location.jsx";

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


/* ─────────────────────────────────────────────────────
   気象庁 震度データベース(eqdb) 検索API
   https://www.data.jma.go.jp/eqdb/data/shindo/
   過去の地震を期間・マグニチュード・最大震度で検索する(mode=search)、
   および1件の地震の観測点別震度を取得する(mode=event)ためのAPI。
   このAPIはP2P地震情報と違い、観測点の緯度経度(lat/lon)を直接返してくるため、
   自前の観測点マスタ(stations)との突き合わせをしなくても地図に描画できる。
   ───────────────────────────────────────────────────── */
const EQDB_API_URL = "https://www.data.jma.go.jp/eqdb/data/shindo/api/";


// 検索フォーム「最大震度」欄の選択肢。値はeqdb APIのmaxIntパラメータそのもの。
export const EQDB_MAX_INT_OPTIONS = [
  { value: "1", label: "指定なし（震度1以上）" },
  { value: "2", label: "震度2以上" },
  { value: "3", label: "震度3以上" },
  { value: "4", label: "震度4以上" },
  { value: "A", label: "震度5弱以上" },
  { value: "B", label: "震度5強以上" },
  { value: "C", label: "震度6弱以上" },
  { value: "D", label: "震度6強以上" },
  { value: "7", label: "震度7" },
];

// 検索の「震度◯以上」フィルターで比較する際に使うスケール値。
// eqdbIntensityStringToScale()は表示用に、旧震度階級(弱/強の区分が無い震度5・6)を
// 現行の5弱(45)/6弱(55)とは別のスケール値(44/54)として返すが、そのままだと
// 「5弱以上」「6弱以上」で検索した際に旧震度階級の地震がヒットしなくなってしまう。
// 実際の震度は5弱〜5強(または6弱〜6強)のいずれかだったはずなので、
// 「◯弱以上」の条件は満たすとみなして45/55に読み替える。
export function eqdbIntensityThresholdScale(raw) {
  const scale = eqdbIntensityStringToScale(raw);
  if (scale === 44) return 45;
  if (scale === 54) return 55;
  return scale;
}


export const EQDB_MAX_INT_SCALE = { "1": 10, "2": 20, "3": 30, "4": 40, "A": 45, "B": 50, "C": 55, "D": 60, "7": 70 };


// 「この震源の近傍で発生した地震」ボタンを出す条件。
// P2P地震情報(リアルタイム)側の地震であれば、震度・マグニチュードに関わらず表示する。
// ただし震源がまだ判明していない段階(震度速報「震源調査中」・稀な「震源地不明」)は、
// 検索条件になる震源地名そのものが無いため、気象庁震度データベースを検索しても
// 一致するはずがない(=ボタンを出しても必ず0件になる)。そのため震源が判明してから
// (震源に関する情報 or 確定報が届いてから)だけボタンを表示するようにする。
export function shouldShowNearbyQuakeButton(quake) {
  return !!quake && !quake.isEqdb && hasKnownHypocenter(quake);
}


export const EQDB_SORT_OPTIONS = [
  { value: "S0", label: "新しい順" },
  { value: "S1", label: "古い順" },
  { value: "S2", label: "最大震度の大きい順" },
  { value: "S3", label: "地震の規模の大きい順" },
];


// 震源地名プルダウンの初期値(ep.jsonの読み込みが終わるまでの間)。
export const EQDB_EPICENTER_NAME_OPTIONS_DEFAULT = [{ value: "", label: "指定なし" }];


// 最小マグニチュードの選択肢("1.0"〜"9.9")
export const EQDB_MIN_MAG_OPTIONS = [
  { value: "0.0", label: "指定なし" },
  ...Array.from({ length: 90 }, (_, i) => {
    const v = ((i + 10) / 10).toFixed(1);
    return { value: v, label: `M${v}以上` };
  }),
];


// "震度５弱"/"５弱"/"震度７"/"5弱(推定)" のような文字列(全角数字・「震度」接頭辞・
// 前後の余分な文字の有無を問わない)を、10刻みのJMAスケール
// (10=震度1 ... 70=震度7、47=旧震度5、57=旧震度6)に変換する。
// 完全一致ではなく部分一致で判定しているのは、eqdb側が返す文字列に
// "(推定)"などの注記が付くことがあり、完全一致だと本来有効な観測点まで
// 判定漏れして震度の塗りつぶしから抜け落ちてしまうことがあったため。
export function eqdbIntensityStringToScale(raw) {
  if (!raw) return 0;
  const str = raw
    .replace(/震度/g, "")
    .replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  if (str.includes("7")) return 70;
  // 1996年10月の震度階級改定より前は「弱」「強」の区分が無く、単に「震度6」
  // 「震度5」とだけ記録されている(旧震度階級)。これらは現在の「5弱」「6弱」とは
  // 区別して、そのまま「5」「6」として表示したいので、専用のスケール値(44/54)を
  // 割り当てる(45=5弱, 55=6弱と衝突しないようにするため)。
  if (str.includes("6")) return str.includes("強") ? 60 : str.includes("弱") ? 55 : 54;
  if (str.includes("5")) return str.includes("強") ? 50 : str.includes("弱") ? 45 : 44;
  if (str.includes("4")) return 40;
  if (str.includes("3")) return 30;
  if (str.includes("2")) return 20;
  if (str.includes("1")) return 10;
  return 0;
}


// eqdbのid(dbid)は "YYYYMMDDHHMMSS..." 形式の発生時刻エンコード文字列。
// アプリ内の他の地震カードと表示を揃えるため "YYYY/MM/DD HH:MM:SS" に変換する。
export function eqdbIdToTimeDisplay(id) {
  if (!id || id.length < 14) return "";
  return `${id.slice(0,4)}/${id.slice(4,6)}/${id.slice(6,8)} ${id.slice(8,10)}:${id.slice(10,12)}:${id.slice(12,14)}`;
}


// mode=search: 期間・M・最大震度・(任意で)震央地名で地震を検索する。
// 観測点別の詳細は含まない一覧のみを返す。
// epi: 震央地名(例:"神奈川県西部")をそのまま渡すと、サーバー側でその震央地名に
// 完全一致する地震だけに絞り込んで返してくれる(実際のeqdb検索フォームの挙動と同じ)。
// 指定が無い場合は"99"(絞り込みなし)を使う。
export async function fetchEqdbSearch({ startDate, endDate, startTime = "00:00", endTime = "23:59", minMag, maxInt, sort, epi }) {
  const epiValue = epi || "99";
  const isFiltered = minMag > 0 || maxInt !== "1" || epiValue !== "99";
  const fd = new FormData();
  fd.append("mode", "search");
  fd.append("dateTimeF[]", startDate); fd.append("dateTimeF[]", startTime);
  fd.append("dateTimeT[]", endDate);   fd.append("dateTimeT[]", endTime);
  fd.append("mag[]", minMag.toFixed(1)); fd.append("mag[]", "9.9");
  fd.append("dep[]", "000"); fd.append("dep[]", "999");
  fd.append("epi[]", epiValue); fd.append("pref[]", "99"); fd.append("city[]", "99"); fd.append("station[]", "99");
  fd.append("obsInt", "1");
  fd.append("maxInt", maxInt);
  fd.append("additionalC", isFiltered ? "true" : "false");
  fd.append("Sort", sort);
  fd.append("Comp", "C0");
  fd.append("seisCount", "false");
  fd.append("observed", "false");
  fd.append("strParam", "[object Object]");

  const res = await fetch(EQDB_API_URL, { method: "POST", body: fd });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const list = Array.isArray(data.res) ? data.res : [];
  const strMsgs = Array.isArray(data.str) ? data.str : [];
  const errMsg = strMsgs.find(s => s.includes("ありません") || s.includes("エラー") || s.includes("見直し"));
  return { list, errMsg, summary: strMsgs[1] || "" };
}


// mode=event: 1件の地震について、観測点ごとの震度(int[], lat/lon付き)を含む詳細を取得する。
async function fetchEqdbEvent(id) {
  const fd = new FormData();
  fd.append("mode", "event");
  fd.append("id", id);
  const res = await fetch(EQDB_API_URL, { method: "POST", body: fd });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.res && Array.isArray(data.res.hyp) && data.res.hyp.length > 0) return data.res;
  return null;
}


/* ─────────────────────────────────────────────────────
   震央分布(地図上の丸)用: 気象庁 震度データベース(eqdb)の座標プリフェッチ。
   eqdbの一覧検索(mode=search、近傍地震検索・データベース検索で使用)は
   震央の緯度経度を返さない。座標が分かるのは1件ごとの詳細(mode=event)
   だけなので、一覧が決まったらバックグラウンドで少しずつ詳細を取得し、
   震央分布に反映していく。
   取得済みの詳細はモジュールスコープのキャッシュ(id→detail)に載せておき、
   一覧をタップして選択する時にも同じデータをそのまま使い回せるようにする
   (二重に同じ地震を取得しないため)。
   ───────────────────────────────────────────────────── */
export const eqdbEventDetailCache = new Map();


export async function fetchEqdbEventCached(id) {
  if (eqdbEventDetailCache.has(id)) return eqdbEventDetailCache.get(id);
  const detail = await fetchEqdbEvent(id);
  if (detail) eqdbEventDetailCache.set(id, detail);
  return detail;
}


// eqdbのmode=event詳細(+検索一覧の元データ)から、震央分布1点分の情報を作る。
// 選択(タップ)時にそのままbuildEqdbQuakeCardへ渡せるよう、元データも持たせておく。
export function eqdbDetailToEpicenterPoint(detail, listItem) {
  if (!detail || !Array.isArray(detail.hyp) || !detail.hyp[0]) return null;
  const hyp = detail.hyp[0];
  const lat = parseFloat(hyp.lat), lon = parseFloat(hyp.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const scale = eqdbIntensityStringToScale(hyp.maxI || "");
  const mag = parseFloat(hyp.mag);
  const depMatch = (hyp.dep || "").match(/\d+/);
  return {
    id: `eqdb_${listItem?.id || hyp.name}`,
    latitude: lat,
    longitude: lon,
    magnitude: Number.isFinite(mag) && mag > 0 ? mag : null,
    maxIntensityKey: scale > 0 ? maxScaleToIntensityKey(scale) : "?",
    time: eqdbIdToTimeDisplay(listItem?.id) || (listItem?.ot || ""),
    depth: depMatch ? parseInt(depMatch[0], 10) : null,
    place: hyp.name || listItem?.name || "震源地不明",
    _eqdbListItem: listItem,
    _eqdbDetail: detail,
  };
}


// 近傍地震検索・データベース検索の結果一覧(rawList、座標を持たない生のeqdb一覧項目)
// から、震央分布用の点をバックグラウンドで少しずつ解決していくフック。
// 同時に取得するのは3件までにして、APIへの負荷と表示までの速さのバランスを取る。
// キャッシュ済みの分は即座に反映され、未取得の分は取得でき次第、順次追加されていく。
// 震央分布の設定がOFFの時、useEqdbEpicenterPointsに毎回新しい[]を渡すと
// (依存配列の参照比較で)無駄にeffectが再実行されてしまうため、固定の空配列を使う。
export const EMPTY_EQDB_LIST = [];


/* ─────────────────────────────────────────────────────
   潮位計(津波タブ「潮位計」モード)
   気象庁 統合地図ページ(map.html#contents=tidelevel)が使っている非公式JSON API。
   ・観測点一覧(静的、めったに変わらない): tide_area.json
   ・観測値(1地点1日1ファイル、15秒間隔): tide_obs_{YYYYMMDD}_{地点コード}.json
   ───────────────────────────────────────────────────── */
export const TIDE_AREA_URL = "https://www.jma.go.jp/bosai/tidelevel/const/tide_area.json";


export function tideObsUrl(dateStr, stationCode) {
  return `https://www.jma.go.jp/bosai/tidelevel/data/tide/tide_obs_${dateStr}_${stationCode}.json`;
}


// Dateオブジェクトを、tide_obsのURLで使うYYYYMMDD形式(JST基準)に変換する。
export function toTideDateStr(d) {
  const pad2 = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
}


// tide_area.json(地域コード→潮位区→地点、の階層構造)を、地図にピンを立てやすい
// フラットな地点一覧に展開する。

// 2点間の距離の2乗(km²相当)を求める、比較専用の簡易距離関数。
// 経度方向は緯度に応じてcos補正する(日本付近ではこれで十分な精度)。
export function fastDist2(lat1, lon1, lat2, lon2) {
  const latScale = 111; // 緯度1度あたりのおおよそのkm数
  const lonScale = 111 * Math.cos((lat1 * Math.PI) / 180); // この緯度での経度1度あたりのkm数
  const dLat = (lat1 - lat2) * latScale;
  const dLon = (lon1 - lon2) * lonScale;
  return dLat * dLat + dLon * dLon;
}


// ポリゴン(Polygon/MultiPolygon)の外周リング頂点の単純平均から、地域の代表点(概算の中心)を
// 求める。面積で重み付けした厳密な重心ではないが、震源からの距離を見積もる用途には十分な精度。
// MultiPolygonは頂点数が最も多い(=主要な陸地側とみなせる)外周リングを代表に使う。
export function polygonRoughCentroid(geometry) {
  if (!geometry) return null;
  let ring = null;
  if (geometry.type === "Polygon") {
    ring = geometry.coordinates?.[0];
  } else if (geometry.type === "MultiPolygon") {
    let bestLen = -1;
    for (const poly of geometry.coordinates || []) {
      const r = poly?.[0];
      if (r && r.length > bestLen) { bestLen = r.length; ring = r; }
    }
  }
  if (!ring || ring.length === 0) return null;
  let sumLat = 0, sumLon = 0;
  for (const pt of ring) { sumLon += pt[0]; sumLat += pt[1]; }
  return { lat: sumLat / ring.length, lon: sumLon / ring.length };
}
