import { findAreaNameByPoint, haversineKm, polygonRoughCentroid } from "./geo";
import { INTENSITY_SCALE_CODE, instrumentalIntensityToScaleKey } from "./testSimulation";

/* ─────────────────────────────────────────────────────
   地震検知テスト連動の緊急地震速報シミュレーション(非推奨・自己責任の実験的機能)。
   MeteoQuakeの震源推定(epicenterEstimation.ts)の結果を、テスト用EEWカードとして表示する。
   気象庁の緊急地震速報ではない。

   【実際の地震を誤ってEEW表示しないための多層防御】
   R1 隔離      : 連動中は、検知・推定に渡す値をシミュレーション値のみにする(App.jsxのeffectiveRealtimeValues)。
   R2 二重条件  : EEW化する推定は、(a)元の検知点が全てシミュレーション対象の観測点、
                  (b)推定の発生時刻がシミュレーション開始の前後の許容内、を満たすものだけ。
   R3 実EEW優先 : 本物のEEWが発表されたら連動シミュレーションを中止する(isRealEewActive)。
   R4 識別      : source/ID接頭辞/isSimulationで、本物と常に区別できる。
   ───────────────────────────────────────────────────── */

export const SIM_EEW_SOURCE = "shake-test-sim";
export const SIM_EEW_ID_PREFIX = "simeew_";
// 推定の発生時刻が、シミュレーション開始(=真の発生時刻)から、これより前にずれていても許容する(ms)。
// 推定は検知が少ない早い段階ほどずれるため、余裕を持たせている。
export const SIM_EEW_ORIGIN_SLACK_MS = 15000;
// (報の発表条件・更新条件は simEewRules.js)
// 発報済みの推定が、この時間以上消えたまま(テストは継続中)なら取消にする(ms)
export const SIM_EEW_VANISH_CANCEL_MS = 5000;
// テストが自然終了して最終報にした後、一覧に残す時間(ms)
export const SIM_EEW_FINAL_LINGER_MS = 10000;

export function isSimEew(e) {
  return !!e && e.source === SIM_EEW_SOURCE;
}

// 本物の緊急地震速報が発表中か。テスト(isTest)・シミュレーション・訓練報・取消済みは数えない。
export function isRealEewActive(eews) {
  return (eews || []).some(e => !!e && !e.cancelled && !e.isTest && !e.isTraining && !isSimEew(e));
}

// 連動シミュレーションが生成している観測点id(perStationのキー)の和集合。
export function collectSimStationIds(linkedTests) {
  const ids = new Set();
  for (const t of linkedTests || []) {
    if (!t?.perStation) continue;
    for (const id of t.perStation.keys()) ids.add(id);
  }
  return ids;
}

// R2(a): 検知イベントの検知点が全てシミュレーション対象の観測点か。
// event: shakeDetection.tsのイベント({ detections: [{ id, ... }] })。無い・空なら不可。
export function isSimulationOnlyEvent(event, simStationIds) {
  if (!event || !Array.isArray(event.detections) || event.detections.length === 0) return false;
  if (!simStationIds || simStationIds.size === 0) return false;
  return event.detections.every(d => simStationIds.has(d.id));
}

// R2(b): 推定の発生時刻(エポックms)が合致するシミュレーションを返す(複数なら開始時刻が最も近いもの)。
// 合致しなければnull。シミュレーションの真の発生時刻=startedAt。
export function findOwnerTest(est, linkedTests, nowMs = Date.now()) {
  if (!est || !Number.isFinite(est.originTime)) return null;
  let best = null;
  let bestGap = Infinity;
  for (const t of linkedTests || []) {
    if (!t || !Number.isFinite(t.startedAt)) continue;
    if (est.originTime < t.startedAt - SIM_EEW_ORIGIN_SLACK_MS) continue;
    if (est.originTime > nowMs + 2000) continue; // 未来の発生時刻はあり得ない
    const gap = Math.abs(est.originTime - t.startedAt);
    if (gap < bestGap) { bestGap = gap; best = t; }
  }
  return best;
}

// 発報に必要な値(位置・M)が揃っているか。
export function canIssueFromEstimate(est) {
  return !!est
    && Number.isFinite(est.lat) && Number.isFinite(est.lon)
    && Number.isFinite(est.magnitude) && Number.isFinite(est.depthKm);
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

// "YYYY/MM/DD HH:mm:ss"(端末のローカル時刻。MapCanvasのEEW円アニメーションと同じ解釈)
export function formatSimOriginTime(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function fallbackSimPlace(lat, lon) {
  return `推定震源(北緯${lat.toFixed(2)}度 東経${lon.toFixed(2)}度)`;
}

// 第1報のカードを組み立てる。evaluated: simEewRules.evaluateReportの戻り値({ state, reasons, display })。
// 震源の位置は内部値、Mと深さは発表値(M0.1刻み・深さ10km刻み)を載せる。
export function buildSimEewCard({ eventId, est, evaluated, place, simTestId, nowMs }) {
  const { state, display } = evaluated;
  const id = `${SIM_EEW_ID_PREFIX}${eventId}`;
  return {
    id, eventId: id,
    serial: "1",
    cancelled: false,
    isTraining: false,
    originTime: formatSimOriginTime(est.originTime),
    arrivalTime: null,
    isAssumedHypocenter: false,
    place: place || fallbackSimPlace(est.lat, est.lon),
    reducedPlace: "シミュレーション",
    latitude: est.lat, longitude: est.lon, depth: state.pub.depthKm,
    magnitude: state.pub.magnitude,
    areas: display.areas,
    maxIntensityKey: display.maxKey,
    isTest: true,
    isSimulation: true,
    source: SIM_EEW_SOURCE,
    simTestId,
    isFinal: false,
    isWarnLevel: display.isWarnLevel,
    isPlum: false, // PLUM法は通常方式との合成(地域ごとのisPlum)で使い、報全体はPLUM法の報にはしない
    isLevel: false,
    intensityHidden: display.intensityHidden === true,
    receivedLocalAt: nowMs,
    cancelledLocalAt: null,
  };
}

// 続報(報番号+1)。警報は一度出たら予報に戻さない(state.warnが引き継ぐ)。
// レベル法の報(震源・M未推定)から、通常方式の報に切り替わる場合にも使う。
export function buildSimEewFollowUp(card, { est, evaluated, place, nowMs }) {
  const { state, display } = evaluated;
  const serial = String((parseInt(card.serial, 10) || 1) + 1);
  return {
    ...card,
    serial,
    originTime: formatSimOriginTime(est.originTime),
    place: place || fallbackSimPlace(est.lat, est.lon),
    latitude: est.lat, longitude: est.lon, depth: state.pub.depthKm,
    magnitude: state.pub.magnitude,
    areas: display.areas,
    maxIntensityKey: display.maxKey,
    isWarnLevel: display.isWarnLevel,
    isPlum: false,
    isLevel: false,
    intensityHidden: display.intensityHidden === true,
    receivedLocalAt: nowMs,
  };
}

/* ─────────────────────────────────────────────────────
   レベル法(震源要素によらない予測手法)の擬似再現。
   観測点の揺れが一定以上(simEewRules.EEW_RULES.LEVEL_INTENSITY)になったら、震源・Mの推定を介さず、
   「観測点近傍で震度5弱程度以上」の予報を直ちに出す。震源・M・到達予測時刻は載せない(気象庁の発表パターン1)。
   ───────────────────────────────────────────────────── */
const LEVEL_KEY = "5-";

// 観測点が属する細分区域の名前。含む区域が無ければ、重心が最も近い区域(PLUM_RADIUS_KM以内)。
export function areaNameForStation(areasGeoJSON, st) {
  const inside = findAreaNameByPoint(areasGeoJSON, st.lat, st.lon);
  if (inside) return inside;
  let best = null;
  let bestKm = PLUM_RADIUS_KM;
  for (const a of areaCentroids(areasGeoJSON)) {
    const km = haversineKm(st.lat, st.lon, a.lat, a.lon);
    if (km <= bestKm) { bestKm = km; best = a.name; }
  }
  return best;
}

// レベル法の対象の観測点(simEewRules.levelTriggerStations)を、属するシミュレーションごと・地域ごとにまとめる。
// 戻り値: Map<simTestId, { first: 観測震度が最大の観測点, areas: Map<地域名, { intensity, key, station }> }>
// 地域に属さない観測点(海上など)は対象外。
export function groupLevelTriggers(areasGeoJSON, triggers, tests) {
  const out = new Map();
  for (const st of triggers || []) {
    const areaName = areaNameForStation(areasGeoJSON, st);
    if (!areaName) continue;
    const owner = (tests || []).find(t => t.perStation?.has(st.id));
    if (!owner) continue;
    let g = out.get(owner.id);
    if (!g) { g = { first: st, areas: new Map() }; out.set(owner.id, g); }
    const cur = g.areas.get(areaName);
    if (!cur || st.value > cur.intensity) {
      g.areas.set(areaName, { intensity: st.value, key: instrumentalIntensityToScaleKey(st.value), station: st });
    }
  }
  return out;
}

function levelArea(name) {
  const code = INTENSITY_SCALE_CODE[LEVEL_KEY] ?? 45;
  return { pref: "", name, scaleFrom: code, scaleTo: code, maxIntensityKey: LEVEL_KEY, isPlum: false };
}

export function simLevelEewId(simTestId) {
  return `${SIM_EEW_ID_PREFIX}level_${simTestId}`;
}

// レベル法の第1報のカード。震源・M・深さは持たない(位置は、揺れを検知した観測点の位置)。
export function buildSimLevelCard({ simTestId, station, areaNames, nowMs }) {
  const id = simLevelEewId(simTestId);
  return {
    id, eventId: id,
    serial: "1",
    cancelled: false,
    isTraining: false,
    originTime: formatSimOriginTime(nowMs),
    arrivalTime: null,
    isAssumedHypocenter: false,
    place: areaNames[0] || "観測点近傍",
    reducedPlace: "シミュレーション",
    latitude: station.lat, longitude: station.lon, depth: null,
    magnitude: null,
    areas: areaNames.map(levelArea),
    maxIntensityKey: LEVEL_KEY,
    isTest: true,
    isSimulation: true,
    source: SIM_EEW_SOURCE,
    simTestId,
    isFinal: false,
    isWarnLevel: false, // レベル法は1観測点の結果なので、警報にはしない
    isPlum: true,       // 震源が無い報の表示(円アイコン・到達円なし)は、PLUM法の報の表示を流用する
    isLevel: true,
    intensityHidden: false,
    receivedLocalAt: nowMs,
    cancelledLocalAt: null,
  };
}

// レベル法の続報: これまでの報に含まれない地域で、新たに強い揺れを観測した時に、その地域を加える。
export function buildSimLevelFollowUp(card, { areaNames, nowMs }) {
  const have = new Set(card.areas.map(a => a.name));
  const add = areaNames.filter(n => !have.has(n)).map(levelArea);
  return {
    ...card,
    serial: String((parseInt(card.serial, 10) || 1) + 1),
    areas: [...card.areas, ...add],
    receivedLocalAt: nowMs,
  };
}

/* ─────────────────────────────────────────────────────
   通常方式とPLUM法のハイブリッド(予想震度の広がりの再現)。
   PLUM法は単独では発表せず、通常方式(震源推定)の第1報・更新報に、観測震度から求めた予想震度を合成する。
     予想震度(地域) = max(通常方式の距離減衰による予測, PLUM法の予測)  (合成はsimEewRules.buildForecast)
   PLUM法の予測 = その地域の代表点(細分区域の重心)から半径PLUM_RADIUS_KM以内のシミュレーション観測点の
   うち、観測震度がPLUM_MIN_OBSERVED_INTENSITY以上のものの最大観測震度(観測点別の地盤増幅などは考慮しない簡易版)。
   適用する観測震度の下限は震度4(計測震度3.5)。気象庁の資料にPLUM法の閾値の数値は無く、この値はMeteoQuakeの設定で、定数で調整できる。
   一度出た予想震度は下げない(holdPlum)。
   ───────────────────────────────────────────────────── */
export const PLUM_RADIUS_KM = 30;
export const PLUM_MIN_OBSERVED_INTENSITY = 3.5; // 計測震度3.5 = 震度4(震度4以上の観測点から適用する)

const centroidCache = new WeakMap();
function areaCentroids(areasGeoJSON) {
  let list = centroidCache.get(areasGeoJSON);
  if (list) return list;
  list = [];
  for (const f of areasGeoJSON?.features || []) {
    const name = f.properties?.name;
    if (!name) continue;
    const c = polygonRoughCentroid(f.geometry);
    if (c) list.push({ name, lat: c.lat, lon: c.lon });
  }
  centroidCache.set(areasGeoJSON, list);
  return list;
}

// 観測震度(values: 観測点id→計測震度)から、PLUM法の地域別予想震度を求める。
// stations: [{ id, lat, lon }]。simStationIds以外の観測点(=シミュレーション以外)は使わない。
// 戻り値: Map<地域名, { intensity, key }>
export function calcPlumAreaIntensities(areasGeoJSON, stations, values, simStationIds) {
  const result = new Map();
  if (!areasGeoJSON || !stations || !values || !simStationIds) return result;
  const hot = [];
  for (const st of stations) {
    if (!simStationIds.has(st.id)) continue;
    const v = values.get(st.id);
    if (Number.isFinite(v) && v >= PLUM_MIN_OBSERVED_INTENSITY) hot.push({ lat: st.lat, lon: st.lon, v });
  }
  if (hot.length === 0) return result;
  for (const a of areaCentroids(areasGeoJSON)) {
    let best = -Infinity;
    for (const h of hot) {
      if (h.v > best && haversineKm(h.lat, h.lon, a.lat, a.lon) <= PLUM_RADIUS_KM) best = h.v;
    }
    if (best > -Infinity) result.set(a.name, { intensity: best, key: instrumentalIntensityToScaleKey(best) });
  }
  return result;
}

// 一度出たPLUM法の予想震度を保持する(揺れが収まっても予想震度は下げない)。holdを更新して返す。
export function holdPlum(hold, plum) {
  for (const [name, p] of plum || []) {
    const cur = hold.get(name);
    if (!cur || cur.intensity < p.intensity) hold.set(name, p);
  }
  return hold;
}
