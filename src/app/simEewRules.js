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

  // ── レベル法(震源要素によらない予測手法) ──
  // 気象庁: 観測点の上下動加速度が100gal以上になると、震源決定を介さず「観測点近傍で震度5弱以上」として直ちに予報を発表する。
  // 計測震度4.5以上がほぼ100gal以上に当たるため、加速度の無いシミュレーションでは、観測震度4.5以上で代用する。
  LEVEL_INTENSITY: 4.5,
  // 気象庁: 所定の時間内に2地点目の観測点が検知できなければ、キャンセル報を出す。時間の数値は資料に無いため仮置き。
  LEVEL_SECOND_STATION_TIMEOUT_MS: 10000,

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
// 震度5弱以上の階級番号(CLASS_ORDERの位置)
export const CLASS_INDEX_5_MINUS = 5;

// 階級の表示名("5-" → "5弱")。ログ用。
export function scaleKeyLabel(key) {
  return ({ "5-": "5弱", "5+": "5強", "6-": "6弱", "6+": "6強" })[key] ?? String(key);
}
export function classLabel(idx) {
  return scaleKeyLabel(CLASS_ORDER[idx] ?? "?");
}

const EPS = 1e-9;
const atLeast = (value, threshold) => value >= threshold - EPS;

// 通常方式(距離減衰、calcTestEewAreasByAttenuationのareaValues)、PLUM法、レベル法の予想震度を合成する。
// 地域ごとに、最も大きいものを採用する(平均ではない)。
//   plumWon : PLUM法のほうが大きかった地域
//   levelWon: レベル法(強い揺れを観測した観測点が属する地域)のほうが大きかった地域
// レベル法の地域も、通常方式の報の一部として扱う(別の報にはしない)。
export function buildForecast(attenuation, plum, level) {
  const areaValues = new Map(attenuation?.areaValues || []);
  const plumWon = new Set();
  const levelWon = new Set();
  for (const [name, p] of plum || []) {
    const cur = areaValues.get(name);
    if (cur === undefined || p.intensity > cur) {
      areaValues.set(name, p.intensity);
      plumWon.add(name);
    }
  }
  for (const [name, p] of level || []) {
    const cur = areaValues.get(name);
    if (cur === undefined || p.intensity > cur) {
      areaValues.set(name, p.intensity);
      plumWon.delete(name);
      levelWon.add(name);
    }
  }
  return { areaValues, plumWon, levelWon };
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
    areas.push({
      pref: "", name, scaleFrom: code, scaleTo: code, maxIntensityKey: key,
      isPlum: forecast.plumWon.has(name), isLevel: forecast.levelWon?.has(name) === true,
    });
  }

  // 1観測点だけの結果による報は、地震以外の揺れや機器障害の可能性があるため、予測震度を載せない(気象庁)。
  const intensityHidden = stationCount <= 1;
  return {
    state: { raw: { ...raw }, pub, maxValue, maxKey, areaClasses, warn: warnNow, warnAreas },
    reasons,
    newWarnAreas,
    display: {
      areas: intensityHidden ? [] : areas,
      maxKey: intensityHidden ? "?" : maxKey,
      isWarnLevel: warnNow,
      intensityHidden,
    },
  };
}

// 前回の報から変わった内容を、ログ用の文にする(更新前後の値)。evaluated: evaluateReportの戻り値。
export function describeChanges(prev, evaluated) {
  if (!prev || !evaluated) return [];
  const { state, newWarnAreas } = evaluated;
  const out = [];
  const f = (n, d) => Number(n).toFixed(d);
  if (state.raw.magnitude !== prev.raw.magnitude) {
    out.push(`M ${f(prev.raw.magnitude, 2)}→${f(state.raw.magnitude, 2)}(発表 ${f(prev.pub.magnitude, 1)}→${f(state.pub.magnitude, 1)})`);
  }
  if (state.raw.depthKm !== prev.raw.depthKm) {
    out.push(`深さ ${f(prev.raw.depthKm, 1)}→${f(state.raw.depthKm, 1)}km(発表 ${prev.pub.depthKm}→${state.pub.depthKm}km)`);
  }
  if (state.raw.lat !== prev.raw.lat || state.raw.lon !== prev.raw.lon) {
    out.push(`震源 (${f(prev.raw.lat, 2)}, ${f(prev.raw.lon, 2)})→(${f(state.raw.lat, 2)}, ${f(state.raw.lon, 2)})`);
  }
  if (Math.abs(state.maxValue - prev.maxValue) > 1e-9) {
    out.push(`最大予測震度 ${scaleKeyLabel(prev.maxKey)}→${scaleKeyLabel(state.maxKey)}(計測震度 ${f(prev.maxValue, 2)}→${f(state.maxValue, 2)})`);
  }
  const added = [];
  const changed = [];
  for (const [name, idx] of state.areaClasses) {
    if (!prev.areaClasses.has(name)) added.push(`${name}(${classLabel(idx)})`);
    else if (prev.areaClasses.get(name) !== idx) changed.push(`${name}(${classLabel(prev.areaClasses.get(name))}→${classLabel(idx)})`);
  }
  for (const [name, idx] of prev.areaClasses) if (!state.areaClasses.has(name)) changed.push(`${name}(${classLabel(idx)}→4未満)`);
  if (added.length) out.push(`新しい予報区: ${added.join("、")}`);
  if (changed.length) out.push(`予報区の変化: ${changed.join("、")}`);
  if (newWarnAreas?.length) out.push(`警報対象に追加: ${newWarnAreas.join("、")}`);
  return out;
}

// レベル法の対象になる観測点(観測震度がLEVEL_INTENSITY以上のシミュレーション観測点)を、観測震度の大きい順に返す。
export function levelTriggerStations(stations, values, simStationIds) {
  const out = [];
  if (!stations || !values || !simStationIds) return out;
  for (const st of stations) {
    if (!simStationIds.has(st.id)) continue;
    const v = values.get(st.id);
    if (Number.isFinite(v) && atLeast(v, EEW_RULES.LEVEL_INTENSITY)) out.push({ id: st.id, lat: st.lat, lon: st.lon, value: v });
  }
  out.sort((a, b) => b.value - a.value);
  return out;
}
