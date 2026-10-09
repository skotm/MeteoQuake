import { loadTurf } from "../lib/loaders.js";
import { NOWCAST_COLOR_SCHEMES, WDIST_MODE_CONFIG, nowcastTileUrl, precipTileUrl, remapImageDataColors, wdistTileUrl } from "./nowcast.js";

/* ─────────────────────────────────────────────────────
   台風情報 — 気象庁 台風情報API(bosai/typhoon)の取得と空間処理。
   turf.jsで暴風域・強風域の円、暴風警戒域(輪郭線から結合したポリゴン)、
   予報円の遷移から作る「警戒領域」の結合ポリゴンを組み立てる。
   1本のGeoJSON FeatureCollectionに全台風ぶんの各種フィーチャーを
   properties.type("center"/"forecastCircle"/"stormArea"/"windArea"/
   "pastTrack"/"track"/"forecastArea"/"stormWarningArea")で区別して入れ、
   MapCanvas側は1つのsourceに対してtypeごとにfilterした複数レイヤーを重ねる
   (雨雲レーダーの仕組みとは別で、こちらは前に作った参考実装をそのまま踏襲)。
   ───────────────────────────────────────────────────── */
const TYPHOON_DATA_BASE = "https://www.jma.go.jp/bosai/typhoon/data";


function parseJMACoord(coord) {
  if (!coord) return null;
  if (Array.isArray(coord) && coord.length >= 2) {
    const lat = Number(coord[0]);
    const lon = Number(coord[1]);
    return Number.isFinite(lat) && Number.isFinite(lon) ? [lon, lat] : null;
  }
  const match = String(coord).match(/([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/);
  if (match) {
    const lat = parseFloat(match[1]);
    const lon = parseFloat(match[2]);
    return [lon, lat];
  }
  return null;
}


// 台風の「階級」(種別)がTY/STS/TSのいずれでもない場合は、熱帯低気圧・温帯低気圧などに
// 変化(減衰)したとみなす
const TYPHOON_CLASS_CODES = new Set(["TY", "STS", "TS"]);

function isWeakenedTyphoonClass(category) {
  if (!category || !category.en) return false;
  return !TYPHOON_CLASS_CODES.has(category.en);
}


// 種別(category: {jp, en})・台風番号・名称から表示名を組み立てる
function getTyphoonDisplayName(category, typhoonNo, name) {
  const suffix = name ? ` (${name})` : "";
  const jp = category?.jp;
  if (jp) {
    if (jp === "台風") {
      return `${Number(typhoonNo) ? `台風第${Number(typhoonNo)}号` : "台風"}${suffix}`;
    }
    return `${jp}${suffix}`;
  }
  return `${Number(typhoonNo) ? `台風第${Number(typhoonNo)}号` : "熱帯低気圧"}${suffix}`;
}


function formatTyphoonCategoryLabel(category, fallback) {
  if (category?.jp) return `${category.jp}${category.en ? `(${category.en})` : ""}`;
  return fallback || "-";
}


function getJMATyphoonRadiusKm(value) {
  if (value == null) return null;
  if (typeof value === "number") return value / 1000;
  if (Array.isArray(value)) return getJMATyphoonRadiusKm(value[0]);
  if (typeof value === "object") {
    // {km, nm}形式(気象庁specifications.jsonのprobabilityCircleRadius/stormWarning.range
    // 等で使われる形。値は既にkm単位なのでそのまま返す)
    if (typeof value.km === "number") return value.km;
    if (typeof value.radius === "number") return value.radius / 1000;
    if (typeof value.base === "number") return value.base / 1000;
    if (Array.isArray(value.base)) return getJMATyphoonRadiusKm(value.base[0]);
  }
  return null;
}


// forecast.json上の1予報点(item)から予報円の半径(km)を取り出す。
// 以前は item.probabilityCircle.radius という決め打ちのキー名だけを見ていたが、
// 実際の気象庁データではprobabilityCircleRadius(specifications.jsonと同じ{km,nm}形式)
// など別名で入ってくるケースがあり、その場合常にnullになって予報円が
// ひとつも描画されない不具合があった。そのため複数の候補キーを順に試す。
function getForecastCircleRadiusKm(item) {
  const candidates = [
    item.probabilityCircle?.radius,
    item.probabilityCircle,
    item.probabilityCircleRadius,
    item.circle?.radius,
    item.circle,
  ];
  for (const candidate of candidates) {
    const km = getJMATyphoonRadiusKm(candidate);
    if (km) return km;
  }
  return null;
}


// forecast.json上の1予報点(item)から、名称・階級・気圧・風速・大きさ・強さ・
// 移動方向速度など、詳細カード/予報タイムラインの表示に必要なフィールドをまとめて
// 作る。半径やジオメトリ(円・ラベル位置)は呼び出し側の用途(地図の予報円か、
// 一覧の予報タイムラインか)によって必要なものが違うため、ここには含めない。
function buildTyphoonForecastPointInfo(item, { tc, specifications, currentCategory, typhoonNo, name }) {
  const forecastLabel = formatTyphoonForecastTimeLabel(item.validtime?.JST || item.validtime?.UTC);
  const forecastSpec = specifications.find(spec => spec.advancedHours === item.advancedHours) || {};
  const forecastCategory = forecastSpec.category || currentCategory;
  return {
    id: tc.tropicalCyclone,
    name: getTyphoonDisplayName(forecastCategory, typhoonNo, name),
    category: formatTyphoonCategoryLabel(forecastCategory, tc.category),
    weakened: isWeakenedTyphoonClass(forecastCategory),
    forecastTime: forecastLabel,
    timeLabel: `${forecastLabel} 予報`,
    pressure: forecastSpec.pressure || "不明",
    maxWind: forecastSpec.maximumWind?.sustained?.["m/s"] || "不明",
    maxGust: forecastSpec.maximumWind?.gust?.["m/s"] || "不明",
    scale: forecastSpec.scale || "-",
    intensity: forecastSpec.intensity || "-",
    speed: forecastSpec.speed?.["km/h"] ? `${forecastSpec.course || ""} ${forecastSpec.speed["km/h"]}km/h`.trim() : (forecastSpec.course || "-"),
    courseText: forecastSpec.course || "-",
    speedKmh: forecastSpec.speed?.["km/h"] || null,
  };
}

// 予報点を「現在(advancedHours=0)から少なくともintervalHours時間離れているものだけ、
// 直前に採用した点からもintervalHours時間以上離れているものだけ」を貪欲に拾う形で間引く。
// 気象庁のadvancedHoursは発表時刻のズレにより必ずしも3,6,12,24の倍数の
// キレイなグリッドに並ばない(例: 1,4,7,10,...のように1時間オフセットしていたり、
// 12,24,45,69,...のように不規則だったりする)。そのため「advancedHours % interval」で
// 判定すると、オフセットとの相性次第で予報点が1つも一致せず、予報円が
// まるごと消えてしまうことがあった。この関数はオフセットに関係なく必ず動く。
function pickThinnedForecastPoints(points, intervalHours) {
  const sorted = points
    .filter(item => item.advancedHours > 0)
    .slice()
    .sort((a, b) => a.advancedHours - b.advancedHours);
  const picked = [];
  let lastHours = 0; // 現在時刻(advancedHours=0)を基準に数える
  for (const item of sorted) {
    if (item.advancedHours - lastHours >= intervalHours) {
      picked.push(item);
      lastHours = item.advancedHours;
    }
  }
  return picked;
}


// 暴風警戒域(stormWarningArea)のポリゴンを作る。
// 気象庁のstormWarningAreaは、解析時刻からその予報時刻までの「円(弧)と接線」の
// 集合で、arcは[中心, 半径(m), [開始角, 終了角]]、lineは隣り合う円どうしをつなぐ
// 接線の端点ペアになっている。
// 以前は弧の角度や向きを使わず、arc配列の中心・半径から作った円を「配列の順に
// 全てconvex hullでつなぐ」方式にしていたため、暴風域が予想される時刻が
// 途中で途切れて複数の塊に分かれている場合でも、塊と塊の間まで橋渡しされて
// 1つにつながって描画されてしまっていた。
// ここでは、
//  1. arcから(中心,半径)が同じ円の重複を除き、予報点の時系列順に並べる
//  2. 隣り合う円は、その切れ目をまたぐ接線(line)がある場合に限ってconvex hullでつなぐ
//     (接線の端点を、円周に最も近い円に対応づけて判定する)
//  3. 接線でつながらなかった円どうしは別の領域のまま、全体をunionする
// とする。角度に依存しないので、従来どおり自己交差で壊れることもない。
// orderedCenters: 予報点(時系列順)の中心[lon,lat]の配列。円の並び替えに使う。
function buildStormWarningAreaFeature(turf, stormWarningArea, orderedCenters = []) {
  const circleSpecs = [];
  (stormWarningArea?.arc || []).forEach(arc => {
    const center = parseJMACoord(arc?.[0]);
    const radiusKm = getJMATyphoonRadiusKm(arc?.[1]);
    if (!center || !radiusKm) return;
    const exists = circleSpecs.some(c =>
      Math.abs(c.center[0] - center[0]) < 1e-6 &&
      Math.abs(c.center[1] - center[1]) < 1e-6 &&
      Math.abs(c.radiusKm - radiusKm) < 0.01
    );
    if (!exists) circleSpecs.push({ center, radiusKm });
  });
  if (circleSpecs.length === 0) return null;

  // 予報点の時系列順(中心が一番近い予報点の順番)に並べ替える
  if (orderedCenters.length > 0) {
    circleSpecs.forEach((c, i) => {
      let best = 0, bestD = Infinity;
      orderedCenters.forEach((oc, idx) => {
        if (!oc) return;
        const d = (oc[0] - c.center[0]) ** 2 + (oc[1] - c.center[1]) ** 2;
        if (d < bestD) { bestD = d; best = idx; }
      });
      c.order = best;
      c.seq = i;
    });
    circleSpecs.sort((a, b) => (a.order - b.order) || (a.seq - b.seq));
  }

  const circles = circleSpecs.map(c =>
    turf.circle(c.center, c.radiusKm, { steps: 64, units: "kilometers" })
  );

  // 接線(line)から、時系列順に並べた円の「どの切れ目(i と i+1 の間)を接線がまたぐか」を求める。
  // 接線の各端点は、円周からの距離のずれが最小の円に対応づける(しきい値は使わない)。
  // 隣り合う円どうしだけでなく、間の円を飛ばして結ぶ接線(間の円が外形に出ない場合)も
  // またぐ切れ目として数えるので、本来つながっている箇所が分裂しない。
  // どの接線もまたがない切れ目だけが「暴風域が途切れた箇所」として分離される。
  const lines = (stormWarningArea?.line || [])
    .map(seg => (Array.isArray(seg) ? seg.map(parseJMACoord) : []))
    .filter(seg => seg.length >= 2 && seg[0] && seg[seg.length - 1])
    .map(seg => [seg[0], seg[seg.length - 1]]);
  const nearestCircleIndex = (pt) => {
    let best = -1, bestErr = Infinity;
    circleSpecs.forEach((spec, idx) => {
      const dist = turf.distance(turf.point(pt), turf.point(spec.center), { units: "kilometers" });
      const err = Math.abs(dist - spec.radiusKm);
      if (err < bestErr) { bestErr = err; best = idx; }
    });
    return best;
  };
  const spans = new Array(Math.max(circles.length - 1, 0)).fill(false);
  lines.forEach(([p1, p2]) => {
    const i1 = nearestCircleIndex(p1), i2 = nearestCircleIndex(p2);
    if (i1 < 0 || i2 < 0) return;
    for (let k = Math.min(i1, i2); k < Math.max(i1, i2); k++) spans[k] = true;
  });

  let result = circles[0];
  for (let i = 0; i < circles.length; i++) {
    if (i > 0) result = turf.union(result, circles[i]) || result;
    if (i + 1 < circles.length) {
      // lineが1本も無いデータ(想定外)では従来どおり隣り合う円をつなぐ
      const linked = lines.length === 0 || spans[i];
      if (linked) {
        const segment = turf.convex(turf.explode(turf.featureCollection([circles[i], circles[i + 1]])));
        if (segment) result = turf.union(result, segment) || result;
      }
    }
  }
  console.info("[typhoon] stormWarningArea", {
    circles: circleSpecs.length,
    lines: lines.length,
    linked: lines.length === 0 ? "all" : spans.map(v => (v ? 1 : 0)).join(""),
  });
  result.properties = { type: "stormWarningArea" };
  return result;
}


function formatTyphoonForecastTimeLabel(time) {
  if (!time) return "予報";
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return "予報";
  const day = date.getDate();
  const hour = date.getHours();
  if (hour === 0) return `${day}日午前0時`;
  if (hour < 12) return `${day}日午前${hour}時`;
  if (hour === 12) return `${day}日午後0時`;
  return `${day}日午後${hour - 12}時`;
}


async function fetchTyphoonJsonOrNull(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return null;
  return res.json();
}


// 「台風情報」ボタン自体を、台風が1つも発生していない間は表示しないために使う
// 軽い問い合わせ。targetTc.json(対象の台風の一覧)だけを見る、件数のみの確認で
// あり、各台風の詳細(forecast.json/specifications.json)は取りに行かない。
export async function fetchActiveTyphoonExists() {
  const targetTc = await fetchTyphoonJsonOrNull(`${TYPHOON_DATA_BASE}/targetTc.json`);
  return Array.isArray(targetTc) && targetTc.length > 0;
}


// 気象庁「現在活動中の台風」一覧とその予報・実況を取得し、地図表示用GeoJSONと
// 一覧パネル表示用のサマリー配列にまとめて返す。
// forecastIntervalHours: 予報円を間引く間隔(時間)。台風接近時は気象庁の予報が
// 3時間おきに増えるため、advancedHoursがこの倍数の予報円だけを表示する
// (例: 12なら12,24,36...時間先だけ。3,6,9時間先などは間引かれる)。
// 戻り値: { geojson: FeatureCollection, list: [{id,name,category,weakened,pressure,
//           maxWind,maxGust,scale,intensity,speed,lon,lat}] }
export async function fetchTyphoonData(forecastIntervalHours = 12) {
  const turf = await loadTurf();
  const features = [];
  const list = [];

  try {
    const targetTc = await fetchTyphoonJsonOrNull(`${TYPHOON_DATA_BASE}/targetTc.json`);
    if (!Array.isArray(targetTc) || targetTc.length === 0) {
      return { geojson: turf.featureCollection([]), list: [] };
    }

    const typhoonData = await Promise.all(targetTc.map(async (tc) => {
      const id = tc.tropicalCyclone;
      const [forecast, specifications] = await Promise.all([
        fetchTyphoonJsonOrNull(`${TYPHOON_DATA_BASE}/${id}/forecast.json`),
        fetchTyphoonJsonOrNull(`${TYPHOON_DATA_BASE}/${id}/specifications.json`),
      ]);
      return { tc, forecast: Array.isArray(forecast) ? forecast : [], specifications: Array.isArray(specifications) ? specifications : [] };
    }));

    typhoonData.forEach(({ tc, forecast, specifications }) => {
      const title = forecast.find(item => item.part === "title") || specifications.find(item => item.part === "title") || tc;
      const specNow = specifications.find(item => item.advancedHours === 0) || {};
      const points = forecast.filter(item => item && item.advancedHours !== undefined && item.center);
      const current = points.find(item => item.advancedHours === 0) || points[0];
      if (!current) return;

      const centerPos = parseJMACoord(current.center);
      if (!centerPos) return;

      const typhoonNo = String(title.typhoonNumber || tc.typhoonNumber || "").slice(-2).replace(/^0/, "");
      const name = title.name?.jp || title.name?.en || "";
      const maxWind = specNow.maximumWind?.sustained?.["m/s"] || specNow.maximumWind?.sustained?.mps || "不明";
      const maxGust = specNow.maximumWind?.gust?.["m/s"] || specNow.maximumWind?.gust?.mps || "不明";
      const currentCategory = specNow.category || (tc.category ? { jp: null, en: tc.category } : null);
      const displayName = getTyphoonDisplayName(currentCategory, typhoonNo, name);
      const weakened = isWeakenedTyphoonClass(currentCategory);
      const pressure = specNow.pressure || "不明";
      const scale = specNow.scale || "-";
      const intensity = specNow.intensity || "-";
      const speed = specNow.speed?.["km/h"] ? `${specNow.course || ""} ${specNow.speed["km/h"]}km/h`.trim() : (specNow.course || "-");
      // 移動速度・移動方向を別々の値としても持っておく(詳細カードで
      // 「移動速度」「移動方向」を別項目として大きく表示するため)。
      const courseText = specNow.course || "-";
      const speedKmh = specNow.speed?.["km/h"] || null;
      const timeLabel = `${formatTyphoonForecastTimeLabel(current.validtime?.JST || current.validtime?.UTC)} 実況`;

      // 暴風警戒域(輪郭線)の元データを先に確定させ、暴風域の塗りも同じ円弧を使う
      // stormWarningAreaは、実況(advancedHours=0)・1時間後の推定では「暴風域」、
      // それ以降の予報では「暴風警戒域」を表す。暴風警戒域の元データは予報点
      // (advancedHours>=2)の中で最後のものだけを使う(解析時刻からその時刻までの
      // 全ての円・接線を含むため)。
      const stormWarningSource = points.slice().reverse().find(item => item.advancedHours >= 2 && item.stormWarningArea?.arc?.length);
      // 現在の暴風域は実況(advancedHours=0)のstormWarningAreaだけから取る。
      // 以前は実況に暴風域が無い(暴風域を伴っていない)場合に、予報側の暴風警戒域の
      // 先頭の円で代用していたため、将来の予報円の位置に「現在の暴風域」の赤い円が
      // 描かれ、その時刻の予報円が濃く見える不具合があった。
      const currentStormArc = current.advancedHours === 0 ? current.stormWarningArea?.arc?.[0] : null;
      const stormAreaCenter = parseJMACoord(currentStormArc?.[0]) || centerPos;
      const stormRadiusKm = getJMATyphoonRadiusKm(currentStormArc?.[1]);

      // 強風域(15m/s以上の風が吹く範囲)。台風一覧タップ時、この範囲が画面に収まる
      // ズーム倍率でflyToするために、暴風域より先に半径・中心を確定させておく。
      const galeCenter = parseJMACoord(current.galeWarningArea?.center) || centerPos;
      const galeRadiusKm = getJMATyphoonRadiusKm(current.galeWarningArea?.radius);

      features.push(turf.point(centerPos, {
        type: "center",
        id: tc.tropicalCyclone,
        name: displayName,
        category: formatTyphoonCategoryLabel(currentCategory, tc.category),
        weakened, pressure, maxWind, maxGust, scale, intensity, speed, courseText, speedKmh,
      }));
      list.push({
        id: tc.tropicalCyclone, name: displayName,
        category: formatTyphoonCategoryLabel(currentCategory, tc.category),
        weakened, pressure, maxWind, maxGust, scale, intensity, speed, courseText, speedKmh, timeLabel,
        lon: centerPos[0], lat: centerPos[1],
        // 一覧タップ時のflyTo先で、地図に強風域(無ければ暴風域、それも無ければ台風の中心のみ)が
        // 収まるズーム倍率を計算するために使う。
        areaRadiusKm: galeRadiusKm || stormRadiusKm || null,
        areaLon: (galeRadiusKm ? galeCenter[0] : stormRadiusKm ? stormAreaCenter[0] : centerPos[0]),
        areaLat: (galeRadiusKm ? galeCenter[1] : stormRadiusKm ? stormAreaCenter[1] : centerPos[1]),
      });

      if (stormRadiusKm) {
        features.push(turf.circle(stormAreaCenter, stormRadiusKm, { steps: 64, units: "kilometers", properties: { type: "stormArea" } }));
      }

      if (galeRadiusKm) {
        features.push(turf.circle(galeCenter, galeRadiusKm, { steps: 64, units: "kilometers", properties: { type: "windArea" } }));
      }

      const pastTrack = [
        ...(current.track?.preTyphoon || []),
        ...(current.track?.typhoon || []),
      ].map(point => parseJMACoord(point)).filter(Boolean);
      if (pastTrack.length >= 2) features.push(turf.lineString(pastTrack, { type: "pastTrack" }));

      const forecastTrack = points.map(item => parseJMACoord(item.center)).filter(Boolean);
      if (forecastTrack.length >= 2) features.push(turf.lineString(forecastTrack, { type: "track" }));

      const stormWarningArea = buildStormWarningAreaFeature(turf, stormWarningSource?.stormWarningArea, points.map(item => parseJMACoord(item.center)));
      if (stormWarningArea) features.push(stormWarningArea);

      const forecastCircles = [];
      const thinnedPoints = pickThinnedForecastPoints(points, forecastIntervalHours);
      // 間引き設定(interval)が原因なのか、半径の取得自体が失敗しているのかを
      // 実機ログだけで切り分けられるよう、対象台風ごとに1回だけ生の予報点一覧を出す。
      console.info(
        `台風予報円デバッグ[${tc.tropicalCyclone}]: forecastIntervalHours=${forecastIntervalHours}`,
        `advancedHours一覧=${points.map(p => p.advancedHours).join(",")}`,
        `間引き後=${thinnedPoints.map(p => p.advancedHours).join(",")}`
      );
      thinnedPoints.forEach(item => {
        const fPos = parseJMACoord(item.center);
        const radiusKm = getForecastCircleRadiusKm(item);
        if (!fPos || !radiusKm) {
          // 半径が取れなかった場合、原因調査用に生データのキー名だけをログに残す
          // (実機での不具合調査用。設定タブ「詳細設定」→「ログ」で確認できる)
          console.warn(
            "台風予報円: 半径を取得できなかった予報点をスキップしました",
            `advancedHours=${item.advancedHours}`,
            `keys=${Object.keys(item).join(",")}`
          );
          return;
        }

        const info = buildTyphoonForecastPointInfo(item, { tc, specifications, currentCategory, typhoonNo, name });
        const labelPoint = turf.destination(turf.point(fPos), radiusKm + 35, 45, { units: "kilometers" }).geometry.coordinates;
        const circle = turf.circle(fPos, radiusKm, {
          steps: 64, units: "kilometers",
          properties: { type: "forecastCircle", ...info, radiusKm: Math.round(radiusKm), labelPoint },
        });
        forecastCircles.push(circle);
        features.push(circle);
      });
      console.info(
        `台風予報円デバッグ[${tc.tropicalCyclone}]: 間引き後の予報点=${thinnedPoints.length}件 / 実際に円を作れた数=${forecastCircles.length}件`
      );
      // 台風一覧の詳細カードの下に「予報を時系列で並べたリスト」を出すため、
      // 円のジオメトリを持たないプレーンな配列としても保持しておく。
      // 地図の予報円は表示間隔設定で間引くが、このリストは間引かず、
      // advancedHours>0の予報点を全件載せる(半径が無くても一覧には出せるので
      // getForecastCircleRadiusKmが失敗する点も除外しない)。
      list[list.length - 1].forecasts = points
        .filter(item => item.advancedHours > 0)
        .map(item => {
          const info = buildTyphoonForecastPointInfo(item, { tc, specifications, currentCategory, typhoonNo, name });
          const radiusKm = getForecastCircleRadiusKm(item);
          return { ...info, radiusKm: radiusKm ? Math.round(radiusKm) : null };
        });

      if (forecastCircles.length > 0) {
        let previousCircle = turf.circle(centerPos, 1, { steps: 64, units: "kilometers" });
        let finalWarningArea = null;
        forecastCircles.forEach(circle => {
          const warningAreaSegment = turf.convex(turf.explode(turf.featureCollection([previousCircle, circle])));
          if (warningAreaSegment) {
            finalWarningArea = finalWarningArea ? (turf.union(finalWarningArea, warningAreaSegment) || finalWarningArea) : warningAreaSegment;
          }
          previousCircle = circle;
        });
        if (finalWarningArea) {
          finalWarningArea.properties = { type: "forecastArea" };
          features.push(finalWarningArea);
        }
      }
    });

    return { geojson: turf.featureCollection(features), list };
  } catch (e) {
    console.warn("[台風] データ取得に失敗:", e);
    return { geojson: turf.featureCollection([]), list: [] };
  }
}



// 404だったタイルURLの記録(モジュールスコープでアプリ全体を通じて使い回す)。
const nowcastFailedTileUrls = new Set();


let nowcastProtocolRegistered = false;

export function registerNowcastProtocol(maplibregl) {
  if (nowcastProtocolRegistered) return;
  nowcastProtocolRegistered = true;
  maplibregl.addProtocol("jmanowc", async (params, abortController) => {
    const m = params.url.match(/^jmanowc:\/\/([a-z]+)\/(\d+)\/(\d+)\/(\d+)\/(-?\d+)\/(-?\d+)$/);
    if (!m) return { data: null };
    const [, schemeId, basetime, validtime, zStr, xStr, yStr] = m;
    let z = Number(zStr), x = Number(xStr), y = Number(yStr);
    const palette = NOWCAST_COLOR_SCHEMES[schemeId]?.palette || null;

    // 奇数ズームは1段階粗い偶数ズームのタイルを取得し、該当する象限だけを
    // 切り出して代用する。
    // (鮮明さ優先で「1段階細かいズームの子タイル4枚を縮小合成」する方式も
    // 試したが、通信量が4倍になって重かったため、軽いこちらの方式に戻した)
    let cropQuadrant = null; // {qx, qy} | null(0=左/上, 1=右/下)
    if (z % 2 !== 0) {
      cropQuadrant = { qx: x % 2, qy: y % 2 };
      z = z - 1;
      x = Math.floor(x / 2);
      y = Math.floor(y / 2);
    }
    const url = nowcastTileUrl(basetime, validtime, z, x, y);
    if (nowcastFailedTileUrls.has(url)) return { data: null };

    let res;
    try {
      res = await fetch(url, { signal: abortController.signal });
    } catch (err) {
      if (err.name === "AbortError") throw err;
      return { data: null };
    }
    if (!res.ok) {
      if (res.status === 404) nowcastFailedTileUrls.add(url);
      return { data: null };
    }
    const blob = await res.blob();

    // 奇数ズームの切り出しも、配色変換も不要な場合だけ、そのまま素通しする
    // (canvas処理をまるごと省いた方が速いため)。
    if (!cropQuadrant && !palette) {
      return { data: await blob.arrayBuffer() };
    }

    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(256, 256);
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    if (cropQuadrant) {
      ctx.drawImage(bitmap, cropQuadrant.qx * 128, cropQuadrant.qy * 128, 128, 128, 0, 0, 256, 256);
    } else {
      ctx.drawImage(bitmap, 0, 0, 256, 256);
    }
    if (palette) {
      const imageData = ctx.getImageData(0, 0, 256, 256);
      remapImageDataColors(imageData, palette);
      ctx.putImageData(imageData, 0, 0);
    }
    const outBlob = await canvas.convertToBlob({ type: "image/png" });
    return { data: await outBlob.arrayBuffer() };
  });
}


// 404だったタイルURLの記録(降水量用。雨雲レーダーと別集合にして、
// 診断メッセージが混ざらないようにする)。
const precipFailedTileUrls = new Set();


let precipProtocolRegistered = false;

export function registerPrecipProtocol(maplibregl) {
  if (precipProtocolRegistered) return;
  precipProtocolRegistered = true;
  maplibregl.addProtocol("jmaprecip", async (params, abortController) => {
    const m = params.url.match(/^jmaprecip:\/\/([a-z0-9]+)\/([a-z]+)\/([a-z]+)\/(\d+)\/(\d+)\/(\d+)\/(-?\d+)\/(-?\d+)$/);
    if (!m) return { data: null };
    const [, mode, schemeId, member, basetime, validtime, zStr, xStr, yStr] = m;
    let z = Number(zStr), x = Number(xStr), y = Number(yStr);
    const palette = NOWCAST_COLOR_SCHEMES[schemeId]?.palette || null;

    // 奇数ズームは1段階粗い偶数ズームのタイルを取得し、該当する象限だけを
    // 切り出して代用する(雨雲レーダーと同じ方式)。
    let cropQuadrant = null;
    if (z % 2 !== 0) {
      cropQuadrant = { qx: x % 2, qy: y % 2 };
      z = z - 1;
      x = Math.floor(x / 2);
      y = Math.floor(y / 2);
    }
    const url = precipTileUrl(mode, member, basetime, validtime, z, x, y);
    if (precipFailedTileUrls.has(url)) return { data: null };

    let res;
    try {
      res = await fetch(url, { signal: abortController.signal });
    } catch (err) {
      if (err.name === "AbortError") throw err;
      return { data: null };
    }
    if (!res.ok) {
      if (res.status === 404) {
        precipFailedTileUrls.add(url);
        console.warn(`降水量[${mode}]タイル 404: ${url}`);
      }
      return { data: null };
    }
    const blob = await res.blob();

    if (!cropQuadrant && !palette) {
      return { data: await blob.arrayBuffer() };
    }

    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(256, 256);
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    if (cropQuadrant) {
      ctx.drawImage(bitmap, cropQuadrant.qx * 128, cropQuadrant.qy * 128, 128, 128, 0, 0, 256, 256);
    } else {
      ctx.drawImage(bitmap, 0, 0, 256, 256);
    }
    if (palette) {
      const imageData = ctx.getImageData(0, 0, 256, 256);
      remapImageDataColors(imageData, palette);
      ctx.putImageData(imageData, 0, 0);
    }
    const outBlob = await canvas.convertToBlob({ type: "image/png" });
    return { data: await outBlob.arrayBuffer() };
  });
}


// 404だったタイルURLの記録(天気分布予報用)。
const wdistFailedTileUrls = new Set();


let wdistProtocolRegistered = false;

export function registerWdistProtocol(maplibregl) {
  if (wdistProtocolRegistered) return;
  wdistProtocolRegistered = true;
  maplibregl.addProtocol("jmawdist", async (params, abortController) => {
    const m = params.url.match(/^jmawdist:\/\/([a-z]+)\/([a-z]+)\/(\d+)\/(\d+)\/(-?\d+)\/(-?\d+)\/(-?\d+)$/);
    if (!m) return { data: null };
    const [, mode, member, basetime, validtime, zStr, xStr, yStr] = m;
    let z = Number(zStr), x = Number(xStr), y = Number(yStr);

    // 奇数ズームは1段階粗い偶数ズームのタイルを取得し、該当する象限だけを
    // 切り出して代用する(雨雲レーダー・降水量と同じ方式)。天気種別・気温の
    // 色分けは配色スキームに関係なく固定なので、色の変換(remapImageDataColors)は
    // 行わない。
    let cropQuadrant = null;
    if (z % 2 !== 0) {
      cropQuadrant = { qx: x % 2, qy: y % 2 };
      z = z - 1;
      x = Math.floor(x / 2);
      y = Math.floor(y / 2);
    }
    const url = wdistTileUrl(mode, member, basetime, validtime, z, x, y);
    if (wdistFailedTileUrls.has(url)) return { data: null };

    let res;
    try {
      res = await fetch(url, { signal: abortController.signal });
    } catch (err) {
      if (err.name === "AbortError") throw err;
      return { data: null };
    }
    if (!res.ok) {
      if (res.status === 404) {
        wdistFailedTileUrls.add(url);
        console.warn(`${WDIST_MODE_CONFIG[mode]?.label || mode}タイル 404(要素名・URL構造の推測が外れている可能性があります): ${url}`);
      }
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
