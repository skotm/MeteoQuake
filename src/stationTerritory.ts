/**
 * stationTerritory.ts
 * ------------------------------------------------------------
 * 観測点マスタ(全観測点の緯度経度)から、気象庁の「テリトリー法」に
 * ならった観測点の事前分類(内部点・外部点・孤立点)を行う。
 *
 * 参考: 気象庁地震火山部「緊急地震速報の概要や処理手法に関する技術的
 * 参考資料」のテリトリー法における観測点の分類。
 *
 * 【分類の考え方】
 * 観測点群のボロノイ分割(各観測点に最も近い領域=テリトリー)を作ると、
 * 各観測点のテリトリーは「有限な多角形(閉じている)」か「無限に広がる
 * 領域(外側に開いている)」のどちらかになる。この「テリトリーが外に
 * 開いているかどうか」は、観測点群の凸包(convex hull)の頂点かどうかと
 * 完全に一致する(計算幾何学のよく知られた定理: 点集合のボロノイ図で
 * テリトリーが非有界になるのは、その点が凸包上にある場合に限る)。
 * そのため、実際にボロノイ図そのものを構築しなくても、より軽い凸包の
 * 計算だけで「内部点/外部点」の判定ができる。
 *
 *   - 内部点(interior): 凸包の内側にある観測点。全方位を他の観測点に
 *     囲まれており、震源決定において「片側に観測点が無い」ことによる
 *     方位角ギャップの問題が起きにくい。
 *   - 外部点(exterior): 凸包の頂点になっている観測点。テリトリーが
 *     外側に開いている=その先(海側など)には他の観測点によるチェックが
 *     及ばない方向がある、という手がかりになる。
 *   - 孤立点(isolated): 外部点のうち、最も近い他の観測点までの距離が
 *     著しく大きいもの(離島の観測点など)。気象庁のテリトリー法でも
 *     1〜2点処理の特別扱いの対象になる。
 *
 * 【想定する使い道(この時点では未着手)】
 * epicenterEstimation.tsの検知点群に対し、検知した外部点・孤立点が
 * どの方位にあるか(outwardBearingDeg)を突き合わせることで、「検知点が
 * 観測網の外側(海側等)に偏っているかどうか」を、都度ボロノイ計算を
 * やり直すことなく安価に判定できるようにする。震源が海域にある地震で、
 * 観測点が片側にしか無いことによる沖方向の距離の不定性への対処(方位角
 * ギャップ補正)の土台として使う想定。ここではその判定・補正自体は行わず、
 * 分類結果を提供するところまでを実装する。
 *
 * 【計算コストについて】
 * 観測点マスタ全体(数千点規模)に対して行うが、実行はアプリ起動時に
 * 一度だけでよい(観測点マスタは動的に変化しないため)。凸包の計算は
 * O(n log n)。孤立点判定(凸包頂点ごとに全観測点との最近傍距離を調べる)
 * は「凸包の頂点数(通常は全体よりずっと少ない、日本全国規模でも数百点
 * 程度)×全観測点数」のオーダーで、これも起動時の一度きりの計算として
 * 現実的な範囲に収まる。
 */

export type StationTerritoryType = "interior" | "exterior" | "isolated";

export interface StationTerritory {
  type: StationTerritoryType;
  // 外部点・孤立点についてのみ設定。凸包頂点の重心から見て、その観測点が
  // ある方向(度、真北0度・時計回り)。「この観測点から見て、観測網の
  // 外側はおおよそこの方角」という粗い目安として使う。
  outwardBearingDeg: number | null;
}

// 孤立点とみなす、最も近い他の観測点までの距離のしきい値(km)。実際の
// 観測点マスタ(密度)を見ながらの要調整の暫定値。
const ISOLATED_STATION_MIN_NEIGHBOR_KM = 100;

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// 2点間の方位角(真北0度、時計回り、度)
function bearingDeg(lat1, lon1, lat2, lon2) {
  const phi1 = lat1 * Math.PI / 180, phi2 = lat2 * Math.PI / 180;
  const deltaLambda = (lon2 - lon1) * Math.PI / 180;
  const y = Math.sin(deltaLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);
  const theta = Math.atan2(y, x);
  return (theta * 180 / Math.PI + 360) % 360;
}

// 緯度経度を、凸包計算用の平面座標(x, y、単位はおおよそkm)に変換する。
// 凸包の「内側/外側」判定は多少の歪みに対してロバストなため、正確な地図
// 投影ではなく、緯度の余弦で経度方向を補正する簡易的な等距円筒図法もどき
// で十分(=既存のcalcPeakIntensity等と同じ、実用上割り切った簡略化)。
function toPlaneXY(lat, lon, meanLatRad) {
  const R = 6371;
  const x = (lon * Math.PI / 180) * Math.cos(meanLatRad) * R;
  const y = (lat * Math.PI / 180) * R;
  return [x, y];
}

// Andrewのmonotone chain法による凸包。pointsは{ x, y, ref }の配列で、
// refに元のオブジェクト(観測点)を持たせておく。戻り値は凸包を構成する
// 点(ref)の配列。
function convexHull(points) {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length <= 2) return pts.map(p => p.ref);

  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }

  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }

  lower.pop();
  upper.pop();
  return [...lower, ...upper].map(p => p.ref);
}

/**
 * 観測点マスタ(配列、各要素は最低限 { id, lat, lon } を持つ)から、
 * 観測点id→StationTerritoryのMapを計算する。
 */
export function computeStationTerritories(stations) {
  const result = new Map();
  if (!stations || stations.length === 0) return result;

  // デフォルトは全点「内部点」。凸包の頂点だけを後で上書きする。
  for (const s of stations) {
    result.set(s.id, { type: "interior", outwardBearingDeg: null });
  }
  if (stations.length < 3) {
    // 3点未満は凸包(面積を持つ多角形)を作れないため、全点を外部点扱いにする。
    for (const s of stations) result.set(s.id, { type: "exterior", outwardBearingDeg: null });
    return result;
  }

  const meanLatRad = (stations.reduce((sum, s) => sum + s.lat, 0) / stations.length) * Math.PI / 180;
  const planePoints = stations.map(s => {
    const [x, y] = toPlaneXY(s.lat, s.lon, meanLatRad);
    return { x, y, ref: s };
  });
  const hull = convexHull(planePoints);
  if (hull.length === 0) return result;

  // outwardBearingDeg算出の基準点(凸包頂点の単純平均という簡易的な代表点)。
  const centroidLat = hull.reduce((sum, s) => sum + s.lat, 0) / hull.length;
  const centroidLon = hull.reduce((sum, s) => sum + s.lon, 0) / hull.length;

  for (const s of hull) {
    // 孤立点判定: 全観測点の中から(自分以外で)最も近い点までの距離。
    // 凸包頂点は通常、全体からみればごく少数(日本全国規模でも数百点
    // 程度)のため、ここだけ全観測点との総当たりを行っても起動時の
    // 一度きりの計算としては現実的なコストに収まる。
    let nearestKm = Infinity;
    for (const other of stations) {
      if (other.id === s.id) continue;
      const d = haversineKm(s.lat, s.lon, other.lat, other.lon);
      if (d < nearestKm) nearestKm = d;
    }
    const type = nearestKm >= ISOLATED_STATION_MIN_NEIGHBOR_KM ? "isolated" : "exterior";
    const outwardBearingDeg = bearingDeg(centroidLat, centroidLon, s.lat, s.lon);
    result.set(s.id, { type, outwardBearingDeg });
  }

  return result;
}

// 観測点マスタ(配列の参照)ごとに計算結果をメモ化する。観測点マスタは
// 起動時に一度取得したら変わらない(App.jsx側でstationsPromiseとして
// キャッシュされている)前提のため、同じ配列参照であれば再計算しない。
let cachedStations = null;
let cachedTerritories = null;
export function getStationTerritories(stations) {
  if (stations !== cachedStations) {
    cachedTerritories = computeStationTerritories(stations);
    cachedStations = stations;
  }
  return cachedTerritories;
}
