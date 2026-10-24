import { fastDist2, polygonRoughCentroid } from "./geo";


// 計測震度(連続値)を気象庁の震度階級に変換する(「震度を知る」の計測震度→震度階級の対応表)。
function instrumentalIntensityToScaleKey(i) {
  if (i < 0.5) return "0";
  if (i < 1.5) return "1";
  if (i < 2.5) return "2";
  if (i < 3.5) return "3";
  if (i < 4.5) return "4";
  if (i < 5.0) return "5-";
  if (i < 5.5) return "5+";
  if (i < 6.0) return "6-";
  if (i < 6.5) return "6+";
  return "7";
}

// 緊急地震速報テスト配信専用: 震源(緯度・経度・M・深さ)から、細分区域.json(areasGeoJSON)の
// 各地域の予測最大震度を距離減衰式で計算する。気象庁「緊急地震速報の概要や処理手法に関する
// 技術的参考資料」(令和6年4月版)の予測震度算出処理をベースにしている:
//   1. Mjma→Mw変換(宇津[1982]等): Mw = M - 0.171
//   2. 断層長(宇津[1977]): log10(L) = 0.5*Mw - 1.85 半分を震源球の半径とし、最短距離から差し引く
//      (下限3km)
//   3. 司・翠川[1999]の距離減衰式で基準基盤(Vs600m/s)上の最大速度PGV600を算出
//   4. 地表への換算。本来は基準基盤→工学的基盤(≒0.90倍)→地点ごとの地盤増幅度、と
//      2段階だが、地点別の地盤増幅度データは持たないため、代わりに市街地の軟弱地盤を
//      想定した簡易増幅係数(SITE_AMPLIFICATION_FACTOR)を掛けている。この値は気象庁の
//      実運用の平均値より高め(＝震度がやや過大気味)に寄せてある。
//   5. 翠川ほか[1999]の換算式で計測震度に変換する。
// 気象庁は震度4未満の予測でも緊急地震速報(予報)自体は発表し、最大震度の予測値も含めて
// いる(警報になるのは震度5弱以上の予測の時)。そのため、地図に塗り潰す地域(areas)は
// 従来通り震度4以上のみに絞る一方、カードの「最大震度」表示に使うmaxIntensityKeyは
// 震度4未満だった場合も含めた全地域中の最大値から求め、震度4未満の震源でも「?」に
// ならず正しい予測震度が表示されるようにしている。
const SITE_AMPLIFICATION_FACTOR = 2.0;
// 震度キー→気象庁の震度階級コード(数値。大きいほど強い)の対応。eewMaxScaleKey等で
// 使われているものと同じ体系。
const INTENSITY_SCALE_CODE = { "7": 70, "6+": 60, "6-": 55, "6": 54, "5+": 50, "5-": 45, "5": 44, "4": 40, "3": 30, "2": 20, "1": 10, "0": 0 };
// テスト配信専用: 震度5弱(気象庁の実運用で警報の基準となる階級)以上を警報級とみなす。
export function isTestWarnLevel(intensityKey) {
  return (INTENSITY_SCALE_CODE[intensityKey] ?? -1) >= 45;
}
export function calcTestEewAreasByAttenuation(areasGeoJSON, lat, lon, magnitude, depthKm, isPlum) {
  if (!areasGeoJSON || !Array.isArray(areasGeoJSON.features)) return { areas: [], maxIntensityKey: "?" };
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(magnitude)) {
    return { areas: [], maxIntensityKey: "?" };
  }
  const D = Number.isFinite(depthKm) ? Math.max(0, depthKm) : 10;
  const Mw = magnitude - 0.171;
  const faultLengthKm = Math.pow(10, 0.5 * Mw - 1.85);
  const sourceRadiusKm = faultLengthKm / 2;

  const areas = []; // 地図の塗り潰し用(震度4以上のみ)
  let overallMaxValue = -Infinity;
  let overallMaxKey = null;

  for (const feature of areasGeoJSON.features) {
    const name = feature.properties?.name;
    if (!name) continue;
    const center = polygonRoughCentroid(feature.geometry);
    if (!center) continue;

    const epicentralKm = Math.sqrt(fastDist2(lat, lon, center.lat, center.lon));
    const hypocentralKm = Math.sqrt(epicentralKm * epicentralKm + D * D);
    const shortestKm = Math.max(3, hypocentralKm - sourceRadiusKm);

    const logPGV600 = 0.58 * Mw + 0.0038 * D - 1.29
      - Math.log10(shortestKm + 0.0028 * Math.pow(10, 0.5 * Mw))
      - 0.002 * shortestKm;
    const PGV600 = Math.pow(10, logPGV600);
    const PGVs = PGV600 * SITE_AMPLIFICATION_FACTOR;

    const instrIntensity = 2.68 + 1.72 * Math.log10(PGVs);
    if (!Number.isFinite(instrIntensity)) continue;

    const key = instrumentalIntensityToScaleKey(instrIntensity);
    if (instrIntensity > overallMaxValue) {
      overallMaxValue = instrIntensity;
      overallMaxKey = key;
    }
    if (instrIntensity < 4) continue; // 塗り潰し対象は震度4以上のみ

    const code = INTENSITY_SCALE_CODE[key] ?? 40;
    areas.push({ pref: "", name, scaleFrom: code, scaleTo: code, maxIntensityKey: key, isPlum: !!isPlum });
  }
  return { areas, maxIntensityKey: overallMaxKey || "?" };
}

/* ─────────────────────────────────────────────────────
   地震情報テスト配信専用: 震源(緯度・経度・M・深さ)から、震度速報・震度に関する情報の
   段階で使うダミーの観測点分布(points)を作る。
   calcTestEewAreasByAttenuationと同じ距離減衰式をそのまま使い回すが、EEW側は
   「地図に塗る震度4以上の地域」だけに絞っているのに対し、こちらは震度速報の
   雰囲気を再現するため震度1以上の地域も含める(細分区域.json全域を計算するため、
   通常の震源だとEEWよりだいぶ多い件数になる)。
   本来のP2P地震情報の観測点(points)は市町村・観測点単位(isArea:false)だが、
   このテスト機能では細分区域単位(isArea:true)の粒度で簡易的に生成する
   (震度速報と同じ粒度。実際の詳細報もこの粒度で代用する簡略化版)。
   ───────────────────────────────────────────────────── */
function calcTestQuakePointsByAttenuation(areasGeoJSON, lat, lon, magnitude, depthKm) {
  if (!areasGeoJSON || !Array.isArray(areasGeoJSON.features)) return { points: [], maxIntensityKey: "?" };
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(magnitude)) {
    return { points: [], maxIntensityKey: "?" };
  }
  const D = Number.isFinite(depthKm) ? Math.max(0, depthKm) : 10;
  const Mw = magnitude - 0.171;
  const faultLengthKm = Math.pow(10, 0.5 * Mw - 1.85);
  const sourceRadiusKm = faultLengthKm / 2;

  const points = [];
  let overallMaxValue = -Infinity;
  let overallMaxKey = null;

  for (const feature of areasGeoJSON.features) {
    const name = feature.properties?.name;
    if (!name) continue;
    const center = polygonRoughCentroid(feature.geometry);
    if (!center) continue;

    const epicentralKm = Math.sqrt(fastDist2(lat, lon, center.lat, center.lon));
    const hypocentralKm = Math.sqrt(epicentralKm * epicentralKm + D * D);
    const shortestKm = Math.max(3, hypocentralKm - sourceRadiusKm);

    const logPGV600 = 0.58 * Mw + 0.0038 * D - 1.29
      - Math.log10(shortestKm + 0.0028 * Math.pow(10, 0.5 * Mw))
      - 0.002 * shortestKm;
    const PGV600 = Math.pow(10, logPGV600);
    const PGVs = PGV600 * SITE_AMPLIFICATION_FACTOR;

    const instrIntensity = 2.68 + 1.72 * Math.log10(PGVs);
    if (!Number.isFinite(instrIntensity)) continue;

    const key = instrumentalIntensityToScaleKey(instrIntensity);
    if (instrIntensity > overallMaxValue) {
      overallMaxValue = instrIntensity;
      overallMaxKey = key;
    }
    if (instrIntensity < 1) continue; // 震度1未満の地域は載せない(震度速報の実際の見え方に合わせる)

    points.push({ pref: "", addr: name, scale: INTENSITY_SCALE_CODE[key] ?? 10, isArea: true });
  }
  return { points, maxIntensityKey: overallMaxKey || "?" };
}

// 地震情報テスト配信: 発表段階(stage)ごとに、実際のtoQuakeCard()と同じ形のカードを作る。
// ①震度速報(prompt): 震源不明、地域単位の震度分布あり、津波は調査中。
// ②震源に関する情報(destination): 震源は判明、震度分布はまだ無い(maxIntensityは"?")。
// ③震度に関する情報(detail): 震源・震度分布ともに確定。津波はフォームの指定値。
// time(発生時刻)は同じ地震の複数段階を通じて固定し、issueTimeStrだけ毎回「今」を渡す
// ことで、実際のmergeQuakeCards(dedupeQuakeList)と同じ仕組みでApp側が段階的に統合できる。
export function buildTestQuakeStageCard(stage, form, time, issueTimeStr, areasGeoJSON) {
  const { points, maxIntensityKey } = calcTestQuakePointsByAttenuation(
    areasGeoJSON, form.latitude, form.longitude, form.magnitude, form.depth
  );

  if (stage === "prompt") {
    return {
      id: `test_${time}_prompt`,
      time, issueTime: issueTimeStr, stage: "prompt",
      place: "震源調査中",
      maxIntensity: maxIntensityKey,
      isForeign: false,
      magnitude: null, depth: null, latitude: null, longitude: null, longPeriod: null,
      points,
      domesticTsunami: "Checking",
      freeFormComment: null,
      isTest: true,
    };
  }
  if (stage === "destination") {
    return {
      id: `test_${time}_destination`,
      time, issueTime: issueTimeStr, stage: "destination",
      place: form.place || "震源地不明",
      maxIntensity: "?",
      isForeign: false,
      magnitude: form.magnitude, depth: form.depth, latitude: form.latitude, longitude: form.longitude, longPeriod: null,
      points: [],
      domesticTsunami: "Checking",
      freeFormComment: null,
      isTest: true,
    };
  }
  // detail(確定)
  return {
    id: `test_${time}_detail`,
    time, issueTime: issueTimeStr, stage: "detail",
    place: form.place || "震源地不明",
    maxIntensity: maxIntensityKey,
    isForeign: false,
    magnitude: form.magnitude, depth: form.depth, latitude: form.latitude, longitude: form.longitude, longPeriod: null,
    points,
    domesticTsunami: form.domesticTsunami || "None",
    freeFormComment: null,
    isTest: true,
  };
}
