


// 2地点間の距離(km)。震源推定と地震検知テストの「正解」震源との誤差表示、
// および震源推定マーカーの円描画で使う共通ヘルパー。
export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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

// 潮位観測点(1点)から一番近い津波予報区を、tsunami-areas.json(海岸線の座標データ、
// 都道府県名などのあいまいな情報に頼らず地図描画に実際使っている正式なデータ)との
// 距離計算で求める。各予報区のMultiLineStringの頂点との最短距離で近似している
// (頂点間隔は密なため、線分内挿までは行わずとも十分な精度が出る)。
export function findNearestTsunamiArea(lat, lon, tsunamiAreasGeoJSON) {
  if (lat == null || lon == null || !tsunamiAreasGeoJSON || !Array.isArray(tsunamiAreasGeoJSON.features)) return null;
  let best = null;
  let bestDist2 = Infinity;
  for (const feature of tsunamiAreasGeoJSON.features) {
    const multiLine = feature.geometry?.coordinates;
    if (!Array.isArray(multiLine)) continue;
    for (const line of multiLine) {
      for (const pt of line) {
        const d2 = fastDist2(lat, lon, pt[1], pt[0]);
        if (d2 < bestDist2) {
          bestDist2 = d2;
          best = feature.properties;
        }
      }
    }
  }
  return best; // { code, name } | null
}

// findNearestTsunamiAreaと同じ距離計算だが、地図タップでの予報区選択用に
// 「どれだけ近かったか(km)」も一緒に返す。海上の何もない場所や地図の範囲外を
// 誤ってタップした場合に、呼び出し側で距離が遠すぎる結果を弾けるようにするため。
export function findNearestTsunamiAreaWithDistance(lat, lon, tsunamiAreasGeoJSON) {
  if (lat == null || lon == null || !tsunamiAreasGeoJSON || !Array.isArray(tsunamiAreasGeoJSON.features)) return null;
  let best = null;
  let bestDist2 = Infinity;
  for (const feature of tsunamiAreasGeoJSON.features) {
    const multiLine = feature.geometry?.coordinates;
    if (!Array.isArray(multiLine)) continue;
    for (const line of multiLine) {
      for (const pt of line) {
        const d2 = fastDist2(lat, lon, pt[1], pt[0]);
        if (d2 < bestDist2) {
          bestDist2 = d2;
          best = feature.properties;
        }
      }
    }
  }
  if (!best) return null;
  return { ...best, distanceKm: Math.sqrt(bestDist2) }; // { code, name, distanceKm } | null
}

// 点(lat,lon)が、GeoJSONのリング(座標配列 [[lon,lat], ...])の内側にあるかどうかを
// レイキャスティング法で判定する。
function isPointInRing(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// 点(lat,lon)が、Polygon/MultiPolygonジオメトリの内側(穴を除く)にあるかどうかを判定する。
function isPointInPolygonGeometry(lat, lon, geometry) {
  if (!geometry) return false;
  const testRings = (rings) => {
    if (!rings.length || !isPointInRing(lat, lon, rings[0])) return false;
    for (let k = 1; k < rings.length; k++) {
      if (isPointInRing(lat, lon, rings[k])) return false; // 穴の内側
    }
    return true;
  };
  if (geometry.type === "Polygon") return testRings(geometry.coordinates);
  if (geometry.type === "MultiPolygon") return geometry.coordinates.some(testRings);
  return false;
}

// 細分区域(areasGeoJSON=細分区域.json)のポリゴンを実際に走査し、点(lat,lon)を
// 含む区域のcode(properties.code)を返す。名前によるあいまい照合と違い、
// 区域境界そのものに基づく判定なので、表記揺れや同名地点による誤判定が起きない。
function findAreaCodeByPoint(areasGeoJSON, lat, lon) {
  if (!areasGeoJSON || !Array.isArray(areasGeoJSON.features) || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  for (const feature of areasGeoJSON.features) {
    if (isPointInPolygonGeometry(lat, lon, feature.geometry)) {
      return feature.properties?.code ?? null;
    }
  }
  return null;
}

// 緊急地震速報のareas[].name(例:「神奈川県東部」「東京都２３区」)から、
// 細分区域.json(areasGeoJSON)側で同じ名前を持つfeatureのcode一覧を返す。
// EEWの地域名は気象庁の細分区域名と表記が一致することが多いため、まず完全一致を
// 試し、見つからなければ全角数字→半角などのゆらぎを吸収して再試行する。
// 該当が無ければ(=地図側に該当ポリゴンが見つからなければ)空配列を返し、
// その地域の塗りつぶしはあきらめる(誤った区域を塗るよりは安全)。
function normalizeAreaNameForMatch(name) {
  if (!name) return "";
  // 全角数字を半角に変換してから比較する(「２３区」→「23区」)
  return name.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).trim();
}
// 細分区域.jsonのfeatureを地域名で探す(完全一致優先、無ければ表記ゆれを吸収した
// あいまい一致)。同名の区域が複数のポリゴンに分かれていることがあるため、
// 該当するfeatureをすべて返す。
export function findAreaFeaturesByName(areasGeoJSON, name) {
  if (!areasGeoJSON || !Array.isArray(areasGeoJSON.features) || !name) return [];
  const exact = areasGeoJSON.features.filter(f => f.properties?.name === name);
  if (exact.length > 0) return exact;
  const normalizedTarget = normalizeAreaNameForMatch(name);
  return areasGeoJSON.features.filter(f => normalizeAreaNameForMatch(f.properties?.name) === normalizedTarget);
}

export function findAreaCodesByName(areasGeoJSON, name) {
  return findAreaFeaturesByName(areasGeoJSON, name).map(f => f.properties?.code).filter(c => c != null);
}

// ep.json(気象庁の震央地名区域)のポリゴンを走査し、点(lat,lon)を
// 含む区域の名前(properties.name)を返す。緊急地震速報テスト配信で「地図をタップ
// して震源を指定」した時、タップ地点から震源地名を自動判定するのに使う。
// 該当する区域が無い(海洋の詳細区分に含まれない・データ範囲外など)場合はnull。
export function findEpicenterNameByPoint(epicenterNamesGeoJSON, lat, lon) {
  if (!epicenterNamesGeoJSON || !Array.isArray(epicenterNamesGeoJSON.features) || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  for (const feature of epicenterNamesGeoJSON.features) {
    if (isPointInPolygonGeometry(lat, lon, feature.geometry)) {
      return feature.properties?.name ?? null;
    }
  }
  return null;
}

// 都道府県 → 地方(8地方区分+北海道・沖縄)。揺れ検知カードの場所表示で、
// 震央地名の区域・都道府県で1つに絞れない時に、地方名まで広げるために使う。
const REGION_OF_PREFECTURE = {
  "北海道": "北海道地方",
  "青森県": "東北地方", "岩手県": "東北地方", "宮城県": "東北地方", "秋田県": "東北地方", "山形県": "東北地方", "福島県": "東北地方",
  "茨城県": "関東地方", "栃木県": "関東地方", "群馬県": "関東地方", "埼玉県": "関東地方", "千葉県": "関東地方", "東京都": "関東地方", "神奈川県": "関東地方",
  "新潟県": "中部地方", "富山県": "中部地方", "石川県": "中部地方", "福井県": "中部地方", "山梨県": "中部地方", "長野県": "中部地方", "岐阜県": "中部地方", "静岡県": "中部地方", "愛知県": "中部地方",
  "三重県": "近畿地方", "滋賀県": "近畿地方", "京都府": "近畿地方", "大阪府": "近畿地方", "兵庫県": "近畿地方", "奈良県": "近畿地方", "和歌山県": "近畿地方",
  "鳥取県": "中国地方", "島根県": "中国地方", "岡山県": "中国地方", "広島県": "中国地方", "山口県": "中国地方",
  "徳島県": "四国地方", "香川県": "四国地方", "愛媛県": "四国地方", "高知県": "四国地方",
  "福岡県": "九州地方", "佐賀県": "九州地方", "長崎県": "九州地方", "熊本県": "九州地方", "大分県": "九州地方", "宮崎県": "九州地方", "鹿児島県": "九州地方",
  "沖縄県": "沖縄地方",
};

// 点が、都道府県ポリゴン(prefectures.json、properties.name=都道府県名)のどれに含まれるかを返す。
// どれにも含まれない(簡略化された海岸線の外にある観測点など)場合はnull。
const prefectureBBoxCache = new WeakMap();
function featureBBox(feature) {
  let bb = prefectureBBoxCache.get(feature);
  if (bb) return bb;
  bb = [Infinity, Infinity, -Infinity, -Infinity]; // minLon, minLat, maxLon, maxLat
  const visit = (c) => { if (typeof c[0] === "number") { if (c[0] < bb[0]) bb[0] = c[0]; if (c[1] < bb[1]) bb[1] = c[1]; if (c[0] > bb[2]) bb[2] = c[0]; if (c[1] > bb[3]) bb[3] = c[1]; } else c.forEach(visit); };
  visit(feature.geometry?.coordinates || []);
  prefectureBBoxCache.set(feature, bb);
  return bb;
}
export function findPrefectureNameByPoint(prefecturesGeoJSON, lat, lon) {
  if (!prefecturesGeoJSON || !Array.isArray(prefecturesGeoJSON.features) || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  for (const feature of prefecturesGeoJSON.features) {
    const bb = featureBBox(feature);
    if (lon < bb[0] || lon > bb[2] || lat < bb[1] || lat > bb[3]) continue;
    if (isPointInPolygonGeometry(lat, lon, feature.geometry)) return feature.properties?.name ?? null;
  }
  return null;
}

// 震央地名(ep.json)の区域名から、都道府県名を推定する(観測点が都道府県ポリゴンの外に
// ある時の予備)。「岩手県沖」「千葉県北東部」のように都道府県名で始まるものと、
// 北海道の「釧路地方北部」のような地方名で始まるものに対応する。海域名(三陸沖など)はnull。
const HOKKAIDO_SUBPREFECTURE_RE = /^(石狩|渡島|檜山|後志|空知|上川|留萌|宗谷|網走|北見|紋別|胆振|日高|十勝|釧路|根室)地方/;
const PREFECTURE_PREFIX_RE = /^(北海道|東京都|大阪府|京都府|[^\s都道府県]{2,3}県)/;
function prefectureFromRegionName(regionName) {
  if (!regionName) return null;
  const m = PREFECTURE_PREFIX_RE.exec(regionName);
  if (m && REGION_OF_PREFECTURE[m[1]]) return m[1];
  if (HOKKAIDO_SUBPREFECTURE_RE.test(regionName)) return "北海道";
  return null;
}

// 地方名を北から南へ並べる順(複数の地方にまたがる時の表示順)。
const AREA_ORDER = ["北海道地方", "東北地方", "関東地方", "中部地方", "近畿地方", "中国地方", "四国地方", "九州地方", "沖縄地方"];
// 複数の地方にまたがる時、地方名をいくつまで並べて書くか。これより多い時は「広い範囲」。
const MAX_AREAS_LISTED = 3;
// 検知した観測点の数のうち、これ未満の割合しかない地方は、飛び地の1〜2点とみなして数えない。
const MIN_AREA_SHARE = 0.05;

// 揺れ検知イベントの観測点群(points: {id, lat, lon}[])の場所を表す名前を返す。
// 震央地名の区域 → 都道府県 → 地方名の順に、少しずつ広げながら「ただ1つ」に絞れる最初の粒度
// ({ name, level: "region" | "prefecture" | "area" })。地方でも1つに絞れない時は、
// またがる地方名を北から並べる({ name: "東北・関東地方", level: "areas" })。またがる地方が
// MAX_AREAS_LISTEDより多い時は { name: "広い範囲", level: "wide" }。
// 判定できる観測点が1つも無い時だけnull。
// 各粒度で、その粒度の名前を判定できない観測点(区域外など)は無視する。地方の粒度では、
// 観測点数の5%未満しかない地方は飛び地とみなして数えない。
// geo = { epicenterNames: ep.json, prefectures: prefectures.json }(どちらもnull可)。
// cache(観測点ID→{region, prefecture, area})を渡すと、同じ観測点のポリゴン走査を
// 繰り返さない(データは変わらないので、観測点IDごとの結果は使い回せる)。
export function findSingleEpicenterPlace(geo, points, cache = new Map()) {
  if (!geo || !Array.isArray(points) || points.length === 0) return null;
  const infos = [];
  for (const p of points) {
    let info = cache.get(p.id);
    if (!info) {
      const region = geo.epicenterNames ? findEpicenterNameByPoint(geo.epicenterNames, p.lat, p.lon) : null;
      const prefecture = findPrefectureNameByPoint(geo.prefectures, p.lat, p.lon) ?? prefectureFromRegionName(region);
      info = { region, prefecture, area: prefecture ? (REGION_OF_PREFECTURE[prefecture] ?? null) : null };
      cache.set(p.id, info);
    }
    infos.push(info);
  }
  for (const [level, key] of [["region", "region"], ["prefecture", "prefecture"]]) {
    const names = new Set();
    for (const info of infos) if (info[key]) names.add(info[key]);
    if (names.size === 1) return { name: [...names][0], level };
  }
  // 地方の粒度。数の少ない飛び地は除いて数える。
  const counts = new Map();
  let known = 0;
  for (const info of infos) if (info.area) { counts.set(info.area, (counts.get(info.area) ?? 0) + 1); known++; }
  if (known === 0) return null;
  const minCount = Math.max(1, Math.ceil(known * MIN_AREA_SHARE));
  const areas = [...counts].filter(([, n]) => n >= minCount).map(([a]) => a)
    .sort((x, y) => AREA_ORDER.indexOf(x) - AREA_ORDER.indexOf(y));
  if (areas.length === 1) return { name: areas[0], level: "area" };
  if (areas.length > MAX_AREAS_LISTED) return { name: "広い範囲", level: "wide" };
  // 「東北地方」「関東地方」→「東北・関東地方」
  return { name: areas.map(a => a.replace(/地方$/, "")).join("・") + "地方", level: "areas" };
}

// 観測点マスタ(stations)から、eqdbの観測点名(name)に対応する地点を探し、
// 区域コード(area.code)を補完する。
// eqdbは観測点の緯度経度(lat/lon)を直接返してくるため、まずareasGeoJSON(細分区域の
// ポリゴン)に対する点-in-多角形判定で区域を確定させる。これは区域境界そのものに
// 基づく判定なので、観測点名の表記揺れや同名地点があっても誤判定しない。
// (以前は観測点マスタとの名前照合だけで区域を推定しており、名前が一致しない/
//  複数の地点に一致してしまうケースで「区域が塗られない」「違う区域の色が塗られる」
//  ことがあった。)
// areasGeoJSONが無い、または該当ポリゴンが見つからない場合のみ、次点として
// 観測点マスタとの名前照合(ベストエフォート)にフォールバックする:
//   1. 地点名が完全一致
//   2. 見つからなければ、地点名が部分一致(どちらかがどちらかを含む)するもの
//   3. それでも見つからなければ、緯度経度が最も近い観測点を採用する
//      (ただしあまりに離れた地点を誤って採用しないよう、約0.05度以内という上限を設ける)
// 観測点マスタ(stations)から、eqdbの観測点名(name)に最も一致する地点を探す。
// findAreaCodeByStationNameと同じマッチング方針(名前の完全一致→部分一致→
// 緯度経度が最も近い地点、の順)を使うが、区域コードだけでなく都道府県名・
// 市区町村名も一緒に取り出したいため、マッチング処理そのものを共通化している。
//
// 【重要】eqdbの観測点名(例: "苫前町旭＊")は市区町村名から始まり、都道府県名は
// 含まれない(気象庁 震度データベースAPIの実際のレスポンスで確認済み)。
// そのため都道府県は文字列解析では判別できず、緯度経度・地点名を観測点マスタと
// 突き合わせて、マスタ側が持つpref.name(都道府県名)を借りてくる必要がある。
function findBestStationMatch(stations, name, lat, lon) {
  if (!stations || stations.length === 0) return null;

  let candidates = name ? stations.filter(s => s.name === name) : [];

  if (candidates.length === 0 && name) {
    candidates = stations.filter(s =>
      s.name.includes(name) || name.includes(s.name) ||
      (s.city && s.city.name && name.includes(s.city.name))
    );
  }

  let fellBackToAll = false;
  if (candidates.length === 0) {
    if (lat == null || lon == null) return null;
    candidates = stations;
    fellBackToAll = true;
  }

  if (candidates.length === 1) return candidates[0];
  if (lat == null || lon == null) return candidates[0] || null;

  let best = null, bestDist = Infinity;
  for (const c of candidates) {
    const cLat = parseFloat(c.lat), cLon = parseFloat(c.lon);
    if (!Number.isFinite(cLat) || !Number.isFinite(cLon)) continue;
    const dLat = cLat - lat, dLon = cLon - lon;
    const dist = dLat * dLat + dLon * dLon;
    if (dist < bestDist) { bestDist = dist; best = c; }
  }
  if (!best) return null;
  if (fellBackToAll) {
    const cLat = parseFloat(best.lat), cLon = parseFloat(best.lon);
    if (Math.abs(cLat - lat) > 0.05 || Math.abs(cLon - lon) > 0.05) return null;
  }
  return best;
}

export function findAreaCodeByStationName(stations, name, lat, lon, areasGeoJSON) {
  const byPoint = findAreaCodeByPoint(areasGeoJSON, lat, lon);
  if (byPoint) return byPoint;

  const match = findBestStationMatch(stations, name, lat, lon);
  return match?.area?.code || null;
}

// eqdbの観測点名(name)・緯度経度から、観測点マスタ上の都道府県名・市区町村名を
// 借りてくる。マッチした市区町村名がnameの先頭に含まれていれば、見出しと
// 二重表示にならないようそこを取り除いた残りをaddrとして一緒に返す
// (例: マスタ側city.name="苫前町"、name="苫前町旭＊" → addr="旭＊")。
// マッチしなかった場合はpref/cityともnullとし、addrは元のnameのまま返す。
export function resolvePrefCityForEqdbPoint(stations, name, lat, lon) {
  const match = findBestStationMatch(stations, name, lat, lon);
  const pref = match?.pref?.name || null;
  const city = match?.city?.name || null;
  let addr = name;
  if (city && name && name.startsWith(city)) {
    const rest = name.slice(city.length);
    if (rest) addr = rest;
  }
  return { pref, city, addr };
}
