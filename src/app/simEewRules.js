import { INTENSITY_SCALE_CODE, instrumentalIntensityToScaleKey } from "./testSimulation";

/* ─────────────────────────────────────────────────────
   緊急地震速報シミュレーション(地震検知テスト連動)の、発表条件・報更新条件。
   気象庁の「緊急地震速報の概要や処理手法に関する技術的参考資料」(2024年4月11日)を参考に、
   MeteoQuake独自仕様(Mと深さの更新条件、発表値の刻み)を加えたもの。気象庁の内部処理の完全な再現ではない。
   閾値は全てEEW_RULESに集めてある。「仮置き」は、資料に数値が無いため暫定で決めた値。
   ───────────────────────────────────────────────────── */
export const EEW_RULES = Object.freeze({
  // ── 発表(第1報)の条件 ──
  // 予報: 推定M3.5以上、または最大予測震度3以上(計測震度2.5以上)。
  // 気象庁にある「観測点の振幅が100ガル以上」は、シミュレーションに加速度が無いため対象外。
  ISSUE_MIN_MAGNITUDE: 3.5,
  ISSUE_MIN_INTENSITY: 2.5,
  // 警報: 2観測点以上で地震波を観測し、最大予測震度が5弱以上(計測震度4.5以上)。
  WARN_MIN_STATIONS: 2,
  WARN_MIN_INTENSITY: 4.5,
  // 地域ごとの予測を載せる・更新判定に使う下限: 震度4以上(計測震度3.5以上)。
  AREA_MIN_INTENSITY: 3.5,

  // ── 更新条件(前回の報を出した時点の内部値と比較する) ──
  // MeteoQuake独自: 発表値(M0.1刻み・深さ10km刻み)とは別に、内部値の変化で判定する。
  UPDATE_MAGNITUDE: 0.05,
  UPDATE_DEPTH_KM: 5,
  // 気象庁: 緯度・経度それぞれ、内陸0.2度以上・海域0.4度以上。
  UPDATE_POS_DEG_LAND: 0.2,
  UPDATE_POS_DEG_SEA: 0.4,
  // 気象庁: 最大予測震度(計測震度)が+0.5以上、または-1.0以上。
  UPDATE_MAXINT_RISE: 0.5,
  UPDATE_MAXINT_DROP: 1.0,

  // ── 終了条件 ──
  // 気象庁: 最初の検知から600秒。または、マグニチュードに応じた時間がたち、一定の閾値以上の揺れが
  // 一定時間観測されなくなった時。後者の数値は資料に無いため仮置き。
  END_MAX_MS: 600000,
  END_QUIET_INTENSITY: 1.5,
  END_QUIET_MS: 30000,
});

// 揺れが収まったと見なす前に、最低限経過させる時間(ms)。Mが大きいほど長い(仮置き)。
export function endMinElapsedMs(magnitude) {
  return Math.min(120000, 30000 + Math.max(0, magnitude - 4) * 15000);
}

// 発表値: Mは0.1刻み、深さは10km刻み(最小10km)。予想震度の計算にも発表値を使う。
export function publishedMagnitude(rawMagnitude) {
  return Math.round(rawMagnitude * 10) / 10;
}
export function publishedDepthKm(rawDepthKm) {
  return Math.max(10, Math.round(rawDepthKm / 10) * 10);
}

const CLASS_ORDER = ["0", "1", "2", "3", "4", "5-", "5+", "6-", "6+", "7"];
function classIndex(key) {
  return CLASS_ORDER.indexOf(key);
}

const EPS = 1e-9;
const atLeast = (value, threshold) => value >= threshold - EPS;

// 通常方式(距離減衰、calcTestEewAreasByAttenuationのareaValues)とPLUM法の予想震度を合成する。
// 地域ごとに、大きいほうを採用する(平均ではない)。plumWon: PLUM法のほうが大きかった地域。
export function buildForecast(attenuation, plum) {
  const areaValues = new Map(attenuation?.areaValues || []);
  const plumWon = new Set();
  for (const [name, p] of plum || []) {
    const cur = areaValues.get(name);
    if (cur === undefined || p.intensity > cur) {
      areaValues.set(name, p.intensity);
      plumWon.add(name);
    }
  }
  return { areaValues, plumWon };
}

/* 前回の報(prev)と最新の解析結果(latest)を比べて、新しい報を出すか判定する。
   prev  : 前回の報の状態(evaluateReportが返したstate)。第1報の前はnull。
   latest: { raw: { lat, lon, depthKm, magnitude }(内部値), stationCount, inland, forecast(buildForecastの戻り値) }
   戻り値: 報を出さないならnull。出すなら { state, reasons, display }
     state  : 次回の比較用に保存する状態(内部値・発表値・予測・警報の状態)
     reasons: 更新理由(複数成立したら全て)
     display: カードに載せる { areas, maxKey, isWarnLevel }
   予報の更新と警報の続報が同時に成立しても、報は1つ(理由は全て記録)。 */
export function evaluateReport(prev, latest) {
  const R = EEW_RULES;
  const { raw, stationCount, inland, forecast } = latest;
  const pub = { magnitude: publishedMagnitude(raw.magnitude), depthKm: publishedDepthKm(raw.depthKm) };

  // 警報を出した地域は、予測震度が下がっても取り消さない。表示は保持した最大値を使う。
  const values = new Map(forecast.areaValues);
  for (const [name, held] of prev?.warnAreas || []) {
    if (!(values.get(name) >= held)) values.set(name, held);
  }
  let maxValue = -Infinity;
  for (const v of values.values()) if (v > maxValue) maxValue = v;
  if (!Number.isFinite(maxValue)) maxValue = -3;
  const maxKey = instrumentalIntensityToScaleKey(maxValue);

  // 警報: 一度出たら続く。続報は、これまで警報対象でなかった地域に新たに震度5弱以上が予測された時だけ。
  const warnWas = prev?.warn === true;
  const warnNow = warnWas || (stationCount >= R.WARN_MIN_STATIONS && atLeast(maxValue, R.WARN_MIN_INTENSITY));
  const warnAreas = new Map(prev?.warnAreas || []);
  const newWarnAreas = [];
  if (warnNow) {
    for (const [name, v] of values) {
      if (!atLeast(v, R.WARN_MIN_INTENSITY)) continue;
      if (!warnAreas.has(name)) newWarnAreas.push(name);
      if (!(warnAreas.get(name) >= v)) warnAreas.set(name, v);
    }
  }

  const areaClasses = new Map();
  for (const [name, v] of values) {
    if (atLeast(v, R.AREA_MIN_INTENSITY)) areaClasses.set(name, classIndex(instrumentalIntensityToScaleKey(v)));
  }

  const reasons = [];
  if (!prev) {
    // 発表条件(予報): M3.5以上、または最大予測震度3以上。
    if (!(atLeast(pub.magnitude, R.ISSUE_MIN_MAGNITUDE) || atLeast(maxValue, R.ISSUE_MIN_INTENSITY))) return null;
    reasons.push("発表");
    if (warnNow) reasons.push("警報の発表");
  } else {
    if (atLeast(Math.abs(raw.magnitude - prev.raw.magnitude), R.UPDATE_MAGNITUDE)) reasons.push("マグニチュードの変化");
    if (atLeast(Math.abs(raw.depthKm - prev.raw.depthKm), R.UPDATE_DEPTH_KM)) reasons.push("震源の深さの変化");
    const posThreshold = inland ? R.UPDATE_POS_DEG_LAND : R.UPDATE_POS_DEG_SEA;
    if (atLeast(Math.abs(raw.lat - prev.raw.lat), posThreshold) || atLeast(Math.abs(raw.lon - prev.raw.lon), posThreshold)) {
      reasons.push("震源位置の変化");
    }
    const maxDiff = maxValue - prev.maxValue;
    if (atLeast(maxDiff, R.UPDATE_MAXINT_RISE)) reasons.push("最大予測震度の上昇");
    if (atLeast(-maxDiff, R.UPDATE_MAXINT_DROP)) reasons.push("最大予測震度の低下");
    // (最大予測長周期地震動階級の上昇: シミュレーションに計算が無いため、当面は判定しない)
    let added = false;
    let changed = false;
    for (const [name, idx] of areaClasses) {
      if (!prev.areaClasses.has(name)) added = true;
      else if (prev.areaClasses.get(name) !== idx) changed = true;
    }
    for (const name of prev.areaClasses.keys()) if (!areaClasses.has(name)) changed = true; // 震度4未満になった
    if (added) reasons.push("新しい予報区の追加");
    if (changed) reasons.push("予報区ごとの予測値の変化");
    if (!warnWas && warnNow) reasons.push("警報の発表");
    else if (warnWas && newWarnAreas.length > 0) reasons.push("警報対象地域の追加");
    if (reasons.length === 0) return null;
    if (reasons.length > 1) reasons.push("複数条件の同時成立");
  }

  const areas = [];
  for (const [name, v] of values) {
    if (!atLeast(v, R.AREA_MIN_INTENSITY)) continue;
    const key = instrumentalIntensityToScaleKey(v);
    const code = INTENSITY_SCALE_CODE[key] ?? 40;
    areas.push({ pref: "", name, scaleFrom: code, scaleTo: code, maxIntensityKey: key, isPlum: forecast.plumWon.has(name) });
  }

  return {
    state: { raw: { ...raw }, pub, maxValue, maxKey, areaClasses, warn: warnNow, warnAreas },
    reasons,
    display: { areas, maxKey, isWarnLevel: warnNow },
  };
}
